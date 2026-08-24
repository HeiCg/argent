/**
 * The IPC protocol between the flow script executor and the
 * `flow-script-runner.mjs` child it forks: an `execute` request out, then
 * `started` and one terminal response back.
 *
 * Script logs never travel here — they ride stdout/stderr, so that console text
 * and any subprocess the script starts land in one stream in written order, and
 * so that a limit can apply while draining rather than after a whole message
 * has been serialized.
 */

/** 1 MiB of encoded output. The child enforces it; the parent re-checks. */
export const SCRIPT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Ceilings on the two free-text fields of a `failure`. An error message is
 * script-controlled — a `throw` that interpolates a whole response body is the
 * ordinary shape — and an IPC message is deserialized whole into the parent's
 * heap before anything can look at it, so only the sender can bound it. The
 * child enforces both; the parent re-checks, because it must not depend on a
 * child staying compliant after arbitrary script code has run inside it.
 * `flow-script-runner.mjs` keeps its own copy — it imports nothing from here.
 */
export const SCRIPT_MAX_FAILURE_MESSAGE_CHARS = 8 * 1024;
export const SCRIPT_MAX_FAILURE_STACK_CHARS = 16 * 1024;

/** Parent → child. Sent once, immediately after the fork. */
export interface ScriptExecuteRequest {
  type: "execute";
  /**
   * The script, as the real-path file URL Node resolved its entry module to.
   * The runner re-imports it — a cache hit — to tell a script that finished
   * from one parked inside a top-level `await` that never settles.
   */
  scriptUrl: string;
  /** The current flow output, already encoded. `"{}"` when the flow has none yet. */
  outputJson: string;
  deadlineMs: number;
  maxOutputBytes: number;
}

/**
 * `load` is a module that never evaluated (missing file, bad syntax, an import
 * Node refused); `runtime` is the script's own code throwing; `output` is a
 * value that cannot cross into flow state; `exit` is the script reporting its
 * own failure through a non-zero exit code; `protocol` is the runner itself
 * failing before or around the script.
 */
export type ScriptFailureType = "load" | "runtime" | "output" | "exit" | "protocol";

/**
 * Child → parent. `started` is the only thing that lets the parent tell "the
 * runner never began the script" apart from "the script stopped its own
 * process".
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

/** The two responses that end a run. */
export type ScriptTerminalResponse = Exclude<ScriptResponse, { type: "started" }>;

const FAILURE_TYPES: readonly ScriptFailureType[] = [
  "load",
  "runtime",
  "output",
  "exit",
  "protocol",
];

/**
 * `null` for anything that matches no shape. The parent treats that as a
 * protocol failure rather than coercing it: guessing at the intent of a runner
 * that has run arbitrary script code is how a wrong verdict reaches the report.
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

export function isTerminalResponse(response: ScriptResponse): response is ScriptTerminalResponse {
  return response.type === "result" || response.type === "failure";
}
