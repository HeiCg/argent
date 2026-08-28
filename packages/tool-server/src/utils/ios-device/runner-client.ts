import { randomUUID } from "node:crypto";
import { FAILURE_CODES, withFailureSignal, type FailureSignal } from "@argent/registry";
import { sleep, type SendRunnerCommand } from "./runner-route";
import {
  appendHintToMessage,
  IosDeviceTransportError,
  isIosDeviceTransportError,
  type IosDeviceTransportErrorKind,
} from "./usbmux-protocol";

/**
 * Command client for the on-device XCUITest runner: stamps command ids,
 * interprets the runner's JSON envelope, and (the part that earns its keep)
 * recovers mutating commands whose transport response was lost.
 *
 * A lost response does not mean the command did not run: the tap may have
 * landed and only the reply died with the cable. Replaying would tap twice, so
 * instead the client asks the runner what happened to that exact commandId
 * (`status` + statusCommandId) and either returns the retained response,
 * surfaces the runner's own failure, or (only when the runner cannot say)
 * rethrows the transport error for the caller to handle conservatively.
 */

/** Default client window per send; PROTOCOL.md's "Timeout budgets" table is the contract. */
export const RUNNER_COMMAND_TIMEOUT_MS = 45_000;
/**
 * Recovery must be fast: it runs while a user-visible command is already
 * failing, and a reachable runner answers `status` in milliseconds. The 3s is
 * one whole-transport budget per send attempt (usbmux handshake and HTTP
 * exchange included), and a runner that cannot answer within it is
 * effectively gone, so the transport error is the honest answer.
 */
const RUNNER_STATUS_RECOVERY_TIMEOUT_MS = 3_000;
const RUNNER_READY_POLL_INTERVAL_MS = 250;
/** Readiness probes are cheap; keep each one short so a dead port fails fast. */
const RUNNER_READY_PROBE_TIMEOUT_MS = 2_000;

const RUNNER_BUSY_ERROR_CODE = "RUNNER_BUSY";
/** unwrapEnvelope's verdict for a reply that was not a runner envelope at all. */
const INVALID_RUNNER_RESPONSE_CODE = "INVALID_RUNNER_RESPONSE";

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
  /**
   * The runner re-fronted a backgrounded target app before executing this
   * command (PROTOCOL.md, Envelope). Encoded only when true; an
   * already-foreground target's reply never carries the field.
   */
  reactivated?: boolean;
  /**
   * Advisory on an ok reply (PROTOCOL.md, Envelope): the mutation succeeded,
   * but suppressed accessibility noise grew during it, so the effect deserves
   * a re-observe. Encoded only when set; clean replies never carry the field.
   */
  warning?: string;
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

    if (options.code !== undefined) {
      this.code = options.code;
    }

    if (options.hint !== undefined) {
      this.hint = options.hint;
    }

    this.retryable = options.code === RUNNER_BUSY_ERROR_CODE;

    // Telemetry stamp so a runner-reported failure classifies instead of
    // landing in the registry's unclassified fallback. The physical-iOS code
    // family has no runner-command constant, so this reuses its one
    // command-failure code; the stage tells the channels apart
    // (ios_devicectl_command vs ios_device_runner_command). The runner's own
    // wire `code` stays on the `code` field: the envelope's open set does not
    // map onto the closed error_kind list, so the kind stays coarse.
    withFailureSignal(this, {
      error_code: FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED,
      failure_stage: "ios_device_runner_command",
      failure_area: "tool_server",
      error_kind: "unknown",
    });
  }
}

/**
 * Failure signal for a transport error surfacing to users. Stamped HERE, not
 * in the IosDeviceTransportError constructor: usbmux-protocol.ts is
 * deliberately dependency-free (see its header) and cannot import
 * `@argent/registry`, so classification happens at this layer boundary, where
 * the errors are (re)thrown to callers. One code for "the runner was
 * unreachable for this command"; the transport `kind` maps onto the
 * error_kind/network_failure axes so telemetry can split cable, port, and
 * mid-exchange failures.
 */
function transportFailureSignal(kind: IosDeviceTransportErrorKind): FailureSignal {
  const base = {
    error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
    failure_stage: "ios_device_runner_transport",
    failure_area: "tool_server",
  } as const;

  switch (kind) {
    case "device-unattached":
      return { ...base, error_kind: "not_found" };
    case "runner-not-listening":
      return { ...base, error_kind: "network", network_failure: "connection_refused" };
    case "timeout":
      return { ...base, error_kind: "timeout" };
    case "protocol":
      return { ...base, error_kind: "network", network_failure: "invalid_response" };
    case "http":
      return { ...base, error_kind: "network", network_failure: "other" };
  }
}

