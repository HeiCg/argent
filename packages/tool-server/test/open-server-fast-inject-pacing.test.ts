/**
 * Phase 3k — scrcpy fast-inject host PACING, with `@yume-chan` mocked (no device,
 * no `@argent/*` so it runs anywhere). The backend paces a swipe timeline against a
 * wall clock; the pre-3k loop (`legacy`) AWAITS one `injectTouch` per frame, so a
 * slow control-socket consume stretches the whole gesture and the OS VelocityTracker
 * reads a lower release velocity (the reproducible long-duration under-scroll, review
 * F2). The fix (`drift`, default) sleeps to each frame's drift-corrected slot and
 * INITIATES the write there without awaiting its consume; the WHATWG WritableStream
 * queues concurrent writes in order, so the frames still arrive in order but a slow
 * write no longer delays the next frame's dispatch. These tests prove: (1) the mode
 * is env-selected and a per-swipe pacing summary is emitted; (2) under a slow socket,
 * drift keeps the DOWN→UP dispatch span ~= the requested duration while the WRITE
 * span lags (decoupling), whereas legacy stretches the dispatch span itself; and
 * (3) drift still lifts still-down pointers + drops the client on a write failure.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

interface FakeCtl {
  injectTouch: ReturnType<typeof vi.fn>;
}
interface Hoisted {
  injectTouchCalls: Array<Record<string, unknown>>;
  injectTouchCallTimes: number[];
  failAtIndex: number | null;
  writeDelayMs: number;
  // Serialize the mock consume like the real WHATWG WritableStream: write N+1's
  // consume resolves only after write N's — so a `drift` swipe that initiates writes
  // faster than the socket drains shows the write span lagging the dispatch span.
  writeChain: Promise<void>;
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
    injectTouchCallTimes: [] as number[],
    failAtIndex: null as number | null,
    writeDelayMs: 0,
    writeChain: Promise.resolve(),
  } as Hoisted;
  self.controller = {
    injectTouch: vi.fn((m: Record<string, unknown>) => {
      const idx = self.injectTouchCalls.length;
      self.injectTouchCalls.push(m); // recorded at CALL time = dispatch order
      self.injectTouchCallTimes.push(performance.now()); // dispatch wall-clock
      if (self.failAtIndex !== null && idx === self.failAtIndex) {
        self.failAtIndex = null;
        return Promise.reject(new Error("simulated scrcpy control-socket write failure"));
      }
      if (self.writeDelayMs <= 0) return Promise.resolve();
      // Serial consume: this write completes only after every prior write's consume.
      self.writeChain = self.writeChain.then(
        () => new Promise<void>((r) => setTimeout(r, self.writeDelayMs))
      );
      return self.writeChain;
    }),
  };
  self.client = {
    controller: self.controller,
    exited: new Promise<void>(() => undefined),
    close: vi.fn(async () => undefined),
  };
  self.adb = {
    subprocess: { noneProtocol: { spawnWaitText: vi.fn(async () => "present") } },
    close: vi.fn(async () => undefined),
  };
  self.createAdb = vi.fn(async () => self.adb);
  self.start = vi.fn(async () => self.client);
  self.pushServer = vi.fn(async () => undefined);
  return self;
});

vi.mock("@yume-chan/adb", () => ({
  Adb: class {},
  AdbServerClient: class {
    createAdb = h.createAdb;
  },
}));
vi.mock("@yume-chan/adb-server-node-tcp", () => ({ AdbServerNodeTcpConnector: class {} }));
vi.mock("@yume-chan/adb-scrcpy", () => ({
  AdbScrcpyClient: { start: h.start, pushServer: h.pushServer },
  AdbScrcpyOptionsLatest: class {},
}));
vi.mock("@yume-chan/fetch-scrcpy-server", () => ({ BIN: new URL("file:///dev/null"), VERSION: "3.3.1" }));
vi.mock("@yume-chan/stream-extra", () => ({ ReadableStream: class {} }));
vi.mock("@yume-chan/scrcpy", () => ({
  AndroidMotionEventAction: { Down: 0, Up: 1, Move: 2, Cancel: 3, PointerDown: 5, PointerUp: 6 },
}));

import { createScrcpyInjectBackend } from "../src/utils/scrcpy-inject-backend";

const geom = { screenWidth: 1080, screenHeight: 2400, displayRotation: 0 };

function makeBackend() {
  const getScreenSize = vi.fn(async () => geom);
  const logs: string[] = [];
  const backend = createScrcpyInjectBackend({
    serial: "emulator-5554",
    getScreenSize,
    log: (m) => logs.push(m),
  });
  return { backend, logs };
}

/** Parse the phase-3k `pacing …` summary line into its fields. */
function parsePacing(logs: string[]): Record<string, string> | null {
  const line = logs.find((l) => l.startsWith("pacing "));
  if (!line) return null;
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)=([-\d.a-z]+)/g)) out[m[1]!] = m[2]!;
  return out;
}

