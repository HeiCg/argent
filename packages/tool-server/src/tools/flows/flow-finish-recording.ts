import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import {
  requireRecordingSession,
  clearRecordingSession,
  clientFileDirective,
  parseFlow,
  serializeFlow,
  selectorToYaml,
  type FlowSavedTo,
  type FlowSelector,
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
    // Derived from the resolved path rather than `params.name` so the line
    // reports the file that was actually written. Holds in client mode too:
    // `path` is still the resolved spelling, it just names a file on the
    // client's disk rather than this host's, and only its basename is read.
    completedMsg: ({ result }) => {
      const flowName =
        result.path
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.ya?ml$/, "") ?? "flow";
      return `Saved recorded flow ${flowName}`;
    },
    failedMsg: ({ params, failureSignal }) =>
      `Failed to finish recording of flow ${params.name}: ${failureSignal.error_code}`,
  },
  description: `Finish recording the flow named by \`name\` + \`project_root\`, leaving any other recordings in progress untouched. Returns a summary of all recorded steps and the final YAML content. Use when you have added all desired steps and want to finalize the flow file. Fails if that flow has no recording in progress.
You can still edit the .yaml file directly afterwards to remove or reorder steps.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const session = requireRecordingSession(params.project_root, params.name);

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
    const flow = parseFlow(flowFile);

    const summary = flow.steps.map((step, i) => {
      const n = i + 1;
      switch (step.kind) {
        case "echo":
          return `${n}. echo: ${step.message}`;
        case "launch":
          return `${n}. launch: ${typeof step.app === "string" ? step.app : JSON.stringify(step.app)}`;
        case "run":
          return `${n}. run: ${step.flow}`;
        case "tap":
        case "long-press":
          return `${n}. ${step.kind}: ${step.selector ? selectorLabel(step.selector) : `(${step.x}, ${step.y})`}`;
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
        case "tool":
        default:
          return `${n}. tool: ${step.name} ${JSON.stringify(step.args)}`;
      }
    });

    clearRecordingSession(params.project_root, params.name);

    return {
      message: `Finished recording "${params.name}" flow (${flow.steps.length} steps)`,
      path: filePath,
      executionPrerequisite: flow.executionPrerequisite,
      steps: flow.steps.length,
      summary,
      flowFile,
      savedTo,
    };
  },
};
