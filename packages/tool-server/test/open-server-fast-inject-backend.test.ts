/**
 * Phase 3f — scrcpy fast-inject backend lifecycle, with `@yume-chan` mocked (no
 * device). Covers: lazy single connect reused across actions; injectTouch fed the
 * ported timelines with a `bigint` pointerId; the geometry cache is warmed ONCE
 * (no per-action `getScreenSize` RPC); the jar is pushed to the version-suffixed
 * path with an explicit random `scid`; an inject error lifts still-down pointers
 * (CANCEL) and drops+restarts the client; `dispose()` awaits an in-flight start and
 * stops the client + adb transport. Also asserts the `open-device-server-fast-inject`
 * flag is registered and off by default — WITHOUT reading the real project flags
 * file (mocked), so a bench that left the flag on can't flip this assertion.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Flag reader is mocked so this suite never depends on ~/.argent or <proj>/.argent
// flags.json (item 8): getFlagDefinition stays real (verifies registration), but
// isFlagEnabled resolves purely from the declared default, file-independent.
vi.mock("@argent/configuration-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/configuration-core")>();
  return {
    ...actual,
    isFlagEnabled: (name: string): boolean =>
      Boolean(actual.getFlagDefinition(name)?.defaultEnabled),
  };
});
import { getFlagDefinition, isFlagEnabled } from "@argent/configuration-core";

interface FakeCtl {
  injectTouch: ReturnType<typeof vi.fn>;
}
interface Hoisted {
  injectTouchCalls: Array<Record<string, unknown>>;
  optionsArgs: unknown[][];
  pushServerCalls: unknown[][];
  failAtIndex: number | null;
  releaseStart: null | (() => void);
  controller: FakeCtl;
  client: { controller: FakeCtl; exited: Promise<void>; close: ReturnType<typeof vi.fn> };
  adb: {
    subprocess: { noneProtocol: { spawnWaitText: ReturnType<typeof vi.fn> } };
    close: ReturnType<typeof vi.fn>;
  };
  createAdb: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  pushServer: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted((): Hoisted => {
  const self = {
    injectTouchCalls: [] as Array<Record<string, unknown>>,
    optionsArgs: [] as unknown[][],
    pushServerCalls: [] as unknown[][],
    failAtIndex: null as number | null,
    releaseStart: null as null | (() => void),
  } as Hoisted;
  self.controller = {
    injectTouch: vi.fn(async (m: Record<string, unknown>) => {
      const idx = self.injectTouchCalls.length;
      self.injectTouchCalls.push(m);
      if (self.failAtIndex !== null && idx === self.failAtIndex) {
        self.failAtIndex = null;
        throw new Error("simulated scrcpy control-socket write failure");
      }
    }),
  };
  self.client = {
    controller: self.controller,
    exited: new Promise<void>(() => undefined), // never resolves in these tests
    close: vi.fn(async () => undefined),
  };
  self.adb = {
    subprocess: { noneProtocol: { spawnWaitText: vi.fn(async () => "present") } },
    close: vi.fn(async () => undefined),
  };
  self.createAdb = vi.fn(async () => self.adb);
  self.start = vi.fn(async () => self.client);
  self.pushServer = vi.fn(async (...args: unknown[]) => {
    self.pushServerCalls.push(args);
  });
  return self;
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
  // Capture constructor args so we can assert the control-only opts + scid.
  AdbScrcpyOptionsLatest: class {
    constructor(...args: unknown[]) {
      h.optionsArgs.push(args);
    }
  },
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
    h.optionsArgs.length = 0;
    h.pushServerCalls.length = 0;
    h.failAtIndex = null;
    h.releaseStart = null;
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

  it("warms the geometry cache once — no getScreenSize RPC per action (item 1)", async () => {
    const { backend, getScreenSize } = makeBackend();
    await backend.tap(1, 1, { holdMs: 0, gapMs: 0 });
    await backend.tap(2, 2, { holdMs: 0, gapMs: 0 });
    await backend.swipe(1, 1, 2, 2, 4, 0);
    // One warm read total, not one per action.
    expect(getScreenSize).toHaveBeenCalledTimes(1);
    // Dims still carried on the wire (the server ignores them with video:false, but
    // we send the cached real size rather than a stale/garbage value).
    expect(h.injectTouchCalls[0]).toMatchObject({ videoWidth: 1080, videoHeight: 2400 });
  });

  it("still injects (dims 0) when geometry is unavailable — never throws on a bad read (item 1)", async () => {
    const getScreenSize = vi.fn(async () => ({ screenWidth: 0, screenHeight: 0, displayRotation: 0 }));
    const backend = createScrcpyInjectBackend({ serial: "emulator-5554", getScreenSize });
    await backend.tap(5, 6, { holdMs: 0, gapMs: 0 });
    expect(h.injectTouchCalls[0]).toMatchObject({ pointerX: 5, pointerY: 6, videoWidth: 0, videoHeight: 0 });
  });

  it("starts control-only with an explicit random scid (item 5)", async () => {
    const { backend } = makeBackend();
    await backend.tap(1, 1, { holdMs: 0, gapMs: 0 });
    expect(h.optionsArgs).toHaveLength(1);
    const opts = h.optionsArgs[0]![0] as Record<string, unknown>;
    expect(opts).toMatchObject({ video: false, audio: false, control: true, tunnelForward: true });
    expect(typeof opts.scid).toBe("string");
    expect(opts.scid as string).toMatch(/^[0-9a-f]{8}$/);
  });

  it("pushes the scrcpy server jar to the version-suffixed path when absent (item 5)", async () => {
    h.adb.subprocess.noneProtocol.spawnWaitText.mockResolvedValue("absent");
    const { backend } = makeBackend();
    await backend.tap(1, 1, { holdMs: 0, gapMs: 0 });
    expect(h.pushServer).toHaveBeenCalledTimes(1);
    // pushServer(adb, stream, devicePath) — assert the version-suffixed device path.
    expect(h.pushServerCalls[0]![2]).toBe("/data/local/tmp/argent-scrcpy-server-3.3.1.jar");
  });

  it("on an inject failure, lifts still-down pointers (CANCEL) and drops the client (item 4)", async () => {
    const { backend } = makeBackend();
    // tap = DOWN (idx 0), UP (idx 1). Fail the UP so pointer 0 is left down.
    h.failAtIndex = 1;
    await expect(backend.tap(10, 20, { holdMs: 50, gapMs: 0 })).rejects.toThrow(/scrcpy/);
    // A CANCEL for the still-down pointer 0 was emitted after the failure.
    const cancel = h.injectTouchCalls.find((m) => m.action === 3);
    expect(cancel).toMatchObject({ action: 3, pointerId: 0n });
    // The client was dropped (closed) so the next action reconnects.
    expect(h.client.close).toHaveBeenCalledTimes(1);
    // Next action reconnects: a second start().
    h.failAtIndex = null;
    await backend.tap(1, 1, { holdMs: 0, gapMs: 0 });
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("dispose stops the scrcpy client and adb transport; further use throws", async () => {
    const { backend } = makeBackend();
    await backend.tap(1, 1, { holdMs: 0, gapMs: 0 });
    await backend.dispose();
    expect(h.client.close).toHaveBeenCalledTimes(1);
    expect(h.adb.close).toHaveBeenCalledTimes(1);
    await expect(backend.tap(1, 1, { holdMs: 0, gapMs: 0 })).rejects.toThrow(/disposed/);
  });

  it("dispose awaits an in-flight start and closes the client it opened (item 6)", async () => {
    const { backend } = makeBackend();
    // Stall start() until we release it, so dispose() runs while it is in flight.
    h.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          h.releaseStart = () => resolve(h.client);
        })
    );
    const tapP = backend.tap(1, 1, { holdMs: 0, gapMs: 0 });
    // Let the tap reach `await ensureStarted()` (start is now pending).
    await new Promise((r) => setTimeout(r, 5));
    const disposeP = backend.dispose();
    // Release the stalled start: start() must see `disposed` and close the client.
    h.releaseStart!();
    await disposeP;
    await expect(tapP).rejects.toThrow(/disposed/);
    expect(h.client.close).toHaveBeenCalled();
  });
});

describe("open-device-server-fast-inject flag", () => {
  it("is registered and off by default (flag reader mocked — file-independent)", () => {
    const def = getFlagDefinition("open-device-server-fast-inject");
    expect(def).toBeDefined();
    expect(def?.defaultEnabled).toBeFalsy();
    // With the reader mocked to the declared default, the fast path is not taken.
    expect(isFlagEnabled("open-device-server-fast-inject")).toBe(false);
  });
});
