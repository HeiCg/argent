/**
 * Screen-graph Phase B describe tiers (ticket B2, design §2.2 / §2.3).
 *
 * - `summary`: `{screen, visits, affordances, changedSince?, reachable?}` — the
 *   label (or hash8), visit count, the top-N outgoing edges with their targets'
 *   labels, and (when the caller passes the graph edges) up to 8 screens
 *   `navigate-to` can reach from here (address, label cut to 40 characters,
 *   hops). With that list, an edge to another screen (a 1-hop destination) is
 *   not an affordance.
 *   ≤ ~100 tokens without the list, ≤ ~200 with it.
 * - `compact`: served from the node's cached rendering when the device
 *   `stateHash` still matches; patched from a device `diff` when only text
 *   changed (structural `hash` unchanged); refreshed otherwise. Cache validity
 *   is the device hash, not time.
 */
import type { Edge, ScreenNode } from "./types";
import { actionLabel, isNodeVolatile } from "./types";
import { reachableScreens, screenAddress } from "./plan";

/** Short display id for a screen with no label. */
export function hash8(hash: string): string {
  return hash.slice(0, 8);
}

/** Longest screen label a summary line prints; a longer one ends with `…`. */
export const MAX_REACHABLE_LABEL = 40;

function cutLabel(label: string): string {
  return label.length <= MAX_REACHABLE_LABEL
    ? label
    : `${label.slice(0, MAX_REACHABLE_LABEL - 1)}…`;
}

/** Short display id for a template identity (4 hex nibbles). */
function tpl4(hash: string): string {
  return hash.slice(0, 4);
}

interface SummaryAffordance {
  action: string;
  to: string;
  count: number;
}

interface ScreenSummary {
  screen: string;
  visits: number;
  affordances: SummaryAffordance[];
  /** Number of changed fields vs the last visit, when `stateHash` differs. */
  changedSince?: number;
  /**
   * Phase E (design D1/D2 R4): the screen is a live-content container — its
   * `stateHash` churns while its `H_id` holds. Rendered as a `volatile` line so
   * the agent knows the cached content is not reused across visits.
   */
  volatile?: boolean;
  /**
   * Screens reachable from this one (nearest first), each with the address
   * `navigate-to` takes as `target.screen` (the hash8, longer only on a prefix
   * collision). Absent when nothing is reachable.
   */
  reachable?: Array<{ address: string; label?: string; hops: number }>;
}

interface SummaryOptions {
  /** Max affordances to list. */
  topN?: number;
  /** Changed-field count vs last visit (present only when it differs). */
  changedSince?: number;
  /** Every graph edge, for the reachable-screens list. */
  edges?: Edge[];
}

const DEFAULT_TOP_N = 6;

function screenName(node: ScreenNode): string {
  return node.label ?? hash8(node.hash);
}

/** Build the structured summary for a node from its outgoing edges. */
export function buildSummary(
  node: ScreenNode,
  outgoing: Edge[],
  nodes: Record<string, ScreenNode>,
  opts: SummaryOptions = {}
): ScreenSummary {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const reachable: NonNullable<ScreenSummary["reachable"]> = [];
  if (opts.edges && opts.edges.length > 0) {
    const graph = { edges: opts.edges, nodes };
    for (const r of reachableScreens(graph, node.hash)) {
      reachable.push({
        address: screenAddress(graph, r.hash),
        hops: r.hops,
        ...(r.label !== undefined ? { label: r.label } : {}),
      });
    }
  }
  // With a reachable list, a plain edge to another screen is a 1-hop
  // destination: listed there, or past the list's cap and reachable by its
  // label. Leave every one out so the tier stays within ~200 tokens however many
  // destinations the screen has; self-loops and template edges stay.
  const oneHop = (e: Edge): boolean =>
    !e.template && e.to !== node.hash && nodes[e.to]?.template !== true;
  const affordances = [...outgoing]
    .filter((e) => reachable.length === 0 || !oneHop(e))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
    .map((e) => ({
      action: templateAffordanceLabel(e) ?? actionLabel(e.action),
      to: nodes[e.to] ? screenName(nodes[e.to]!) : hash8(e.to),
      count: e.count,
    }));
  const summary: ScreenSummary = {
    screen: screenName(node),
    visits: node.visits,
    affordances,
  };
  if (opts.changedSince !== undefined) summary.changedSince = opts.changedSince;
  // Phase E: flag a live-content container so the agent does not trust cached text.
  if (isNodeVolatile(node)) summary.volatile = true;
  if (reachable.length > 0) summary.reachable = reachable;
  return summary;
}

