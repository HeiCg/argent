import { describe, it, expect } from "vitest";
import {
  BENCH_GESTURE_PARAMS,
  assertIdenticalGestureParams,
} from "../src/utils/bench-gesture-parity";

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
