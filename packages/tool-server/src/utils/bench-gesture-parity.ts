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
// Phase 3n.2: the scrcpy fast-inject path was removed, so this no longer imports the
// scrcpy timeline. The MotionEvent action codes are inlined for the parity shape check
// (DOWN then UP, no MOVE) — every remaining backend injects a bare two-frame tap.
const TouchAction = { Down: 0, Up: 1, Move: 2 } as const;

export interface BenchGestureParams {
  /** gesture-swipe authored duration (ms). */
  swipeDurationMs: number;
  /** gesture-pinch authored duration (ms). */
  pinchDurationMs: number;
  /** tap press hold (ms) — tool-enforced on both backends (F1/F8). */
  tapHoldMs: number;
}

/** Which injector a block actually drove tap/swipe/gesture through. */
export type InjectBackend = "uiautomation" | "proprietary";

/**
 * The tap frame timeline a block actually injected — frame count, per-frame `tMs`,
 * and the authored `holdMs` — recorded per block so the merge can prove parity
 * from the REAL shape rather than from re-reading the same source constant (which
 * is meaningless per block under BENCH_ONLY). Phase 3h: every backend injects the
 * IDENTICAL two-frame DOWN→UP tap (no MOVE — it lands as-is). Parity is exact: same
 * holdMs, same two frames, no MOVE anywhere.
 */
export interface InjectedTapTimeline {
  backend: InjectBackend;
  holdMs: number;
  frameCount: number;
  /** [action, tMs] per frame, in order (action uses MotionEvent action codes). */
  frames: Array<{ action: number; tMs: number }>;
  hasMoveFrame: boolean;
}

/**
 * The tap timeline the given backend injects for a single tap held `holdMs`. Every
 * backend (UiAutomation / proprietary) emits the bare DOWN→UP its on-device injector
 * sends — a clean two-frame tap, no MOVE. (Phase 3n.2: the scrcpy backend and its
 * timeline builder were removed.)
 */
export function describeInjectedTapTimeline(
  backend: InjectBackend,
  holdMs: number
): InjectedTapTimeline {
  return {
    backend,
    holdMs,
    frameCount: 2,
    frames: [
      { action: TouchAction.Down, tMs: 0 },
      { action: TouchAction.Up, tMs: holdMs },
    ],
    hasMoveFrame: false,
  };
}

/**
 * Cross-block tap-timeline parity (phase 3h). Throws unless every block injected the
 * IDENTICAL tap: same authored `holdMs`, exactly two frames (DOWN then UP), and NO
 * MOVE on any backend — every backend (UiAutomation/proprietary) is at parity by
 * shape, not merely by holdMs.
 */
export function assertTapTimelineParity(
  // Phase 3n.3 (3N2-L4): the vestigial `fastInject?: boolean` was dropped — nothing set
  // it after the scrcpy removal.
  blocks: Array<{ block: string; injectedTapTimeline?: InjectedTapTimeline }>
): void {
  const withTl = blocks.filter((b) => b.injectedTapTimeline);
  const first = withTl[0];
  if (!first?.injectedTapTimeline) return;
  const holdMs = first.injectedTapTimeline.holdMs;
  for (const b of withTl) {
    const tl = b.injectedTapTimeline!;
    if (tl.holdMs !== holdMs) {
      throw new Error(
        `tap-timeline parity violated: ${b.block} holdMs=${tl.holdMs} != ${first.block} holdMs=${holdMs}`
      );
    }
    if (tl.hasMoveFrame || tl.frameCount !== 2) {
      throw new Error(
        `tap-timeline parity violated: ${b.block} (backend ${tl.backend}) is not a clean ` +
          `two-frame DOWN→UP (frameCount=${tl.frameCount}, hasMoveFrame=${tl.hasMoveFrame})`
      );
    }
  }
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
