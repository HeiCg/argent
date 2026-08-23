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
 * One `script` step, from a path to a verdict — the whole of what a script step
 * DOES, with nothing of where it was asked for.
 *
 * Two callers reach it. The flow runner runs a step it read out of a YAML file;
 * `flow-add-script` runs one an agent is about to record. They must agree
 * exactly — a recorded step that ran differently from the way it will replay
 * would make the recording prove nothing — and the only way to be sure of that
 * is for there to be one path. So the resolution, the pre-fork checks, the
 * executor call and the verdict live here, and each caller supplies only its
 * own anchor and its own run-scoped extras.
 */

/**
 * The half of a `script` step's report the step itself decides — the shape the
 * runner spreads straight into a `StepReport`.
 */
interface FlowScriptStepOutcome {
  status: "pass" | "fail" | "error";
  reason?: string;
  scriptLog?: string;
  scriptLogTruncated?: true;
}

/** What one script step produced: its verdict, and the executor's own result. */
interface FlowScriptStepRun {
  outcome: FlowScriptStepOutcome;
  /**
   * The executor's result — absent exactly when the step was refused before any
   * fork, so a caller that reports a duration or an output document can tell
   * "the script ran and failed" from "the script never started".
   */
  result?: FlowScriptResult;
}

interface FlowScriptStepRequest {
  /**
   * Directory of the flow file that NAMES the step — the resolution anchor and
   * the executor's working-directory fallback. Canonical (symlink-resolved),
   * because the runner's is.
   */
  flowDir: string;
  /** The step, parsed: its `path` as written, and its optional time limit. */
  step: Extract<FlowStep, { kind: "script" }>;
  /** The caller's `project_root` — the executor's first choice of directory. */
  projectRoot: string;
  /** A run's shared log allowance. Omitted ⇒ only the per-step limit applies. */
  logBudget?: FlowScriptLogBudget;
  /** Cancels the step; a queued step gives up its position at once. */
  signal?: AbortSignal;
}

/**
 * Run one `script` step: resolve its path, check it, run the file in a fresh
 * Node process, and turn the executor's outcome into a verdict.
 *
 * **The path is checked HERE, at the step, and nowhere earlier.** A `run:`
 * target already behaves this way — `execRunStep` resolves one hop at a
 * time as it executes, and a wrong path fails at its own step — and a script
 * path is the same kind of name. A preflight walk of the reachable flow graph
 * was considered and dropped: the canonical script step is step 1, so an early
 * pass adds nothing to it, and such a pass failed a flow whose bad path sat
 * behind a `when:` guard that never runs.
 *
 * The cost of that is real and is accepted: a script late in a long flow
 * reports a wrong path late. Which is why the verdict has to say plainly what
 * failed and why — it is the only signal the author gets.
 *
 * Nothing here reads the script's source or loads its dependencies. The checks
 * are a directory listing and a stat.
 */
