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
import { summarizeStep } from "./flow-finish-recording";

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
  /** The verdict, decided by the same function that writes a replay's step report. */
  status: "pass" | "fail" | "error";
  /** Why it did not pass, or an executor note on a pass (a clamped time limit). */
  reason?: string;
  /** The script's stdout and stderr in written order, as it wrote them. */
  log?: string;
  /** A log limit dropped some of that output — the text carries no marker. */
  logTruncated?: true;
  /**
   * Wall clock the executor spent on the step. Absent exactly when the step was
   * refused before the executor was called at all — a path that resolved to no
   * file, or to one spelled a different way on disk.
   */
  durationMs?: number;
  /**
   * The output document the script returned, as JSON text. Present only on a
   * pass.
   *
   * Text rather than the parsed object, and the reason is a trust boundary
   * this tool is the first to cross. Every tool result is deep-walked twice by
   * the client — once for `__argentClientFile` directives, which write a file
   * on the agent's machine, and once for `__argentArtifact` handles, which
   * fetch a file and can push an image block into the agent's context — and
   * both walks match on shape alone. A script's document is the only part of
   * any result this server does not author: the documented uses are relaying
   * what a backend answered, so the bytes are routinely NOT the script's own.
   * Handed on as an object it would inherit every structural meaning the wire
   * format has today and every one it gains later; as a string it has none of
   * them, and the agent is shown exactly what the script returned rather than
   * the walkers' rewrite of it.
   */
  outputJson?: string;
  /** Steps in the recording. Unchanged by a call that did not record. */
  stepCount: number;
  /** The appended step's summary line. Absent when nothing was recorded. */
  recorded?: string;
  /** Where the flow file was persisted. Absent when nothing was recorded. */
  savedTo?: FlowSavedTo;
}

/**
 * Steps in the recording, read where they actually live.
 *
 * The success path gets this from {@link appendStepToFlow}, which counts off the
 * file it just re-read. The failure path has no append to ask, and the session's
 * in-memory copy only catches up on each append — so a hand-edit made
 * mid-recording (a documented workflow) would make the two paths report counts
 * of two different things. Client mode is refused before this is reached, so the
 * file is always this host's. An unreadable or unparseable one falls back to the
 * in-memory copy rather than failing a call that is already reporting a failure.
 */
async function recordedStepCount(session: RecordingSession): Promise<number> {
  return (await countStepsOnDisk(session.filePath)) ?? session.flow.steps.length;
}

/**
 * Run a local script and record the `script:` step that ran it.
 *
 * The second recording tool with no MCP tool behind it — `flow-add-echo` was
 * the first, for the same reason: `echo:` and `script:` are directives the
 * runner owns, so there is nothing for `flow-add-step` to dispatch and capture.
 * Where the two differ is what running one costs. An `echo:` has no effect
 * worth executing, so `flow-add-echo` only records; a script has nothing BUT
 * effects, so this one executes first and records second — the contract
 * `flow-add-step` already states, that each step is executed live so the author
 * can verify it works before it gets recorded.
 *
 * That is the whole point of the tool. Before it, a `script:` step could only
 * be typed into the YAML after the recording ended: it had never run when the
 * flow was authored, and the device steps walked after it were walked against
 * backend state the agent had established by hand — so the recording proved
 * nothing about whether the script establishes that same state. Recording the
 * script where it belongs in the order makes the walkthrough real again.
 */
