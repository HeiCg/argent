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
import { buildTapTimeline, TouchAction } from "./scrcpy-inject-timeline";

export interface BenchGestureParams {
  /** gesture-swipe authored duration (ms). */
  swipeDurationMs: number;
  /** gesture-pinch authored duration (ms). */
  pinchDurationMs: number;
  /** tap press hold (ms) — tool-enforced on both backends (F1/F8). */
  tapHoldMs: number;
}

/** Which injector a block actually drove tap/swipe/gesture through. */
export type InjectBackend = "scrcpy" | "uiautomation" | "proprietary";

/**
 * The tap frame timeline a block actually injected — frame count, per-frame `tMs`,
 * and the authored `holdMs` — recorded per block so the merge can prove parity
 * from the REAL shape rather than from re-reading the same source constant (which
 * is meaningless per block under BENCH_ONLY). Phase 3h: the scrcpy path carries a
 * same-point MOVE between DOWN and UP (the tap-landing fix); the UiAutomation and
 * proprietary paths inject a bare DOWN→UP (they land without it). So the tap frame
 * COUNT legitimately differs by backend — the invariant that must hold across
 * blocks is the authored `holdMs`, plus "exactly the scrcpy block carries a MOVE".
 */
export interface InjectedTapTimeline {
  backend: InjectBackend;
  holdMs: number;
  frameCount: number;
  /** [action, tMs] per frame, in order (action uses the scrcpy wire values). */
  frames: Array<{ action: number; tMs: number }>;
  hasMoveFrame: boolean;
}

/**
 * The tap timeline the given backend injects for a single tap held `holdMs`. The
 * scrcpy shape comes straight from {@link buildTapTimeline} (single source of
 * truth for what the fast-inject backend sends); the UiAutomation / proprietary
 * shape is the bare DOWN→UP their on-device injectors emit.
 */
export function describeInjectedTapTimeline(
  backend: InjectBackend,
  holdMs: number
): InjectedTapTimeline {
  if (backend === "scrcpy") {
    const frames = buildTapTimeline(0, 0, { clickCount: 1, holdMs, gapMs: 100 });
    return {
      backend,
      holdMs,
      frameCount: frames.length,
      frames: frames.map((f) => ({ action: f.action, tMs: f.tMs })),
      hasMoveFrame: frames.some((f) => f.action === TouchAction.Move),
    };
  }
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
 * Cross-block tap-timeline parity (phase 3h). Throws unless every block used the
 * identical authored `holdMs`, and the MOVE frame is present in EXACTLY the scrcpy
 * blocks (the fast-inject tap-landing fix) and absent everywhere else. This is the
 * honest replacement for "assert the frame count is identical across blocks": the
 * scrcpy tap genuinely carries one extra same-point MOVE, so a naive equality would
 * be wrong — this asserts the intended shape instead.
 */
export function assertTapTimelineParity(
  blocks: Array<{ block: string; fastInject?: boolean; injectedTapTimeline?: InjectedTapTimeline }>
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
    const expectMove = tl.backend === "scrcpy";
    if (tl.hasMoveFrame !== expectMove) {
      throw new Error(
        `tap-timeline parity violated: ${b.block} (backend ${tl.backend}) ` +
          `hasMoveFrame=${tl.hasMoveFrame} but expected ${expectMove} ` +
          `(only the scrcpy fast-inject tap carries a same-point MOVE)`
      );
    }
    // The scrcpy MOVE sits strictly between DOWN and UP.
    if (expectMove) {
      const [d, m, u] = tl.frames;
      if (!d || !m || !u || !(d.tMs <= m.tMs && m.tMs <= u.tMs)) {
        throw new Error(`tap-timeline parity violated: ${b.block} scrcpy frames not DOWN≤MOVE≤UP: ${JSON.stringify(tl.frames)}`);
      }
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
