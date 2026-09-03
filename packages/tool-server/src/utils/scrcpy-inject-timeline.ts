/**
 * Host-side touch timelines for the scrcpy fast-inject backend (phase 3f), a
 * faithful port of the on-device Kotlin `MotionInjector` / `TapHandler` /
 * `SwipeHandler` / `GestureHandler` so a gesture injected over the scrcpy control
 * channel has the SAME shape (frame count, per-frame `tMs`, positions, pointer
 * order) it has when the Kotlin server injects it via UiAutomation. Keeping the
 * pacing identical is what preserves fling fidelity: the OS VelocityTracker fits
 * the release velocity over the last ~100 ms, so the dense trailing tail of a
 * momentum swipe and the decelerating hold of a momentum-free swipe must land at
 * the same wall-clock offsets they do on-device.
 *
 * This module is PURE (no `@yume-chan`, no I/O): it turns verb parameters into an
 * ordered list of {@link TouchFrame}s. The backend ({@link
 * scrcpy-inject-backend}) paces and injects them; the unit tests assert this
 * output equals the Kotlin timelines.
 *
 * Wire vs Android actions. scrcpy's on-device server maintains its own pointer
 * set and RE-COMPUTES `ACTION_POINTER_DOWN` / `ACTION_POINTER_UP` (with the
 * shifted pointer index) from a plain `ACTION_DOWN` / `ACTION_UP` based on how
 * many pointers are currently down. So on the wire every finger's press is a
 * {@link TouchAction.Down} and every lift an {@link TouchAction.Up}; the server
 * turns the 2nd..nth of them into the POINTER_* forms the Kotlin `MotionInjector`
 * emits directly.
 *
 * IMPORTANT — multi-pointer is NOT a per-event parity claim. Kotlin's
 * `MotionInjector` sends a multi-pointer MOVE as ONE `MotionEvent` carrying all
 * pointers' updated coordinates; scrcpy is one pointer per control message, so the
 * same tick becomes N separate messages here. The server applies each to its
 * pointer set and dispatches a MotionEvent per message, i.e. ~N× as many on-device
 * MotionEvents per tick, and the intermediate ones are "half-updated" (pointer 0
 * moved, pointer 1 not yet). The gesture still lands correctly and the resampled
 * frame timing matches, but the on-device event STREAM differs from Kotlin's, so
 * pinch/rotate/custom gestures are excluded from any "per-event parity" / "fling
 * fidelity unchanged" claim in the v7 report — only single-pointer tap/swipe make
 * that claim (one message per event there, so the streams do match).
 */

/** scrcpy wire touch actions (subset of `AndroidMotionEventAction`, same values). */
export const TouchAction = {
  Down: 0,
  Up: 1,
  Move: 2,
} as const;
export type TouchActionValue = (typeof TouchAction)[keyof typeof TouchAction];

/** One touch message to inject: a single pointer at one instant. */
export interface TouchFrame {
  action: TouchActionValue;
  /** Finger index (0-based); the backend maps it to a scrcpy `bigint` pointerId. */
  pointerId: number;
  /** Device-pixel coordinates. */
  x: number;
  y: number;
  /** Wall-clock offset (ms) from gesture start; the backend paces against it. */
  tMs: number;
  /** 1 while the finger is down (Down/Move), 0 on the lift (Up). */
  pressure: number;
}

/* -------------------------------------------------------------------------- */
/* Tap — port of MotionInjector.injectTaps / TapHandler                       */
/* -------------------------------------------------------------------------- */

export interface TapTimelineOpts {
  clickCount: number;
  holdMs: number;
  gapMs: number;
}

/**
 * `clickCount` presses at (x, y), each held `holdMs`, successive taps `gapMs`
 * apart, as ONE timeline — so a double-tap lands inside the OS double-tap window
 * (F1/F8/F9). Tap k presses DOWN at `k*(holdMs+gapMs)`, holds, and lifts UP at
 * `+holdMs`.
 *
 * DIVERGENCE from the Kotlin `MotionInjector.injectTaps` (phase 3h). The Kotlin
 * path injects a bare DOWN→UP via `UiAutomation.injectInputEvent` and it lands.
 * scrcpy injects the SAME two events via a shell-uid `InputManager.injectInputEvent`
 * (`INJECT_MODE_ASYNC`), and on the emulator a MOVE-less DOWN→UP does NOT land
 * (`pngDiffRatio == 0`, tap→describe destination 0/20) even though scrcpy swipe /
 * held-swipe — which carry MOVE frames at the SAME coordinates — do land. The async
 * UP arrives before the async DOWN has established a touch target for a static
 * press, so the click is dropped. Inserting one same-point MOVE between DOWN and UP
 * (at the hold midpoint) commits the press exactly as the working swipe does, and
 * a standard clickable View still fires `performClick()` on UP (zero displacement
 * is within touch slop, `holdMs` is within the tap timeout). This MOVE is
 * scrcpy-path-only; it does not change the Kotlin/UiAutomation or proprietary tap.
 */