export const flowAddScriptTool: ToolDefinition<z.infer<typeof zodSchema>, FlowAddScriptResult> = {
  id: "flow-add-script",
  interaction: {
    // Name the flow: recordings are concurrent, so several of these lines can
    // interleave in one log and "the recorded flow" would not identify which.
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
Returns { message, status, reason?, log?, logTruncated?, durationMs?, outputJson?, stepCount, recorded?, savedTo? }.
UNLIKE flow-add-step, a failure records NOTHING: the step is appended only when the script passes, because a failed script did not establish the state the rest of the recording would then be walked against. A script that ran before it stopped did not roll back what it created; the \`message\` says whether anything ran, so you can fix and re-run or clean up first.
\`outputJson\` is the document the script returned, as JSON text. It is shown so you can see the shape a later release will read; no flow step can reference it yet.
Refused for a recording whose project root is not on this tool server's filesystem: the .mjs file stays on the client, so there is nothing here to resolve the path against or to run.`,
  // A script's default limit is 30s and its host cap is five minutes, both of
  // which outlive the MCP adapter's per-request fetch budget. Without this the
  // adapter aborts a slow call and RETRIES it — re-running a script whose whole
  // purpose is a side effect, up to five times, while the agent sees a
  // transport error instead of the "nothing was recorded" result this tool
  // takes such care to produce. It also keeps the server's idle timer warm for
  // the call's duration, so auto-shutdown cannot reap the host mid-script.
  // `flow-execute`, which runs the same executor, is declared the same way.
  longRunning: true,
  zodSchema,
  services: () => ({}),
  async execute(_services, params, ctx) {
    const session = await requireRecordingSession(params.project_root, params.name);

    // Same boundary, and the same reason, as the three refusals a script step
    // already meets: assertUploadSelfContained rejects one in an uploaded flow,
    // and `run:` and `snapshot` are refused there because they anchor at a flow
    // file this host does not have. A "client" recording has no flow file here
    // and no script directory either — `filePath` names a file on the AGENT's
    // machine, which this server never touches — so there is nothing to resolve
    // `path` against and nothing to execute. A tool that appeared to work here
    // would produce a flow whose topology this same server cannot replay.
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
    // read out of YAML — so the message an agent gets here is the message the
    // same mistake produces in a hand-written flow, and a path this tool
    // accepts is a path parseFlow accepts. Never a second spelling of either
    // rule.
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

    // The anchor the RUNNER will use for this step: the canonical directory of
    // the flow file that names it. Canonical, because a recording made through
    // a symlinked flow file replays against the link's target directory — so a
    // relative path validated beside the link's spelling could resolve a
    // different file, or none, at replay.
    const flowDir = nodePath.dirname(await canonicalFlowPath(session.filePath));

    // Run BEFORE taking the flow-file lock. A script may legitimately run for
    // minutes, and appendStepToFlow holds a per-key lock: executing inside it
    // would block every other call on this recording for the script's whole
    // duration, for no benefit — nothing about the append depends on the run
    // beyond its verdict.
    //
    // No `logBudget`. The run-scoped allowance exists so one chatty step in a
    // long unattended run cannot starve the report; a recording is neither long
    // nor unattended — the agent reads each call's result as it comes — and a
    // session-wide budget would silently truncate the tenth script's logs
    // during authoring, which is the moment those logs matter most. The
    // per-step limit still applies.
    // A caller that gave up should not leave a script holding an executor slot
    // until the step's own time limit. Replay hands the executor its run's
    // signal for the same reason; this hands it the tool call's.
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
      // Nothing is appended, and that is deliberate — the opposite of
      // flow-add-step, which records a step whenever the tool call returns.
      // A failed script did not establish the state the rest of the recording
      // is about to be walked against, so recording it writes a known-red step
      // into a flow whose remaining steps were then authored against state that
      // step did not create. An unmet `await-ui-element` costs one stale step;
      // a recorded failing script costs every step after it.
      //
      // What to do next turns on whether a child actually ran, which is not the
      // same as whether there is a result: a path this step could not resolve
      // forked nothing, and neither did a queue that was full or a process that
      // would not start. Telling any of their authors to weigh a cleanup sends
      // them hunting for state that was never created — the same false advice a
      // superseded echo used to get.
      const nextMove = ran
        ? `Whatever the script did before it stopped is still done: nothing was rolled back, so ` +
          `either make the re-run safe to repeat or clean up first, then call this again.`
        : `Nothing ran, so there is nothing to clean up — the reason above says what stopped it.`;
      return {
        ...common,
        message:
          `The script "${step.path}" ${ran ? "failed" : "could not be run"} — nothing was ` +
          `recorded in "${params.name}", so the flow is exactly as it was. ${nextMove}`,
        stepCount: await recordedStepCount(session),
      };
    }

    // The script has already run and passed. If the append now fails — the
    // recording was restarted or finished under us, the flow file was hand-
    // edited into something that will not parse, the write itself failed — the
    // raw error would say only that, and the one thing the caller most needs to
    // know would be missing: the script ran, and whatever it created is still
    // there. So the failure is re-thrown carrying that, keeping the original
    // diagnosis and its failure signal.
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
          error_kind: "validation",
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
      ...(result?.output ? { outputJson: JSON.stringify(result.output) } : {}),
      stepCount,
      recorded: summarizeStep(step, stepCount),
      savedTo,
    };
  },
};
