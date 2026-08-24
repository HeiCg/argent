import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SCRIPT_FILE_NAME_PATTERN } from "@argent/registry";
import type { FlowStep } from "./flow-utils";
import { resolveFlowRelativeFile } from "./flow-file-refs";
import {
  flowScriptExecutor,
  type FlowScriptFailureKind,
  type FlowScriptLogBudget,
  type FlowScriptResult,
} from "./script/flow-script-executor";

/**
 * One `script` step, from a path to a verdict.
 *
 * The flow runner and `flow-add-script` both come through here: a recorded step
 * that ran differently from the way it will replay would make the recording
 * prove nothing, so there is one path and each caller supplies only its own
 * anchor and its own run-scoped extras.
 */

/** The half of a `script` step's report the step itself decides. */
interface FlowScriptStepOutcome {
  status: "pass" | "fail" | "error";
  reason?: string;
  scriptLog?: string;
  scriptLogTruncated?: true;
}

interface FlowScriptStepRun {
  outcome: FlowScriptStepOutcome;
  /** Absent exactly when the step was refused before the executor was reached. */
  result?: FlowScriptResult;
  /** NOT the same question as "is there a result" — see {@link scriptRan}. */
  ran: ScriptRan;
}

interface FlowScriptStepRequest {
  /**
   * Directory of the flow file that NAMES the step — the resolution anchor.
   * Canonical (symlink-resolved), because the runner's is.
   */
  flowDir: string;
  step: Extract<FlowStep, { kind: "script" }>;
  projectRoot: string;
  logBudget?: FlowScriptLogBudget;
  signal?: AbortSignal;
}

/**
 * The path is checked HERE, at the step, and nowhere earlier — nothing
 * preflights the reachable flow graph, so a wrong script path fails at its own
 * step exactly as a wrong `run:` target does (`execRunStep` in flow-run.ts).
 */