export function buildTapTimeline(x: number, y: number, opts: TapTimelineOpts): TouchFrame[] {
  const count = Math.max(1, opts.clickCount);
  const holdMs = Math.max(0, opts.holdMs);
  const gapMs = Math.max(0, opts.gapMs);
  const period = holdMs + gapMs;
  const frames: TouchFrame[] = [];
  for (let k = 0; k < count; k++) {
    const downSlot = k * period;
    // Same-point MOVE at the hold midpoint: paced with a real-clock gap on either
    // side (like the swipe frames) so the DOWN is committed before the UP.
    const moveSlot = downSlot + Math.trunc(holdMs / 2);
    frames.push({ action: TouchAction.Down, pointerId: 0, x, y, tMs: downSlot, pressure: 1 });
    frames.push({ action: TouchAction.Move, pointerId: 0, x, y, tMs: moveSlot, pressure: 1 });
    frames.push({ action: TouchAction.Up, pointerId: 0, x, y, tMs: downSlot + holdMs, pressure: 0 });
  }
  return frames;
}

/* -------------------------------------------------------------------------- */
/* Swipe — port of SwipeHandler (momentum + momentum-free/held)               */
/* -------------------------------------------------------------------------- */

// SwipeHandler companion constants.
const STEP_MS = 8; // held-swipe sample spacing
const MOMENTUM_STEP_MS = 16; // plain-swipe cadence (mirrors the proprietary path)
const TAIL_SAMPLES = 5; // dense frames near the lift the velocity tracker fits
const HEAD_SAMPLES = 2; // coarse run-up frames before the tail

/** Turn a single-pointer positional path into Down / Move… / Up wire frames. */
function pathToFrames(path: Array<{ x: number; y: number; tMs: number }>): TouchFrame[] {
  const frames: TouchFrame[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    const action =
      i === 0 ? TouchAction.Down : i === path.length - 1 ? TouchAction.Up : TouchAction.Move;
    frames.push({
      action,
      pointerId: 0,
      x: p.x,
      y: p.y,
      tMs: p.tMs,
      pressure: action === TouchAction.Up ? 0 : 1,
    });
  }
  return frames;
}

/**
 * Plain flinging swipe — port of `SwipeHandler.injectMomentumSwipe`. Down at 0,
 * two coarse run-up frames, then a dense tail at 16 ms cadence so the OS velocity
 * fit over the last ~100 ms sees the same motion the proprietary 16 ms-per-frame
 * path produces, then the lift carries that velocity.
 */
function buildMomentumSwipe(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  steps: number
): TouchFrame[] {
  const requested = Math.max(1, steps);
  const durationMs = requested * MOMENTUM_STEP_MS;
  const tailMs = Math.min(durationMs, TAIL_SAMPLES * MOMENTUM_STEP_MS);
  const headEnd = durationMs - tailMs;
  // Kotlin uses a sorted Long set: unique, ascending, values truncated toward 0.
  const offsets = new Set<number>([0, Math.trunc(durationMs)]);
  for (let h = 1; h <= HEAD_SAMPLES; h++) {
    offsets.add(Math.trunc((headEnd * h) / (HEAD_SAMPLES + 1)));
  }
  for (let t = durationMs; t > headEnd; t -= MOMENTUM_STEP_MS) {
    offsets.add(Math.trunc(t));
  }
  const ordered = [...offsets].sort((a, b) => a - b);
  const path = ordered.map((ms) => {
    const f = durationMs > 0 ? ms / durationMs : 1.0;
    return { x: startX + (endX - startX) * f, y: startY + (endY - startY) * f, tMs: ms };
  });
  return pathToFrames(path);
}

/**
 * Momentum-free / held swipe — port of `SwipeHandler.injectHeldSwipe`. Travels
 * start→end over `steps` samples at 8 ms, then holds the end point for
 * `holdEndMs` so the velocity tracker reads ~0 at the lift (little/no fling).
 */
function buildHeldSwipe(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  steps: number,
  holdEndMs: number
): TouchFrame[] {
  const travelSteps = Math.max(1, steps);
  const path: Array<{ x: number; y: number; tMs: number }> = [];
  for (let i = 0; i <= travelSteps; i++) {
    const t = i / travelSteps;
    path.push({
      x: startX + (endX - startX) * t,
      y: startY + (endY - startY) * t,
      tMs: i * STEP_MS,
    });
  }
  // holdFrames = max(2, ceil(holdEndMs / STEP_MS)) via integer arithmetic.
  const holdFrames = Math.max(2, Math.trunc((holdEndMs + STEP_MS - 1) / STEP_MS));
  const baseT = travelSteps * STEP_MS;
  for (let h = 1; h <= holdFrames; h++) {
    path.push({ x: endX, y: endY, tMs: baseT + h * STEP_MS });
  }
  return pathToFrames(path);
}

