/**
 * Screen-graph phase D.3 (review D2-H3): resolve a UNIQUE node for a bench
 * selector from a set of query-result nodes, so a tap is never issued to
 * `nodes[0]` of an ambiguous set. `t("Internet")` used to match the collapsing
 * toolbar title "Network & internet" (contains) and tap it — a dead tap that
 * never reached the Internet screen. Whole-field EXACT wins first.
 *
 * Pure and device-free so the bench (`locateNorm`) and the pre-flight
 * (`execCaptureStep`) share one definition and the unit test drives it directly.
 */
import type { BenchSelector } from "./types";

/** The minimal query-result node shape the resolver reasons over. */
export interface QueryNodeLite {
  id?: string;
  text?: string;
  cd?: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
}

export interface PickResult {
  node?: QueryNodeLite;
  /** A resolution tier had >1 candidate and none was unique — do NOT tap. */
  ambiguous: boolean;
}

export const normLc = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * Resolve `sel` to exactly one node: EXACT resource-id, then EXACT text, then
 * EXACT contentDescription, then a CONTAINS match only when exactly one node
 * contains it. `{ node }` on a unique hit; `{ ambiguous: true }` when a tier had
 * >1; `{ ambiguous: false }` (no node) when nothing matched.
 */
export function pickUniqueNode(nodes: readonly QueryNodeLite[], sel: BenchSelector): PickResult {
  const wid = normLc(sel.id);
  const wt = normLc(sel.text);
  const uniq = (cands: QueryNodeLite[]): PickResult | null => {
    if (cands.length === 1) return { node: cands[0]!, ambiguous: false };
    if (cands.length > 1) return { ambiguous: true };
    return null;
  };
  if (wid) {
    const r = uniq(nodes.filter((n) => normLc(n.id) === wid));
    if (r) return r;
  }
  if (wt) {
    let r = uniq(nodes.filter((n) => normLc(n.text) === wt));
    if (r) return r;
    r = uniq(nodes.filter((n) => normLc(n.cd) === wt));
    if (r) return r;
    r = uniq(nodes.filter((n) => normLc(n.text).includes(wt) || normLc(n.cd).includes(wt)));
    if (r) return r;
  }
  return { ambiguous: false };
}
