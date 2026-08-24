import type { StepStatus } from "./flow-run";

/**
 * Reading the verdict of a nested orchestrator step.
 *
 * `flow-execute` and `run-sequence` report what happened in their result
 * rather than by throwing, so the generic `tool` step counted a composed flow
 * that failed every step, or a sequence that stopped on its first tool, as a
 * pass (#606).
 *
 * Deliberately two named, tool-scoped branches rather than a general
 * "`ok: false` fails the step" rule: the generic `tool` step dispatches results
 * typed `unknown`, several carrying app-derived payloads, and a blanket rule
 * would bind all of them — and every tool added later — to "a key called `ok`
 * decides my flow's verdict". `isUnmetUiWaitResult` set the precedent for
 * naming the tool instead.
 *
 * Results cross the registry boundary as `unknown`: a shape not recognised
 * here falls through to the runner's existing behaviour rather than guessing a
 * verdict.
 */

export const FLOW_EXECUTE_TOOL_ID = "flow-execute";
export const RUN_SEQUENCE_TOOL_ID = "run-sequence";

export interface NestedOutcome {
  status: StepStatus;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstFailingStep(steps: unknown): string | undefined {
  if (!Array.isArray(steps)) return undefined;
  for (const entry of steps) {
    if (!isRecord(entry)) continue;
    if (entry.status !== "fail" && entry.status !== "error") continue;
    // Typed checks rather than coercion: this report crossed the registry
    // boundary as `unknown`, and an object here would render "[object Object]".
    const what =
      typeof entry.tool === "string"
        ? entry.tool
        : typeof entry.kind === "string"
          ? entry.kind
          : "step";
    const why = typeof entry.reason === "string" ? entry.reason : "no reason given";
    return `${what}: ${why}`;
  }
  return undefined;
}

function count(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** A nested `flow-execute` result: a run report, or a prerequisite notice. */
function flowExecuteOutcome(result: Record<string, unknown>): NestedOutcome | undefined {
  const flow = typeof result.flow === "string" ? result.flow : "the composed flow";

  // A notice means the sub-flow ran NOTHING: nothing was asserted, so this is
  // the runner's error class — never runnable as written, like an unreadable
  // fragment or a cyclic reference — not a failure.
  if (!("steps" in result) && typeof result.notice === "string") {
    const prerequisite =
      typeof result.executionPrerequisite === "string" && result.executionPrerequisite
        ? `: ${result.executionPrerequisite}`
        : "";
    return {
      status: "error",
      reason:
        `flow "${flow}" did not run — its execution prerequisite was not acknowledged${prerequisite}. ` +
        `Add prerequisiteAcknowledged: true to the step's args, or compose with run: instead.`,
    };
  }

  // Cancellation is a skip, never a failure — the rule the runner applies to
  // its own steps.
  //
  // `summarize` folds the abort into the verdict: `ok` is false whenever
  // `aborted` is set, so a composed step that FAILED and was then cancelled
  // reaches this branch, not the one below. Carry the failing step in `reason`
  // — the only string the RECORDER's refusal renders — or two identically
  // worded cancellations read the same.
  if (result.aborted === true) {
    const detail = firstFailingStep(result.steps);
    return {
      status: "skip",
      reason: `flow "${flow}" was aborted${detail ? ` (${detail})` : ""}`,
    };
  }

  if (result.ok === false) {
    const detail = firstFailingStep(result.steps);
    return {
      status: "fail",
      reason:
        `flow "${flow}" failed: ${count(result.passed)} passed, ${count(result.failed)} failed, ` +
        `${count(result.errored)} errored${detail ? ` (${detail})` : ""}`,
    };
  }

  return undefined;
}

/**
 * A nested `run-sequence` result.
 *
 * `run-sequence` has no verdict field: every failure path — a disallowed tool,
 * an unsupported operation, an unmet `await-ui-element`, a tool that threw —
 * pushes an `error` entry, breaks the loop, and returns normally.
 */
function runSequenceOutcome(result: Record<string, unknown>): NestedOutcome | undefined {
  const steps = result.steps;
  if (!Array.isArray(steps)) return undefined;

  // A nested step failed if it carries an `error` KEY. Success pushes
  // `{ tool, result }` and never sets one. Keyed on presence, not on a
  // non-empty message. A tool that throws `new Error("")` records `error: ""`,
  // and a skip there would score a failed step as a pass. An empty message is
  // named instead, so the report does not trail off after the colon.
  const failed = steps.find((s) => isRecord(s) && typeof s.error === "string");
  if (failed && isRecord(failed)) {
    const tool = typeof failed.tool === "string" ? failed.tool : "step";
    // Re-narrowed, not coerced: the proof from `find` does not survive into
    // `failed`, and a coerced object would render "[object Object]".
    const message = typeof failed.error === "string" ? failed.error : "";
    const why = message || "failed without an error message";
    return {
      status: "fail",
      reason:
        `run-sequence stopped at ${tool} after ${count(result.completed)} of ` +
        `${count(result.total)} steps: ${why}`,
    };
  }

  // No error entry but the sequence stopped short: its only other exit is the
  // abort check. Cancellation is a skip, matching flow-execute.
  const total = count(result.total);
  if (total > 0 && steps.length < total) {
    return {
      status: "skip",
      reason: `run-sequence was aborted after ${count(result.completed)} of ${total} steps`,
    };
  }

  return undefined;
}

/**
 * One list, so a caller asking only WHETHER a tool runs a nested flow — the
 * flow runner spends its tree-outage verdict on one — cannot drift from this
 * dispatch.
 */
const NESTED_ORCHESTRATORS = new Map<
  string,
  (result: Record<string, unknown>) => NestedOutcome | undefined
>([
  [FLOW_EXECUTE_TOOL_ID, flowExecuteOutcome],
  [RUN_SEQUENCE_TOOL_ID, runSequenceOutcome],
]);

/** Whether a `tool:` step runs other tools through a run of its own. */
export function isNestedOrchestratorTool(tool: string): boolean {
  return NESTED_ORCHESTRATORS.has(tool);
}

/**
 * Classify a nested orchestrator's result. `undefined` when this is not one of
 * them, when it succeeded, or when the shape is not recognised — the runner's
 * existing handling is correct in each case.
 */
export function nestedOrchestratorOutcome(
  tool: string,
  result: unknown
): NestedOutcome | undefined {
  if (!isRecord(result)) return undefined;
  return NESTED_ORCHESTRATORS.get(tool)?.(result);
}
