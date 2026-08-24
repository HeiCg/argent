import { randomUUID } from "node:crypto";
import type { SendRunnerCommand } from "./runner-route";
import { IosDeviceTransportError, isIosDeviceTransportError } from "./usbmux-protocol";

/**
 * Command client for the on-device XCUITest runner: stamps command ids,
 * interprets the runner's JSON envelope, and — the part that earns its keep —
 * recovers mutating commands whose transport response was lost.
 *
 * A lost response does not mean the command did not run: the tap may have
 * landed and only the reply died with the cable. Replaying would tap twice, so
 * instead the client asks the runner what happened to that exact commandId
 * (`status` + statusCommandId) and either returns the retained response,
 * surfaces the runner's own failure, or — only when the runner cannot say —
 * rethrows the transport error for the caller to handle conservatively.
 */

export const RUNNER_COMMAND_TIMEOUT_MS = 45_000;
/**
 * Recovery must be fast: it runs while a user-visible command is already
 * failing, and a reachable runner answers `status` in milliseconds. A runner
 * that cannot answer within 3s is effectively gone, and the transport error
 * is the honest answer.
 */
const RUNNER_STATUS_RECOVERY_TIMEOUT_MS = 3_000;
const RUNNER_READY_POLL_INTERVAL_MS = 250;
/** Readiness probes are cheap; keep each one short so a dead port fails fast. */
const RUNNER_READY_PROBE_TIMEOUT_MS = 2_000;

/** The command codes the runner flags as safe to retry after it answered. */
const RUNNER_BUSY_ERROR_CODE = "RUNNER_BUSY";

export interface RunnerCommand {
  command: string;
  commandId?: string;
  statusCommandId?: string;
  [key: string]: unknown;
}

export interface RunnerResponseError {
  code?: string;
  message: string;
  hint?: string;
}

export interface RunnerResponseEnvelope {
  ok: boolean;
  data?: unknown;
  error?: RunnerResponseError;
}

/**
 * Fold the runner's recovery hint into the message at construction time:
 * agent-facing error rendering surfaces only `.message` (walked down the
 * .cause chain), so guidance left on the `.hint` property alone would be
 * write-only. Skips the append when the message already carries the hint text.
 */
function appendHintToMessage(message: string, hint: string | undefined): string {
  if (!hint || message.includes(hint)) return message;
  return `${message}${/[.!?]$/.test(message) ? "" : "."} Hint: ${hint}`;
}

/**
 * A failure the RUNNER reported (as opposed to a transport failure): the
 * envelope parsed and carried ok:false. `retryable` is true only for
 * RUNNER_BUSY, the runner's explicit "try again" verdict.
 */
export class RunnerCommandError extends Error {
  readonly code?: string;
  /** Kept for callers that branch on it; the message carries the same text. */
  readonly hint?: string;
  readonly retryable: boolean;

  constructor(message: string, options: { code?: string; hint?: string } = {}) {
    super(appendHintToMessage(message, options.hint));
    this.name = "RunnerCommandError";
    if (options.code !== undefined) this.code = options.code;
    if (options.hint !== undefined) this.hint = options.hint;
    this.retryable = options.code === RUNNER_BUSY_ERROR_CODE;
  }
}

export interface RunCommandOptions {
  /** See SendRunnerCommandOptions: read-only commands may be retried by the route layer. */
  readOnly?: boolean;
  timeoutMs?: number;
}

export interface RunnerClient {
  /**
   * Accepts any object (see RunnerCommand for the expected shape) so callers
   * assembling commands dynamically do not have to cast; the `command` field
   * is read defensively.
   */
  run(command: Record<string, unknown>, options?: RunCommandOptions): Promise<unknown>;
}

