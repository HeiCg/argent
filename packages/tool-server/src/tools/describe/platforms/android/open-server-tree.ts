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
}

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
 * Lower the open server's full nested accessibility tree to a `DescribeNode` by
 * running the EXACT v2 interactables-only trim the `uiautomator dump` /
 * `android-devtools` path runs. The server root is wrapped as the single window
 * `<node>` under a synthetic `<hierarchy>`, mirroring the XML the trim expects,
 * so the compacted output (dropped layout containers, concatenated row labels,
 * collapsed wrappers, package-qualified ids) is byte-identical to the
 * proprietary path — which is what makes the describe token count and label set
 * match rather than merely approximate it.
 */
export function openServerNestedToDescribeNode(
  roots: OpenServerNestedElement[],
  screenW: number,
  screenH: number
): DescribeNode {
  // Each element is one window's root (active window, IME keyboard, dialogs …),
  // exactly the multi-window shape a uiautomator `<hierarchy>` carries.
  const hierarchy: ParsedXmlNode = {
    tag: "hierarchy",
    attrs: {},
    children: roots.map(nestedToParsed),
  };
  return buildDescribeTreeFromParsedRoot(hierarchy, screenW, screenH);
}
