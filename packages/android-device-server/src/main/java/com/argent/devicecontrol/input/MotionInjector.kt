package com.argent.devicecontrol.input

import android.app.UiAutomation
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent

/**
 * Low-level multi-pointer touch injector over [UiAutomation.injectInputEvent].
 *
 * A gesture is a set of synchronized pointer paths: every pointer carries the
 * same number of frames sampled at the same timeline, so frame `f` of every
 * pointer happens at the same `tMs`. That is exactly what the host-side gesture
 * tools (swipe, pinch, rotate, custom) already generate — one Move per frame
 * across all fingers — so requiring equal-length paths keeps the wire shape
 * simple without losing any gesture the proprietary path could send.
 *
 * `uiDevice.swipe()` cannot express a hold before the lift, which is what a
 * momentum-free swipe needs to kill fling: repeating the end point across
 * several trailing frames drives the OS velocity tracker to ~0 before ACTION_UP.
 * Injecting the timeline by hand is the only way to get that, so both the
 * multi-pointer `gesture` RPC and the single-pointer momentum-free swipe route
 * through here.
 *
 * Pacing (F17). Frames are paced against a real wall clock anchored at the
 * gesture's start, NOT by sleeping the delta between successive scheduled times:
 * if one frame's dispatch runs long, the next frame's wait shrinks so the
 * timeline does not drift. Each injected event's `eventTime` is the ACTUAL
 * `SystemClock.uptimeMillis()` at dispatch, so the framework VelocityTracker and
 * long-press timer — which key off arrival time — see the truth rather than an
 * optimistic schedule.
 *
 * Final-event sync (F3). The last ACTION_UP is always injected synchronously, so
 * the RPC returns only after the whole gesture has actually been dispatched (the
 * finger is up) — the parity the proprietary path's blocking Up gives. Only the
 * intermediate DOWN / MOVE / POINTER_UP events are async: the wall-clock pacing
 * above already spaces their arrival, so blocking on each one bought nothing but
 * latency.
 *
 * Drop surfacing (R1, phase 3g). [UiAutomation.injectInputEvent] returns whether
 * the event was accepted; the framework rejects an injection when there is no
 * focused/injectable window (mid-transition, secure surface, another injector
 * holding the pipe). The phase-3e code discarded that boolean, so a tap that
 * never landed still returned `success`. Every site now records the return and
 * [inject] / [injectTaps] return `dropped = true` if ANY event was rejected, so
 * the handler can surface it and fail the action instead of lying.
 */
object MotionInjector {

    /** One sampled point on a pointer's path. `tMs` is relative to gesture start. */
    data class Point(val x: Float, val y: Float, val tMs: Long)

    // R1 (phase 3e/3g). A `tap`'s final ACTION_UP is injected asynchronously so
    // the RPC returns as soon as the UP is queued. [AsyncUpTracker] remembers that
    // and enforces the "drain before capture, clear the flag only AFTER the sync
    // flush returns" ordering (see the class doc). Any synchronous injection here
    // (a gesture's final UP) already flushes the dispatcher FIFO, so it clears the
    // flag directly.
    private val asyncUp = AsyncUpTracker()

