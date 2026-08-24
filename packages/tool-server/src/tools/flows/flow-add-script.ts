import { z } from "zod";
import * as nodePath from "node:path";
import { FAILURE_CODES, FailureError, wrapFailure, type ToolDefinition } from "@argent/registry";
import {
  appendStepToFlow,
  countStepsOnDisk,
  parseScriptPath,
  parseScriptTimeout,
  requireRecordingSession,
  type FlowSavedTo,
  type FlowStep,
  type RecordingSession,
} from "./flow-utils";
import { canonicalFlowPath } from "./flow-file-refs";
import { runFlowScriptStep } from "./flow-script-step";
import { utf8SafeCut } from "./script/flow-script-executor";
import { summarizeStep } from "./flow-finish-recording";

/**
 * Bound on the JSON document shown in one tool result. The executor's own
 * `SCRIPT_MAX_OUTPUT_BYTES` is a MiB, and it bounds what a script may RETURN
 * rather than what may be handed on.
 */
const OUTPUT_RENDER_LIMIT_BYTES = 64 * 1024;

const zodSchema = z.object({
  name: z
    .string()
    .describe("Name of the flow being recorded — the one passed to flow-start-recording."),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root of the flow being recorded — the same value passed to flow-start-recording. Together with `name` it identifies which recording this script step belongs to."
    ),
  path: z
    .string()
    .describe(
      'The .mjs file to run, relative to the flow file being recorded (`<project_root>/.argent/flows/<name>.yaml`) — so a script at `<project_root>/scripts/seed-order.mjs` is "../../scripts/seed-order.mjs". Forward slashes, lowercase .mjs; `..` is allowed. Recorded verbatim as the step\'s `path`.'
    ),
  timeout: z
    .number()
    .optional()
    .describe(
      "Hard time limit for the script, in milliseconds (default 30000, capped by the host's `scripts.maxTimeoutMs`). Recorded verbatim as the step's `timeout`, so the run here and the replay share one limit."
    ),
});

interface FlowAddScriptResult {
  message: string;
  status: "pass" | "fail" | "error";
  /** Why it did not pass, or an executor note on a pass (a clamped time limit). */
  reason?: string;
  log?: string;
  /** A log limit dropped some of that output — the text carries no marker. */
  logTruncated?: true;
  /**
   * Absent exactly when the step was refused before the executor was called at
   * all — a path that resolved to no file, or to one mis-cased on disk.
   */
  durationMs?: number;
  /**
   * The document the script returned, as JSON text. Present only on a pass.
   *
   * Text rather than the parsed object: the client deep-walks every tool result
   * for `__argentClientFile` directives and `__argentArtifact` handles, both
   * matched on shape alone, and a script's document is the one part of a result
   * this server does not author.
   */
  outputJson?: string;
  /**
   * `outputJson` was cut at {@link OUTPUT_RENDER_LIMIT_BYTES}, so it does not
   * parse as JSON. Its own field because the text holds no marker.
   */
  outputTruncated?: true;
  /** Steps in the recording. Unchanged by a call that did not record. */
  stepCount: number;
  recorded?: string;
  savedTo?: FlowSavedTo;
}

/**
 * Steps in the recording, counted off the file — as {@link appendStepToFlow}
 * counts them on the success path. The session's in-memory copy only catches up
 * on each append, so a hand-edit made mid-recording would otherwise make the two
 * paths report counts of two different things.
 */
async function recordedStepCount(session: RecordingSession): Promise<number> {
  return (await countStepsOnDisk(session.filePath)) ?? session.flow.steps.length;
}

function renderOutput(output: Record<string, unknown>): {
  outputJson: string;
  outputTruncated?: true;
} {
  const encoded = JSON.stringify(output);
  const bytes = Buffer.from(encoded, "utf8");
  if (bytes.length <= OUTPUT_RENDER_LIMIT_BYTES) return { outputJson: encoded };
  const kept = bytes.subarray(0, utf8SafeCut(bytes, OUTPUT_RENDER_LIMIT_BYTES));
  return { outputJson: kept.toString("utf8"), outputTruncated: true };
}