describe("scrcpy fast-inject pacing (phase 3k)", () => {
  beforeEach(() => {
    h.injectTouchCalls.length = 0;
    h.injectTouchCallTimes.length = 0;
    h.failAtIndex = null;
    h.writeDelayMs = 0;
    h.writeChain = Promise.resolve();
    delete process.env.ARGENT_SCRCPY_PACING;
    delete process.env.ARGENT_SCRCPY_PACING_TRACE_FILE;
    vi.clearAllMocks();
    h.createAdb.mockResolvedValue(h.adb);
    h.start.mockResolvedValue(h.client);
    h.adb.subprocess.noneProtocol.spawnWaitText.mockResolvedValue("present");
  });

  it("DEFAULTS to legacy pacing (phase 3k.1: drift is opt-in), frames in order (DOWN…UP)", async () => {
    // Phase 3k.1 decision: the default is the byte-equal pre-3k await-per-frame loop.
    // The legacy branch carries NO per-frame pacing trace, so no `pacing …` summary is
    // emitted on the default path — only the frames-in-order wire contract is asserted.
    const { backend, logs } = makeBackend();
    await backend.swipe(0.5, 0.72, 0.5, 0.32, 8, 0);
    expect(parsePacing(logs)).toBeNull(); // legacy emits no trace (byte-equal to pre-3k)
    expect(h.injectTouchCalls[0]).toMatchObject({ action: 0 });
    expect(h.injectTouchCalls[h.injectTouchCalls.length - 1]).toMatchObject({ action: 1 });
  });

  it("drift pacing is OPT-IN via ARGENT_SCRCPY_PACING=drift and emits a per-swipe summary", async () => {
    process.env.ARGENT_SCRCPY_PACING = "drift";
    const { backend, logs } = makeBackend();
    await backend.swipe(0.5, 0.72, 0.5, 0.32, 8, 0);
    const p = parsePacing(logs);
    expect(p).not.toBeNull();
    expect(p!.mode).toBe("drift");
    expect(h.injectTouchCalls[0]).toMatchObject({ action: 0 });
    expect(h.injectTouchCalls[h.injectTouchCalls.length - 1]).toMatchObject({ action: 1 });
  });

  it("any other ARGENT_SCRCPY_PACING value falls back to the legacy default", async () => {
    process.env.ARGENT_SCRCPY_PACING = "something-else";
    const { backend, logs } = makeBackend();
    await backend.swipe(0.5, 0.72, 0.5, 0.32, 8, 0);
    expect(parsePacing(logs)).toBeNull(); // legacy default, no trace
    expect(h.injectTouchCalls[0]).toMatchObject({ action: 0 });
    expect(h.injectTouchCalls[h.injectTouchCalls.length - 1]).toMatchObject({ action: 1 });
  });

  it("drift DECOUPLES writes from the frame clock under a slow socket; legacy stretches the gesture", async () => {
    // 30 ms per-frame consume (> the dense-tail 16 ms cadence). The structural
    // difference the fix makes, independent of exact magnitudes on a loaded runner:
    //  - legacy (default, untraced byte-equal path): each frame's dispatch AWAITS the
    //    prior write, so the whole gesture's wall time is dragged out by the coupled
    //    writes — measured here by wall-clock since the legacy path emits no trace.
    //  - drift: dispatch is paced by the clock while writes drain behind it, so the
    //    WRITE span lags the DISPATCH span (decoupled) and the dispatch span stays
    //    near the requested duration.
    h.writeDelayMs = 30;

    // Legacy: no trace summary on the byte-equal path, so measure its DISPATCH span
    // (first→last injectTouch CALL time) directly from the mock.
    process.env.ARGENT_SCRCPY_PACING = "legacy";
    const legacy = makeBackend();
    await legacy.backend.swipe(0.5, 0.72, 0.5, 0.32, 10, 0);
    const lt = h.injectTouchCallTimes;
    const legacyDispatchSpan = lt[lt.length - 1]! - lt[0]!;
    expect(parsePacing(legacy.logs)).toBeNull(); // byte-equal legacy path emits no trace
    h.injectTouchCallTimes.length = 0;

    process.env.ARGENT_SCRCPY_PACING = "drift";
    const drift = makeBackend();
    await drift.backend.swipe(0.5, 0.72, 0.5, 0.32, 10, 0);
    const pd = parsePacing(drift.logs)!;

    const intended = Number(pd.intendedDurMs);
    expect(pd.mode).toBe("drift");
    // Drift: writes lag the dispatch span (decoupled), dispatch tracks the duration.
    expect(Number(pd.writeSpanMs) - Number(pd.downUpDispatchMs)).toBeGreaterThan(30);
    expect(Number(pd.downUpDispatchMs)).toBeLessThan(intended + 25);
    // Legacy STRETCHES: awaiting one 30 ms write per frame drags the DISPATCH span
    // (the DOWN→UP gesture the OS VelocityTracker sees) well past drift's, which
    // stays near the requested duration.
    expect(legacyDispatchSpan).toBeGreaterThan(Number(pd.downUpDispatchMs) + 30);
  });

  it("drift still lifts still-down pointers (CANCEL) and drops the client on a write failure", async () => {
    process.env.ARGENT_SCRCPY_PACING = "drift";
    h.failAtIndex = 0; // fail the DOWN
    const { backend } = makeBackend();
    await expect(backend.swipe(0.5, 0.72, 0.5, 0.32, 6, 0)).rejects.toThrow(/scrcpy|write failure/);
    expect(h.injectTouchCalls.some((m) => m.action === 3)).toBe(true); // CANCEL emitted
    expect(h.client.close).toHaveBeenCalledTimes(1); // client dropped
  });

  it("legacy (default) also lifts still-down pointers (CANCEL) and drops the client on a write failure", async () => {
    // The byte-equal default path keeps the pre-3k recovery: a mid-gesture MOVE
    // failure (the DOWN already recorded) still cancels the down pointer and drops
    // the client. (Legacy records the pointer only AFTER its write, so it is a later
    // frame — not the DOWN itself — that leaves a pointer to cancel, exactly as
    // pre-3k; the drift arm records optimistically and so cancels even on the DOWN.)
    h.failAtIndex = 2; // fail a MOVE (no ARGENT_SCRCPY_PACING ⇒ legacy default)
    const { backend } = makeBackend();
    await expect(backend.swipe(0.5, 0.72, 0.5, 0.32, 6, 0)).rejects.toThrow(/scrcpy|write failure/);
    expect(h.injectTouchCalls.some((m) => m.action === 3)).toBe(true); // CANCEL emitted
    expect(h.client.close).toHaveBeenCalledTimes(1); // client dropped
  });

  it("appends the drift per-swipe trace to ARGENT_SCRCPY_PACING_TRACE_FILE (reliable sink)", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const nodePath = await import("node:path");
    const file = nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), "pacing-trace-")), "trace.txt");
    process.env.ARGENT_SCRCPY_PACING = "drift";
    process.env.ARGENT_SCRCPY_PACING_TRACE_FILE = file;
    try {
      const { backend } = makeBackend();
      await backend.swipe(0.5, 0.72, 0.5, 0.32, 8, 0);
      const contents = fs.readFileSync(file, "utf8");
      expect(contents).toMatch(/\[pacing-trace\] pacing mode=drift /);
    } finally {
      delete process.env.ARGENT_SCRCPY_PACING_TRACE_FILE;
    }
  });
});
