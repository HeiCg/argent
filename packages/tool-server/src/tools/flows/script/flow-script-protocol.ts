/**
 * The IPC protocol between the flow script executor (the parent, in this
 * package) and `flow-script-runner.mjs` (the child it forks).
 *
 * Exactly two messages cross the channel in a passing run: the parent's
 * `execute` request, and the child's `started` followed by one terminal
 * response. Script logs never travel here — they ride stdout/stderr, so that
 * console text and any subprocess the script starts land in one stream in
 * written order, and so that a limit can apply while draining rather than after
 * a whole message has been serialized.
 *
 * **There is no version field.** Both sides ship in the same package from the
 * same installation, so the two can never disagree, and nothing keeps a message
 * after the run. Adding a version later costs one change to two files that
 * already ship together.
 */

/** 1 MiB of encoded output. The child enforces it; the parent re-checks. */
export const SCRIPT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Parent → child. Sent once, immediately after the fork. */
export interface ScriptExecuteRequest {
  type: "execute";
  /**
   * The script, as the real-path file URL Node resolved its entry module to.
   * The runner re-imports it — a cache hit — to tell a script that finished
   * from one parked inside a top-level `await` that never settles.
   */
  scriptUrl: string;
  /** The current flow output, already encoded. PR 1 always sends `"{}"`. */
  outputJson: string;
  /** The child's own copy of the hard time limit, for its deadline watchdog. */
  deadlineMs: number;
  /** The encoded-output ceiling the child enforces. */
  maxOutputBytes: number;
}

/**
 * Why a script did not produce output, as the child sees it.
 *
 * `load` is a module that never evaluated (missing file, bad syntax, an import
 * Node refused); `runtime` is the script's own code throwing; `output` is a
 * value that cannot cross into flow state; `protocol` is the runner itself
 * failing before or around the script.
 */
export type ScriptFailureType = "load" | "runtime" | "output" | "protocol";

/**
 * Child → parent. `started` is load-bearing: it is the only thing that lets the
 * parent tell "the runner never began the script" apart from "the script
 * stopped its own process".
 */
export type ScriptResponse =
  | { type: "started" }
  | { type: "result"; outputJson: string }
  | {
      type: "failure";
      failureType: ScriptFailureType;
      message: string;
      stack?: string;
    };

/** The two responses that end a run. `started` is not one of them. */
export type ScriptTerminalResponse = Exclude<ScriptResponse, { type: "started" }>;

const FAILURE_TYPES: readonly ScriptFailureType[] = ["load", "runtime", "output", "protocol"];

/**
 * Validate one message off the IPC channel.
 *
 * Returns `null` for anything that matches no shape. The parent treats that as
 * a protocol failure rather than coercing it: a script runs arbitrary code, so
 * a malformed message means the runner is no longer behaving, and guessing at
 * its intent is how a wrong verdict reaches the report.
 */
export function parseScriptResponse(raw: unknown): ScriptResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  switch (msg.type) {
    case "started":
      return { type: "started" };
    case "result":
      return typeof msg.outputJson === "string"
        ? { type: "result", outputJson: msg.outputJson }
        : null;
    case "failure": {
      const failureType = msg.failureType;
      if (typeof failureType !== "string") return null;
      if (!FAILURE_TYPES.includes(failureType as ScriptFailureType)) return null;
      if (typeof msg.message !== "string") return null;
      return {
        type: "failure",
        failureType: failureType as ScriptFailureType,
        message: msg.message,
        ...(typeof msg.stack === "string" ? { stack: msg.stack } : {}),
      };
    }
    default:
      return null;
  }
}

/** Narrows a response to the two shapes that end a run. */
export function isTerminalResponse(response: ScriptResponse): response is ScriptTerminalResponse {
  return response.type === "result" || response.type === "failure";
}