/**
 * `script:` is a directive the runner owns, so there is nothing for
 * `flow-add-step` to dispatch: this tool executes the file itself and records
 * the step only if it passes.
 */
export const flowAddScriptTool: ToolDefinition<z.infer<typeof zodSchema>, FlowAddScriptResult> = {
  id: "flow-add-script",
  interaction: {
    // Name the flow: concurrent recordings interleave their lines in one log.
    startedMsg: ({ params }) => `Running script for flow ${params.name}`,
    completedMsg: ({ params, result }) =>
      result.status === "pass"
        ? `Added script step to flow ${params.name}`
        : `Script for flow ${params.name} failed; nothing recorded`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to add script step to flow ${params.name}: ${failureSignal.error_code}`,
  },
  description: `Run a local .mjs file through the flow script executor and record it as a \`script:\` step in the flow named by \`name\` + \`project_root\` (the recording must already be open — see flow-start-recording).
Use when a flow needs backend state before it touches the device: seed an order, create a test account, read a one-time code. The script drives nothing on the device; the steps around it do. Record it at the point in the walkthrough where it belongs — a setup script goes BEFORE the restart-app it prepares state for, because that is where it runs at replay.
It runs the file exactly as a replay will: same path resolution (relative to the flow file being recorded), same environment allowlist, same time limit, and the same working directory — this recording's \`project_root\`, which is what a replay launched from that root also uses.
Returns { message, status, reason?, log?, logTruncated?, durationMs?, outputJson?, outputTruncated?, stepCount, recorded?, savedTo? }.
UNLIKE flow-add-step, a failure records NOTHING: the step is appended only when the script passes, because a failed script did not establish the state the rest of the recording would then be walked against. A script that ran before it stopped did not roll back what it created; the \`message\` says whether anything ran, or that the runner failed around the script and cannot tell, so you can fix and re-run or clean up first. A call that ends in a TRANSPORT error rather than a result is the one case with no \`message\` to read: the script may have run more than once, so check the state it touches before calling again.
\`outputJson\` is the document the script returned, as JSON text. It is shown so you can see the shape a later release will read; no flow step can reference it yet. A document over 64 KiB is cut, and \`outputTruncated\` says so.
Refused for a recording whose project root is not on this tool server's filesystem: the .mjs file stays on the client, so there is nothing here to resolve the path against or to run.`,
  // A script's default limit is 30s and its host cap five minutes, against the
  // MCP adapter's 30s per-request fetch budget. Without this the adapter aborts
  // a slow call and RETRIES it, re-running a script whose whole purpose is a
  // side effect. It also keeps the server's idle timer warm for the call's
  // duration, so auto-shutdown cannot reap the host mid-script.
  //
  // The flag only skips the adapter's own abort timer; its retry loop is
  // untouched, so a call that fails some other way is still re-POSTed.
  longRunning: true,
  zodSchema,
  services: () => ({}),
  async execute(_services, params, ctx) {
    const session = await requireRecordingSession(params.project_root, params.name);

    // The same boundary `assertUploadSelfContained` draws for an uploaded flow:
    // in a "client" recording `filePath` names a file on the AGENT's machine,
    // so there is nothing here to resolve `path` against and nothing to execute.
    if (session.persist !== "host") {
      throw new FailureError(
        `Cannot record a script step for "${params.name}": this recording's project root is not ` +
          `on the tool server's filesystem, so ${session.filePath} — and the .mjs file beside it ` +
          `— exist only on your machine. There is nothing here to resolve "${params.path}" ` +
          `against and nothing to run. Record against a tool server that shares your filesystem, ` +
          `or finish the recording, add the \`script:\` step to the YAML by hand, and replay it ` +
          `locally.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_add_script_client_mode",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    // Validated by the flow parser's own helpers, against the entry they would
    // read out of YAML: a path this tool accepts is a path parseFlow accepts,
    // and a rejection reads the same as in a hand-written flow.
    const entry = {
      script: {
        path: params.path,
        ...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
      },
    };
    const step: Extract<FlowStep, { kind: "script" }> = {
      kind: "script",
      path: parseScriptPath(entry, params.path),
      ...(params.timeout !== undefined
        ? { timeout: parseScriptTimeout(entry, params.timeout) }
        : {}),
    };

    // The anchor the RUNNER will use for this step. Canonical, because a
    // recording made through a symlinked flow file replays against the link's
    // target directory, where the same relative path can resolve elsewhere.
    const flowDir = nodePath.dirname(await canonicalFlowPath(session.filePath));

    // Run BEFORE taking the flow-file lock: a script may run for minutes, and
    // appendStepToFlow holds a per-key lock that would block every other call on
    // this recording for that whole duration.
    //
    // No `logBudget`: the run-scoped allowance would silently truncate a late
    // script's logs during authoring. The per-step limit still applies.
    const { outcome, result, ran } = await runFlowScriptStep({
      flowDir,
      step,
      projectRoot: params.project_root,
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });

    const common = {
      status: outcome.status,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(outcome.scriptLog !== undefined ? { log: outcome.scriptLog } : {}),
      ...(outcome.scriptLogTruncated ? { logTruncated: true as const } : {}),
      ...(result ? { durationMs: result.durationMs } : {}),
    };

    if (outcome.status !== "pass") {
      // Nothing is appended, unlike flow-add-step, which records a step
      // whenever the tool call returns: a failed script did not establish the
      // state the rest of the recording is about to be walked against.
      //
      // What to do next turns on whether the script left anything behind,
      // which is not the same as whether there is a result — and which one
      // failure kind cannot answer. See `ran` in flow-script-step.
      const nextMove =
        ran === "yes"
          ? `Whatever the script did before it stopped is still done: nothing was rolled back, so ` +
            `either make the re-run safe to repeat or clean up first, then call this again.`
          : ran === "no"
            ? `Nothing ran, so there is nothing to clean up — the reason above says what stopped it.`
            : `The runner failed around the script rather than inside it, so the script may never ` +
              `have started — check the state it touches before you call this again.`;
      return {
        ...common,
        message:
          `The script "${step.path}" ${ran === "yes" ? "failed" : "could not be run"} — nothing ` +
          `was recorded in "${params.name}", so the flow is exactly as it was. ${nextMove}`,
        stepCount: await recordedStepCount(session),
      };
    }

    // The script has already run and passed, so an append failure is re-thrown
    // carrying the one thing the raw error would not say: whatever the script
    // created is still there.
    let savedTo: FlowSavedTo;
    let stepCount: number;
    try {
      ({ savedTo, stepCount } = await appendStepToFlow(session, step));
    } catch (err) {
      throw wrapFailure(
        err,
        {
          error_code: FAILURE_CODES.FLOW_FILE_WRITE_FAILED,
          failure_stage: "flow_add_script_append",
          failure_area: "tool_server",
          // `unknown`, as every other throw of this code is: the fallback
          // catches a raw filesystem error that reached here carrying no
          // diagnosis of its own, and nothing about the CALL was invalid.
          error_kind: "unknown",
        },
        `The script "${step.path}" ran and passed in ${result!.durationMs}ms and nothing it did ` +
          `was rolled back, but recording it failed — so the step is not in the flow, and its ` +
          `logs and output document are lost with this error. ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }

    return {
      ...common,
      message:
        `Script step added to "${params.name}" flow — it ran here exactly as it will at replay. ` +
        `\`outputJson\` is what the script returned; no flow step can reference it yet.`,
      ...(result?.output ? renderOutput(result.output) : {}),
      stepCount,
      recorded: summarizeStep(step, stepCount),
      savedTo,
    };
  },
};
