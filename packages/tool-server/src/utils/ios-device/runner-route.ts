import { postRunnerCommand, postRunnerCommandTcp } from "./runner-http";
import { openUsbmuxRunnerSocket } from "./usbmux";
import { isIosDeviceTransportError } from "./usbmux-protocol";

/**
 * Route resolution for physical iOS devices.
 *
 * Cabled devices are reached through usbmux: usbmuxd answers in milliseconds
 * and stays responsive across idle gaps, whereas the CoreDevice tunnel route
 * re-probes `devicectl` — seconds per command once its short-lived cache
 * expires. So every attempt tries usbmux FIRST, unconditionally. Only the
 * typed "device-unattached" verdict (usbmuxd answered and the device is simply
 * not on a cable — i.e. Wi-Fi-only) falls back to the tunnel, and it does so
 * within the same logical attempt: the command was never delivered over
 * usbmux, so the fallback cannot double-send, and burning a retry round-trip
 * on it would only add latency.
 */

/**
 * Tunnel IPs are stable for the lifetime of a device connection, and the
 * `devicectl` lookup that produces them costs seconds. 30s keeps a burst of
 * commands on one lookup while still noticing a re-established tunnel quickly.
 */
const TUNNEL_IP_CACHE_TTL_MS = 30_000;

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

export function createRunnerRouteResolver(options: {
  /**
   * Injected (the devicectl wrapper provides it) so this module stays free of
   * subprocess dependencies. Resolves the CoreDevice tunnel IP for a device,
   * or null when the device has no tunnel (e.g. XCTest-only backends).
   */
  resolveTunnelIpAddress: (udid: string) => Promise<string | null>;
  /** Test seam: replaces the usbmux socket + HTTP send. */
  sendViaUsbmux?: (
    udid: string,
    port: number,
    body: unknown,
    timeoutMs: number
  ) => Promise<unknown>;
  /** Test seam: replaces the tunnel TCP send. */
  sendViaTunnel?: (
    host: string,
    port: number,
    body: unknown,
    timeoutMs: number
  ) => Promise<unknown>;
}): { sendCommand: SendRunnerCommand } {
  const sendViaUsbmux = options.sendViaUsbmux ?? defaultSendViaUsbmux;
  const sendViaTunnel = options.sendViaTunnel ?? defaultSendViaTunnel;
  // Per-resolver rather than module-global: two resolvers (e.g. tests, or a
  // future multi-daemon setup) must not share stale tunnel state.
  const tunnelIpCache = new Map<string, { ip: string; expiresAt: number }>();

  const readCachedTunnelIp = (udid: string): string | null => {
    const cached = tunnelIpCache.get(udid);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      tunnelIpCache.delete(udid);
      return null;
    }
    return cached.ip;
  };

  const lookupTunnelIp = async (udid: string): Promise<string | null> => {
    const ip = await options.resolveTunnelIpAddress(udid);
    if (ip) tunnelIpCache.set(udid, { ip, expiresAt: Date.now() + TUNNEL_IP_CACHE_TTL_MS });
    return ip;
  };

  /**
   * One logical attempt: usbmux, then — only on the unattached verdict — the
   * tunnel. The unattached verdict is pre-send by construction (usbmuxd
   * refused to even open the pipe), so falling back here never risks a double
   * delivery, even for mutating commands.
   */
  const attemptOnce = async (
    udid: string,
    port: number,
    body: unknown,
    sendOptions: SendRunnerCommandOptions
  ): Promise<unknown> => {
    try {
      return await sendViaUsbmux(udid, port, body, sendOptions.timeoutMs);
    } catch (error) {
      if (!isIosDeviceTransportError(error) || error.kind !== "device-unattached") throw error;
      const cachedIp = readCachedTunnelIp(udid);
      const ip = cachedIp ?? (await lookupTunnelIp(udid));
      // No tunnel either: the unattached verdict (with its cable hint) is the
      // most actionable error, so surface it rather than a lookup failure.
      if (!ip) throw error;
      try {
        return await sendViaTunnel(ip, port, body, sendOptions.timeoutMs);
      } catch (tunnelError) {
        // First failure invalidates: a dead tunnel IP would otherwise poison
        // every command for the rest of the TTL.
        tunnelIpCache.delete(udid);
        // A stale CACHED IP earns one refreshed lookup within the attempt.
        // Restricted to read-only commands: the failed TCP send may have
        // reached the runner before dying, and re-sending a mutating command
        // would break the at-most-once guarantee.
        if (cachedIp && sendOptions.readOnly) {
          const refreshedIp = await lookupTunnelIp(udid);
          if (refreshedIp && refreshedIp !== cachedIp) {
            return await sendViaTunnel(refreshedIp, port, body, sendOptions.timeoutMs);
          }
        }
        throw tunnelError;
      }
    }
  };

  return {
    sendCommand: async (udid, port, body, sendOptions) => {
      if (!sendOptions.readOnly) {
        try {
          return await attemptOnce(udid, port, body, sendOptions);
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
          return await attemptOnce(udid, port, body, sendOptions);
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

function defaultSendViaTunnel(
  host: string,
  port: number,
  body: unknown,
  timeoutMs: number
): Promise<unknown> {
  return postRunnerCommandTcp({ host, port, body, timeoutMs });
}

function readCommandId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const commandId = (body as { commandId?: unknown }).commandId;
  return typeof commandId === "string" && commandId.length > 0 ? commandId : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
