import { describe, it, expect } from "vitest";
import {
  BENCH_GESTURE_PARAMS,
  assertIdenticalGestureParams,
  describeInjectedTapTimeline,
  assertTapTimelineParity,
} from "../src/utils/bench-gesture-parity";
import { TouchAction } from "../src/utils/scrcpy-inject-timeline";

// The open-vs-proprietary bench (scripts/bench-open-vs-proprietary.ts) records
// these params per block and calls assertIdenticalGestureParams(blocks) before
// scoring, so an OFF vs ON comparison cannot silently use different timelines.
describe("bench gesture-param parity assertion (P3c fix 5)", () => {
  it("passes when every block ran the identical gesture params", () => {
    const blocks = [
      { block: "OFF-1", gestureParams: BENCH_GESTURE_PARAMS },
      { block: "ON", gestureParams: BENCH_GESTURE_PARAMS },
      { block: "OFF-2", gestureParams: BENCH_GESTURE_PARAMS },
    ];
    expect(() => assertIdenticalGestureParams(blocks)).not.toThrow();
  });

  it("throws when a block used a different durationMs/holdMs (the v2 pinch-cap bug)", () => {
    const blocks = [
      { block: "OFF-1", gestureParams: BENCH_GESTURE_PARAMS },
      {
        block: "ON",
        gestureParams: { ...BENCH_GESTURE_PARAMS, pinchDurationMs: 180 },
      },
      { block: "OFF-2", gestureParams: BENCH_GESTURE_PARAMS },
    ];
    expect(() => assertIdenticalGestureParams(blocks)).toThrow(/parity violated/);
  });

  it("is a no-op for fewer than two blocks", () => {
    expect(() =>
      assertIdenticalGestureParams([{ block: "ON", gestureParams: BENCH_GESTURE_PARAMS }])
    ).not.toThrow();
    expect(() => assertIdenticalGestureParams([])).not.toThrow();
  });

  it("holds the honest defaults (50 ms hold, 250 ms swipe, 300 ms pinch)", () => {
    expect(BENCH_GESTURE_PARAMS).toEqual({
      swipeDurationMs: 250,
      pinchDurationMs: 300,
      tapHoldMs: 50,
    });
  });
});

// Phase 3h: the injected tap timeline is recorded per block so the merge can prove
// tap parity from the real shape. The scrcpy tap carries a same-point MOVE (the
// tap-landing fix); UiAutomation/proprietary inject a bare DOWN→UP.
describe("bench injected tap-timeline recording + parity (phase 3h)", () => {
  it("scrcpy tap timeline is DOWN → MOVE → UP with the MOVE flagged", () => {
    const tl = describeInjectedTapTimeline("scrcpy", 50);
    expect(tl.frameCount).toBe(3);
    expect(tl.hasMoveFrame).toBe(true);
    expect(tl.frames.map((f) => f.action)).toEqual([
      TouchAction.Down,
      TouchAction.Move,
      TouchAction.Up,
    ]);
    expect(tl.frames.map((f) => f.tMs)).toEqual([0, 25, 50]);
  });

  it("uiautomation and proprietary tap timelines are a bare DOWN → UP (no MOVE)", () => {
    for (const backend of ["uiautomation", "proprietary"] as const) {
      const tl = describeInjectedTapTimeline(backend, 50);
      expect(tl.frameCount).toBe(2);
      expect(tl.hasMoveFrame).toBe(false);
      expect(tl.frames.map((f) => f.action)).toEqual([TouchAction.Down, TouchAction.Up]);
    }
  });

  it("parity passes across the 4 blocks: same holdMs, MOVE only on the scrcpy block", () => {
    const blocks = [
      { block: "OFF-1", fastInject: false, injectedTapTimeline: describeInjectedTapTimeline("proprietary", 50) },
      { block: "ON-uiautomation", fastInject: false, injectedTapTimeline: describeInjectedTapTimeline("uiautomation", 50) },
      { block: "ON-scrcpy", fastInject: true, injectedTapTimeline: describeInjectedTapTimeline("scrcpy", 50) },
      { block: "OFF-2", fastInject: false, injectedTapTimeline: describeInjectedTapTimeline("proprietary", 50) },
    ];
    expect(() => assertTapTimelineParity(blocks)).not.toThrow();
  });

  it("throws when holdMs drifts across blocks", () => {
    const blocks = [
      { block: "ON-uiautomation", injectedTapTimeline: describeInjectedTapTimeline("uiautomation", 50) },
      { block: "ON-scrcpy", injectedTapTimeline: describeInjectedTapTimeline("scrcpy", 80) },
    ];
    expect(() => assertTapTimelineParity(blocks)).toThrow(/parity violated/);
  });

  it("throws if a non-scrcpy block somehow carries a MOVE (or scrcpy loses it)", () => {
    const scrcpyShape = describeInjectedTapTimeline("scrcpy", 50);
    const blocks = [
      { block: "ON-uiautomation", injectedTapTimeline: { ...scrcpyShape, backend: "uiautomation" as const } },
      { block: "ON-scrcpy", injectedTapTimeline: scrcpyShape },
    ];
    expect(() => assertTapTimelineParity(blocks)).toThrow(/parity violated/);
  });
});