export async function runFlowScriptStep(
  request: FlowScriptStepRequest
): Promise<FlowScriptStepRun> {
  const { flowDir, step } = request;
  const target = step.path;
  const { canonical, spelling } = await resolveFlowRelativeFile(
    flowDir,
    target,
    SCRIPT_FILE_NAME_PATTERN
  );
  const suppliedBase = path.posix.basename(target);

  // macOS (APFS) and Windows (NTFS) compare file names without case, so
  // `path: scripts/CreateUser.mjs` opens a file really named `createUser.mjs`:
  // the flow passes here every time it is repeated, then fails with ENOENT on
  // Linux CI with nothing in the flow file to show why. Only `case_folded`
  // refuses — a basename matching nothing at all is an ordinary missing file,
  // reported below, and an unreadable listing vouches for nothing.
  if (spelling.state === "case_folded") {
    // Quote a replacement path only when parseScriptPath would accept one
    // (`addressable` tests the same SCRIPT_FILE_NAME_PATTERN), keeping the
    // target's directory prefix so the hint is a line the author can paste.
    const recovery = spelling.addressable
      ? `write it as "${target.slice(0, target.length - suppliedBase.length)}${spelling.actual}"`
      : `rename "${spelling.actual}" to "${suppliedBase}" to run it — a script filename must ` +
        `match ${SCRIPT_FILE_NAME_PATTERN}`;
    return {
      ran: "no",
      outcome: {
        status: "error",
        reason:
          `mis-cased script path "${target}": the directory holds "${spelling.actual}", not ` +
          `"${suppliedBase}" — a case-sensitive checkout (Linux CI) fails this step with ` +
          `ENOENT — ${recovery}`,
      },
    };
  }

  // Checked before the fork so the report names the file the step looked for.
  // The executor reports a missing module too — as a `load` failure, hence the
  // matching `fail` status — but its message carries only the specifier Node
  // was given, which says nothing about which flow file it was resolved against.
  const missing = await scriptFileProblem(canonical);
  if (missing) {
    return {
      ran: "no",
      outcome: {
        status: "fail",
        reason: `script "${target}" ${missing} (resolved to ${canonical})`,
      },
    };
  }

  const result = await flowScriptExecutor().execute({
    scriptPath: canonical,
    // An empty input document: nothing threads flow output between steps yet,
    // so a script's only inputs are the environment allowlist and its own
    // files. What comes BACK is returned to the caller — the runner discards
    // it, the recorder shows it to the agent.
    output: {},
    ...(step.timeout !== undefined ? { timeoutMs: step.timeout } : {}),
    projectRoot: request.projectRoot,
    flowDir,
    // No `secrets`: nothing resolves one into a script step yet, so there is
    // nothing for the executor to redact out of the captured log.
    ...(request.logBudget ? { logBudget: request.logBudget } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });

  return {
    outcome: {
      ...scriptVerdict(result),
      ...(result.log ? { scriptLog: result.log } : {}),
      // Carried independently of the log: a run-wide budget an earlier step
      // exhausted drops a later script's output entirely, and a report with
      // neither text nor flag would say the script printed nothing.
      ...(result.logTruncated ? { scriptLogTruncated: true } : {}),
    },
    result,
    ran: scriptRan(result),
  };
}

/** Whether the author's script left state behind. See {@link scriptRan}. */
export type ScriptRan = "yes" | "no" | "unknown";

/** The failure kinds the executor reports WITHOUT ever forking a child. */
const NEVER_FORKED: ReadonlySet<FlowScriptFailureKind> = new Set(["invalid", "spawn", "queue"]);

/**
 * Whether the author's script left anything behind — the question "is there
 * something to clean up" turns on, and one a result's mere presence does not
 * answer: the executor returns a full result for a queue it could not admit the
 * step to and for a spawn that never happened.
 *
 * `protocol` is the one kind that cannot be answered either way, so it does not
 * pretend to. It is the runner failing AROUND the script, and every protocol
 * failure the executor raises itself lands before Node evaluates the entry — a
 * malformed request the runner parked on, a channel that closed before the
 * request arrived, a runner that exited without ever saying it started — so
 * usually nothing ran. But the runner's `process.send` is not the only way onto
 * that channel: a script that writes a line to the channel descriptor reaches
 * the same kind having already done its work, and "nothing ran" is the more
 * dangerous of the two to claim wrongly.
 *
 * Everything else answers yes, `cancelled` included: a cancellation can land
 * before the fork or after the script has already reached the system it talks
 * to, and the result does not say which — but the fork is immediate, so the
 * half that beats it is the rare one, which is the opposite balance to
 * `protocol`.
 */
function scriptRan(result: FlowScriptResult): ScriptRan {
  if (result.ok || !result.failure) return "yes";
  const { kind } = result.failure;
  if (NEVER_FORKED.has(kind)) return "no";
  return kind === "protocol" ? "unknown" : "yes";
}

/**
 * Why the resolved script file cannot be run, or null when it can be.
 *
 * `stat`, not `access`: a directory named `seed.mjs` is readable.
 */
async function scriptFileProblem(canonical: string): Promise<string | null> {
  try {
    const stat = await fs.stat(canonical);
    return stat.isFile() ? null : "is not a file";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? "does not exist"
      : `cannot be read: ${errMsg(err)}`;
  }
}

/**
 * The line between `fail` and `error` is who is at fault. A `fail` is the
 * SCRIPT's answer: it threw, it never loaded, it returned something that cannot
 * cross into flow state, or it stopped its own process. An `error` is
 * everything the runner did to it — a process it could not start, a limit it
 * hit, a signal it did not choose, a queue it never left. That split is what
 * lets CI read a red script step: a `fail` is a regression in the flow or the
 * system it talks to, an `error` is the machine it ran on.
 *
 * `cancelled` is an `error`, not a `skip`: every reader of a report takes
 * `skip` to mean the step did not run (the CLI's not-executed line,
 * `FlowRunResult.skipped`), and a script killed after reaching the system it
 * talks to left that state behind. The genuine "did not run" case never
 * reaches the executor — `execSteps` skips it at its own pre-step abort gate.
 *
 * Notes ride into the reason on every outcome, pass included. They are how the
 * executor says a time limit was clamped to the host's maximum, or that the
 * working directory it was given did not exist — and dropping them on a pass is
 * how a script that silently ran somewhere else stays silent.
 *
 * Exported for the test that pins the recorder's verdict and the runner's
 * against it, kind for kind.
 */
export function scriptVerdict(
  result: FlowScriptResult
): Pick<FlowScriptStepOutcome, "status" | "reason"> {
  const notes = result.notes.join(" ");
  if (result.ok) return { status: "pass", ...(notes ? { reason: notes } : {}) };
  const failure = result.failure;
  const message = failure?.message ?? "The script produced no verdict.";
  return {
    status: failure ? scriptFailureStatus(failure.kind) : "error",
    reason: notes ? `${message} ${notes}` : message,
  };
}

function scriptFailureStatus(kind: FlowScriptFailureKind): "fail" | "error" {
  switch (kind) {
    case "load":
    case "runtime":
    case "output":
    case "exit":
      return "fail";
    case "protocol":
    case "timeout":
    case "cancelled":
    case "signal":
    case "heap":
    case "spawn":
    case "queue":
    case "invalid":
      return "error";
    default: {
      // A kind added to the executor without a verdict here defaults to
      // `error`, never `fail`: `fail` would blame the flow for the host's doing.
      const unclassified: never = kind;
      void unclassified;
      return "error";
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