/**
 * Phase E (design D1): the summary line for a TEMPLATE edge — one line per
 * (container, template) instead of up to six arbitrary item titles. `count` is
 * the total item taps seen through the container; `instances` the distinct
 * concrete destinations folded (the number that matters). Returns `undefined`
 * for an ordinary edge (the caller then uses `actionLabel`).
 */
function templateAffordanceLabel(e: Edge): string | undefined {
  const t = e.template;
  if (!t) return undefined;
  const where = t.containerId ? `#${t.containerId}` : `#${tpl4(t.containerKey)}`;
  return `tap item[*] in ${where} (tpl ${tpl4(t.itemTemplate)}, ${e.count} seen, ${t.instances} instances)`;
}

/** Render a {@link ScreenSummary} to terse text (the ≤ ~100 token tier). */
export function renderSummary(summary: ScreenSummary): string {
  const lines: string[] = [`screen: ${summary.screen}  visits: ${summary.visits}`];
  if (summary.affordances.length > 0) {
    lines.push("affordances:");
    for (const a of summary.affordances) {
      lines.push(`- ${a.action} -> ${cutLabel(a.to)} (${a.count})`);
    }
  } else if (!summary.reachable) {
    lines.push("affordances: (none known)");
  }
  if (summary.changedSince !== undefined) {
    lines.push(`changedSince: ${summary.changedSince} field(s)`);
  }
  if (summary.volatile) {
    lines.push("volatile: content changes every visit");
  }
  if (summary.reachable) {
    lines.push("reachable screens:");
    for (const r of summary.reachable) {
      const hops = `(${r.hops} ${r.hops === 1 ? "hop" : "hops"})`;
      lines.push(
        r.label ? `- ${r.address}  ${cutLabel(r.label)}  ${hops}` : `- ${r.address}  ${hops}`
      );
    }
  }
  return lines.join("\n");
}

type CompactTierMode = "cache" | "patch" | "refresh";

interface CompactTierResult {
  text: string;
  mode: CompactTierMode;
}

/** The current device fingerprints the compact tier reconciles against. */
interface CurrentFingerprint {
  hash: string;
  stateHash: string;
}

/**
 * Deps for {@link resolveCompactTier}. `patch` is only called on the "only text
 * changed" path (structural `hash` unchanged, `stateHash` differs); `refresh`
 * on a structural change. Neither is called on a cache hit.
 */
export interface CompactTierDeps {
  /** Patch the cached rendering from a device `diff` (cheap). */
  patch: () => Promise<string>;
  /** Re-read + re-render the screen (cold). */
  refresh: () => Promise<string>;
}

/**
 * Resolve the `compact` describe tier against the current device fingerprint:
 *  - `stateHash` matches the node's and the cached text is not empty → serve
 *    the cache (no client call);
 *  - structural `hash` matches but `stateHash` differs → `patch` from a diff;
 *  - otherwise → `refresh`.
 */
export async function resolveCompactTier(
  node: ScreenNode,
  current: CurrentFingerprint,
  deps: CompactTierDeps
): Promise<CompactTierResult> {
  // An empty `compact` is never served: a volatile node is persisted without it
  // (store R4a) while it keeps its stateHash, so a match would serve "".
  if (
    node.stateHash !== undefined &&
    node.stateHash === current.stateHash &&
    !node.redacted &&
    node.compact !== ""
  ) {
    return { text: node.compact, mode: "cache" };
  }
  if (node.hash === current.hash && node.stateHash !== undefined && !node.redacted) {
    return { text: await deps.patch(), mode: "patch" };
  }
  return { text: await deps.refresh(), mode: "refresh" };
}
