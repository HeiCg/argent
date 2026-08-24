import { postRunnerCommand } from "./runner-http";
import { openUsbmuxRunnerSocket } from "./usbmux";
import { isIosDeviceTransportError } from "./usbmux-protocol";

/**
 * Route resolution for physical iOS devices: usbmux (USB cable), only.
 *
 * usbmuxd answers in milliseconds and stays responsive across idle gaps. The
 * CoreDevice Wi-Fi tunnel could reach a cable-less device too, but it re-probes
 * `devicectl` — seconds per command — and has never been hardware-verified, so
 * it is deliberately not a route: a Wi-Fi-only device fails fast with usbmuxd's
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

export function createRunnerRouteResolver(
  options: {
    /** Test seam: replaces the usbmux socket + HTTP send. */
    sendViaUsbmux?: (
      udid: string,
      port: number,
      body: unknown,
      timeoutMs: number
    ) => Promise<unknown>;
  } = {}
): { sendCommand: SendRunnerCommand } {
  const sendViaUsbmux = options.sendViaUsbmux ?? defaultSendViaUsbmux;

  return {
    sendCommand: async (udid, port, body, sendOptions) => {
      if (!sendOptions.readOnly) {
        try {
          return await sendViaUsbmux(udid, port, body, sendOptions.timeoutMs);
        } catch (error) {
          // Carry the commandId on the typed error so the client can run
          // status recovery for exactly the command that was in flight.
          if (isIosDeviceTransportError(error)) {
            const commandId = readCommandId(body);
            if (commandId) error.commandId = commandId;
          }
          throw error;
        }
      }
      let lastError: unknown;
      for (let attempt = 1; attempt <= READ_ONLY_MAX_ATTEMPTS; attempt += 1) {
        try {
          return await sendViaUsbmux(udid, port, body, sendOptions.timeoutMs);
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

function defaultSendViaUsbmux(
  udid: string,
  port: number,
  body: unknown,
  timeoutMs: number
): Promise<unknown> {
  return postRunnerCommand({
    socketFactory: () => openUsbmuxRunnerSocket({ udid, port, timeoutMs }),
    body,
    timeoutMs,
  });
}

function readCommandId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const commandId = (body as { commandId?: unknown }).commandId;
  return typeof commandId === "string" && commandId.length > 0 ? commandId : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
