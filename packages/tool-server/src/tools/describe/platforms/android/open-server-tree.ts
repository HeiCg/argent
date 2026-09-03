import type { DescribeFrame, DescribeNode } from "../../contract";
import {
  buildDescribeTreeFromParsedRoot,
  clipBoundsToScreen,
  deriveUiAutomatorRole,
  type ParsedXmlNode,
} from "./uiautomator-parser";

/**
 * One element in the `getAccessibilityTree` reply from `@argent/android-device-server`.
 * The on-device server already compresses the tree (drops empty containers, keeps
 * interactables) and flattens it into a 1-indexed list with screen-pixel bounds.
 */
export interface OpenServerElement {
  index: number;
  className: string;
  resourceId?: string;
  text?: string;
  contentDesc?: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  clickable?: boolean;
  scrollable?: boolean;
  focused?: boolean;
  enabled?: boolean;
  checked?: boolean;
  selected?: boolean;
}

/**
 * Lower the server's flat element list to the `DescribeNode` contract the rest of
 * `describe` renders, matching the field conventions of the uiautomator-dump path
 * (`content-desc` wins the label, a diverging `text` becomes `value`, resource-id
 * is the identifier, `enabled: false` → `disabled`). The server's output is
 * already a flat, compressed list, so every element becomes a direct child of a
 * synthetic `Screen` root rather than a reconstructed hierarchy.
 */
export function openServerElementsToDescribeNode(
  elements: OpenServerElement[],
  screenW: number,
  screenH: number
): DescribeNode {
  const children: DescribeNode[] = [];
  for (const el of elements) {
    const node = elementToNode(el, screenW, screenH);
    if (node) children.push(node);
  }
  return {
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  };
}

function elementToNode(
  el: OpenServerElement,
  screenW: number,
  screenH: number
): DescribeNode | null {
  const px = {
    x: el.bounds.x1,
    y: el.bounds.y1,
    w: Math.max(0, el.bounds.x2 - el.bounds.x1),
    h: Math.max(0, el.bounds.y2 - el.bounds.y1),
  };
  const clipped = clipBoundsToScreen(px, screenW, screenH);
  // Drop zero-area elements that clip fully off-screen — no tap target there.
  if (clipped.w <= 0 || clipped.h <= 0) return null;

  const frame: DescribeFrame = {
    x: screenW > 0 ? clipped.x / screenW : 0,
    y: screenH > 0 ? clipped.y / screenH : 0,
    width: screenW > 0 ? clipped.w / screenW : 0,
    height: screenH > 0 ? clipped.h / screenH : 0,
  };

  const contentDesc = (el.contentDesc ?? "").trim();
  const text = (el.text ?? "").trim();
  // Prefer content-desc as the label, mirroring `labelOf` in the dump parser.
  const label = contentDesc || text;

  const out: DescribeNode = {
    role: deriveUiAutomatorRole(el.className),
    frame,
    children: [],
  };
  if (label) out.label = label;
  if (el.resourceId) out.identifier = el.resourceId;
  // A diverging `text` (EditText content while content-desc is the placeholder)
  // becomes `value`, same as the dump path.
  if (text && text !== label) out.value = text;
  if (el.clickable) out.clickable = true;
  if (el.scrollable) out.scrollable = true;
  if (el.checked) out.checked = true;
  if (el.selected) out.selected = true;
  if (el.focused) out.focused = true;
  if (el.enabled === false) out.disabled = true;
  return out;
}

/**
 * One node in the FULL, nested `getAccessibilityTree({ nested: true })` reply.
 * Unlike {@link OpenServerElement} nothing is pruned or stripped here: raw
 * `className`, package-qualified `resourceId`, and every attribute the v2 trim
 * reads are present, so the host can run the same interactables-only trim the
 * proprietary `android-devtools` XML path runs (token parity).
 */
export interface OpenServerNestedElement {
  className: string;
  resourceId?: string;
  text?: string;
  contentDesc?: string;
  packageName?: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  clickable?: boolean;
  longClickable?: boolean;
  scrollable?: boolean;
  checkable?: boolean;
  checked?: boolean;
  focusable?: boolean;
  focused?: boolean;
  selected?: boolean;
  enabled?: boolean;
  password?: boolean;
  children?: OpenServerNestedElement[];
  /**
   * Set on a window root when the on-device serializer hit its `maxElements`
   * runaway guard, so the tree is a prefix of the real one (F13). The host
   * surfaces this as a describe hint rather than silently rendering a partial
   * screen.
   */
  truncated?: boolean;
}

