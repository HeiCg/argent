import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import {
  requireRecordingSession,
  clearRecordingSession,
  withFlowFileLock,
  clientFileDirective,
  parseFlow,
  serializeFlow,
  selectorToYaml,
  type FlowFile,
  type FlowStep,
  type FlowSavedTo,
  type FlowSelector,
  type RecordedStepWarning,
  type RecordingSession,
} from "./flow-utils";
import type { TextMatchMode } from "../../utils/ui-tree-match";

// Quote selectors in the step summary the way the flow FILE spells them
// (`id`, bare string for loose, no internal `loose` flag) — the summary is what
// gets read before hand-editing the YAML, so the spellings must agree.
function selectorLabel(sel: FlowSelector): string {
  return JSON.stringify(selectorToYaml(sel));
}

// Render a text condition for the summary, one spelling for every step kind
// that carries one (await/assert/when): the comparator is preserved — regex
// patterns as `matches /…/`, exact text as `== "…"`, substrings as
// `contains "…"` — and literals use JSON quoting so embedded quotes and
// control characters stay unambiguous.
function textConditionLabel(
  sel: FlowSelector,
  expectedText: string | undefined,
  textMatch: TextMatchMode | undefined
): string {
  const selector = selectorLabel(sel);
  const expected = expectedText ?? "";
  return textMatch === "matches"
    ? `text ${selector} matches /${expected}/`
    : textMatch === "equals"
      ? `text ${selector} == ${JSON.stringify(expected)}`
      : `text ${selector} contains ${JSON.stringify(expected)}`;
}

const zodSchema = z.object({
  name: z
    .string()
    .describe("Name of the flow being recorded — the one passed to flow-start-recording."),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root of the flow being recorded — the same value passed to flow-start-recording. Together with `name` it identifies which recording to finish."
    ),
});

/**
 * Fold each recorded step's cross-tree verdict into its own summary line.
 *
 * The probe raises that verdict on one step's `message`, but what it answers —
 * "is this wait safe to convert to `await:`/`assert:`?" — is a POLISH-time
 * question, and polish begins here. Without this, a warning raised at step 7 of
 * a 40-step recording has scrolled out of reach by the time it is actionable,
 * and no artifact carries it: the finish payload never mentioned it and
 * `summarizeStep` renders the step as a bare `7. tool: await-ui-element {json}`.
 *
 * On its own line rather than appended to the step text: the verdict runs to
 * paragraphs, and running it into the step line would bury the step it belongs
 * to. That line is its own ARRAY ELEMENT, not a newline inside the step's:
 * `flow-finish-recording` has no bespoke MCP renderer, so its result reaches
 * the agent through `JSON.stringify(value, null, 2)` — where an embedded
 * newline is escaped and the verdict arrives inside one long string, which is
 * the opposite of what a separate line is for. One element per line is what
 * that renderer actually prints on its own line. The indent and the `warning:`
 * prefix keep it attached to the step above it, whose own line still opens with
 * its number.
 *
 * Which verdicts survive to be folded in is {@link anchoredWarnings}' answer.
 */
function attachStepWarnings(
  summary: string[],
  warnings: Map<number, RecordedStepWarning>
): string[] {
  if (warnings.size === 0) return summary;
  return summary.flatMap((line, i) => {
    const recorded = warnings.get(i + 1);
    return recorded ? [line, `   warning: ${recorded.warning}`] : [line];
  });
}

/**
 * What `message` says about the warnings the summary carries, by KIND.
 *
 * The two are different news and only one is about conversion. A recorded wait
 * that came back `success: false` was never probed — its own warning says so —
 * and what it means is that the step failed live, which at replay stops the run
 * rather than raising a polish-time question. Counting it as a "cross-tree
 * warning about converting a recorded wait" states the opposite of the
 * actionable fact, and tells a caller who is not converting anything that the
 * summary can be skipped.
 */
function warningHeadline(warnings: Map<number, RecordedStepWarning>): string {
  const counts = { conversion: 0, wait: 0 };
  for (const { kind } of warnings.values()) counts[kind] += 1;
  const clauses: string[] = [];
  if (counts.conversion > 0) {
    clauses.push(
      `${counts.conversion} ${counts.conversion === 1 ? "step carries" : "steps carry"} a ` +
        `cross-tree warning about converting a recorded wait`
    );
  }
  if (counts.wait > 0) {
    clauses.push(
      `${counts.wait} ${counts.wait === 1 ? "step" : "steps"} recorded a wait that did not pass`
    );
  }
  if (clauses.length === 0) return "";
  return ` — ${clauses.join(", and ")}; read \`summary\` before converting or replaying`;
}

