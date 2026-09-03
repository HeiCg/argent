/**
 * Screen-graph Phase C.4 — the per-step OBSERVATION selector (work item D).
 *
 * The C.3 harness fed `task.assertion` (the success oracle's needle) as the
 * `query` selector on every NON-tap step, so O1/O2 per-step tokens moved whenever
 * a needle changed — the metric was coupled to the oracle (review C-H5:
 * `swipe 22→48, back 38→1, type 184→1, tapXY 133→41` between C.2 and C.3 with
 * identical tier code). This pure function decides which selector a step observes
 * WITHOUT ever consulting `task.assertion`, so tokens/step are needle-independent
 * and stay comparable across needle changes.
 *
 * Rule:
 *  - a `tap` / `type` step observes its OWN action target (the element it acts on);
 *  - every other step (`swipe` / `back` / `tapXY` / `launch`) observes the task's
 *    declared `query` anchor, else the task's FIRST tap selector, else an app-level
 *    anchor. None of these is the assertion needle.
 */
import type { BenchSelector, BenchStep, BenchTask } from "./types";

/** App-level fallback anchor when a task declares neither `query` nor a tap. */
function appAnchor(task: BenchTask): BenchSelector {
  return { text: task.app === "chrome" ? "Example" : "Settings" };
}

/**
 * The selector a step's observation queries. Pure and independent of
 * `task.assertion`; see the module header for the rule.
 */
export function observationQuery(task: BenchTask, step: BenchStep): BenchSelector {
  const a = step.action;
  if (a.kind === "tap" || a.kind === "type") return a.selector;
  if (task.query) return task.query;
  const firstTap = task.steps.find((s) => s.action.kind === "tap");
  if (firstTap && firstTap.action.kind === "tap") return firstTap.action.selector;
  return appAnchor(task);
}