/**
 * Whether any window root reports it was truncated at the server's element cap
 * (F13). Used to add a hint to the describe output.
 */
export function nestedTreeTruncated(roots: OpenServerNestedElement[]): boolean {
  return roots.some((r) => r.truncated === true);
}

// Counterpart to the on-device serializer's payload trim (`NodeSerializer`):
// that side emits only true booleans and non-empty strings (and `enabled` only
// when false). This restores the defaults — a missing boolean is false, a
// missing `class` is "", a missing `enabled` is true — so the trimmed wire
// payload lowers to the byte-identical `ParsedXmlNode` (and thus the identical
// DescribeNode / rendered text) the fully-populated payload used to.
function nestedToParsed(el: OpenServerNestedElement): ParsedXmlNode {
  const b = el.bounds;
  const attrs: Record<string, string> = {
    class: el.className ?? "",
    bounds: `[${b.x1},${b.y1}][${b.x2},${b.y2}]`,
    clickable: el.clickable ? "true" : "false",
    "long-clickable": el.longClickable ? "true" : "false",
    scrollable: el.scrollable ? "true" : "false",
    checkable: el.checkable ? "true" : "false",
    checked: el.checked ? "true" : "false",
    focusable: el.focusable ? "true" : "false",
    focused: el.focused ? "true" : "false",
    selected: el.selected ? "true" : "false",
    // `enabled` defaults true (matches uiautomator dump, where only false is
    // notable); `makeUiNode` reads `enabled === "false"`.
    enabled: el.enabled === false ? "false" : "true",
    password: el.password ? "true" : "false",
  };
  if (el.resourceId) attrs["resource-id"] = el.resourceId;
  if (el.text) attrs.text = el.text;
  if (el.contentDesc) attrs["content-desc"] = el.contentDesc;
  if (el.packageName) attrs.package = el.packageName;
  return {
    tag: "node",
    attrs,
    children: (el.children ?? []).map(nestedToParsed),
  };
}

/**
 * First host pass: lower the nested roots to the XML-shaped `ParsedXmlNode`
 * `<hierarchy>` the v2 trim consumes. Each element is one window's root (active
 * window, IME keyboard, dialogs …), exactly the multi-window shape a uiautomator
 * `<hierarchy>` carries. Exported so the phase 3i host micro-bench can time this
 * pass (the nested→parsed rebuild) separately from the trim
 * (`buildDescribeTreeFromParsedRoot`) and measure the two-pass cost.
 */
export function nestedRootsToParsedHierarchy(roots: OpenServerNestedElement[]): ParsedXmlNode {
  return {
    tag: "hierarchy",
    attrs: {},
    children: roots.map(nestedToParsed),
  };
}

// ---------------------------------------------------------------------------
// compact payload (phase 3j)
// ---------------------------------------------------------------------------

// The v2 trim's layout-passthrough set (`LAYOUT_CONTAINERS` in uiautomator-parser),
// duplicated here as a raw class list so the compaction can recognise the exact
// wrappers `computeNodeOutput` inlines. Kept byte-for-byte in sync with that set;
// the on-device `TreeCompressor.LAYOUT_CONTAINERS` (Kotlin) mirrors it too. The
// empty class ("") is deliberately NOT here: the trim's passthrough uses
// `LAYOUT_CONTAINERS.has(cls)`, which is false for "", so an empty-class node is
// not a passthrough and must not be hoisted.
const COMPACT_LAYOUT_CONTAINERS = new Set([
  "android.widget.FrameLayout",
  "android.widget.LinearLayout",
  "android.widget.RelativeLayout",
  "androidx.constraintlayout.widget.ConstraintLayout",
  "androidx.coordinatorlayout.widget.CoordinatorLayout",
  "android.view.ViewGroup",
  "android.view.View",
]);

/** Label the trim derives for a nested element: content-desc wins, else text. */
function compactLabelOf(el: OpenServerNestedElement): string {
  const cd = (el.contentDesc ?? "").trim();
  if (cd) return cd;
  return (el.text ?? "").trim();
}

/** Whether the trim treats this element as interactive (mirrors `isInteractive`). */
function compactIsInteractive(el: OpenServerNestedElement, label: string): boolean {
  if (el.clickable || el.longClickable || el.checkable || el.scrollable) return true;
  if (el.focusable && label !== "") return true;
  return false;
}

/**
 * Whether this element is the trim's pure-passthrough case: a layout container or
 * a decorative ImageView that is non-interactive and carries no label of its own.
 * `computeNodeOutput` returns such a node's kept children in its place (it is never
 * emitted), so dropping the wrapper and hoisting its children is output-preserving.
 * It carries no text/content-desc (label === ""), so no ancestor's descendantText
 * aggregation changes.
 */
