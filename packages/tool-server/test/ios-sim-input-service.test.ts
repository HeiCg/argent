import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Registry, type DeviceInfo } from "@argent/registry";
import {
  createIosSimInputBlueprint,
  iosSimInputRef,
  type IosSimInputApi,
} from "../src/blueprints/ios-sim-input";
import { IosSimInputService, isForwardableLogLine } from "../src/utils/ios-sim-input-service";

/**
 * iOS-4 ticket 3 (send queue + deadline pacing): the sim-input ack carries
 * per-gesture pacing (`scheduledMs`, `actualMs`, `overshootMs`,
 * `maxFrameLateMs`) and the host service exposes it. The framing / FIFO queue
 * tests live in `test/utils/ios-sim-input-service.test.ts`; this file covers
 * the pacing fields on a fake spawn, plus the Swift pacer itself through
 * `sim-input selftest-pacing` (macOS with a Swift toolchain only; no simulator).
 */

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function serviceWithChild(): { svc: IosSimInputService; children: FakeChild[]; written: string[] } {
  const children: FakeChild[] = [];
  const written: string[] = [];
  const spawn = vi.fn(() => {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    child.stdin.on("data", (buf: Buffer) => written.push(buf.toString("utf-8")));
    children.push(child);
    return child;
  });
  const svc = new IosSimInputService({ binary: "/fake/sim-input", spawn: spawn as never });
  return { svc, children, written };
}

function pushAck(child: FakeChild, obj: Record<string, unknown>): void {
  child.stdout.write(JSON.stringify(obj) + "\n");
}

describe("IosSimInputService — pacing fields on the ack", () => {
  it("tapWithAck exposes scheduledMs / actualMs / overshootMs / maxFrameLateMs", async () => {
    const { svc, children } = serviceWithChild();
    const p = svc.tapWithAck("UDID-A", { x: 10, y: 20, width: 390, height: 844 });
    pushAck(children[0]!, {
      id: 1,
      ok: true,
      scheduledMs: 50,
      actualMs: 50.4,
      overshootMs: 0.4,
      maxFrameLateMs: 0.02,
    });
    await expect(p).resolves.toEqual({
      id: 1,
      hostWriteAt: expect.any(Number),
      hostAckAt: expect.any(Number),
      timing: null,
      scheduledMs: 50,
      actualMs: 50.4,
      overshootMs: 0.4,
      maxFrameLateMs: 0.02,
    });
  });

  it("swipeWithAck writes the same swipe envelope and exposes the pacing", async () => {
    const { svc, children, written } = serviceWithChild();
    const p = svc.swipeWithAck("UDID-A", { fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 250 });
    const cmd = JSON.parse(written.join("").trim());
    expect(cmd).toMatchObject({ id: 1, type: "swipe", fromX: 1, toY: 4, durationMs: 250 });
    pushAck(children[0]!, {
      id: 1,
      ok: true,
      scheduledMs: 220,
      actualMs: 221.3,
      overshootMs: 1.3,
      maxFrameLateMs: 0.6,
    });
    const ack = await p;
    expect(ack.scheduledMs).toBe(220);
    expect(ack.actualMs).toBe(221.3);
    expect(ack.overshootMs).toBe(1.3);
    expect(ack.maxFrameLateMs).toBe(0.6);
  });

  it("an ack without the fields (older binary) resolves with them undefined", async () => {
    const { svc, children } = serviceWithChild();
    const p = svc.tapWithAck("UDID-A", { x: 1, y: 1, width: 10, height: 10 });
    pushAck(children[0]!, { id: 1, ok: true });
    const ack = await p;
    expect(ack.id).toBe(1);
    expect(ack.scheduledMs).toBeUndefined();
    expect(ack.actualMs).toBeUndefined();
    expect(ack.overshootMs).toBeUndefined();
    expect(ack.maxFrameLateMs).toBeUndefined();
  });

  it("drops a non-numeric or non-finite field instead of passing it through", async () => {
    const { svc, children } = serviceWithChild();
    const p = svc.tapWithAck("UDID-A", { x: 1, y: 1, width: 10, height: 10 });
    pushAck(children[0]!, { id: 1, ok: true, scheduledMs: "50", actualMs: null, overshootMs: 2 });
    const ack = await p;
    expect(ack.scheduledMs).toBeUndefined();
    expect(ack.actualMs).toBeUndefined();
    expect(ack.overshootMs).toBe(2);
  });

  it("the FIFO fallback (ack without id) carries the pacing too", async () => {
    const { svc, children } = serviceWithChild();
    const p = svc.swipeWithAck("UDID-A", { fromX: 1, fromY: 2, toX: 3, toY: 4 });
    pushAck(children[0]!, { ok: true, scheduledMs: 220, actualMs: 230 });
    await expect(p).resolves.toMatchObject({ id: 1, scheduledMs: 220, actualMs: 230 });
  });

  it("a momentum-free swipe (holdEndMs > 0) puts holdEndMs on the wire; 0 or absent sends none", () => {
    // `holdEndMs` > 0 is the momentum-free request: sim-input then runs the
    // ease-out plan (16 ms frames, ease-out to ~0 velocity) plus the end hold.
    const { svc, written } = serviceWithChild();
    void svc.swipe("UDID-A", {
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.3,
      durationMs: 300,
      holdEndMs: 120,
      width: 1,
      height: 1,
    });
    void svc.swipe("UDID-A", { fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.3, holdEndMs: 0 });
    void svc.swipe("UDID-A", { fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.3 });
    const cmds = written
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(cmds).toHaveLength(3);
    expect(cmds[0]).toMatchObject({ type: "swipe", durationMs: 300, holdEndMs: 120 });
    expect(cmds[1]).not.toHaveProperty("holdEndMs");
    expect(cmds[2]).not.toHaveProperty("holdEndMs");
  });

  it("tap / swipe resolve the same combined ack as the *WithAck aliases (pacing + timing)", async () => {
    const { svc, children } = serviceWithChild();
    const t = svc.tap("UDID-A", { x: 1, y: 1, width: 10, height: 10 });
    const s = svc.swipe("UDID-A", { fromX: 1, fromY: 2, toX: 3, toY: 4 });
    const timing = { recvAt: 10, sends: [{ sendStart: 10.1, sendEnd: 10.2 }], ackAt: 61 };
    pushAck(children[0]!, { id: 1, ok: true, scheduledMs: 50, actualMs: 51, timing });
    pushAck(children[0]!, { id: 2, ok: true });
    await expect(t).resolves.toMatchObject({ id: 1, scheduledMs: 50, actualMs: 51, timing });
    const swipe = await s;
    expect(swipe.id).toBe(2);
    expect(swipe.timing).toBeNull();
    expect(swipe.scheduledMs).toBeUndefined();
  });
});

