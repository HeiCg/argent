/**
 * Screen-graph Phase E — template edges per scrollable container (design D1).
 *
 * A scrollable container's item taps are folded onto ONE template edge whose
 * destination is a synthetic TEMPLATE NODE (not a real screen), so the graph's
 * size is independent of how many content states the feed renders (E-0 §F5).
 * Everything here is host-side and pure — it operates on the FLAT element list
 * the open device server serves (no hierarchy, E-0 §F7), so containment is
 * recovered GEOMETRICALLY (design D1 option B): an element belongs to the
 * SMALLEST scrollable whose bounds contain it, ties broken by flat index.
 *
 * The identities below reuse the exact tokens `utils/screen-hash` already folds
 * into `H_id` (the `SC:<class>#<id>` container token, `screen-hash.ts:214`; the
 * text-free class sequence of the recycler rule, `screen-hash.ts:177-180`), so a
 * container key is invariant under scroll position, item count and content
 * refresh by the same argument that makes `H_id` content-free (E-0 §F1). The
 * FNV-1a construction is the twin of `utils/screen-hash` `fnv1a` (same offset
 * basis, prime and 64-bit mask); it is duplicated here rather than imported to
 * keep the screen-graph module free of a `utils` dependency, and is unit-tested
 * against a known vector.
 */