function compactIsScaffoldPassthrough(el: OpenServerNestedElement): boolean {
  const label = compactLabelOf(el);
  if (label !== "") return false;
  if (compactIsInteractive(el, label)) return false;
  const cls = el.className ?? "";
  return COMPACT_LAYOUT_CONTAINERS.has(cls) || cls.endsWith(".ImageView");
}

function compactNestedNode(el: OpenServerNestedElement): OpenServerNestedElement[] {
  const compactedChildren: OpenServerNestedElement[] = [];
  for (const c of el.children ?? []) {
    for (const cc of compactNestedNode(c)) compactedChildren.push(cc);
  }
  // Rule 1 — scaffold hoist: drop the wrapper, splice its compacted children into
  // its slot (document order preserved by the in-order push above).
  if (compactIsScaffoldPassthrough(el)) return compactedChildren;
  // Rule 2 — zero-area empty leaf: a leaf with a zero-area rect and no
  // text/content-desc is always dropped by the trim (invisible, no kept children)
  // and feeds no descendantText, so drop it. A zero-area node that still carries
  // text, or one whose descendants survived, is kept (the trim will drop the
  // invisible one on its own — keeping it only wastes a few bytes, never diverges).
  const b = el.bounds;
  const zeroArea = b.x2 <= b.x1 || b.y2 <= b.y1;
  if (compactedChildren.length === 0 && zeroArea && compactLabelOf(el) === "") {
    return [];
  }
  // Kept: same node, compacted children. Preserve every field the trim reads.
  return el.children === undefined && compactedChildren.length === 0
    ? [el]
    : [{ ...el, children: compactedChildren }];
}

function compactChildren(children: OpenServerNestedElement[] | undefined): OpenServerNestedElement[] {
  const out: OpenServerNestedElement[] = [];
  for (const c of children ?? []) {
    for (const cc of compactNestedNode(c)) out.push(cc);
  }
  return out;
}

/**
 * Drop, before serialization, the nested nodes the host v2 trim discards anyway,
 * so a `compact:true` capture ships a smaller wire payload that lowers to the
 * BYTE-IDENTICAL DescribeNode (phase 3j). Conservative and output-preserving: it
 * only removes trim-passthrough wrappers (rule 1) and trim-dropped zero-area empty
 * leaves (rule 2) — see {@link compactIsScaffoldPassthrough}.
 *
 * Each WINDOW ROOT is kept as-is (only its descendants are compacted): the trim
 * passes a scaffold root through anyway, so keeping it is byte-identical, and it
 * preserves the per-root `truncated` runaway-guard flag the host reads. This
 * mirrors the on-device serializer, which compacts within each window root.
 *
 * Contract: `openServerNestedToDescribeNode(roots)` and
 * `openServerNestedToDescribeNode(compactNestedRoots(roots))` are deep-equal — the
 * golden asserts it on the committed fixtures. The on-device serializer applies
 * the identical rules (`NodeSerializer` compact path); either side being *more*
 * conservative stays byte-identical, because both only ever remove nodes the trim
 * itself passes through or drops.
 */
export function compactNestedRoots(
  roots: OpenServerNestedElement[]
): OpenServerNestedElement[] {
  return roots.map((r) => ({ ...r, children: compactChildren(r.children) }));
}

/**
 * Lower the open server's full nested accessibility tree to a `DescribeNode` by
 * running the EXACT v2 interactables-only trim the `uiautomator dump` /
 * `android-devtools` path runs. The server root is wrapped as the single window
 * `<node>` under a synthetic `<hierarchy>`, mirroring the XML the trim expects,
 * so the compacted output (dropped layout containers, concatenated row labels,
 * collapsed wrappers, package-qualified ids) is byte-identical to the
 * proprietary path — which is what makes the describe token count and label set
 * match rather than merely approximate it.
 *
 * Two passes: {@link nestedRootsToParsedHierarchy} (nested→parsed) then
 * `buildDescribeTreeFromParsedRoot` (parsed→trimmed DescribeNode). Kept as a
 * composition of the two so both the goldens (the byte-identical contract) and
 * the host micro-bench see the identical output.
 */
export function openServerNestedToDescribeNode(
  roots: OpenServerNestedElement[],
  screenW: number,
  screenH: number
): DescribeNode {
  return buildDescribeTreeFromParsedRoot(nestedRootsToParsedHierarchy(roots), screenW, screenH);
}
