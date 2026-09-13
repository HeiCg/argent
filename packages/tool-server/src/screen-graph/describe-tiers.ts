/**
 * Screen-graph Phase B describe tiers (ticket B2, design §2.2 / §2.3).
 *
 * - `summary`: `{screen, visits, affordances, changedSince?}` rendered to ≤ ~100
 *   tokens — the label (or hash8), visit count, and the top-N outgoing edges
 *   with their targets' labels.
 * - `compact`: served from the node's cached rendering when the device
 *   `stateHash` still matches; patched from a device `diff` when only text
 *   changed (structural `hash` unchanged); refreshed otherwise. Cache validity
 *   is the device hash, not time.
 */
import type { Edge, ScreenNode } from "./types";
import { actionLabel } from "./types";

/** Short display id for a screen with no label. */
export function hash8(hash: string): string {
  return hash.slice(0, 8);
}

export interface SummaryAffordance {
  action: string;
  to: string;
  count: number;
}

export interface ScreenSummary {
  screen: string;
  visits: number;
  affordances: SummaryAffordance[];
  /** Number of changed fields vs the last visit, when `stateHash` differs. */
  changedSince?: number;
}

export interface SummaryOptions {
  /** Max affordances to list. */
  topN?: number;
  /** Changed-field count vs last visit (present only when it differs). */
  changedSince?: number;
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
  const affordances = [...outgoing]
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
    .map((e) => ({
      action: actionLabel(e.action),
      to: nodes[e.to] ? screenName(nodes[e.to]!) : hash8(e.to),
      count: e.count,
    }));
  const summary: ScreenSummary = {
    screen: screenName(node),
    visits: node.visits,
    affordances,
  };
  if (opts.changedSince !== undefined) summary.changedSince = opts.changedSince;
  return summary;
}

/** Render a {@link ScreenSummary} to terse text (the ≤ ~100 token tier). */
export function renderSummary(summary: ScreenSummary): string {
  const lines: string[] = [`screen: ${summary.screen}  visits: ${summary.visits}`];
  if (summary.affordances.length > 0) {
    lines.push("affordances:");
    for (const a of summary.affordances) lines.push(`- ${a.action} -> ${a.to} (${a.count})`);
  } else {
    lines.push("affordances: (none known)");
  }
  if (summary.changedSince !== undefined) {
    lines.push(`changedSince: ${summary.changedSince} field(s)`);
  }
  return lines.join("\n");
}

/** Convenience: build + render in one call. */
export function renderSummaryFor(
  node: ScreenNode,
  outgoing: Edge[],
  nodes: Record<string, ScreenNode>,
  opts: SummaryOptions = {}
): string {
  return renderSummary(buildSummary(node, outgoing, nodes, opts));
}

export type CompactTierMode = "cache" | "patch" | "refresh";

export interface CompactTierResult {
  text: string;
  mode: CompactTierMode;
}

/** The current device fingerprints the compact tier reconciles against. */
export interface CurrentFingerprint {
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
 *  - `stateHash` matches the node's → serve the cache (no client call);
 *  - structural `hash` matches but `stateHash` differs → `patch` from a diff;
 *  - otherwise → `refresh`.
 */
export async function resolveCompactTier(
  node: ScreenNode,
  current: CurrentFingerprint,
  deps: CompactTierDeps
): Promise<CompactTierResult> {
  if (node.stateHash !== undefined && node.stateHash === current.stateHash && !node.redacted) {
    return { text: node.compact, mode: "cache" };
  }
  if (node.hash === current.hash && node.stateHash !== undefined && !node.redacted) {
    return { text: await deps.patch(), mode: "patch" };
  }
  return { text: await deps.refresh(), mode: "refresh" };
}
