import { postRunnerCommand } from "./runner-http";
import { createDeadline, openUsbmuxRunnerSocket, type Deadline } from "./usbmux";
import { isIosDeviceTransportError } from "./usbmux-protocol";

/**
 * The usbmux send for physical iOS devices, wrapped in retry policy: mutating
 * commands go out AT MOST ONCE, read-only commands retry with backoff on
 * retryable errors. USB cable is the only transport — the CoreDevice Wi-Fi
 * tunnel could reach a cable-less device too, but it re-probes `devicectl` —
 * seconds per command — and has never been hardware-verified, so it is
 * deliberately not a fallback: a Wi-Fi-only device fails fast with usbmuxd's
 * typed "device-unattached" verdict, whose hint says to connect the cable.
 */

const READ_ONLY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 300;
const RETRY_MAX_DELAY_MS = 2_000;

export interface SendRunnerCommandOptions {
  timeoutMs: number;
  /**
   * Read-only commands are idempotent and may be retried on retryable
   * transport errors. Mutating commands (the default) are sent AT MOST ONCE:
   * a lost response does not prove the command did not execute, so replaying
   * it could tap twice.
   */
  readOnly?: boolean;
}

export type SendRunnerCommand = (
  udid: string,
  port: number,
  body: unknown,
  options: SendRunnerCommandOptions
) => Promise<unknown>;

export function createUsbmuxCommandSender(
  options: {
    /**
     * Test seam: replaces the usbmux socket + HTTP send. The deadline is the
     * whole send's budget — created fresh per attempt, already ticking.
     */
    sendViaUsbmux?: (
      udid: string,
      port: number,
      body: unknown,
      deadline: Deadline
    ) => Promise<unknown>;
  } = {}
): { sendCommand: SendRunnerCommand } {
  const sendViaUsbmux = options.sendViaUsbmux ?? defaultSendViaUsbmux;

  return {
    sendCommand: async (udid, port, body, sendOptions) => {
      if (!sendOptions.readOnly) {
        return sendViaUsbmux(udid, port, body, createDeadline(sendOptions.timeoutMs));
      }
      let lastError: unknown;
      for (let attempt = 1; attempt <= READ_ONLY_MAX_ATTEMPTS; attempt += 1) {
        try {
          // A fresh deadline per attempt: timeoutMs is the per-attempt budget
          // (backoff sleeps between attempts do not spend from it).
          return await sendViaUsbmux(udid, port, body, createDeadline(sendOptions.timeoutMs));
        } catch (error) {
          lastError = error;
          const retryable = isIosDeviceTransportError(error) && error.retryable;
          if (!retryable || attempt === READ_ONLY_MAX_ATTEMPTS) throw error;
          await sleep(Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS));
        }
      }
      // Unreachable: the loop always returns or throws. Kept for the type checker.
      throw lastError;
    },
  };
}

/**
 * The one deadline bounds the whole send: the usbmux handshake spends from the
 * same budget as the HTTP exchange (remainingMs is read when the factory
 * runs), so a slow handshake shrinks the HTTP stage's timeout instead of the
 * two stages each getting the full timeoutMs.
 */
function defaultSendViaUsbmux(
  udid: string,
  port: number,
  body: unknown,
  deadline: Deadline
): Promise<unknown> {
  return postRunnerCommand({
    socketFactory: () => openUsbmuxRunnerSocket({ udid, port, timeoutMs: deadline.remainingMs() }),
    body,
    deadline,
  });
}

/** Also serves runner-client's readiness poll — deliberately defined once. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
