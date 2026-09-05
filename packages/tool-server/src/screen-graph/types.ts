/**
 * Screen-graph Phase B (design §2.2 / §3) host-side "app memory" types.
 *
 * A screen is a node fingerprinted by the device-computed structural hash `H`
 * (see `utils/screen-hash` / the Phase A `hash` field); an edge is a canonical
 * action that took one screen to another. The graph is persisted per
 * `(packageName, versionCode)` so a warm run costs a hash check and a lookup
 * rather than a re-description.
 */

/**
 * A canonical, backend-independent action label for a graph edge (design §3,
 * `A` = canonical actions). `target` prefers a resource-id, else visible text;
 * when neither is known the tap is bucketed to a 1/16 screen grid cell in
 * `bucket` (see `canonical.ts`). `dir` labels swipes; `key` names a key event.
 *
 * Deviation from the ticket's literal `{kind, target?, dir?}` triple: `bucket`
 * and `key` are additive optional fields — the triple cannot otherwise
 * distinguish two coordinate-only taps, or name a key press, and edges are
 * keyed by action identity, so both are load-bearing. Documented in the report.
 */
export interface CanonicalAction {
  kind: "tap" | "longPress" | "swipe" | "back" | "typeText" | "key";
  /** Element identity: resource-id wins, else visible text. */
  target?: { id?: string; text?: string };
  /** Swipe direction, derived from the dominant delta. */
  dir?: "up" | "down" | "left" | "right";
  /** Coordinate fallback for a tap with no id/text: 1/16 grid cell, 0..15. */
  bucket?: { x: number; y: number };
  /** Key name for `kind: 'key'` (e.g. `enter`, `KEYCODE_TAB`). */
  key?: string;
}

/** A stored selector index entry: where a selector was, and its flags. */
export interface IndexEntry {
  bounds: { x1: number; y1: number; x2: number; y2: number };
  /** Actionability bitmask (`utils/screen-hash` bits + `FLAG_PASSWORD`). */
  flags: number;
}

/**
 * Screen-graph-only actionability bit layered above the Kotlin-synced
 * `utils/screen-hash` flags (bits 0..5). Set on an index entry the host knows to
 * be a password / secret field, so a node carrying one is redacted on persist
 * ("never persist text of nodes flagged password", design §6 / ticket B1).
 */
export const FLAG_PASSWORD = 1 << 6;

/** A `selectorKey` in a node's `index` — a stable string form of a selector. */
export type SelectorKey = string;

/**
 * The acted element's selector, recorded on the edge it produced (phase D §2).
 * Captured from the tree AT ACTION TIME so replay can re-resolve the element on
 * the live screen (exact resource-id / text, then content-description) instead of
 * replaying a bare coordinate that lands on an arbitrary sibling. `boundsBucket`
 * is the 1/16 grid cell of the tapped centre — the last-resort fallback used only
 * when no selector field resolved.
 */
export interface EdgeSelector {
  resourceId?: string;
  text?: string;
  contentDescription?: string;
  className?: string;
  indexInParent?: number;
  boundsBucket?: { x: number; y: number };
  /**
   * Which key was UNIQUE on the source tree at record time (phase D.1, Fix A),
   * so replay resolves with the same precedence and never taps a non-unique
   * resource-id (e.g. every Settings list row shares `android:id/title`):
   * `id` (resource-id unique among visible nodes), `text` (visible text / cd
   * unique), or `position` (neither unique — fall back to indexInParent +
   * boundsBucket under the parent). Absent on pre-D.1 edges.
   */
  via?: "id" | "text" | "position";
}

/** A screen: an identity fingerprint with its cached rendering and index. */
export interface ScreenNode {
  /**
   * The node's IDENTITY — the device screen-identity hash `H_id` (phase D §1):
   * stable across scroll/focus, distinct across sibling screens. (Before phase D
   * this was the structural hash `H`; the graph now keys on `H_id` so sibling
   * detail screens no longer collapse onto one node.) The field name stays `hash`
   * so the store/plan/navigate identity plumbing is unchanged.
   */
  hash: string;
  /**
   * The structural hash `H` (text-free, scroll-sensitive) most recently observed
   * for this identity. Diagnostic only — two `H` for one screen is the drift
   * `H_id` collapses. Absent on pre-phase-D nodes.
   */
  structuralHash?: string;
  /** epoch ms of first / most recent observation. */
  firstSeen: number;
  lastSeen: number;
  /** Number of times this screen was visited. */
  visits: number;
  /** Optional heuristic / human label (see `label.ts`). */
  label?: string;
  /**
   * Rendered compact describe captured when `compact` was last (re)built.
   * Empty when `redacted` (a secret was on screen). Served by the `compact`
   * describe tier while the device's `stateHash` still matches `stateHash`.
   */
  compact: string;
  /**
   * State hash `H_text` at the time `compact` was rendered — the cache-validity
   * token for the `compact` tier (design §2.2). Additive to the ticket's field
   * list; the compact-cache contract needs it. Documented in the report.
   */
  stateHash?: string;
  /**
   * Device AX version clock at the time `compact`/`stateHash` were captured
   * (Phase B leftover B1). Lets the compact tier's "only text changed" path ask
   * the device for `diff(sinceVersion = version)` — a keyed delta it can patch —
   * instead of re-reading the whole tree, and lets the live summary report
   * `changedSince` against the last-observed version.
   */
  version?: number;
  /** resource-id / text → last-known bounds + flags. */
  index: Record<SelectorKey, IndexEntry>;
  /**
   * The screen's resource-id MULTISET (one entry per node that carries a
   * resource-id, WITH repeats), captured when the node is (re)rendered. This is
   * the stable structural fingerprint the host uses to re-localize a live screen
   * whose exact structural hash `H` drifted between runs (Phase C.4, work item C):
   * the device `H` excludes text but is still perturbed by quantized-bounds
   * bucket crossings, the `focused` flag, the RecyclerView first-child rule and
   * volatile node insert/remove — none of which move the resource-id multiset by
   * much, so a Jaccard match on it recovers the node when `H` misses. Absent on
   * pre-C.4 nodes (a warm graph from before this field degrades to exact-hash).
   */
  resourceIds?: string[];
  /** Path to a stored thumbnail, when captured. */
  thumbnailPath?: string;
  /** `compact` text was dropped because the screen held a secret. */
  redacted?: boolean;
}