/**
 * The verdicts still anchored to the steps they judged.
 *
 * These anchors are POSITIONS, and hand-editing the .yaml mid-recording is a
 * documented workflow that moves positions: host mode re-reads the file before
 * each append, so a delete, a reorder or an in-place replacement renumbers the
 * steps and a verdict left on its old number would convict whichever step
 * inherited it — a false conviction on an innocent step, with the real risk
 * reading clean, which is strictly worse than having no verdict at all. Two
 * checks, because one edit can defeat either alone:
 *
 * 1. The finished flow must still be the file the RECORDER saw —
 *    `session.flow`, which `appendStepToFlow` refreshes on every append, from
 *    the re-read file in host mode and from the in-memory copy in client mode.
 *    An edit made after the last append fails here, and a swap of two steps
 *    that render alike fails nothing else. Comparing step CONTENT rather than a
 *    count of the appends this tool made is also what keeps an ordinary append
 *    — a `flow-add-echo` label, which files no verdict — from reading as an
 *    edit.
 * 2. Each verdict's own step must still occupy its number. An edit the recorder
 *    then appended over passes check 1, because that append re-read the edited
 *    file into `session.flow`: delete step 1 of 3, record one more step, and
 *    the two views agree while every key past the deletion points one step too
 *    far.
 *
 * A verdict that fails check 2 is dropped rather than re-anchored: which step
 * moved where is unknowable from here, and dropping is the only answer that
 * cannot convict an innocent step. Both checks are content comparisons, so two
 * genuinely identical steps are interchangeable to them — which is sound, since
 * a verdict quotes the condition and selector that are identical between them.
 */
function anchoredWarnings(
  session: RecordingSession,
  steps: FlowStep[]
): Map<number, RecordedStepWarning> {
  const kept = new Map<number, RecordedStepWarning>();
  const recorded = session.flow.steps;
  if (recorded.length !== steps.length) return kept;
  if (!steps.every((step, i) => stepAnchor(step) === stepAnchor(recorded[i]))) return kept;
  for (const [n, verdict] of session.stepWarnings ?? []) {
    const step = steps[n - 1];
    if (step !== undefined && stepAnchor(step) === verdict.step) kept.set(n, verdict);
  }
  return kept;
}

export const flowFinishRecordingTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    message: string;
    path: string;
    executionPrerequisite: string;
    steps: number;
    summary: string[];
    flowFile: string;
    savedTo: FlowSavedTo;
  }
