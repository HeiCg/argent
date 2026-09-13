/**
 * Screen-graph Phase B `navigate-to` executor (ticket B2, design §2.2). Runs a
 * planned path step by step through the caller's action executor, verifying the
 * device's `after` structural hash against the plan's expected screen at each
 * step. On divergence it stops and reports where.
 */
import type { CanonicalAction } from "./types";
import type { PlanStep } from "./plan";

/** Outcome of executing one action on the device. */
export interface StepOutcome {
  afterHash: string;
  /**
   * Live resource-id multiset of the screen the action landed on (C.4 work item
   * C). Supplied so a tolerant `matches` can accept an arrival whose exact
   * structural hash drifted from the recorded one — the same instability that
   * scattered the root nodes also perturbs the sub-screen hash.
   */
  afterResourceIds?: string[];
}

export interface NavigateDeps {
  /** Perform one action and return the resulting screen's structural hash. */
  execute: (action: CanonicalAction, step: PlanStep) => Promise<StepOutcome>;
  /**
   * Whether an executed step reached its planned screen. Defaults to exact
   * structural-hash equality (`outcome.afterHash === step.to`). The navigate-to
   * tool passes a tolerant check (exact hash OR a resource-id Jaccard match
   * against the recorded node) so a drifted-but-equivalent screen still counts as
   * reached (C.4 work item C — `runNavigation` used to verify text-free `H`
   * exactly, which failed on any hash drift even when the tap landed correctly).
   */
  matches?: (step: PlanStep, outcome: StepOutcome) => boolean;
}

export interface NavigateDivergence {
  /** 1-based index of the step whose result did not match the plan. */
  reachedStep: number;
  expected: string;
  actual: string;
}

export interface NavigateResult {
  ok: boolean;
  /** Number of steps that landed on their expected screen. */
  completedSteps: number;
  /** Final structural hash reached. */
  finalHash: string;
  divergence?: NavigateDivergence;
}

/**
 * Execute `steps` in order, verifying each step's `after.hash` equals the
 * planned `to`. Stops at the first divergence.
 */
export async function runNavigation(
  fromHash: string,
  steps: PlanStep[],
  deps: NavigateDeps
): Promise<NavigateResult> {
  let finalHash = fromHash;
  let completed = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const outcome = await deps.execute(step.action, step);
    finalHash = outcome.afterHash;
    const reached = deps.matches ? deps.matches(step, outcome) : outcome.afterHash === step.to;
    if (!reached) {
      return {
        ok: false,
        completedSteps: completed,
        finalHash,
        divergence: { reachedStep: i + 1, expected: step.to, actual: outcome.afterHash },
      };
    }
    completed += 1;
  }
  return { ok: true, completedSteps: completed, finalHash };
}