export interface RunCommandOptions {
  /** See SendRunnerCommandOptions: read-only commands may be retried by the send layer. */
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
  /** The usbmux sender's sendCommand, injected so the client is transport-agnostic. */
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
      if (!isIosDeviceTransportError(error)) {
        throw error;
      }

      // Stamp once at catch-entry: every path below (the direct rethrows and
      // recovery's `throw transportError`) surfaces this same object, and the
      // in-place stamp preserves error identity for callers that compare it.
      withFailureSignal(error, transportFailureSignal(error.kind));

      // Read-only commands are idempotent: the send layer already retried
      // them, and there is nothing to recover. Status commands must never
      // recurse into recovery.
      if (readOnly || command.command === "status" || !commandId) {
        throw error;
      }

      // Pre-send kinds: the usbmux connection never opened, so the command
      // cannot have executed and a status probe would ride the same dead route.
      if (error.kind === "device-unattached" || error.kind === "runner-not-listening") {
        throw error;
      }

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
      // The status probe failing tells us nothing new; the original
      // transport error remains the most truthful report.
      throw transportError;
    }

    const state = typeof status.state === "string" ? status.state : "";

    if (state === "completed") {
      const retained = parseRetainedResponse(status.responseJson);

      // The retained JSON is the response the transport lost, envelope and
      // all: an ok:false in it surfaces as the command's real outcome.
      if (retained && asEnvelope(retained)) {
        return unwrapEnvelope(retained);
      }

      // Completed but nothing (usable) retained: the effect happened, the
      // result is gone. Do not pretend to have data; surface the transport
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
 * Poll `status` until the runner produces its first parsed envelope. Even an
 * ok:false envelope counts as ready: it proves the HTTP stack on the device is
 * up, which is all readiness means here.
 *
 * A reply that is NOT an envelope does not count. The port comes from
 * pickFreePort and the runner binds it only later, so whatever else grabbed it
 * in between would otherwise answer the first probe, end the wait in success,
 * and leave the first real command to fail.
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
      throw withFailureSignal(
        new IosDeviceTransportError(
          "timeout",
          `Runner did not become ready within ${options.timeoutMs}ms`,
          { retryable: false, cause: lastError }
        ),
        transportFailureSignal("timeout")
      );
    }

    try {
      await client.run(
        { command: "status" },
        { readOnly: true, timeoutMs: Math.min(remainingMs, RUNNER_READY_PROBE_TIMEOUT_MS) }
      );

      return;
    } catch (error) {
      if (error instanceof RunnerCommandError && error.code !== INVALID_RUNNER_RESPONSE_CODE) {
        return;
      }

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
  if (command.command === "status" || typeof command.commandId === "string") {
    return command;
  }

  return { ...command, commandId: `argent-${randomUUID()}` };
}

function unwrapEnvelope(response: unknown): unknown {
  const envelope = asEnvelope(response);

  if (!envelope) {
    throw new RunnerCommandError("Runner returned an unrecognized response shape", {
      code: INVALID_RUNNER_RESPONSE_CODE,
    });
  }

  if (envelope.ok) {
    return withEnvelopeMarkers(envelope);
  }

  throw new RunnerCommandError(envelope.error?.message ?? "Runner command failed", {
    code: envelope.error?.code,
    hint: envelope.error?.hint,
  });
}

/**
 * A success envelope's out-of-band markers ride the returned data object:
 * `reactivated: true` means the runner re-fronted a backgrounded target
 * before executing (the foreground screen changed as a side effect of the
 * command), and `warning` carries the runner's advisory on an ok mutation
 * (suppressed accessibility noise grew during it). Success replies have no
 * hint channel (hints are folded into error messages only), so the markers
 * are copied onto the data object for the tool layer to surface; one reply
 * can carry both. An envelope without markers returns its data untouched:
 * same reference, byte-identical behavior.
 */
function withEnvelopeMarkers(envelope: RunnerResponseEnvelope): unknown {
  const reactivated = envelope.reactivated === true;
  const warning = typeof envelope.warning === "string" ? envelope.warning : undefined;

  if (!reactivated && warning === undefined) {
    return envelope.data;
  }

  const data = envelope.data;

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return data;
  }

  return {
    ...data,
    ...(reactivated ? { reactivated: true } : {}),
    ...(warning !== undefined ? { warning } : {}),
  };
}

function asEnvelope(response: unknown): RunnerResponseEnvelope | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }

  const candidate = response as { ok?: unknown };

  if (typeof candidate.ok !== "boolean") {
    return null;
  }

  return response as RunnerResponseEnvelope;
}

function parseRetainedResponse(value: unknown): unknown | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
