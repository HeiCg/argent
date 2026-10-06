/**
 * Screen-graph bench — infrastructure validity gate (fail-closed on a lost emulator).
 *
 * Run 37215518035: the emulator died during B2, every later config "aborted after 3
 * consecutive task errors" with 0/3 scored, and the job still concluded SUCCESS. A
 * config whose task-runs were cut short or excluded for an INFRASTRUCTURE reason
 * (device not found, open-server init failure, the watchdog terminating the run) has
 * no success rate: it is INVALID, the report says so, and the harness exits non-zero.
 *
 * Only infrastructure invalidates. A locate/action/oracle failure that follows the
 * config's own navigation keeps its meaning (a failure counted against the config,
 * see oracle.ts `accountSuccess`); the B1 describe-fallback flag, the warm-store note
 * and the documented "proprietary binaries unavailable" skip are unchanged.
 */

/** The results-markdown label for an invalidated config. */
export const INVALID_LABEL = "INVALID (emulator lost)";

/** The marker the CI watchdog writes (`.github/bench-ci/emulator-diagnostics.js`). */
export interface EmulatorLostMarker {
  lostAt: string;
  reason?: string;
  context?: string | null;
}

interface ValidityAgg {
  config: string;
  /** all task-runs recorded for the config. */
  total: number;
  /** task-runs judged by the oracle (total − excluded). */
  scored: number;
  /** task-runs excluded as pre-action infrastructure faults (`infraPreAction`). */
  excluded: number;
}

export interface ConfigValidity {
  config: string;
  reason: string;
}

const ABORT_RE = /^aborted after \d+ consecutive task errors/;
const INTERRUPTED_RE = /^(?:interrupted|not run):/;

/** reps × tasks from the run's env block, or null when either is unknown. */
export function plannedTaskRuns(env: Record<string, unknown> | undefined): number | null {
  const reps = Number(env?.reps);
  const tasks = Number(env?.tasks);
  return Number.isFinite(reps) && Number.isFinite(tasks) && reps > 0 && tasks > 0
    ? reps * tasks
    : null;
}

/** `skipped[config]` for the config the watchdog interrupted mid-run. */
export function interruptedSkip(
  lost: EmulatorLostMarker | null,
  nowIso = new Date().toISOString()
): string {
  return lost
    ? `interrupted: emulator lost at ${lost.lostAt}${lost.reason ? ` (${lost.reason})` : ""}`
    : `interrupted: SIGTERM at ${nowIso} (no emulator-lost marker)`;
}

/** `skipped[config]` for a config that never started because the run was interrupted. */
export function notRunSkip(
  lost: EmulatorLostMarker | null,
  nowIso = new Date().toISOString()
): string {
  return lost ? `not run: emulator lost at ${lost.lostAt}` : `not run: SIGTERM at ${nowIso}`;
}

/**
 * The configs with no valid success rate, in aggregate order then skipped-only
 * order. A config is INVALID when it was aborted after consecutive task errors,
 * when any of its task-runs was excluded as a pre-action infra fault, when it ran
 * fewer task-runs than planned, or when the run was interrupted during/before it.
 */
export function invalidConfigs(input: {
  aggregates: ValidityAgg[];
  skipped: Record<string, string>;
  planned: number | null;
}): ConfigValidity[] {
  const { aggregates, skipped, planned } = input;
  const out: ConfigValidity[] = [];
  const seen = new Set<string>();
  for (const a of aggregates) {
    seen.add(a.config);
    const skip = skipped[a.config];
    const reasons: string[] = [];
    if (skip && (ABORT_RE.test(skip) || INTERRUPTED_RE.test(skip))) reasons.push(skip);
    if (a.excluded > 0) {
      reasons.push(
        `${a.excluded} run(s) excluded as pre-action infrastructure faults ` +
          `(scored ${a.scored}/${planned ?? a.total})`
      );
    }
    if (planned !== null && a.total < planned) {
      reasons.push(`ran ${a.total}/${planned} planned task-runs`);
    }
    if (reasons.length) out.push({ config: a.config, reason: reasons.join("; ") });
  }
  for (const [config, skip] of Object.entries(skipped)) {
    if (!seen.has(config) && INTERRUPTED_RE.test(skip)) out.push({ config, reason: skip });
  }
  return out;
}

export function validityExitCode(invalid: ConfigValidity[]): 0 | 1 {
  return invalid.length > 0 ? 1 : 0;
}