> = {
  id: "flow-finish-recording",
  interaction: {
    // Name the flow: other recordings stay live across this call, so an
    // unqualified "Finishing flow recording" would not identify which one.
    startedMsg: ({ params }) => `Finishing recording of flow ${params.name}`,
    // `params.name` rather than the basename of `result.path`: the two are the
    // same string on every branch — `assertSafeFlowName` admits no dots or
    // separators, so `getFlowPath` produces `<name>.yaml` and nothing else —
    // and this spelling matches the two formatters either side of it.
    completedMsg: ({ params }) => `Saved recorded flow ${params.name}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to finish recording of flow ${params.name}: ${failureSignal.error_code}`,
  },
  description: `Finish recording the flow named by \`name\` + \`project_root\`, leaving recordings under any other key untouched. Returns { message, path, executionPrerequisite, steps, summary, flowFile, savedTo } - a summary of all recorded steps plus the final YAML. Use when you have added all desired steps and want to finalize the flow file. Fails if that flow has no recording in progress.
Every warning flow-add-step raised on a recorded \`await-ui-element\` is repeated in \`summary\` as a \`warning:\` line of its own, right below the step it judges, and \`message\` counts them by kind. A step that carries a cross-tree warning was re-probed against the runner's tree: read it before converting that wait to \`await:\`/\`assert:\`, which is what the verdict is about and what this moment is for. A step that recorded a wait which did not pass was never probed at all - that wait failed live, and an unmet one stops the run at replay, so read those before replaying.
You can still edit the .yaml file directly afterwards to remove or reorder steps.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    // Resolve, read and clear as ONE critical section under the flow-file lock.
    // Host mode's `await fs.readFile` is a yield, and an append that lands in it
    // would be on disk while the summary and step count reported here — taken
    // from the pre-append read — say otherwise.
    const { filePath, flowFile, savedTo, flow, summary, headline } = await withFlowFileLock(
      params.project_root,
      params.name,
      async () => {
        const session = await requireRecordingSession(params.project_root, params.name);

        // Host mode re-reads the file so manual edits made during the recording
        // survive into the summary; in client mode this host never has the file,
        // so the in-memory copy is the truth and travels back in the directive.
        const filePath = session.filePath;
        let flowFile: string;
        let savedTo: FlowSavedTo;
        if (session.persist === "client") {
          flowFile = serializeFlow(session.flow);
          savedTo = clientFileDirective(filePath, flowFile);
        } else {
          flowFile = await fs.readFile(filePath, "utf8");
          savedTo = filePath;
        }
        // Parse BEFORE clearing. Hand-editing the .yaml mid-recording is a
        // documented workflow, so parseFlow can legitimately throw here on a
        // botched edit — and clearing first would destroy the session on the
        // way out, leaving the agent unable to retry the finish after repairing
        // the file (the only tool that re-establishes the key,
        // flow-start-recording, truncates the take it would be recovering).
        const flow = parseFlow(flowFile);
        // Render the summary before clearing too, for the same reason: it walks
        // step bodies the parser does not fully constrain, and nothing that can
        // throw may run after the session is destroyed. The one known thrower
        // there — `JSON.stringify` on a cyclic `args` anchor — is guarded in
        // {@link renderToolArgs}; keeping the order is what makes the next one
        // recoverable rather than fatal.
        const anchored = anchoredWarnings(session, flow.steps);
        const summary = attachStepWarnings(summarizeSteps(flow), anchored);
        const headline = warningHeadline(anchored);
        clearRecordingSession(session);
        return { filePath, flowFile, savedTo, flow, summary, headline };
      }
    );

    return {
      // Name the counts in `message` as well as the summary. The warnings the
      // summary carries are the reason to read it before converting or
      // replaying anything, and a caller that only reads `message` would
      // otherwise polish blind.
      message: `Finished recording "${params.name}" flow (${flow.steps.length} steps)` + headline,
      path: filePath,
      executionPrerequisite: flow.executionPrerequisite,
      steps: flow.steps.length,
      summary,
      flowFile,
      savedTo,
    };
  },
};

/**
 * A `tool:` step's `args` is the one step body the parser does not constrain, so
 * a cyclic YAML alias in a hand-edited file reaches here as a cyclic object and
 * `JSON.stringify` throws on it. Fall back to a marker, the way `parseFlow`
 * already does for the same input class (see `badEntry` in flow-utils) — the
 * summary of a recording that is otherwise fine should not fail on one
 * unrenderable step.
 *
 * The body interpolates rather than returning `JSON.stringify(args)` directly,
 * because `JSON.stringify(undefined)` is the VALUE `undefined`, not a string,
 * and would leave through a `string`-typed signature uncaught (TypeScript does
 * not flag it — `JSON.stringify`'s overload is declared to return `string`).
 * No reachable input is undefined today, on either of the two paths into
 * {@link summarizeStep}: the finish comes through {@link summarizeSteps}, which
 * is only ever handed `parseFlow` output, where `fromYamlStep` normalises a
 * missing/`null` `args:` to `{}` on the way through; the recorder
 * (`flow-add-step`) hands over a step it built in memory, whose `args` is
 * `stripDeviceKeys(params.args ? JSON.parse(params.args) : {})` — a fresh
 * spread, so an object either way. It is the `default:` arm of that switch this
 * guards — a step kind added without its own `case` lands there and is rendered
 * as a `tool:` step, with no `args` field to read.
 */
function renderToolArgs(args: unknown): string {
  try {
    return `${JSON.stringify(args)}`;
  } catch {
    return "[cyclic args]";
  }
}

/**
 * The pre-step sleep a replay performs, when the step carries one. Narrowed to
 * the one arm that has a `delayMs` — over the whole union the field could only
 * be read through a cast, which is also what would stop the compiler checking
 * it.
 *
 * A runtime check is still needed, because `fromYamlStep` copies `delayMs`
 * across unvalidated and `validateFlow` does not check it, so a hand-edited
 * non-number survives a parse. The check has to be the RUNNER's, though, not a
 * `typeof`: flow-run gates on truthiness and hands the raw value to
 * `setTimeout` (`if (step.delayMs && !(await sleepOrAbort(step.delayMs, …)))`),
 * which coerces it. A quoted `delayMs: "2000"` is not a number and sleeps two
 * real seconds; `delayMs: .nan` IS a number and sleeps none. Testing `typeof`
 * was therefore wrong in both directions — silent about a delay that happens,
 * and claiming `(after NaNms)` for one that does not.
 */
function delayLabel(step: Extract<FlowStep, { kind: "tool" }>): string {
  // The runner's own gate: a falsy `delayMs` (absent, 0, NaN) is never slept.
  if (!step.delayMs) return "";
  const ms = Number(step.delayMs);
  // What `setTimeout` will actually wait. It floors anything under 1ms — and
  // anything non-numeric, which coerces to NaN — to an immediate tick, so there
  // is no delay to describe; an out-of-range value is clamped the same way.
  return Number.isFinite(ms) && ms >= 1 ? ` (after ${ms}ms)` : "";
}

/** One human-readable line per recorded step, in the flow file's own spellings. */
function summarizeSteps(flow: FlowFile): string[] {
  return flow.steps.map((step, i) => summarizeStep(step, i + 1));
}

/**
 * WHICH step this is, told apart from where it sits.
 *
 * The same renderer as the summary, on a fixed number so the identity does not
 * move with the position. A step read back from the file renders exactly as the
 * one the recorder appended — both sides of every comparison here are
 * `parseFlow` output, in client mode via one serialize/parse round trip — so
 * this differs only when the step itself does.
 */
export function stepAnchor(step: FlowStep): string {
  return summarizeStep(step, 0);
}

/**
 * One recorded step, rendered the way the flow FILE spells it. Shared with the
 * recorder, which echoes just the line it appended instead of the whole
 * growing file.
 */
export function summarizeStep(step: FlowStep, n: number): string {
  switch (step.kind) {
    case "echo":
      return `${n}. echo: ${step.message}`;
    case "launch":
      return `${n}. launch: ${typeof step.app === "string" ? step.app : JSON.stringify(step.app)}`;
    case "run":
      return `${n}. run: ${step.flow}`;
    case "tap":
    case "long-press": {
      // `times` (tap) and `duration` (long-press) change what replays, so a
      // summary line that drops them misdescribes the file. `times` has a
      // second reason: `tap` is one of the kinds the recorder builds, and since
      // it stopped returning the YAML per step this line is the author's only
      // per-step view of what was appended. `long-press` has no recorder path,
      // so it only ever reaches an author through flow-finish-recording's
      // `summary`, which still returns `flowFile` beside it. Neither kind
      // carries a `delayMs` (only `tool` steps do), so no delayLabel here.
      //
      // That reasoning is NOT applied file-wide, and the arms below show it:
      // `type.submit` (whose `false` suppresses the Enter press) and
      // `await.timeout` also change what replays and still render nothing, as
      // they did before the recorder shared this renderer. Neither kind is
      // recorder-built, so both reach an author only through the finish
      // `summary` — beside the `flowFile` that spells them out. Rendering them
      // is a fair follow-up, not a gap this per-step view opened.
      const target = step.selector ? selectorLabel(step.selector) : `(${step.x}, ${step.y})`;
      // Only ×2..×10 is renderable: `times: 1` is the default and never lands in
      // the file (parseTapTimes normalizes it to absent), so rendering `×1` for
      // a stray in-memory `times: 1` would describe a file that can't exist.
      const times =
        step.kind === "tap" && step.times !== undefined && step.times > 1 ? ` ×${step.times}` : "";
      const held =
        step.kind === "long-press" && step.duration !== undefined ? ` for ${step.duration}ms` : "";
      return `${n}. ${step.kind}: ${target}${times}${held}`;
    }
    case "type":
      return `${n}. type: ${selectorLabel(step.into)} ← "${step.text}"`;
    case "await":
    case "assert": {
      const tail =
        step.condition === "text"
          ? textConditionLabel(step.selector, step.expectedText, step.textMatch)
          : `${step.condition} ${selectorLabel(step.selector)}`;
      return `${n}. ${step.kind}: ${tail}`;
    }
    case "wait":
      return `${n}. wait: ${step.ms}ms`;
    case "when": {
      // Mirror the await/assert rendering above — selectorLabel spelling,
      // same comparator tail for text guards.
      const cond =
        step.condition.kind === "platform"
          ? `platform ${step.condition.platform}`
          : step.condition.condition === "text"
            ? textConditionLabel(
                step.condition.selector,
                step.condition.expectedText,
                step.condition.textMatch
              )
            : `${step.condition.condition} ${selectorLabel(step.condition.selector)}`;
      // Pluralize like flow-run's skip reason so the two surfaces agree.
      const count = step.steps.length;
      return `${n}. when: ${cond} (${count} step${count === 1 ? "" : "s"})`;
    }
    case "scroll-to":
      return `${n}. scroll-to: ${selectorLabel(step.target)} (${step.direction})`;
    case "pinch":
      return `${n}. pinch: scale ${step.scale}${step.selector ? ` on ${selectorLabel(step.selector)}` : ""}`;
    case "rotate":
      return `${n}. rotate: by ${step.by}°${step.selector ? ` on ${selectorLabel(step.selector)}` : ""}`;
    case "snapshot":
      return `${n}. snapshot: ${step.name}`;
    case "idle":
      return `${n}. await: screen idle`;
    case "tool":
    default:
      return `${n}. tool: ${step.name} ${renderToolArgs(step.args)}${delayLabel(step)}`;
  }
}