const US = String.fromCharCode(0x1f);

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** 64-bit FNV-1a hex (twin of `utils/screen-hash` `fnv1a`). */
export function fnv1aHex(s: string): string {
  let h = FNV_OFFSET;
  const bytes = Buffer.from(s, "utf8");
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * The minimal shape a template needs from a live element. Structurally a subset
 * of `OpenServerElement` (the flat `getState().tree` element), so the wiring
 * passes those straight through.
 */
export interface TemplateElement {
  /** Fully-qualified class name (`androidx.recyclerview.widget.RecyclerView`). */
  className: string;
  /** Package-qualified resource id (`com.x:id/list`), when present. */
  resourceId?: string;
  /** The `scrollable` accessibility flag. */
  scrollable?: boolean;
  /** 1-based flat DFS index (the only positional field the flat tree carries). */
  index: number;
  bounds: { x1: number; y1: number; x2: number; y2: number };
}

/** Simple class name — the last dotted segment (mirrors the device SC token). */
export function stripClass(className: string): string {
  const c = className ?? "";
  const dot = c.lastIndexOf(".");
  return dot >= 0 ? c.slice(dot + 1) : c;
}

/** Stripped resource id — the part after `id/`, else after the last `/`, else all. */
export function stripId(resourceId: string | undefined): string {
  const r = (resourceId ?? "").trim();
  if (r === "") return "";
  const marker = r.indexOf("id/");
  if (marker >= 0) return r.slice(marker + 3);
  const slash = r.lastIndexOf("/");
  return slash >= 0 ? r.slice(slash + 1) : r;
}

/** Window-decor ids excluded from screen identity (mirror of screen-hash). */
const SYSTEM_RIDS = new Set(["statusBarBackground", "navigationBarBackground"]);

/** Scrolling-container classes (mirror of `screen-hash.ts` `SCROLLING_CONTAINERS`). */
const SCROLLING_CONTAINERS = new Set([
  "RecyclerView",
  "ListView",
  "ScrollView",
  "HorizontalScrollView",
]);

/** Whether a flat element is a scrolling container (mirror of `isScrollingContainer`). */
export function isScrollingElement(el: TemplateElement): boolean {
  if (el.scrollable) return true;
  const c = stripClass(el.className);
  return SCROLLING_CONTAINERS.has(c) || c.startsWith("ViewPager");
}

function area(b: { x1: number; y1: number; x2: number; y2: number }): number {
  return Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
}

function contains(
  outer: { x1: number; y1: number; x2: number; y2: number },
  x: number,
  y: number
): boolean {
  return x >= outer.x1 && x <= outer.x2 && y >= outer.y1 && y <= outer.y2;
}

/** The `SC:<class>#<id>` token screen-hash folds for a scrolling container. */
export function scTokenOf(el: TemplateElement): string {
  return `SC:${stripClass(el.className)}#${stripId(el.resourceId)}`;
}

/**
 * The smallest scrolling container whose bounds contain the point `(x, y)`, or
 * `null` when the tap was not inside any scrollable (design D1 option B). Ties on
 * area break on the lower flat index so a nested horizontal carousel inside a
 * vertical list resolves to the carousel (the tightest bound), exactly the
 * Netflix shape the churn app exercises.
 */
export function resolveContainer(
  elements: readonly TemplateElement[],
  x: number,
  y: number
): TemplateElement | null {
  let best: TemplateElement | null = null;
  let bestArea = Infinity;
  for (const el of elements) {
    if (!isScrollingElement(el)) continue;
    if (!contains(el.bounds, x, y)) continue;
    const a = area(el.bounds);
    if (a < bestArea || (a === bestArea && best !== null && el.index < best.index)) {
      bestArea = a;
      best = el;
    }
  }
  return best;
}

/**
 * The acted item: the smallest element whose bounds contain `(x, y)` (the row the
 * tap landed on), ties broken by lower flat index. `null` when nothing contains
 * the point.
 */
export function actedElementAt(
  elements: readonly TemplateElement[],
  x: number,
  y: number
): TemplateElement | null {
  let best: TemplateElement | null = null;
  let bestArea = Infinity;
  for (const el of elements) {
    if (!contains(el.bounds, x, y)) continue;
    const a = area(el.bounds);
    if (a < bestArea || (a === bestArea && best !== null && el.index < best.index)) {
      bestArea = a;
      best = el;
    }
  }
  return best;
}

/**
 * The item subtree: the acted element plus every flat element strictly inside its
 * bounds, in flat order. On the compressed flat tree a list row is usually one
 * element, so this is `[acted]`; when the row's descendants survived compression
 * they are folded in, reconstructing the subtree geometrically.
 */
export function itemElementsOf(
  elements: readonly TemplateElement[],
  acted: TemplateElement
): TemplateElement[] {
  const out: TemplateElement[] = [acted];
  for (const el of elements) {
    if (el.index === acted.index) continue;
    const b = el.bounds;
    const a = acted.bounds;
    const inside = b.x1 >= a.x1 && b.y1 >= a.y1 && b.x2 <= a.x2 && b.y2 <= a.y2;
    if (inside && area(b) < area(a)) out.push(el);
  }
  out.sort((p, q) => p.index - q.index);
  return out;
}

/**
 * Item template — text-free and bounds-free (design D1): the class sequence of
 * the item subtree in flat order plus its SORTED stripped resource-id multiset.
 * The rid multiset is load-bearing: inside-scroll ids are absent from `H_id`
 * (E-0 §F1), so the class sequence alone would merge a content row with an ad row
 * of the same layout — the sorted rids keep them two templates.
 */
export function itemTemplateOf(itemEls: readonly TemplateElement[]): string {
  const classSeq = itemEls.map((e) => stripClass(e.className)).join(",");
  const rids = itemEls
    .map((e) => stripId(e.resourceId))
    .filter((r) => r !== "")
    .sort();
  return fnv1aHex(`${classSeq}${US}${rids.join(",")}`);
}

/** Rank of `container` among containers sharing its `SC` token, in flat order. */
export function ordinalOf(
  elements: readonly TemplateElement[],
  container: TemplateElement
): number {
  const token = scTokenOf(container);
  const siblings = elements
    .filter((el) => isScrollingElement(el) && scTokenOf(el) === token)
    .sort((a, b) => a.index - b.index);
  return Math.max(
    0,
    siblings.findIndex((el) => el.index === container.index)
  );
}

/**
 * Container identity, stable across scroll and refresh (design D1): the screen's
 * `H_id`, the container's `SC` token and its ordinal among same-token siblings.
 * No bounds, no children, no text, no item count — invariant by the same argument
 * that makes `H_id` content-free (E-0 §F1).
 */
export function containerKeyOf(
  idHash: string,
  container: TemplateElement,
  ordinal: number
): string {
  return fnv1aHex(`${idHash}${US}${scTokenOf(container)}${US}${ordinal}`);
}

/**
 * The destination's stripped resource ids that are NOT inside any scrollable
 * container (geometric inside-scroll test on the flat tree), sorted. This is the
 * text-free structural fingerprint of the destination the template node stores,
 * and the rid multiset a tolerant Jaccard arrival check runs against (design D1
 * step 4, `plan.ts:180-262`).
 */
export function nonScrollRids(elements: readonly TemplateElement[], packageName: string): string[] {
  void packageName;
  const scrollables = elements.filter(isScrollingElement);
  const rids: string[] = [];
  for (const el of elements) {
    const rid = stripId(el.resourceId);
    if (rid === "" || SYSTEM_RIDS.has(rid)) continue;
    // Inside-scroll when contained by a DIFFERENT scrollable (a scrollable itself
    // is not "inside" — its own token is folded separately below).
    const inside = scrollables.some(
      (sc) =>
        sc.index !== el.index &&
        el.bounds.x1 >= sc.bounds.x1 &&
        el.bounds.y1 >= sc.bounds.y1 &&
        el.bounds.x2 <= sc.bounds.x2 &&
        el.bounds.y2 <= sc.bounds.y2
    );
    if (!inside) rids.push(rid);
  }
  return rids.sort();
}

/**
 * Destination shape — `H_id` of the destination with the identity-title component
 * replaced by `"*"` (design D1). Computed host-side from the flat tree (never
 * compared to a device hash): the package + the sorted `SC` tokens + the
 * text-free non-scroll rid multiset, titles excluded. It coincides for every
 * item's detail screen whose only difference is the toolbar title, so the 50-node
 * explosion regime and the 1-node false-merge regime BOTH collapse to one shape
 * (E-0 §F2 / §Design D1).
 */
export function destinationShapeOf(
  elements: readonly TemplateElement[],
  packageName: string
): string {
  const scTokens = [...new Set(elements.filter(isScrollingElement).map(scTokenOf))].sort();
  const rids = nonScrollRids(elements, packageName);
  return fnv1aHex(`${packageName}${US}ID:*${US}RID:${rids.join(",")}${US}SC:${scTokens.join(",")}`);
}

/** The synthetic template-node hash (design D1). */
export function templateNodeHashOf(
  containerKey: string,
  itemTemplate: string,
  destinationShape: string
): string {
  return fnv1aHex(`TPL${US}${containerKey}${US}${itemTemplate}${US}${destinationShape}`);
}

/** A fully-resolved template edge target, or `null` when the tap was not in a list. */
export interface ResolvedTemplate {
  containerKey: string;
  itemTemplate: string;
  destinationShape: string;
  templateNodeHash: string;
  /** Non-scroll rid multiset of the destination (arrival-check key). */
  destinationResourceIds: string[];
}

/**
 * Resolve a container-item tap into its template identities, or `null` when the
 * tapped point was not inside any scrollable container on the source screen.
 * `sourceIdHash` is the feed screen's `H_id`; `destinationElements` is the
 * settled destination's flat tree.
 */
export function resolveTemplate(
  sourceElements: readonly TemplateElement[],
  x: number,
  y: number,
  sourceIdHash: string,
  destinationElements: readonly TemplateElement[],
  packageName: string
): ResolvedTemplate | null {
  const container = resolveContainer(sourceElements, x, y);
  if (!container) return null;
  const acted = actedElementAt(sourceElements, x, y);
  if (!acted) return null;
  const ordinal = ordinalOf(sourceElements, container);
  const containerKey = containerKeyOf(sourceIdHash, container, ordinal);
  const itemTemplate = itemTemplateOf(itemElementsOf(sourceElements, acted));
  const destinationShape = destinationShapeOf(destinationElements, packageName);
  const templateNodeHash = templateNodeHashOf(containerKey, itemTemplate, destinationShape);
  return {
    containerKey,
    itemTemplate,
    destinationShape,
    templateNodeHash,
    destinationResourceIds: nonScrollRids(destinationElements, packageName),
  };
}
