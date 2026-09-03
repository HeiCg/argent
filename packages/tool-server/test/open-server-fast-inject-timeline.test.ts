/**
 * Phase 3f — the scrcpy fast-inject timelines must equal the on-device Kotlin
 * `MotionInjector` / `TapHandler` / `SwipeHandler` / `GestureHandler` shapes, so a
 * gesture injected over the control channel is frame-for-frame the one the
 * UiAutomation path injects (fling fidelity unchanged). These assert frame count,
 * per-frame `tMs`, actions and pointer ids against the Kotlin formulas.
 */
import { describe, it, expect } from "vitest";
import {
  buildTapTimeline,
  buildSwipeTimeline,
  buildGestureTimeline,
  resampleGesturePath,
  TouchAction,
} from "../src/utils/scrcpy-inject-timeline";

describe("fast-inject tap timeline (MotionInjector.injectTaps parity)", () => {
  it("single tap: DOWN@0, UP@holdMs (default hold 50)", () => {
    const t = buildTapTimeline(100, 200, { clickCount: 1, holdMs: 50, gapMs: 100 });
    expect(t).toEqual([
      { action: TouchAction.Down, pointerId: 0, x: 100, y: 200, tMs: 0, pressure: 1 },
      { action: TouchAction.Up, pointerId: 0, x: 100, y: 200, tMs: 50, pressure: 0 },
    ]);
  });

  it("double tap: two DOWN/UP pairs one period (hold+gap) apart", () => {
    const t = buildTapTimeline(10, 20, { clickCount: 2, holdMs: 50, gapMs: 100 });
    // period = 150; tap0 DOWN@0 UP@50; tap1 DOWN@150 UP@200.
    expect(t.map((f) => [f.action, f.tMs])).toEqual([
      [TouchAction.Down, 0],
      [TouchAction.Up, 50],
      [TouchAction.Down, 150],
      [TouchAction.Up, 200],
    ]);
    expect(t.every((f) => f.pointerId === 0)).toBe(true);
  });
});

describe("fast-inject swipe timeline (SwipeHandler parity)", () => {
  it("momentum swipe: head run-up + dense 16ms tail, DOWN first / UP last", () => {
    // steps=10 -> durationMs=160, tailMs=min(160,5*16)=80, headEnd=80.
    // offsets: {0,160} + head{floor(80/3)=26, floor(160/3)=53} + tail{144,128,112,96}.
    const t = buildSwipeTimeline(0, 0, 100, 200, 10);
    const tMs = t.map((f) => f.tMs);
    expect(tMs).toEqual([0, 26, 53, 96, 112, 128, 144, 160]);
    expect(t[0]!.action).toBe(TouchAction.Down);
    expect(t[t.length - 1]!.action).toBe(TouchAction.Up);
    expect(t.slice(1, -1).every((f) => f.action === TouchAction.Move)).toBe(true);
    // Down carries the start point, Up the end point.
    expect({ x: t[0]!.x, y: t[0]!.y }).toEqual({ x: 0, y: 0 });
    expect({ x: t[t.length - 1]!.x, y: t[t.length - 1]!.y }).toEqual({ x: 100, y: 200 });
  });

  it("momentum-free (held) swipe: travel at 8ms then a hold tail at the end point", () => {
    // steps=10 -> 11 travel pts (tMs 0..80 step 8); holdFrames=max(2,ceil(200/8)=25)=25.
    const t = buildSwipeTimeline(0, 0, 100, 100, 10, 200);
    expect(t.length).toBe(11 + 25); // 36 frames
    expect(t[0]!.action).toBe(TouchAction.Down);
    expect(t[t.length - 1]!.action).toBe(TouchAction.Up);
    // Every hold frame (and the UP) sits on the end point so velocity decays to ~0.
    const holdFrames = t.slice(11);
    expect(holdFrames.every((f) => f.x === 100 && f.y === 100)).toBe(true);
    // tMs is monotonic in 8ms steps: last = travel(80) + 25*8 = 280.
    expect(t[t.length - 1]!.tMs).toBe(280);
  });

  it("momentum-free lift velocity < momentum (denser trailing frames on the end point)", () => {
    const momentum = buildSwipeTimeline(0, 0, 300, 0, 10);
    const held = buildSwipeTimeline(0, 0, 300, 0, 10, 120);
    // The held swipe's last two frames are identical position (zero velocity at lift);
    // the momentum swipe's last two frames still advance (non-zero lift velocity).
    const heldLast2 = held.slice(-2);
    expect(heldLast2[0]!.x).toBe(heldLast2[1]!.x);
    const momLast2 = momentum.slice(-2);
    expect(momLast2[0]!.x).not.toBe(momLast2[1]!.x);
  });
});