    /**
     * Inject a synchronized multi-pointer gesture. `paths` is one entry per
     * pointer; `ids[i]` is pointer i's stable id. Every path must be the same
     * length (>= 2: a down frame and an up frame). Coordinates are device pixels.
     * The final ACTION_UP is dispatched synchronously under DEFAULT (F3); the
     * explicit [strategy] values override the final-UP mode (phase 3n).
     *
     * @return the [InjectOutcome]: `dropped` if any event was rejected, plus the
     *   strategy that actually ran (`"unavailable"` on a hiddenapi fallback).
     */
    fun inject(
        uiAutomation: UiAutomation,
        ids: IntArray,
        paths: List<List<Point>>,
        strategy: InjectStrategy = InjectStrategy.DEFAULT
    ): InjectOutcome {
        val n = paths.size
        require(n >= 1) { "gesture needs at least one pointer" }
        require(ids.size == n) { "ids and paths length mismatch" }
        val frames = paths[0].size
        require(frames >= 2) { "each pointer needs at least a down and an up frame" }
        for (path in paths) {
            require(path.size == frames) { "all pointers must have the same number of frames" }
        }

        val props = Array(n) { i ->
            MotionEvent.PointerProperties().apply {
                id = ids[i]
                toolType = MotionEvent.TOOL_TYPE_FINGER
            }
        }
        val coords = Array(n) { MotionEvent.PointerCoords() }

        // Anchor the whole timeline to one real start instant; every frame's
        // wall-clock slot is `downTime + tMs`, and we wait against `uptimeMillis()`
        // rather than the previous frame's scheduled time, so a slow dispatch does
        // not push the rest of the gesture late (F17).
        val downTime = SystemClock.uptimeMillis()
        var dropped = false

        // Resolve the strategy for this gesture. A swipe/gesture's DEFAULT keeps its
        // SYNCHRONOUS final UP (F3): the RPC returns only once the finger is up. The
        // explicit strategies override that (uia-async / input-manager return after
        // the async UP and fold the drain into the next read; uia-sync forces the
        // blocking UP). input-manager degrades to uia-async when the hidden API is
        // blocked, reported on the outcome.
        val effective = resolveEffective(strategy)
        val finalUpSync = finalUpSyncFor(effective.strategy, defaultFinalUpSync = true)

        fun setCoords(frame: Int, count: Int) {
            for (i in 0 until count) {
                val p = paths[i][frame]
                coords[i].apply {
                    x = p.x
                    y = p.y
                    pressure = 1f
                    size = 1f
                }
            }
        }

        fun send(action: Int, count: Int, slotMs: Long, isFinalUp: Boolean = false) {
            // Real-clock pacing: sleep only for the time still remaining until this
            // frame's slot, measured now.
            val waitMs = (downTime + slotMs) - SystemClock.uptimeMillis()
            if (waitMs > 0) SystemClock.sleep(waitMs)
            // The event's timestamp is the true arrival time, so VelocityTracker
            // fits its curve over what actually happened (F17).
            val eventTime = SystemClock.uptimeMillis()
            val event = MotionEvent.obtain(
                downTime,
                eventTime,
                action,
                count,
                props.copyOfRange(0, count),
                coords.copyOfRange(0, count),
                0,
                0,
                1f,
                1f,
                0,
                0,
                InputDevice.SOURCE_TOUCHSCREEN,
                0
            )
            // Only the FINAL UP blocks, and only for a sync strategy; every other
            // frame is async (its arrival is already spaced by the wall-clock wait
            // above). input-manager routes every frame through the reflective ASYNC
            // pipe regardless.
            val doSync = isFinalUp && finalUpSync
            try {
                if (!dispatchEvent(uiAutomation, effective.strategy, event, doSync)) dropped = true
            } finally {
                event.recycle()
            }
        }

        // Downs: pointer 0 with ACTION_DOWN, each additional pointer with an
        // ACTION_POINTER_DOWN carrying every pointer already on the glass.
        for (k in 0 until n) {
            setCoords(0, k + 1)
            val action = if (k == 0) {
                MotionEvent.ACTION_DOWN
            } else {
                MotionEvent.ACTION_POINTER_DOWN or (k shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
            }
            send(action, k + 1, paths[0][0].tMs)
        }

        // Moves: every intermediate frame with all pointers at that frame.
        for (f in 1 until frames - 1) {
            setCoords(f, n)
            send(MotionEvent.ACTION_MOVE, n, paths[0][f].tMs)
        }

        // Ups: lift the highest-indexed pointer first (ACTION_POINTER_UP), then
        // the primary pointer with ACTION_UP. The final ACTION_UP is synchronous
        // so the RPC returns only after the finger is actually up (F3).
        val last = frames - 1
        val upSlot = paths[0][last].tMs
        for (k in n - 1 downTo 1) {
            setCoords(last, k + 1)
            send(
                MotionEvent.ACTION_POINTER_UP or (k shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),
                k + 1,
                upSlot
            )
        }
        setCoords(last, 1)
        send(MotionEvent.ACTION_UP, 1, upSlot, isFinalUp = true)
        // Settle bookkeeping. A synchronous final UP (default swipe/gesture, or
        // uia-sync) already drained the dispatcher FIFO — including any tap async UP
        // still in flight — so clear the flag. An async final UP (uia-async /
        // input-manager) leaves the UP queued; record it at the end point so the
        // next state/hierarchy read folds the drain in (an async-UP
        // asymmetry, on this channel).
        val finalUpWasSync = effective.strategy != InjectStrategy.INPUT_MANAGER && finalUpSync
        if (finalUpWasSync) {
            asyncUp.clear()
        } else {
            asyncUp.markOutstanding(coords[0].x, coords[0].y)
        }
        InjectStrategyCounter.record(effective.reported)
        return InjectOutcome(dropped, effective.reported, effective.fellBackTo, effective.error)
    }

    /**
     * Inject a sequence of [count] taps at (x, y) as one timeline (F1/F8/F9).
     *
     * Each tap is an ACTION_DOWN held [holdMs] before its ACTION_UP; successive
     * taps are separated by [gapMs] of empty time so the whole run lands inside
     * the OS double-tap window (which is what a host-side loop of single taps
     * could not guarantee). For `count = 2` this emits four events — DOWN@0,
     * UP@holdMs, DOWN@(holdMs+gapMs), UP@(2*holdMs+gapMs) — each tap carrying its
     * own `downTime`, as a real multi-tap does. The final ACTION_UP is injected
     * ASYNCHRONOUSLY (R1, phase 3e): the RPC returns as soon as the UP is queued,
     * so a plain tap no longer pays the sync round-trip on top of its `holdMs`
     * press. Ordering vs a following capture is preserved by the dispatcher's FIFO
     * delivery, and [StateHandler]/[HierarchyHandler] flush the pending UP via
     * [drainAsyncUp] before they read the tree. The final-UP mode is DEFAULT
     * (async); the explicit [strategy] values override it (phase 3n).
     *
     * @return the [InjectOutcome]: `dropped` if any event was rejected, plus the
     *   strategy that actually ran (`"unavailable"` on a hiddenapi fallback).
     */
    fun injectTaps(
        uiAutomation: UiAutomation,
        x: Float,
        y: Float,
        count: Int,
        holdMs: Long,
        gapMs: Long,
        strategy: InjectStrategy = InjectStrategy.DEFAULT
    ): InjectOutcome {
        require(count >= 1) { "tap needs count >= 1" }
        // A tap's DEFAULT is an ASYNC final UP (F1/R1): the RPC returns as soon as
        // the UP is queued and the next capture drains it. uia-sync opts into a
        // blocking UP; input-manager routes every event through the reflective ASYNC
        // pipe (falling back to uia-async when the hidden API is blocked).
        val effective = resolveEffective(strategy)
        val finalUpSync = finalUpSyncFor(effective.strategy, defaultFinalUpSync = false)
        val props = MotionEvent.PointerProperties().apply {
            id = 0
            toolType = MotionEvent.TOOL_TYPE_FINGER
        }
        val coords = MotionEvent.PointerCoords().apply {
            this.x = x
            this.y = y
            pressure = 1f
            size = 1f
        }
        // Anchor for the whole multi-tap run so the DOWN/UP slots below are paced
        // against one real clock (F17), preserving the gap between taps.
        val base = SystemClock.uptimeMillis()
        var dropped = false

        fun dispatch(action: Int, downTime: Long, slotMs: Long, isFinalUp: Boolean) {
            val waitMs = (base + slotMs) - SystemClock.uptimeMillis()
            if (waitMs > 0) SystemClock.sleep(waitMs)
            val eventTime = SystemClock.uptimeMillis()
            val event = MotionEvent.obtain(
                downTime,
                eventTime,
                action,
                1,
                arrayOf(props),
                arrayOf(coords),
                0,
                0,
                1f,
                1f,
                0,
                0,
                InputDevice.SOURCE_TOUCHSCREEN,
                0
            )
            val doSync = isFinalUp && finalUpSync
            try {
                if (!dispatchEvent(uiAutomation, effective.strategy, event, doSync)) dropped = true
            } finally {
                event.recycle()
            }
        }

        val period = holdMs + gapMs
        for (k in 0 until count) {
            val downSlot = k * period
            val upSlot = downSlot + holdMs
            // The DOWN's real arrival time is this tap's downTime; the UP shares it.
            val downWait = (base + downSlot) - SystemClock.uptimeMillis()
            if (downWait > 0) SystemClock.sleep(downWait)
            val tapDownTime = SystemClock.uptimeMillis()
            // DOWN is always async (ordering is preserved by the dispatcher). The UP
            // is async too by default (R1); only uia-sync makes the LAST tap's UP
            // block. Every event routes through the effective strategy's pipe.
            if (!dispatchAt(
                    uiAutomation,
                    effective.strategy,
                    props,
                    coords,
                    MotionEvent.ACTION_DOWN,
                    tapDownTime,
                    tapDownTime,
                    false
                )
            ) {
                dropped = true
            }
            dispatch(MotionEvent.ACTION_UP, tapDownTime, upSlot, isFinalUp = k == count - 1)
        }
        // Settle bookkeeping mirrors [inject]: a synchronous last UP (uia-sync)
        // drained the queue, so clear; an async last UP (default / uia-async /
        // input-manager) is recorded so the next capture drains it before reading.
        val lastUpWasSync = effective.strategy != InjectStrategy.INPUT_MANAGER && finalUpSync
        if (lastUpWasSync) {
            asyncUp.clear()
        } else {
            asyncUp.markOutstanding(x, y)
        }
        InjectStrategyCounter.record(effective.reported)
        return InjectOutcome(dropped, effective.reported, effective.fellBackTo, effective.error)
    }

    /** Whether a `tap`'s final ACTION_UP is still queued but not yet drained. */
    fun hasOutstandingAsyncUp(): Boolean = asyncUp.hasOutstanding()

    /**
     * Drain a pending async ACTION_UP from a preceding [injectTaps] (R1).
     *
     * No-op unless a tap left an async UP in flight. When one is outstanding,
     * inject a single ACTION_CANCEL SYNCHRONOUSLY: with no pointer down the
     * dispatcher drops it (zero UI effect), but injecting it in `WAIT_FOR_FINISH`
     * mode blocks until it — and therefore the async UP queued ahead of it (FIFO)
     * — has been delivered. That gives a capture a finger-up tree without any
     * `waitForIdle`. The outstanding flag is cleared only AFTER this sync inject
     * returns (see [AsyncUpTracker]).
     */
    fun drainAsyncUp(uiAutomation: UiAutomation) {
        asyncUp.drainWith { x, y -> injectCancelSync(uiAutomation, x, y, 0f, 0f) }
    }

    /**
     * Flush the input dispatcher's touch queue synchronously (phase 3f).
     *
     * Historically the (now-removed, phase 3n.2) scrcpy fast-inject backend delivered
     * tap/swipe/gesture events over a separate `app_process` (not this UiAutomation),
     * so this process's own async-UP bookkeeping did NOT see them and [drainAsyncUp]
     * would no-op. This remains generic plumbing: a following `getNestedState` on THIS
     * channel must still observe the post-UP tree, never the mid-press state. Any such
     * out-of-band event and the event below funnel through the one system InputDispatcher
     * FIFO, so injecting a single no-op MotionEvent SYNCHRONOUSLY blocks until it —
     * and therefore every touch event enqueued ahead of it — has been delivered.
     * Also clears any stale outstanding flag AFTER the inject returns (R1).
     */
    fun flushInput(uiAutomation: UiAutomation) {
        asyncUp.flushWith { injectCancelSync(uiAutomation, 0f, 0f, 0f, 0f) }
    }

    /** Inject one no-op ACTION_CANCEL synchronously (pressure/size 0 → dropped by the dispatcher). */
    private fun injectCancelSync(uiAutomation: UiAutomation, x: Float, y: Float, pressure: Float, size: Float) {
        val props = MotionEvent.PointerProperties().apply {
            id = 0
            toolType = MotionEvent.TOOL_TYPE_FINGER
        }
        val coords = MotionEvent.PointerCoords().apply {
            this.x = x
            this.y = y
            this.pressure = pressure
            this.size = size
        }
        val now = SystemClock.uptimeMillis()
        val event = MotionEvent.obtain(
            now,
            now,
            MotionEvent.ACTION_CANCEL,
            1,
            arrayOf(props),
            arrayOf(coords),
            0,
            0,
            1f,
            1f,
            0,
            0,
            InputDevice.SOURCE_TOUCHSCREEN,
            0
        )
        try {
            uiAutomation.injectInputEvent(event, true)
        } finally {
            event.recycle()
        }
    }

    /** @return `false` if the injection was rejected by the dispatcher. */
    private fun dispatchAt(
        uiAutomation: UiAutomation,
        effectiveStrategy: InjectStrategy,
        props: MotionEvent.PointerProperties,
        coords: MotionEvent.PointerCoords,
        action: Int,
        downTime: Long,
        eventTime: Long,
        sync: Boolean
    ): Boolean {
        val event = MotionEvent.obtain(
            downTime,
            eventTime,
            action,
            1,
            arrayOf(props),
            arrayOf(coords),
            0,
            0,
            1f,
            1f,
            0,
            0,
            InputDevice.SOURCE_TOUCHSCREEN,
            0
        )
        return try {
            dispatchEvent(uiAutomation, effectiveStrategy, event, sync)
        } finally {
            event.recycle()
        }
    }

    /** The strategy actually used for a gesture plus how the outcome is reported. */
    private data class Effective(
        val strategy: InjectStrategy,
        val reported: String,
        val fellBackTo: String?,
        val error: String?
    )

    /**
     * Resolve the requested strategy to the one that will run. Only
     * [InjectStrategy.INPUT_MANAGER] can change: when the hidden API is blocked it
     * degrades to [InjectStrategy.UIA_ASYNC] and the outcome reports
     * `strategy: "unavailable"` with the exception text. Every other value maps to
     * itself.
     */
    private fun resolveEffective(requested: InjectStrategy): Effective {
        if (requested == InjectStrategy.INPUT_MANAGER) {
            val availability = InputManagerInjector.probe()
            return if (availability.available) {
                Effective(InjectStrategy.INPUT_MANAGER, InjectStrategy.INPUT_MANAGER.wire, null, null)
            } else {
                Effective(
                    InjectStrategy.UIA_ASYNC,
                    InjectOutcome.UNAVAILABLE,
                    InjectStrategy.UIA_ASYNC.wire,
                    availability.error
                )
            }
        }
        return Effective(requested, requested.wire, null, null)
    }

    /**
     * Whether the FINAL ACTION_UP blocks. uia-sync always blocks; uia-async and
     * input-manager never do (async UP, drain folded into the next read); DEFAULT
     * defers to the call site ([defaultFinalUpSync] — true for swipe/gesture, false
     * for tap).
     */
    private fun finalUpSyncFor(effective: InjectStrategy, defaultFinalUpSync: Boolean): Boolean =
        when (effective) {
            InjectStrategy.UIA_SYNC -> true
            InjectStrategy.UIA_ASYNC -> false
            InjectStrategy.INPUT_MANAGER -> false
            InjectStrategy.DEFAULT -> defaultFinalUpSync
        }

    /**
     * Inject one built [MotionEvent] through the effective strategy's pipe.
     * [InjectStrategy.INPUT_MANAGER] uses the reflective ASYNC pipe (the `sync`
     * flag does not apply there); every other strategy uses
     * [UiAutomation.injectInputEvent] with the given `sync`. Returns whether the
     * dispatcher accepted the event.
     */
    private fun dispatchEvent(
        uiAutomation: UiAutomation,
        effectiveStrategy: InjectStrategy,
        event: MotionEvent,
        sync: Boolean
    ): Boolean =
        if (effectiveStrategy == InjectStrategy.INPUT_MANAGER) {
            InputManagerInjector.injectAsync(event)
        } else {
            uiAutomation.injectInputEvent(event, sync)
        }
}