describe("IosSimInput blueprint — a swipe's call timeout covers the gesture", () => {
  const SIM: DeviceInfo = {
    id: "11111111-2222-3333-4444-555555555555",
    platform: "ios",
    kind: "simulator",
  };

  async function apiWithTimeout(
    timeoutMs: number
  ): Promise<{ api: IosSimInputApi; written: string[] }> {
    const written: string[] = [];
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as FakeChild;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => {
        setImmediate(() => child.emit("exit", null, "SIGTERM"));
        return true;
      });
      child.stdin.on("data", (buf: Buffer) => written.push(buf.toString("utf-8")));
      return child;
    });
    const registry = new Registry();
    registry.registerBlueprint(
      createIosSimInputBlueprint({
        spawn: spawn as never,
        resolveBinary: async () => "/fake/sim-input",
        timeoutMs,
      })
    );
    const ref = iosSimInputRef(SIM);
    const api = await registry.resolveService<IosSimInputApi>(ref.urn, ref.options);
    return { api, written };
  }

  it("base + durationMs + holdEndMs for a momentum-free swipe, base + durationMs without a hold", async () => {
    const { api, written } = await apiWithTimeout(30);
    const mf = api.sendSwipe({
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.3,
      durationMs: 200,
      holdEndMs: 100,
    });
    await expect(mf).rejects.toThrow(/timed out after 330 ms/);
    const plain = api.sendSwipe({ fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.3, durationMs: 200 });
    await expect(plain).rejects.toThrow(/timed out after 230 ms/);
    // The envelope is the service's swipe envelope.
    const first = JSON.parse(written.join("").trim().split("\n")[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({
      type: "swipe",
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.3,
      durationMs: 200,
      holdEndMs: 100,
      screenWidth: 1,
      screenHeight: 1,
    });
  });
});

