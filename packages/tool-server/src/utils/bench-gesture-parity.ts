/**
 * Gesture-timing parameters the open-vs-proprietary bench drives BOTH backends
 * with, and the assertion that proves they were identical across every block.
 *
 * The bench toggles only the `open-device-server` flag between OFF and ON blocks;
 * the gesture params below are the same literals for both. The v2 report's tap /
 * pinch "wins" came from the open path secretly using a shorter timeline (a
 * no-hold tap, a 180 ms pinch cap) than the proprietary path — so the honest
 * comparison depends on OFF and ON running the SAME `holdMs` / `durationMs`. This
 * asserts exactly that from the recorded per-block params, turning "we used the
 * same numbers" from a claim into a checked invariant.
 */
export interface BenchGestureParams {
  /** gesture-swipe authored duration (ms). */
  swipeDurationMs: number;
  /** gesture-pinch authored duration (ms). */
  pinchDurationMs: number;
  /** tap press hold (ms) — tool-enforced on both backends (F1/F8). */
  tapHoldMs: number;
}

export const BENCH_GESTURE_PARAMS: BenchGestureParams = {
  swipeDurationMs: 250,
  pinchDurationMs: 300,
  tapHoldMs: 50,
};

/**
 * Throw unless every block used byte-identical gesture params — so a bench run
 * cannot silently compare a 300 ms pinch on one backend against a 180 ms pinch on
 * the other. Blocks with < 2 entries are trivially consistent.
 */
export function assertIdenticalGestureParams(
  blocks: Array<{ block: string; gestureParams: BenchGestureParams }>
): void {
  const first = blocks[0];
  if (!first) return;
  const keys = Object.keys(first.gestureParams) as Array<keyof BenchGestureParams>;
  for (const b of blocks.slice(1)) {
    for (const k of keys) {
      if (b.gestureParams[k] !== first.gestureParams[k]) {
        throw new Error(
          `bench gesture-param parity violated: ${b.block}.${k}=${b.gestureParams[k]} ` +
            `!= ${first.block}.${k}=${first.gestureParams[k]} — OFF and ON must run the ` +
            `identical holdMs/durationMs for a like-for-like comparison.`
        );
      }
    }
  }
}
