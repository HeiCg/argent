/**
 * Screen-graph bench PRE-FLIGHT verdict (phase C.3 §1).
 *
 * The PURE decision the pre-flight uses to gate the matrix: it turns the
 * needle-vs-launch-screen evaluation `scripts/bench-preflight.ts` produces into a
 * boolean `ok` plus the offending rows. Kept device-free (no adb, no server) so
 * the unit test drives it directly and the script sets its process exit code from
 * it — the whole point of C.3 is that a non-zero `PROBLEM needles` count MUST
 * fail the pre-flight step (and, with `set -o pipefail` in the workflow, stop the
 * matrix from running on a false-passing needle set).
 */

/**
 * One row of the pre-flight's needle evaluation. Only `task` and `verdict` are
 * load-bearing here; the rest travels for the human summary + the fixture the
 * BLOCKER-1 test reads. A row is a PROBLEM when its verdict begins with `BAD`
 * (a needle already on the launch screen a navigating task leaves — a missed tap
 * would false-pass) or `MISSING` (a launch-only task whose needle is not on the
 * screen at all).
 */
export interface NeedleEvalRow {
  task: string;
  app?: string;
  needle?: string;
  navigates?: boolean;
  matchesLaunch?: boolean;
  launchMatchText?: string;
  verdict: string;
}

export interface PreflightVerdict {
  /** True only when NO row is a PROBLEM (BAD or MISSING). */
  ok: boolean;
  /** One `"<task>: <verdict>"` line per PROBLEM needle, in input order. */
  problems: string[];
}

/**
 * A row is a PROBLEM when its verdict is `BAD …` or `MISSING …`. Leading
 * whitespace (the summary prefixes offenders with a marker) is tolerated so the
 * classifier is robust to how the row was rendered.
 */
export function isProblemVerdict(verdict: string): boolean {
  const v = (verdict ?? "").trimStart();
  // Phase D.2 L1: an UNVERIFIED navigating task (destination unreachable in
  // pre-flight, so needle presence could not be confirmed) is a gate PROBLEM —
  // it is no longer silently reported as "ok".
  return v.startsWith("BAD") || v.startsWith("MISSING") || v.startsWith("UNVERIFIED");
}

/**
 * `ok` is true iff every needle is destination-unique / present as required.
 * `problems` names each offending task with its verdict so the caller can print
 * them and exit non-zero.
 */
export function preflightVerdict(needleEval: readonly NeedleEvalRow[]): PreflightVerdict {
  const problems = needleEval
    .filter((e) => isProblemVerdict(e.verdict))
    .map((e) => `${e.task}: ${e.verdict}`);
  return { ok: problems.length === 0, problems };
}
