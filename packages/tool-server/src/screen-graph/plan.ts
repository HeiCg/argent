/**
 * Screen-graph Phase B route planning (ticket B1 `plan.ts`, design §2.2 / §3):
 * Dijkstra over graph edges under the weight
 *   `w(e) = 1/(successes + 1) + staleness(days) / 30`
 * so a well-trodden, recent edge is cheap and a flaky or stale one is dear.
 */
import type { CanonicalAction, Edge, GraphSelector, ScreenNode } from "./types";
import { selectorKeys } from "./types";

const MS_PER_DAY = 86_400_000;

/** The read surface `plan`/`planToSelector` need from a store or snapshot. */
export interface PlanGraph {
  edges: Edge[];
  nodes: Record<string, ScreenNode>;
}

/** One step of a plan: the action to take and the screen it should reach. */
export interface PlanStep {
  action: CanonicalAction;
  to: string;
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
    steps.push({ action: edge.action, to: edge.to });
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
