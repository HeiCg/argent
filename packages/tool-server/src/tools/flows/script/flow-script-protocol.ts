/**
 * The IPC protocol between the flow script executor and the
 * `flow-script-runner.mjs` child it forks: an `execute` request out, then
 * `started` and one terminal response back.
 *
 * The runner has two modes, and `interpreter` is what picks one. In `node` mode
 * it rides in as an `--import` preload in front of the script itself, and the
 * document crosses this channel in both directions. In `bash` mode it is the
 * entry module and spawns bash as its own child, so the document travels
 * through the two files the executor names in the request instead — bash has no
 * IPC channel, and the runner closes its own to what it starts.
 *
 * Script logs never travel here — they ride stdout/stderr, which the parent
 * drains and discards.
 */

export const SCRIPT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * An error message is script-controlled — a `throw` interpolating a whole
 * response body is the ordinary shape — and an IPC message is deserialized
 * whole into the parent's heap before anything can look at it, so only the
 * sender can bound it. The parent re-checks, because it must not depend on a
 * child staying compliant after arbitrary script code has run inside it.
 * `flow-script-runner.mjs` keeps its own copy — it imports nothing from here.
 */
export const SCRIPT_MAX_FAILURE_MESSAGE_CHARS = 8 * 1024;
export const SCRIPT_MAX_FAILURE_STACK_CHARS = 16 * 1024;

interface ScriptExecuteCommon {
  type: "execute";
  deadlineMs: number;
  maxOutputBytes: number;
}

export interface ScriptExecuteNodeRequest extends ScriptExecuteCommon {
  interpreter: "node";
  /**
   * The script, as the real-path file URL Node resolved its entry module to.
   * The runner re-imports it — a cache hit — to tell a script that finished
   * from one parked inside a top-level `await` that never settles.
   */
  scriptUrl: string;
  outputJson: string;
}

export interface ScriptExecuteBashRequest extends ScriptExecuteCommon {
  interpreter: "bash";
  /** Absolute, resolved by the parent; the runner runs what it is told. */
  interpreterPath: string;
  /** bash's one argument, and `$0`. Forward slashes on every platform. */
  scriptPath: string;
  /** `$ARGENT_OUTPUT`: the document, in and out. Created by the parent. */
  outputFile: string;
  /** `$ARGENT_REASON`: the failure text, read only on a non-zero exit. */
  reasonFile: string;
}

/**
 * The runner never inspects an extension — it runs what the request names,
 * which is what lets a test drive bash mode with any file name.
 */
export type ScriptExecuteRequest = ScriptExecuteNodeRequest | ScriptExecuteBashRequest;

export type ScriptFailureType =
  | "load"
  | "runtime"
  | "output"
  | "exit"
  | "protocol"
  | "spawn"
  | "signal";

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

export type ScriptTerminalResponse = Exclude<ScriptResponse, { type: "started" }>;

const FAILURE_TYPES: readonly ScriptFailureType[] = [
  "load",
  "runtime",
  "output",
  "exit",
  "protocol",
  // Bash mode only: the runner spawns its own child there, so it is the side
  // that learns bash could not be started or was killed by a signal. In node
  // mode the parent reaches both conclusions itself.
  "spawn",
  "signal",
];

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