export function createRunnerClient(options: {
  udid: string;
  port: number;
  /** The route resolver's sendCommand — injected so the client is transport-agnostic. */
  send: SendRunnerCommand;
}): RunnerClient {
  const run = async (
    command: Record<string, unknown>,
    runOptions: RunCommandOptions = {}
  ): Promise<unknown> => {
    const timeoutMs = runOptions.timeoutMs ?? RUNNER_COMMAND_TIMEOUT_MS;
    const readOnly = runOptions.readOnly === true;
    const stamped = withCommandId(command);
    const commandId = typeof stamped.commandId === "string" ? stamped.commandId : undefined;
    try {
      const response = await options.send(options.udid, options.port, stamped, {
        timeoutMs,
        readOnly,
      });
      return unwrapEnvelope(response);
    } catch (error) {
      if (!isIosDeviceTransportError(error)) throw error;
      // Read-only commands are idempotent — the route layer already retried
      // them, and there is nothing to recover. Status commands must never
      // recurse into recovery.
      if (readOnly || command.command === "status" || !commandId) throw error;
      return await recoverAfterLostResponse(stamped, commandId, error);
    }
  };

  /**
   * The mutating-command lost-response protocol: ask the runner for the fate
   * of the exact commandId that was in flight.
   */
  const recoverAfterLostResponse = async (
    command: Record<string, unknown>,
    commandId: string,
    transportError: IosDeviceTransportError
  ): Promise<unknown> => {
    let status: Record<string, unknown>;
    try {
      const response = await options.send(
        options.udid,
        options.port,
        { command: "status", statusCommandId: commandId },
        { timeoutMs: RUNNER_STATUS_RECOVERY_TIMEOUT_MS, readOnly: true }
      );
      const data = unwrapEnvelope(response);
      status = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    } catch {
      // The status probe failing tells us nothing new — the original
      // transport error remains the most truthful report.
      throw transportError;
    }
    const state = typeof status.state === "string" ? status.state : "";
    if (state === "completed") {
      const retained = parseRetainedResponse(status.responseJson);
      // The retained JSON is the response the transport lost, envelope and
      // all — an ok:false in it surfaces as the command's real outcome.
      if (retained && asEnvelope(retained)) return unwrapEnvelope(retained);
      // Completed but nothing (usable) retained: the effect happened, the
      // result is gone. Do not pretend to have data — surface the transport
      // error.
      throw transportError;
    }
    if (state === "failed") {
      throw new RunnerCommandError(
        typeof status.errorMessage === "string"
          ? status.errorMessage
          : `Runner command "${String(command.command)}" failed`,
        {
          code: typeof status.errorCode === "string" ? status.errorCode : undefined,
          hint: typeof status.errorHint === "string" ? status.errorHint : undefined,
        }
      );
    }
    throw transportError;
  };

  return { run };
}

/**
 * Poll `status` until the runner produces its first parsed response. Any
 * parsed envelope counts as ready — even an ok:false one proves the HTTP
 * stack on the device is up, which is all readiness means here.
 */
export async function waitForRunnerReady(
  client: RunnerClient,
  options: { timeoutMs: number }
): Promise<void> {
  const expiresAt = Date.now() + options.timeoutMs;
  let lastError: unknown;
  for (;;) {
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      throw new IosDeviceTransportError(
        "timeout",
        `Runner did not become ready within ${options.timeoutMs}ms`,
        { retryable: false, cause: lastError }
      );
    }
    try {
      await client.run(
        { command: "status" },
        { readOnly: true, timeoutMs: Math.min(remainingMs, RUNNER_READY_PROBE_TIMEOUT_MS) }
      );
      return;
    } catch (error) {
      if (error instanceof RunnerCommandError) return;
      lastError = error;
    }
    await sleep(RUNNER_READY_POLL_INTERVAL_MS);
  }
}

/**
 * Every non-status command gets a fresh id so lost-response recovery can name
 * exactly the command it is asking about. Caller-provided ids are preserved
 * (retry orchestration above this layer may re-issue with a known id).
 */
function withCommandId(command: Record<string, unknown>): Record<string, unknown> {
  if (command.command === "status" || typeof command.commandId === "string") return command;
  return { ...command, commandId: `argent-${randomUUID()}` };
}

function unwrapEnvelope(response: unknown): unknown {
  const envelope = asEnvelope(response);
  if (!envelope) {
    throw new RunnerCommandError("Runner returned an unrecognized response shape", {
      code: "INVALID_RUNNER_RESPONSE",
    });
  }
  if (envelope.ok) return envelope.data;
  throw new RunnerCommandError(envelope.error?.message ?? "Runner command failed", {
    code: envelope.error?.code,
    hint: envelope.error?.hint,
  });
}

function asEnvelope(response: unknown): RunnerResponseEnvelope | null {
  if (typeof response !== "object" || response === null) return null;
  const candidate = response as { ok?: unknown };
  if (typeof candidate.ok !== "boolean") return null;
  return response as RunnerResponseEnvelope;
}

function parseRetainedResponse(value: unknown): unknown | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
