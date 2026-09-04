/**
 * Screen-graph Phase B route planning (ticket B1 `plan.ts`, design §2.2 / §3):
 * Dijkstra over graph edges under the weight
 *   `w(e) = 1/(successes + 1) + staleness(days) / 30`
 * so a well-trodden, recent edge is cheap and a flaky or stale one is dear.
 */
import type { CanonicalAction, Edge, EdgeSelector, GraphSelector, ScreenNode } from "./types";
import { parseSelectorKey, selectorKeys } from "./types";

const MS_PER_DAY = 86_400_000;

/** Default Jaccard threshold for the resource-id fallback localizer (C.4 §C). */
export const DEFAULT_STABLE_MATCH_THRESHOLD = 0.9;

/**
 * Text that is volatile between otherwise-identical screen states: a clock, a
 * battery / signal percentage, a date, or a bare counter. Used only to DROP such
 * nodes' text when deriving a text-based signature — the structural hash `H`
 * already excludes text (see `ScreenHash.kt`), so this is documentation of what
 * `stable(H)` would exclude, not a re-hash. The resource-id multiset (which these
 * nodes share with their stable siblings) is the actual match key.
 */
export const VOLATILE_TEXT = /^\s*(?:\d{1,3}\s*%|\d{1,2}:\d{2}(?:\s*[ap]m)?|\d[\d.,]*\s*(?:%|min|hr|hrs|h|GB|MB|KB|B)?|[A-Z][a-z]{2}\s+\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*$/i;

/** True when `text` is purely volatile content (a clock, percentage, counter, date). */
export function isVolatileText(text: string): boolean {
  return VOLATILE_TEXT.test(text.trim());
}

/** The read surface `plan`/`planToSelector` need from a store or snapshot. */
export interface PlanGraph {
  edges: Edge[];
  nodes: Record<string, ScreenNode>;
}

/** One step of a plan: the action to take and the screen it should reach. */
export interface PlanStep {
  action: CanonicalAction;
  to: string;
  /** The acted element's recorded selector (phase D §2), for live re-resolution. */
  selector?: EdgeSelector;
}

export interface PlanResult {
  target: string;
  steps: PlanStep[];
}

export function edgeWeight(edge: Edge, now: number): number {
  const stalenessDays = Math.max(0, (now - edge.lastSeen) / MS_PER_DAY);
  return 1 / (edge.successes + 1) + stalenessDays / 30;
}

interface Adjacency {
  [from: string]: Edge[];
}

function buildAdjacency(edges: Edge[]): Adjacency {
  const adj: Adjacency = {};
  for (const e of edges) (adj[e.from] ??= []).push(e);
  return adj;
}

/**
 * Shortest known action path from `from` to any node in `targets`, or `null`
 * when none is reachable. Ties break on the target reached first in `targets`
 * order via a total cost + insertion order; the caller passes `targets` already
 * ordered by preference where that matters.
 */
function dijkstra(
  graph: PlanGraph,
  from: string,
  targets: Set<string>,
  now: number
): PlanResult | null {
  if (targets.has(from)) return { target: from, steps: [] };
  const adj = buildAdjacency(graph.edges);
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { node: string; edge: Edge }>();
  const visited = new Set<string>();
  // Small graphs — a linear-scan frontier is simpler than a heap and fast enough.
  const frontier = new Set<string>([from]);

  while (frontier.size > 0) {
    let current: string | null = null;
    let best = Infinity;
    for (const node of frontier) {
      const d = dist.get(node) ?? Infinity;
      if (d < best) {
        best = d;
        current = node;
      }
    }
    if (current === null) break;
    frontier.delete(current);
    if (visited.has(current)) continue;
    visited.add(current);

    if (targets.has(current) && current !== from) {
      return { target: current, steps: reconstruct(prev, current) };
    }

    for (const edge of adj[current] ?? []) {
      if (visited.has(edge.to)) continue;
      const nd = best + edgeWeight(edge, now);
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, { node: current, edge });
        frontier.add(edge.to);
      }
    }
  }
  return null;
}

function reconstruct(
  prev: Map<string, { node: string; edge: Edge }>,
  target: string
): PlanStep[] {
  const steps: PlanStep[] = [];
  let cur = target;
  while (prev.has(cur)) {
    const { node, edge } = prev.get(cur)!;
    steps.push({ action: edge.action, to: edge.to, ...(edge.selector ? { selector: edge.selector } : {}) });
    cur = node;
  }
  steps.reverse();
  return steps;
}

/** Shortest action path from screen `from` to screen `to`, or `null`. */
export function plan(
  graph: PlanGraph,
  from: string,
  to: string,
  now: number = Date.now()
): PlanResult | null {
  return dijkstra(graph, from, new Set([to]), now);
}

/**
 * Shortest action path from `from` to the nearest node whose `index` contains
 * `selector` (design §2.2 `planToSelector`), or `null` when unreachable.
 */
export function planToSelector(
  graph: PlanGraph,
  from: string,
  selector: GraphSelector,
  now: number = Date.now()
): PlanResult | null {
  const keys = selectorKeys(selector);
  if (keys.length === 0) return null;
  const targets = new Set<string>();
  for (const [hash, node] of Object.entries(graph.nodes)) {
    if (keys.some((k) => k in node.index)) targets.add(hash);
  }
  if (targets.size === 0) return null;
  return dijkstra(graph, from, targets, now);
}

/* -------------------------------------------------------------------------- */
/* stable (Jaccard) localization — C.4 work item C                            */
/* -------------------------------------------------------------------------- */