/** A transition: `action` took screen `from` to screen `to`. */
export interface Edge {
  from: string;
  action: CanonicalAction;
  to: string;
  /**
   * The acted element's selector at action time (phase D §2). Planning PREFERS an
   * edge that carries one; replay re-resolves it on the live screen. Absent on a
   * pure-coordinate edge (and on pre-phase-D graphs).
   */
  selector?: EdgeSelector;
  /** Times this (from, action) was observed. */
  count: number;
  /** Times it landed on `to` (used for the plan weight). */
  successes: number;
  /** epoch ms of the most recent observation (staleness). */
  lastSeen: number;
}

/** The persisted graph document for one `(packageName, versionCode)`. */
export interface ScreenGraphData {
  version: 1;
  packageName: string;
  versionCode: string;
  nodes: Record<string, ScreenNode>;
  edges: Edge[];
}

/** A plain selector the host matches against a node's `index`. */
export interface GraphSelector {
  id?: string;
  text?: string;
}

const US = String.fromCharCode(0x1f);

/** Stable index key for a resource-id. */
export function selectorKeyForId(id: string): SelectorKey {
  return `id${US}${id}`;
}

/** Stable index key for visible text. */
export function selectorKeyForText(text: string): SelectorKey {
  return `text${US}${text}`;
}

/** Reverse {@link selectorKeyForId} / {@link selectorKeyForText}. */
export function parseSelectorKey(key: SelectorKey): GraphSelector | null {
  const sep = key.indexOf(US);
  if (sep < 0) return null;
  const kind = key.slice(0, sep);
  const value = key.slice(sep + 1);
  if (value === "") return null;
  if (kind === "id") return { id: value };
  if (kind === "text") return { text: value };
  return null;
}

/**
 * The index keys a selector could match — id first (more specific), then text.
 * A node's `index` "contains the selector" (design §2.2, `planToSelector`) when
 * it holds any of these keys.
 */
export function selectorKeys(selector: GraphSelector): SelectorKey[] {
  const keys: SelectorKey[] = [];
  if (selector.id) keys.push(selectorKeyForId(selector.id));
  if (selector.text) keys.push(selectorKeyForText(selector.text));
  return keys;
}

/**
 * A stable string identity for an action, so an edge from a screen dedupes on
 * `(from, actionSignature)`. Two actions with the same signature are the same
 * edge; the plan weight aggregates over them.
 */
export function actionSignature(a: CanonicalAction): string {
  const parts: string[] = [a.kind];
  if (a.target?.id) parts.push(`id=${a.target.id}`);
  else if (a.target?.text) parts.push(`text=${a.target.text}`);
  else if (a.bucket) parts.push(`xy=${a.bucket.x},${a.bucket.y}`);
  if (a.dir) parts.push(`dir=${a.dir}`);
  if (a.key) parts.push(`key=${a.key}`);
  return parts.join(US);
}

/** A human-facing one-liner for an action, used in summaries and plans. */
export function actionLabel(a: CanonicalAction): string {
  switch (a.kind) {
    case "tap":
    case "longPress": {
      const verb = a.kind === "tap" ? "tap" : "long-press";
      if (a.target?.id) return `${verb} #${a.target.id}`;
      if (a.target?.text) return `${verb} "${a.target.text}"`;
      if (a.bucket) return `${verb} @${a.bucket.x},${a.bucket.y}`;
      return verb;
    }
    case "swipe":
      return `swipe ${a.dir ?? ""}`.trim();
    case "back":
      return "back";
    case "typeText":
      return a.target?.id ? `type #${a.target.id}` : a.target?.text ? `type "${a.target.text}"` : "type";
    case "key":
      return `key ${a.key ?? ""}`.trim();
  }
}
