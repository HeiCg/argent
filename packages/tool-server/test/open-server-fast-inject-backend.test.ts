/**
 * Phase 3f — scrcpy fast-inject backend lifecycle, with `@yume-chan` mocked (no
 * device). Covers: lazy single connect reused across actions, injectTouch is fed
 * the ported timelines with device geometry as videoWidth/videoHeight and a
 * `bigint` pointerId, multi-pointer ids, and `dispose()` stopping the scrcpy
 * client + adb transport. Also asserts the `open-device-server-fast-inject` flag
 * is registered and off by default (so the tap/swipe/gesture closures are left on
 * the Kotlin channel unless it is explicitly enabled).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFlagDefinition, isFlagEnabled } from "@argent/configuration-core";

const h = vi.hoisted(() => {
  const injectTouchCalls: Array<Record<string, unknown>> = [];
  const controller = {
    injectTouch: vi.fn(async (m: Record<string, unknown>) => {
      injectTouchCalls.push(m);
    }),
  };
  const client = {
    controller,
    exited: new Promise<void>(() => undefined), // never resolves in these tests
    close: vi.fn(async () => undefined),
  };
  const adb = {
    subprocess: { noneProtocol: { spawnWaitText: vi.fn(async () => "present") } },
    close: vi.fn(async () => undefined),
  };
  return {
    injectTouchCalls,
    controller,
    client,
    adb,
    createAdb: vi.fn(async () => adb),
    start: vi.fn(async () => client),
    pushServer: vi.fn(async () => undefined),
  };
});

vi.mock("@yume-chan/adb", () => ({
  Adb: class {},
  AdbServerClient: class {
    createAdb = h.createAdb;
  },
}));
vi.mock("@yume-chan/adb-server-node-tcp", () => ({
  AdbServerNodeTcpConnector: class {},
}));
vi.mock("@yume-chan/adb-scrcpy", () => ({
  AdbScrcpyClient: { start: h.start, pushServer: h.pushServer },
  AdbScrcpyOptionsLatest: class {},
}));
vi.mock("@yume-chan/fetch-scrcpy-server", () => ({
  BIN: new URL("file:///dev/null"),
  VERSION: "3.3.1",
}));
vi.mock("@yume-chan/stream-extra", () => ({ ReadableStream: class {} }));
vi.mock("@yume-chan/scrcpy", () => ({
  AndroidMotionEventAction: { Down: 0, Up: 1, Move: 2, Cancel: 3, PointerDown: 5, PointerUp: 6 },
}));

// Imported after the mocks (vi.mock is hoisted).
import { createScrcpyInjectBackend } from "../src/utils/scrcpy-inject-backend";

const geom = { screenWidth: 1080, screenHeight: 2400, displayRotation: 0 };

function makeBackend() {
  const getScreenSize = vi.fn(async () => geom);
  const backend = createScrcpyInjectBackend({ serial: "emulator-5554", getScreenSize });
  return { backend, getScreenSize };
}

describe("scrcpy fast-inject backend lifecycle", () => {
  beforeEach(() => {
    h.injectTouchCalls.length = 0;
    vi.clearAllMocks();
    h.createAdb.mockResolvedValue(h.adb);
    h.start.mockResolvedValue(h.client);
    h.adb.subprocess.noneProtocol.spawnWaitText.mockResolvedValue("present");
  });

  it("tap injects DOWN then UP with device geometry, rounded px, bigint pointerId", async () => {
    const { backend } = makeBackend();
    await backend.tap(100.4, 200.6, { holdMs: 0, gapMs: 0 });
    expect(h.injectTouchCalls).toHaveLength(2);
    expect(h.injectTouchCalls[0]).toMatchObject({
      action: 0, // Down
      pointerId: 0n,
      pointerX: 100,
      pointerY: 201,
      videoWidth: 1080,
      videoHeight: 2400,
      pressure: 1,
      actionButton: 0,
      buttons: 0,
    });
    expect(h.injectTouchCalls[1]).toMatchObject({ action: 1, pointerId: 0n, pressure: 0 });
  });

  it("connects once and reuses the session across actions", async () => {
    const { backend } = makeBackend();
    await backend.tap(1, 1, { holdMs: 0, gapMs: 0 });
    await backend.tap(2, 2, { holdMs: 0, gapMs: 0 });
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.createAdb).toHaveBeenCalledTimes(1);
  });

  it("gesture injects distinct bigint pointer ids for each finger", async () => {
    const { backend } = makeBackend();
    const mk = (xs: number[]) => xs.map((x, i) => ({ x, y: 0, tMs: i * 16 }));
    await backend.gesture([
      { id: 0, points: mk([0, 20, 40]) },
      { id: 1, points: mk([100, 80, 60]) },
    ]);
    const ids = new Set(h.injectTouchCalls.map((m) => m.pointerId));
    expect(ids).toEqual(new Set([0n, 1n]));
    // First two messages are the DOWNs (one per finger).
    expect(h.injectTouchCalls[0]).toMatchObject({ action: 0, pointerId: 0n });
    expect(h.injectTouchCalls[1]).toMatchObject({ action: 0, pointerId: 1n });
  });

  it("dispose stops the scrcpy client and adb transport; further use throws", async () => {
    const { backend } = makeBackend();
    await backend.tap(1, 1, { holdMs: 0, gapMs: 0 });
    await backend.dispose();
    expect(h.client.close).toHaveBeenCalledTimes(1);
    expect(h.adb.close).toHaveBeenCalledTimes(1);
    await expect(backend.tap(1, 1, { holdMs: 0, gapMs: 0 })).rejects.toThrow(/disposed/);
  });

  it("pushes the scrcpy server jar when it is absent from the device", async () => {
    h.adb.subprocess.noneProtocol.spawnWaitText.mockResolvedValue("absent");
    const { backend } = makeBackend();
    await backend.tap(1, 1, { holdMs: 0, gapMs: 0 });
    expect(h.pushServer).toHaveBeenCalledTimes(1);
  });
});

describe("open-device-server-fast-inject flag", () => {
  it("is registered and off by default", () => {
    const def = getFlagDefinition("open-device-server-fast-inject");
    expect(def).toBeDefined();
    expect(def?.defaultEnabled).toBeFalsy();
    // With no flag set, the fast path is not taken (closures stay on the Kotlin channel).
    expect(isFlagEnabled("open-device-server-fast-inject")).toBe(false);
  });
});