/** Multiplicity map of a string bag. */
function counts(xs: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

/**
 * Multiset Jaccard similarity of two string bags: `Σ min(count) / Σ max(count)`
 * over the union of distinct elements. 1 = identical multisets, 0 = disjoint.
 * Two empty bags are treated as fully dissimilar (0) so an empty live signature
 * never spuriously matches an empty node.
 */
export function multisetJaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const ca = counts(a);
  const cb = counts(b);
  let inter = 0;
  let uni = 0;
  for (const key of new Set([...ca.keys(), ...cb.keys()])) {
    const x = ca.get(key) ?? 0;
    const y = cb.get(key) ?? 0;
    inter += Math.min(x, y);
    uni += Math.max(x, y);
  }
  return uni === 0 ? 0 : inter / uni;
}

/**
 * A node's resource-id multiset: the stored `resourceIds` when present (C.4),
 * else derived from the node's index id-keys (one per distinct id — no repeats,
 * a lossy fallback for pre-C.4 nodes).
 */
export function nodeResourceIds(node: ScreenNode): string[] {
  if (node.resourceIds && node.resourceIds.length > 0) return node.resourceIds;
  const ids: string[] = [];
  for (const key of Object.keys(node.index)) {
    const sel = parseSelectorKey(key);
    if (sel?.id) ids.push(sel.id);
  }
  return ids;
}

export interface StableMatch {
  hash: string;
  score: number;
}

/**
 * The graph node whose resource-id multiset best matches `liveResourceIds`, when
 * that similarity is ≥ `threshold`. `null` when nothing clears the bar (or the
 * live signature is empty). Ties break on the higher `visits` (a more-established
 * node), then on the hash for determinism.
 */
export function bestNodeByResourceIds(
  graph: PlanGraph,
  liveResourceIds: readonly string[],
  threshold: number = DEFAULT_STABLE_MATCH_THRESHOLD
): StableMatch | null {
  if (liveResourceIds.length === 0) return null;
  let best: (StableMatch & { visits: number }) | null = null;
  for (const [hash, node] of Object.entries(graph.nodes)) {
    const score = multisetJaccard(liveResourceIds, nodeResourceIds(node));
    if (score < threshold) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && node.visits > best.visits) ||
      (score === best.score && node.visits === best.visits && hash < best.hash)
    ) {
      best = { hash, score, visits: node.visits };
    }
  }
  return best ? { hash: best.hash, score: best.score } : null;
}

/**
 * Resolve the graph node to plan FROM for a live screen: the exact `liveHash`
 * when it is already a node, else the best resource-id Jaccard match ≥ threshold,
 * else `liveHash` unchanged (so the caller still gets a deterministic — if
 * unrouteable — source). This is the fix for the C.3 "no route" failures: the
 * live Settings root drifts to a near-duplicate `H` between runs, scattering the
 * root→sub-screen edges across several root nodes; collapsing the live root onto
 * the established node recovers those edges.
 */
export function localizeFrom(
  graph: PlanGraph,
  liveHash: string,
  liveResourceIds: readonly string[],
  threshold: number = DEFAULT_STABLE_MATCH_THRESHOLD
): { hash: string; via: "exact" | "jaccard" | "none"; score?: number } {
  if (liveHash && graph.nodes[liveHash]) return { hash: liveHash, via: "exact" };
  const match = bestNodeByResourceIds(graph, liveResourceIds, threshold);
  if (match) return { hash: match.hash, via: "jaccard", score: match.score };
  return { hash: liveHash, via: "none" };
}

/** Case-insensitive test that a node's index holds a selector (id or text). */
export function nodeIndexesSelectorTolerant(node: ScreenNode, selector: GraphSelector): boolean {
  const wantId = selector.id?.toLowerCase();
  const wantText = selector.text?.toLowerCase();
  for (const key of Object.keys(node.index)) {
    const sel = parseSelectorKey(key);
    if (!sel) continue;
    if (wantId && sel.id && sel.id.toLowerCase() === wantId) return true;
    if (wantText && sel.text && sel.text.toLowerCase() === wantText) return true;
  }
  return false;
}

/**
 * Like {@link planToSelector} but (a) localizes the FROM screen through
 * {@link localizeFrom} — an exact hash when known, else a resource-id Jaccard
 * match — and (b) matches the target selector case-insensitively over every
 * node's index. Returns the plan plus how the source was localized, so the caller
 * can report `from` recovery. `null` when no node indexes the selector or no path
 * exists from the resolved source (C.4 work item C).
 */
export function planToSelectorStable(
  graph: PlanGraph,
  liveHash: string,
  liveResourceIds: readonly string[],
  selector: GraphSelector,
  now: number = Date.now(),
  threshold: number = DEFAULT_STABLE_MATCH_THRESHOLD
): (PlanResult & { fromVia: "exact" | "jaccard" | "none"; fromScore?: number }) | null {
  if (!selector.id && !selector.text) return null;
  const from = localizeFrom(graph, liveHash, liveResourceIds, threshold);
  const targets = new Set<string>();
  for (const [hash, node] of Object.entries(graph.nodes)) {
    if (nodeIndexesSelectorTolerant(node, selector)) targets.add(hash);
  }
  if (targets.size === 0) return null;
  const result = dijkstra(graph, from.hash, targets, now);
  if (!result) return null;
  return { ...result, fromVia: from.via, ...(from.score !== undefined ? { fromScore: from.score } : {}) };
}
