import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunnerRouteResolver } from "../src/utils/ios-device/runner-route";
import {
  IosDeviceTransportError,
  type IosDeviceTransportErrorKind,
} from "../src/utils/ios-device/usbmux-protocol";

const UDID = "00008110-000978540290401E";
const PORT = 8_100;
const OK = { ok: true, data: {} };

const unattachedError = (): IosDeviceTransportError =>
  new IosDeviceTransportError("device-unattached", "device not on cable", {
    retryable: false,
    hint: "Connect the device by cable, trust this Mac, keep it unlocked, and retry.",
  });

const notListeningError = (): IosDeviceTransportError =>
  new IosDeviceTransportError("runner-not-listening", "port closed", { retryable: true });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRunnerRouteResolver", () => {
  it("sends over usbmux without ever consulting the tunnel resolver", async () => {
    const resolveTunnelIpAddress = vi.fn(async () => "fd00::1");
    const sendViaUsbmux = vi.fn(async () => OK);
    const resolver = createRunnerRouteResolver({
      resolveTunnelIpAddress,
      sendViaUsbmux,
      sendViaTunnel: vi.fn(),
    });

    const result = await resolver.sendCommand(
      UDID,
      PORT,
      { command: "status" },
      {
        timeoutMs: 1_000,
        readOnly: true,
      }
    );

    expect(result).toBe(OK);
    expect(sendViaUsbmux).toHaveBeenCalledTimes(1);
    // The devicectl tunnel probe is the cost usbmux-first exists to avoid.
    expect(resolveTunnelIpAddress).not.toHaveBeenCalled();
  });

  it("falls back to the tunnel within the same attempt when usbmux reports unattached", async () => {
    const sendViaUsbmux = vi.fn(async () => {
      throw unattachedError();
    });
    const sendViaTunnel = vi.fn(async () => OK);
    const resolveTunnelIpAddress = vi.fn(async () => "fd00::123");
    const resolver = createRunnerRouteResolver({
      resolveTunnelIpAddress,
      sendViaUsbmux,
      sendViaTunnel,
    });

    const result = await resolver.sendCommand(
      UDID,
      PORT,
      { command: "status" },
      {
        timeoutMs: 1_000,
        readOnly: true,
      }
    );

    expect(result).toBe(OK);
    // One usbmux probe, then the tunnel — no retry round-trip in between.
    expect(sendViaUsbmux).toHaveBeenCalledTimes(1);
    expect(sendViaTunnel).toHaveBeenCalledTimes(1);
    expect(sendViaTunnel).toHaveBeenCalledWith("fd00::123", PORT, { command: "status" }, 1_000);
  });

  it("surfaces the unattached verdict when no tunnel exists either", async () => {
    const sendViaUsbmux = vi.fn(async () => {
      throw unattachedError();
    });
    const resolver = createRunnerRouteResolver({
      resolveTunnelIpAddress: async () => null,
      sendViaUsbmux,
      sendViaTunnel: vi.fn(),
    });

    const error = await resolver
      .sendCommand(UDID, PORT, { command: "status" }, { timeoutMs: 1_000, readOnly: true })
      .catch((caught: unknown) => caught);

    // The cable hint is the actionable message; a lookup failure would bury it.
    expect((error as IosDeviceTransportError).kind).toBe(
      "device-unattached" satisfies IosDeviceTransportErrorKind
    );
    expect((error as IosDeviceTransportError).hint).toMatch(/cable/);
  });

  it("caches the tunnel IP per udid for 30s, then looks it up again", async () => {
    const sendViaUsbmux = vi.fn(async () => {
      throw unattachedError();
    });
    const sendViaTunnel = vi.fn(async () => OK);
    const resolveTunnelIpAddress = vi.fn(async () => "fd00::123");
    const resolver = createRunnerRouteResolver({
      resolveTunnelIpAddress,
      sendViaUsbmux,
      sendViaTunnel,
    });
    const send = () =>
      resolver.sendCommand(UDID, PORT, { command: "status" }, { timeoutMs: 1_000, readOnly: true });

    await send();
    vi.advanceTimersByTime(29_000);
    await send();
    expect(resolveTunnelIpAddress).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await send();
    expect(resolveTunnelIpAddress).toHaveBeenCalledTimes(2);
  });

  it("invalidates a failed cached tunnel IP and retries one refreshed lookup within the attempt", async () => {
    const sendViaUsbmux = vi.fn(async () => {
      throw unattachedError();
    });
    const tunnelIps = ["fd00::123", "fd00::456"];
    const resolveTunnelIpAddress = vi.fn(async () => tunnelIps.shift() ?? null);
    const sendViaTunnel = vi.fn(async (host: string) => {
      if (host === "fd00::456") return OK;
      // Non-retryable so the read-only outer retry loop stays out of the
      // picture — this test isolates cache invalidation, not retries.
      throw new IosDeviceTransportError("protocol", `stale tunnel ${host}`, { retryable: false });
    });
    const resolver = createRunnerRouteResolver({
      resolveTunnelIpAddress,
      sendViaUsbmux,
      sendViaTunnel,
    });

    // Warm the cache with the soon-to-be-stale IP. This send itself fails
    // (fresh lookup, so no refresh retry) — the point is the cache write.
    await resolver
      .sendCommand(UDID, PORT, { command: "status" }, { timeoutMs: 1_000, readOnly: true })
      .catch(() => undefined);
    resolveTunnelIpAddress.mockClear();
    sendViaTunnel.mockClear();

    // The failed attempt invalidated the cache, so this send performs a fresh
    // lookup, gets the new IP, and succeeds first try.
    const result = await resolver.sendCommand(
      UDID,
      PORT,
      { command: "status" },
      {
        timeoutMs: 1_000,
        readOnly: true,
      }
    );

    expect(result).toBe(OK);
    expect(resolveTunnelIpAddress).toHaveBeenCalledTimes(1);
    expect(sendViaTunnel.mock.calls.map(([host]) => host)).toEqual(["fd00::456"]);
  });

  it("retries a refreshed IP inside one attempt when the CACHED tunnel IP fails a read-only send", async () => {
    const sendViaUsbmux = vi.fn(async () => {
      throw unattachedError();
    });
    let staleFailed = false;
    const sendViaTunnel = vi.fn(async (host: string) => {
      if (host === "fd00::123" && staleFailed) {
        throw new IosDeviceTransportError("http", "stale tunnel", { retryable: true });
      }
      if (host === "fd00::123") {
        staleFailed = true;
        return OK;
      }
      return OK;
    });
    const tunnelIps = ["fd00::123", "fd00::456"];
    const resolveTunnelIpAddress = vi.fn(async () => tunnelIps.shift() ?? null);
    const resolver = createRunnerRouteResolver({
      resolveTunnelIpAddress,
      sendViaUsbmux,
      sendViaTunnel,
    });
    const send = () =>
      resolver.sendCommand(UDID, PORT, { command: "status" }, { timeoutMs: 1_000, readOnly: true });

    await send(); // warms the cache with fd00::123 and succeeds
    const result = await send(); // cached IP now fails -> refreshed lookup -> fd00::456

    expect(result).toBe(OK);
    expect(resolveTunnelIpAddress).toHaveBeenCalledTimes(2);
    expect(sendViaTunnel.mock.calls.map(([host]) => host)).toEqual([
      "fd00::123",
      "fd00::123",
      "fd00::456",
    ]);
  });

  it("sends mutating commands AT MOST ONCE even for retryable transport errors", async () => {
    const sendViaUsbmux = vi.fn(async () => {
      throw notListeningError();
    });
    const resolver = createRunnerRouteResolver({
      resolveTunnelIpAddress: async () => null,
      sendViaUsbmux,
      sendViaTunnel: vi.fn(),
    });

    const error = await resolver
      .sendCommand(
        UDID,
        PORT,
        { command: "tap", commandId: "argent-abc", x: 10, y: 20 },
        { timeoutMs: 1_000 }
      )
      .catch((caught: unknown) => caught);

    expect(sendViaUsbmux).toHaveBeenCalledTimes(1);
    expect((error as IosDeviceTransportError).kind).toBe("runner-not-listening");
    // The typed error carries the commandId so the caller can run status recovery.
    expect((error as IosDeviceTransportError).commandId).toBe("argent-abc");
  });

  it("does not retry the refreshed tunnel lookup for mutating commands", async () => {
    const sendViaUsbmux = vi.fn(async () => {
      throw unattachedError();
    });
    let calls = 0;
    const sendViaTunnel = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return OK; // read-only warm-up over the cache-filling IP
      throw new IosDeviceTransportError("http", "stale tunnel", { retryable: true });
    });
    const resolveTunnelIpAddress = vi.fn(async () => "fd00::123");
    const resolver = createRunnerRouteResolver({
      resolveTunnelIpAddress,
      sendViaUsbmux,
      sendViaTunnel,
    });

    await resolver.sendCommand(
      UDID,
      PORT,
      { command: "status" },
      {
        timeoutMs: 1_000,
        readOnly: true,
      }
    );
    const error = await resolver
      .sendCommand(UDID, PORT, { command: "tap", commandId: "argent-x" }, { timeoutMs: 1_000 })
      .catch((caught: unknown) => caught);

    // The cached-IP failure may have reached the runner; re-sending over a
    // refreshed IP would break at-most-once, so only the lookup cache is
    // invalidated and the error surfaces.
    expect(error).toBeInstanceOf(IosDeviceTransportError);
    expect(sendViaTunnel).toHaveBeenCalledTimes(2);
    expect(resolveTunnelIpAddress).toHaveBeenCalledTimes(1);
  });

  it("retries read-only commands on retryable errors with backoff, up to 3 attempts", async () => {
    const sendViaUsbmux = vi
      .fn()
      .mockRejectedValueOnce(notListeningError())
      .mockRejectedValueOnce(notListeningError())
      .mockResolvedValueOnce(OK);
    const resolver = createRunnerRouteResolver({
      resolveTunnelIpAddress: async () => null,
      sendViaUsbmux,
      sendViaTunnel: vi.fn(),
    });

    const pending = resolver.sendCommand(
      UDID,
      PORT,
      { command: "status" },
      {
        timeoutMs: 1_000,
        readOnly: true,
      }
    );
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(OK);
    expect(sendViaUsbmux).toHaveBeenCalledTimes(3);
  });

  it("gives up read-only retries after 3 attempts", async () => {
    const sendViaUsbmux = vi.fn(async () => {
      throw notListeningError();
    });
    const resolver = createRunnerRouteResolver({
      resolveTunnelIpAddress: async () => null,
      sendViaUsbmux,
      sendViaTunnel: vi.fn(),
    });

    const pending = resolver
      .sendCommand(UDID, PORT, { command: "status" }, { timeoutMs: 1_000, readOnly: true })
      .catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();

    expect(await pending).toBeInstanceOf(IosDeviceTransportError);
    expect(sendViaUsbmux).toHaveBeenCalledTimes(3);
  });

  it("does not retry read-only commands on non-retryable errors", async () => {
    const sendViaUsbmux = vi.fn(async () => {
      throw new IosDeviceTransportError("protocol", "bad packet", { retryable: false });
    });
    const resolver = createRunnerRouteResolver({
      resolveTunnelIpAddress: async () => null,
      sendViaUsbmux,
      sendViaTunnel: vi.fn(),
    });

    const error = await resolver
      .sendCommand(UDID, PORT, { command: "status" }, { timeoutMs: 1_000, readOnly: true })
      .catch((caught: unknown) => caught);

    expect((error as IosDeviceTransportError).kind).toBe("protocol");
    expect(sendViaUsbmux).toHaveBeenCalledTimes(1);
  });
});