/**
 * Swipe timeline. `holdEndMs > 0` selects the momentum-free (held) swipe; omit /
 * 0 gives the plain flinging swipe. Mirrors `SwipeHandler.execute`.
 */
export function buildSwipeTimeline(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  steps: number,
  holdEndMs = 0
): TouchFrame[] {
  return holdEndMs > 0
    ? buildHeldSwipe(startX, startY, endX, endY, steps, holdEndMs)
    : buildMomentumSwipe(startX, startY, endX, endY, steps);
}

/* -------------------------------------------------------------------------- */
/* Gesture — port of GestureHandler.resample + MotionInjector.inject          */
/* -------------------------------------------------------------------------- */

const GESTURE_STEP_MS = 16; // GestureHandler resample cadence (F18)

/** One pointer's device-pixel path for {@link buildGestureTimeline}. */
export interface GesturePointer {
  id: number;
  points: Array<{ x: number; y: number; tMs: number }>;
}

/**
 * Time-uniform thinning — port of `GestureHandler.resample`: keep the first and
 * last frame, keep any dwell frame (same position as the previous — part of a
 * hold), and otherwise keep a frame only once ≥16 ms has elapsed since the last
 * kept frame. Original timestamps are preserved; nothing is resynthesized.
 */
export function resampleGesturePath(
  path: Array<{ x: number; y: number; tMs: number }>
): Array<{ x: number; y: number; tMs: number }> {
  const size = path.length;
  if (size <= 2) return path.slice();
  const out = [path[0]!];
  let lastKeptT = path[0]!.tMs;
  for (let i = 1; i < size - 1; i++) {
    const p = path[i]!;
    const prev = path[i - 1]!;
    const isDwell = p.x === prev.x && p.y === prev.y;
    if (isDwell || p.tMs - lastKeptT >= GESTURE_STEP_MS) {
      out.push(p);
      lastKeptT = p.tMs;
    }
  }
  out.push(path[size - 1]!);
  return out;
}

/**
 * Multi-pointer gesture (pinch / rotate / custom) — port of
 * `MotionInjector.inject` over each pointer's resampled path. Emits, in order:
 * every pointer's DOWN at the first frame (pointer 0 then the rest — the scrcpy
 * server turns 2nd..nth into POINTER_DOWN); one MOVE per pointer at every
 * intermediate frame; then every pointer's UP at the last frame, highest index
 * first (POINTER_UP…) down to pointer 0 (UP) — the reverse-lift order the OS
 * expects. All paths must resample to the same length (the gesture tools emit one
 * frame per pointer per tick), matching the Kotlin injector's equal-length rule.
 */
export function buildGestureTimeline(pointers: GesturePointer[]): TouchFrame[] {
  if (pointers.length < 1) throw new Error("gesture needs at least one pointer");
  const resampled = pointers.map((p) => ({ id: p.id, points: resampleGesturePath(p.points) }));
  const frames = resampled[0]!.points.length;
  if (frames < 2) throw new Error("each pointer needs at least a down and an up frame");
  for (const p of resampled) {
    if (p.points.length !== frames) {
      throw new Error("all pointers must have the same number of frames after resample");
    }
  }
  const n = resampled.length;
  const out: TouchFrame[] = [];

  // Downs: pointer 0, then each additional pointer, all at frame 0's tMs.
  const downT = resampled[0]!.points[0]!.tMs;
  for (let k = 0; k < n; k++) {
    const p = resampled[k]!.points[0]!;
    out.push({ action: TouchAction.Down, pointerId: resampled[k]!.id, x: p.x, y: p.y, tMs: downT, pressure: 1 });
  }

  // Moves: every intermediate frame, one message per pointer at that frame's tMs.
  for (let f = 1; f < frames - 1; f++) {
    const moveT = resampled[0]!.points[f]!.tMs;
    for (let i = 0; i < n; i++) {
      const p = resampled[i]!.points[f]!;
      out.push({ action: TouchAction.Move, pointerId: resampled[i]!.id, x: p.x, y: p.y, tMs: moveT, pressure: 1 });
    }
  }

  // Ups: highest-indexed pointer first, primary pointer last, all at the last tMs.
  const last = frames - 1;
  const upT = resampled[0]!.points[last]!.tMs;
  for (let k = n - 1; k >= 0; k--) {
    const p = resampled[k]!.points[last]!;
    out.push({ action: TouchAction.Up, pointerId: resampled[k]!.id, x: p.x, y: p.y, tMs: upT, pressure: 0 });
  }
  return out;
}
