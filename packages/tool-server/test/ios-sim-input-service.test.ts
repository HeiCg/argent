import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { IosSimInputService } from "../src/utils/ios-sim-input-service";

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

  it("tap / swipe keep resolving undefined for the existing consumers", async () => {
    const { svc, children } = serviceWithChild();
    const t = svc.tap("UDID-A", { x: 1, y: 1, width: 10, height: 10 });
    const s = svc.swipe("UDID-A", { fromX: 1, fromY: 2, toX: 3, toY: 4 });
    pushAck(children[0]!, { id: 1, ok: true, scheduledMs: 50, actualMs: 51 });
    pushAck(children[0]!, { id: 2, ok: true });
    await expect(t).resolves.toBeUndefined();
    await expect(s).resolves.toBeUndefined();
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
  frameMs: number;
  scheduledMs: number;
  actualMs: number;
  overshootMs: number;
  maxFrameLateMs: number;
  minMs: number;
  maxMs: number;
  pass: boolean;
}

describe.skipIf(!hasSwift)("sim-input selftest-pacing (macOS, swift build)", () => {
  it("12 frames at 20 ms end in 240-290 ms, 1 frame of 50 ms in 50-60 ms, a stalled frame does not propagate", () => {
    execFileSync("swift", ["build", "--package-path", PKG], { stdio: "ignore", timeout: 300_000 });
    const bin = execFileSync("swift", ["build", "--package-path", PKG, "--show-bin-path"], {
      encoding: "utf-8",
    }).trim();
    const run = spawnSync(path.join(bin, "sim-input"), ["selftest-pacing"], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim()) as { ok: boolean; cases: PacingCase[] };
    expect(out.ok).toBe(true);
    const byName = new Map(out.cases.map((c) => [c.name, c]));

    const swipe = byName.get("frames-12x20")!;
    expect(swipe.scheduledMs).toBe(240);
    expect(swipe.actualMs).toBeGreaterThanOrEqual(240);
    expect(swipe.actualMs).toBeLessThanOrEqual(290);

    const tap = byName.get("frames-1x50")!;
    expect(tap.scheduledMs).toBe(50);
    expect(tap.actualMs).toBeGreaterThanOrEqual(50);
    expect(tap.actualMs).toBeLessThanOrEqual(60);

    // A 60 ms stall inside frame 3 makes frame 4 late, but the deadlines after
    // it are absolute: the gesture still ends near 240 ms (chained sleeps: 300).
    const stall = byName.get("frames-12x20-stall60")!;
    expect(stall.maxFrameLateMs).toBeGreaterThanOrEqual(30);
    expect(stall.actualMs).toBeGreaterThanOrEqual(240);
    expect(stall.actualMs).toBeLessThanOrEqual(290);
  }, 330_000);
});