describe("fast-inject gesture timeline (GestureHandler.resample + MotionInjector.inject parity)", () => {
  it("resample keeps first/last, thins to >=16ms, keeps dwell frames", () => {
    // Frames at 0,8,16,24,32 -> keep 0(first), skip 8(<16), keep 16, skip 24, keep 32(last).
    const path = [0, 8, 16, 24, 32].map((tMs) => ({ x: tMs, y: 0, tMs }));
    const r = resampleGesturePath(path);
    expect(r.map((p) => p.tMs)).toEqual([0, 16, 32]);
  });

  it("dwell (same-position) frames survive thinning even under 16ms", () => {
    const path = [
      { x: 0, y: 0, tMs: 0 },
      { x: 5, y: 5, tMs: 4 }, // <16, moves -> dropped
      { x: 5, y: 5, tMs: 8 }, // dwell (== prev pos) -> kept
      { x: 10, y: 10, tMs: 20 }, // last
    ];
    const r = resampleGesturePath(path);
    expect(r.map((p) => p.tMs)).toEqual([0, 8, 20]);
  });

  it("two-pointer pinch: DOWNs, per-pointer MOVEs, reverse-order UPs", () => {
    const mk = (xs: number[]) => xs.map((x, i) => ({ x, y: 0, tMs: i * 16 }));
    const t = buildGestureTimeline([
      { id: 0, points: mk([0, 10, 20, 30, 40]) },
      { id: 1, points: mk([100, 90, 80, 70, 60]) },
    ]);
    // 5 frames each (all kept, 16ms apart): downs=2, moves=(5-2)*2=6, ups=2 => 10.
    expect(t.length).toBe(10);
    // Downs at t0 for pointer 0 then 1.
    expect(t[0]).toMatchObject({ action: TouchAction.Down, pointerId: 0, tMs: 0 });
    expect(t[1]).toMatchObject({ action: TouchAction.Down, pointerId: 1, tMs: 0 });
    // Moves: three intermediate frames, each pointer 0 then 1, at tMs 16/32/48.
    expect(t.slice(2, 8).map((f) => [f.action, f.pointerId, f.tMs])).toEqual([
      [TouchAction.Move, 0, 16],
      [TouchAction.Move, 1, 16],
      [TouchAction.Move, 0, 32],
      [TouchAction.Move, 1, 32],
      [TouchAction.Move, 0, 48],
      [TouchAction.Move, 1, 48],
    ]);
    // Ups: highest pointer first (POINTER_UP on-device), then pointer 0 (UP), at last tMs 64.
    expect(t[8]).toMatchObject({ action: TouchAction.Up, pointerId: 1, tMs: 64, pressure: 0 });
    expect(t[9]).toMatchObject({ action: TouchAction.Up, pointerId: 0, tMs: 64, pressure: 0 });
  });

  it("rejects mismatched pointer path lengths after resample", () => {
    expect(() =>
      buildGestureTimeline([
        { id: 0, points: [{ x: 0, y: 0, tMs: 0 }, { x: 1, y: 1, tMs: 16 }] },
        { id: 1, points: [{ x: 0, y: 0, tMs: 0 }, { x: 1, y: 1, tMs: 16 }, { x: 2, y: 2, tMs: 32 }] },
      ])
    ).toThrow(/same number of frames/);
  });
});