describe("IosSimInputService — stderr forwarding carries no typed input", () => {
  it("isForwardableLogLine drops key-usage and character lines, keeps the rest", () => {
    expect(isForwardableLogLine("[hid] key page=7 usage=4 modifiers=[] hold=100000us")).toBe(false);
    expect(isForwardableLogLine("[hid] press home target=0x1 page=12 usage=64 hold=1us")).toBe(
      false
    );
    expect(isForwardableLogLine("text: unsupported character 'é'")).toBe(false);
    expect(isForwardableLogLine("sim-input ready (udid=ABC)")).toBe(true);
    expect(isForwardableLogLine("text: unsupported input, skipped")).toBe(true);
    expect(isForwardableLogLine("[hid] symbols resolved — mouse:true")).toBe(true);
  });

  it("the stderr forwarding path applies the filter", async () => {
    const forwarded: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      forwarded.push(args.map(String).join(" "));
    });
    try {
      const { svc, children } = serviceWithChild();
      const p = svc.typeText("UDID-A", "abc");
      children[0]!.stderr.write(
        "sim-input ready (udid=UDID-A)\n[hid] key page=7 usage=4 modifiers=[] hold=100000us\n"
      );
      pushAck(children[0]!, { id: 1, ok: true });
      await p;
      await new Promise((r) => setImmediate(r));
      expect(forwarded.some((l) => l.includes("sim-input ready"))).toBe(true);
      expect(forwarded.some((l) => l.includes("usage="))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---- Swift pacer (real binary, no simulator) ----

const PKG = path.resolve(__dirname, "..", "..", "ios-sim-input");
const hasSwift =
  process.platform === "darwin" &&
  spawnSync("swift", ["--version"], { stdio: "ignore" }).status === 0;

interface PacingCase {
  name: string;
  frames: number;
  scheduledMs: number;
  actualMs: number;
  overshootMs: number;
  maxFrameLateMs: number;
  minMs: number;
  maxMs: number;
  pass: boolean;
  offsetsMs: number[];
}

/** The extra fields of a `swipe-momentum-free-<durationMs>` case. */
interface MomentumFreeCase extends PacingCase {
  durationMs: number;
  holdEndMs: number;
  pathPt: number;
  moveFrameMs: number;
  moves: number;
  constantFrames: number;
  easeOutFrames: number;
  positionsPt: number[];
  velocitiesPtPerS: number[];
  lastFramesVelocityPtPerS: number;
  last6FramesVelocityPtPerS: number;
}

/** One row of the selftest's check of the dispatch's ease-out predicate. */
interface PredicateRow {
  edge: string;
  dwellMs: number;
  easeOut: boolean;
  pass: boolean;
}

describe.skipIf(!hasSwift)("sim-input selftest-pacing (macOS, swift build)", () => {
  it("paces the real tap / swipe frame plans: tap 50 ms, swipe 250 ms (10 moves at 20 ms, Up at 220), a stalled frame does not propagate", () => {
    execFileSync("swift", ["build", "--package-path", PKG], { stdio: "ignore", timeout: 300_000 });
    const bin = execFileSync("swift", ["build", "--package-path", PKG, "--show-bin-path"], {
      encoding: "utf-8",
    }).trim();
    const run = spawnSync(path.join(bin, "sim-input"), ["selftest-pacing"], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim()) as {
      ok: boolean;
      cases: PacingCase[];
      momentumFreePredicate: PredicateRow[];
    };
    expect(out.ok).toBe(true);
    const byName = new Map(out.cases.map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual([
      "swipe-250",
      "swipe-250-dwell120",
      "swipe-250-stall60",
      "swipe-momentum-free-150",
      "swipe-momentum-free-250",
      "swipe-momentum-free-300",
      "tap-default",
    ]);

    // IndigoHIDInput.tap with no holdMs: one wait, the Up at 50 ms.
    const tap = byName.get("tap-default")!;
    expect(tap.frames).toBe(1);
    expect(tap.scheduledMs).toBe(50);
    expect(tap.actualMs).toBeGreaterThanOrEqual(50);
    expect(tap.actualMs).toBeLessThanOrEqual(60);

    // IndigoHIDInput.swipe(durationMs 250): 10 moves at 250/12 = 20 ms, Up one
    // step after the last move.
    const swipe = byName.get("swipe-250")!;
    expect(swipe.frames).toBe(11);
    expect(swipe.scheduledMs).toBe(220);
    expect(swipe.actualMs).toBeGreaterThanOrEqual(220);
    expect(swipe.actualMs).toBeLessThanOrEqual(270);

    // A 60 ms stall inside frame 3 makes frame 4 late, but the deadlines after
    // it are absolute: the gesture still ends near 220 ms (chained sleeps: 280).
    // A linear swipe with a 120 ms dwell (the plan of an edge swipe with a
    // dwell): 10 moves at 20 ms, dwell pulses at 200 and 250 ms (120 / 50 = 2),
    // the Up one step after 300 ms.
    const dwell = byName.get("swipe-250-dwell120")!;
    expect(dwell.frames).toBe(13);
    expect(dwell.scheduledMs).toBe(320);
    expect(dwell.actualMs).toBeGreaterThanOrEqual(320);
    expect(dwell.actualMs).toBeLessThanOrEqual(370);

    const stall = byName.get("swipe-250-stall60")!;
    expect(stall.maxFrameLateMs).toBeGreaterThanOrEqual(30);
    expect(stall.actualMs).toBeGreaterThanOrEqual(220);
    expect(stall.actualMs).toBeLessThanOrEqual(270);

    // `{"type":"swipe","durationMs":D,"holdEndMs":120}` (gesture-swipe
    // momentum:false) over the bench's 437 pt finger path, at the tool default
    // (300), the iOS bench's duration (250) and the momentum:false minimum
    // (150). Moves on 16 ms frames: ceil(12 * floor(D / 12) / 16) frames, of
    // which the last 10 (160 ms) ease out to rest and the rest (at least 1) run
    // at constant velocity; then the hold (2 pulses, 50 ms apart from the last
    // move) and the Up one frame after the last pulse plus 50 ms.
    const expected = [
      { durationMs: 300, moves: 19, constantFrames: 9, up: 420 },
      { durationMs: 250, moves: 15, constantFrames: 5, up: 356 },
      { durationMs: 150, moves: 11, constantFrames: 1, up: 292 },
    ];
    for (const e of expected) {
      const mf = byName.get(`swipe-momentum-free-${e.durationMs}`) as MomentumFreeCase;
      expect(mf.pass, mf.name).toBe(true);
      expect(mf).toMatchObject({
        durationMs: e.durationMs,
        holdEndMs: 120,
        pathPt: 437,
        moveFrameMs: 16,
        moves: e.moves,
        constantFrames: e.constantFrames,
        easeOutFrames: 10,
      });
      expect(mf.offsetsMs).toEqual([
        ...Array.from({ length: e.moves }, (_, i) => (i + 1) * 16),
        e.moves * 16,
        e.moves * 16 + 50,
        e.up,
      ]);
      expect(mf.frames).toBe(e.moves + 3);
      expect(mf.scheduledMs).toBe(e.up);
      expect(mf.actualMs).toBeGreaterThanOrEqual(e.up);
      expect(mf.actualMs).toBeLessThanOrEqual(e.up + 50);
      expect(mf.positionsPt).toHaveLength(e.moves);
      expect(mf.positionsPt[e.moves - 1]).toBeCloseTo(437, 6);
      for (let i = 1; i < mf.positionsPt.length; i++) {
        expect(mf.positionsPt[i]!).toBeGreaterThanOrEqual(mf.positionsPt[i - 1]!);
      }
      // Constant velocity over the constant frames, then strictly slower.
      const v = mf.velocitiesPtPerS;
      for (let i = 0; i < e.constantFrames; i++) expect(v[i]).toBeCloseTo(v[0]!, 6);
      for (let i = e.constantFrames; i < e.moves; i++) expect(v[i]!).toBeLessThan(v[i - 1]!);
      // The release: the velocity over the last 3 frames (48 ms) before the hold.
      // (last6FramesVelocityPtPerS, the last 96 ms, is printed, not gated.)
      expect(mf.lastFramesVelocityPtPerS, mf.name).toBeLessThan(50);
      expect(v[e.moves - 1]!).toBeLessThan(5);
    }

    // IOHIDDigitizerDispatch.swipe's choice (GestureFrames.isMomentumFree): a
    // non-edge swipe with a dwell eases out; an edge swipe with a dwell (App
    // Switcher: bottom, 900 ms) and a swipe without a dwell stay linear.
    expect(out.momentumFreePredicate).toEqual([
      { edge: "none", dwellMs: 120, easeOut: true, pass: true },
      { edge: "bottom", dwellMs: 900, easeOut: false, pass: true },
      { edge: "none", dwellMs: 0, easeOut: false, pass: true },
    ]);
  }, 330_000);
});