export async function runFlowScriptStep(
  request: FlowScriptStepRequest
): Promise<FlowScriptStepRun> {
  const { flowDir, step } = request;
  const target = step.path;
  // The anchor is the directory of the flow file that NAMES this step, not the
  // root flow's — so a fragment carrying a script step resolves the same file
  // whichever flow composed it. That is the property `run:` composition exists
  // to have, and a script path inherits it by using the same anchor. The
  // recorder passes its own recording's directory, which is that same file.
  const { canonical, spelling } = await resolveFlowRelativeFile(
    flowDir,
    target,
    SCRIPT_FILE_NAME_PATTERN
  );
  const suppliedBase = path.posix.basename(target);

  // The casing check is not optional, and it is the one authoring error a local
  // run cannot find. macOS (APFS) and Windows (NTFS) compare file names without
  // case, so `path: scripts/CreateUser.mjs` opens a file really named
  // `createUser.mjs`: the flow runs, it passes, and it passes again every time
  // it is repeated — then the same files fail with ENOENT on Linux CI, with
  // nothing in the flow file to show why. Every route that turns a caller's
  // spelling into a file is held to this line — a `run:` basename, the root
  // flow's `flow_path` and `name`, the recorder's two nested flow-execute
  // targets — and they all reach it through the one
  // `classifyOnDiskSpelling` in flow-utils.ts. A script path takes the same verdict
  // shape: only `case_folded` refuses. A basename matching nothing at all is an
  // ordinary missing file, reported below with the path it looked for, and an
  // unreadable listing vouches for nothing so it refuses nothing.
  //
  // Only the CASE can differ. `scripts/create-user.mjs` does not open
  // `createUser.mjs` on any of the three platforms — the hyphen makes it a
  // different name — so that one is a plain missing file everywhere.
  if (spelling.state === "case_folded") {
    // Quote a replacement path only when parseScriptPath would accept one;
    // otherwise ask for the rename the file really needs. The target's own
    // directory prefix is kept so the hint is a line the author can paste.
    const recovery = spelling.addressable
      ? `write it as "${target.slice(0, target.length - suppliedBase.length)}${spelling.actual}"`
      : `rename "${spelling.actual}" to "${suppliedBase}" to run it — a script filename must ` +
        `match ${SCRIPT_FILE_NAME_PATTERN}`;
    return {
      outcome: {
        status: "error",
        reason:
          `mis-cased script path "${target}": no directory entry is named "${suppliedBase}" ` +
          `(this filesystem matched it case-insensitively to "${spelling.actual}"), so this flow ` +
          `runs here and fails with ENOENT on a case-sensitive checkout — ${recovery}`,
      },
    };
  }

  // Checked before the fork so the report names the file the step looked for,
  // anchored at the flow that named it. The executor would report a missing
  // module too — as a `load` failure, hence the matching `fail` status — but
  // its message carries only the specifier Node was given, which says nothing
  // about which flow file the path was resolved against.
  const missing = await scriptFileProblem(canonical);
  if (missing) {
    return {
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
    // files. Passed explicitly rather than omitted, so the script's `output`
    // global is the empty document rather than absent. What comes BACK is
    // returned to the caller — the runner still discards it, the recorder shows
    // it to the agent that is about to depend on its shape.
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
      // exhausted drops a later script's output ENTIRELY, and a report with
      // neither text nor flag says the script printed nothing.
      ...(result.logTruncated ? { scriptLogTruncated: true } : {}),
    },
    result,
  };
}

/**
 * Why the resolved script file cannot be run, or null when it can be.
 *
 * `stat`, not `access`: a directory named `seed.mjs` is readable, and forking
 * one produces an EISDIR from inside Node's module loader that names neither
 * the flow nor the step. Any other stat error (a permission denied on a parent
 * directory, a dangling symlink) is reported as its own text rather than
 * guessed at.
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
 * The executor's outcome as a step verdict.
 *
 * The line between `fail` and `error` is who is at fault. A `fail` is the
 * SCRIPT's answer: it threw, it never loaded, it returned something that cannot
 * cross into flow state, or it stopped its own process. An `error` is
 * everything the runner did to it — a process it could not start, a limit it
 * hit, a signal it did not choose, a queue it never left. That split is what
 * lets CI read a red script step: a `fail` is a regression in the flow or the
 * system it talks to, an `error` is the machine it ran on.
 *
 * `cancelled` is an `error`, and that is the one classification worth arguing
 * about. `skip` means "the step did not run", and every reader of a report acts
 * on that meaning — the CLI prints it as a not-executed line and
 * `FlowRunResult.skipped` counts it. A script that ran, reached the system
 * it talks to and was then killed is the one case where "did not run" is the most dangerous
 * thing a report can say, because the state it created is still there. So a
 * cancellation the executor reports is an `error`, whose reason says which of
 * the two happened; the "did not run" case is reported by `execSteps`'
 * own pre-step cancellation gate, which skips the step without ever reaching
 * the executor. The narrow remainder — a step cancelled while it queued for a
 * concurrency slot, which needs two flow runs racing for one host's script
 * slots — takes the safe reading rather than a new field: its reason still says
 * plainly that the script was waiting for a slot.
 *
 * Notes ride into the reason on every outcome, pass included. They are how the
 * executor says a time limit was clamped to the host's maximum, or that the
 * working directory it was given did not exist — facts about what the step
 * ACTUALLY did, and dropping them on a pass is how a script that silently ran
 * somewhere else stays silent.
 *
 * Exported for the test that pins the recorder's verdict and the runner's
 * against it, kind for kind. Neither caller reaches it directly — both come
 * through {@link runFlowScriptStep}, which is what makes them agree — so the
 * export buys the proof, not the property.
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

/** Which side of the fail/error line one executor failure kind falls on. */
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
      // A failure kind added to the executor without a verdict here would
      // otherwise default to one of the two silently, and the wrong default is
      // `fail`: it blames the flow for something the host did.
      const unclassified: never = kind;
      void unclassified;
      return "error";
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
