/**
 * Screen-graph Phase C.1 — the ONE success oracle + success/locate accounting
 * (ticket `2026-09-03-screen-graph-phase-c1-oracle.md` §3 + §2).
 *
 * The oracle is a PURE function over the nodes an on-device `query` returns, so
 * every config (B1 included) is judged by the identical rule and H4 compares
 * like with like. The device-facing runner in `scripts/bench-screen-graph.ts`
 * fetches the nodes (for B1 via an instrumentation switch, off the metric path)
 * and calls in here.
 *
 * Matching rule (deliberately stricter/clearer than the server's `query`, whose
 * Kotlin `ScreenSelector` folds only case and matches `text` ONLY — never
 * content-description): a needle is PRESENT when it appears, case-insensitively,
 * as a substring of the `text` OR the `contentDescription` of a VISIBLE node.
 * We log which field carried it. Visibility is decided from geometry (bounds on
 * screen, positive area) rather than trusting a server visibility flag, so a
 * scrolled-away node does not count.
 */

export interface OracleBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The subset of an open-server compact node the oracle reads. */
export interface OracleNode {
  id?: string;
  text?: string;
  /** content-description (open-server compact field `cd`). */
  cd?: string;
  bounds?: OracleBounds;
  /** explicit visibility when the source knows it; else derived from bounds. */
  visible?: boolean;
}

/** One matched node, persisted in the JSON as evidence for every assertion. */
export interface AssertionMatch {
  text: string;
  id: string;
  bounds: OracleBounds | null;
  /** which field carried the needle. */
  field: "text" | "contentDescription";
}

export interface OracleResult {
  matched: boolean;
  matches: AssertionMatch[];
}

export interface OracleOptions {
  /** `contains` (default, substring) or `equals` (whole-field) matching. */
  mode?: "contains" | "equals";
  /**
   * Screen geometry used to decide visibility from bounds when a node carries no
   * explicit `visible`. A node whose bounds fall entirely off this rect is not
   * visible. Omit to skip the on-screen check (geometry area check still runs).
   */
  screen?: { width: number; height: number };
}

/**
 * A node counts as visible when it is not explicitly hidden, has bounds of
 * positive area, and (when a screen size is given) at least partially overlaps
 * the screen rect. A node with no bounds is visible only if it says so.
 */
export function isVisibleNode(n: OracleNode, screen?: { width: number; height: number }): boolean {
  if (n.visible === false) return false;
  const b = n.bounds;
  if (!b) return n.visible === true;
  const area = (b.x2 - b.x1) * (b.y2 - b.y1);
  if (area <= 0) return false;
  if (screen) {
    if (b.x2 <= 0 || b.y2 <= 0 || b.x1 >= screen.width || b.y1 >= screen.height) return false;
  }
  return true;
}

function fieldHolds(value: string, needleLc: string, mode: "contains" | "equals"): boolean {
  const hay = value.toLowerCase();
  return mode === "equals" ? hay === needleLc : hay.includes(needleLc);
}

/**
 * Evaluate the success oracle for one needle over the current screen's nodes.
 * Case-insensitive; matches `text` first, else `contentDescription`; only over
 * VISIBLE nodes. Returns every match (with the field that carried the needle) so
 * the harness can persist the evidence.
 */
export function evaluateAssertion(
  nodes: OracleNode[],
  needle: string,
  opts: OracleOptions = {}
): OracleResult {
  const mode = opts.mode ?? "contains";
  const needleLc = needle.trim().toLowerCase();
  if (needleLc.length === 0) return { matched: false, matches: [] };
  const matches: AssertionMatch[] = [];
  for (const n of nodes) {
    if (!isVisibleNode(n, opts.screen)) continue;
    const text = n.text ?? "";
    const cd = n.cd ?? "";
    let field: "text" | "contentDescription" | null = null;
    if (fieldHolds(text, needleLc, mode)) field = "text";
    else if (fieldHolds(cd, needleLc, mode)) field = "contentDescription";
    if (field) {
      matches.push({ text, id: n.id ?? "", bounds: n.bounds ?? null, field });
    }
  }
  return { matched: matches.length > 0, matches };
}

/* -------------------------------------------------------------------------- */
/* success / locate accounting                                                */
/* -------------------------------------------------------------------------- */

/** The minimal per-run shape the accounting reads. */
export interface AccountableRun {
  success: boolean;
  /** the task was aborted because a tap target could not be located. */
  locateFailed?: boolean;
  /** an action (tap/gesture) tool call failed mid-task — the run is invalid. */
  actionFailed?: boolean;
  /** the success oracle itself could not be read (open query / B1 switch threw). */
  oracleError?: boolean;
  /** the task threw before producing a usable record (backend down, etc.). */
  taskError?: boolean;
}

/**
 * A run is EXCLUDED from the success denominator when any plumbing/infra reason
 * prevented an honest oracle judgement (ticket §2 + review MEDIUM-7/8): a failed
 * locate, a failed action, an oracle read error, or a task-level throw. Such a
 * run is never counted as a success even if a stale `success:true` rides along.
 */
export function isExcludedRun(r: AccountableRun): boolean {
  return Boolean(r.locateFailed || r.actionFailed || r.oracleError || r.taskError);
}

export interface SuccessAccount {
  /** all task-runs for the config. */
  total: number;
  /** runs actually judged by the oracle (`total - excluded`). */
  scored: number;
  /** successful runs among the scored. */
  ok: number;
  /** `ok / scored`, or 0 when nothing was scored. */
  successRate: number;
  /** total excluded runs. */
  excluded: number;
  locateFailed: number;
  actionFailed: number;
  oracleError: number;
  taskError: number;
}

/**
 * Success rate over the runs that actually reached the oracle: every plumbing/
 * infra failure is counted separately and removed from the denominator (ticket
 * §2, review MEDIUM-7/8). An all-excluded config scores 0 over 0 scored runs.
 */
export function accountSuccess(records: AccountableRun[]): SuccessAccount {
  const total = records.length;
  const locateFailed = records.filter((r) => r.locateFailed).length;
  const actionFailed = records.filter((r) => r.actionFailed).length;
  const oracleError = records.filter((r) => r.oracleError).length;
  const taskError = records.filter((r) => r.taskError).length;
  const excluded = records.filter(isExcludedRun).length;
  const scored = total - excluded;
  const ok = records.filter((r) => !isExcludedRun(r) && r.success).length;
  return {
    total,
    scored,
    ok,
    successRate: scored ? Number((ok / scored).toFixed(3)) : 0,
    excluded,
    locateFailed,
    actionFailed,
    oracleError,
    taskError,
  };
}
