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
 */
object MotionInjector {

    /** One sampled point on a pointer's path. `tMs` is relative to gesture start. */
    data class Point(val x: Float, val y: Float, val tMs: Long)

    // R1 (phase 3e). A `tap`'s final ACTION_UP is injected asynchronously so the
    // RPC returns as soon as the UP is queued — not after the input dispatcher has
    // finished delivering it — which is what shaved the tap's sync round-trip. That
    // leaves a window where a follow-up describe could read the tree before the UP
    // lands (the mid-press, finger-down state). `asyncUpOutstanding` tracks exactly
    // that: [StateHandler] calls [drainAsyncUp] before every capture and, only when
    // an async UP is still in flight, injects ONE synchronous no-op to flush the
    // dispatcher's FIFO queue (guaranteeing the UP was delivered) without a
    // `waitForIdle`. Any synchronous injection here (a gesture's final UP, or the
    // drain itself) already flushes the queue, so it clears the flag.
    @Volatile private var asyncUpOutstanding = false
    @Volatile private var lastAsyncUpX = 0f
    @Volatile private var lastAsyncUpY = 0f

    /**
     * Inject a synchronized multi-pointer gesture. `paths` is one entry per
     * pointer; `ids[i]` is pointer i's stable id. Every path must be the same
     * length (>= 2: a down frame and an up frame). Coordinates are device pixels.
     * The final ACTION_UP is dispatched synchronously (F3).
     */
    fun inject(
        uiAutomation: UiAutomation,
        ids: IntArray,
        paths: List<List<Point>>
    ) {
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

        fun send(action: Int, count: Int, slotMs: Long, sync: Boolean = false) {
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
            try {
                uiAutomation.injectInputEvent(event, sync)
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
        send(MotionEvent.ACTION_UP, 1, upSlot, sync = true)
        // The final UP above was synchronous, so the dispatcher queue is drained;
        // any tap's async UP that was still in flight is now delivered too.
        asyncUpOutstanding = false
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
     * delivery, and [StateHandler] flushes the pending UP via [drainAsyncUp] before
     * it reads the tree (see [asyncUpOutstanding]).
     */
    fun injectTaps(
        uiAutomation: UiAutomation,
        x: Float,
        y: Float,
        count: Int,
        holdMs: Long,
        gapMs: Long
    ) {
        require(count >= 1) { "tap needs count >= 1" }
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

        fun dispatch(action: Int, downTime: Long, slotMs: Long, sync: Boolean) {
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
            try {
                uiAutomation.injectInputEvent(event, sync)
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
            // DOWN has always been async (ordering is preserved by the dispatcher);
            // the final UP is now async too (R1) so the whole tap returns without a
            // sync round-trip.
            dispatchAt(uiAutomation, props, coords, MotionEvent.ACTION_DOWN, tapDownTime, tapDownTime, false)
            dispatch(MotionEvent.ACTION_UP, tapDownTime, upSlot, sync = false)
        }
        // The final UP was queued asynchronously; record it so a following capture
        // drains it before reading the tree.
        asyncUpOutstanding = true
        lastAsyncUpX = x
        lastAsyncUpY = y
    }

    /** Whether a `tap`'s final ACTION_UP is still queued but not yet drained. */
    fun hasOutstandingAsyncUp(): Boolean = asyncUpOutstanding

    /**
     * Drain a pending async ACTION_UP from a preceding [injectTaps] (R1, phase 3e).
     *
     * No-op unless a tap left an async UP in flight. When one is outstanding, inject
     * a single ACTION_CANCEL SYNCHRONOUSLY: with no pointer down the dispatcher
     * drops it (zero UI effect), but injecting it in `WAIT_FOR_FINISH` mode blocks
     * until it — and therefore the async UP queued ahead of it (FIFO) — has been
     * delivered. That gives a capture a finger-up tree without any `waitForIdle`.
     */
    fun drainAsyncUp(uiAutomation: UiAutomation) {
        if (!asyncUpOutstanding) return
        asyncUpOutstanding = false
        val props = MotionEvent.PointerProperties().apply {
            id = 0
            toolType = MotionEvent.TOOL_TYPE_FINGER
        }
        val coords = MotionEvent.PointerCoords().apply {
            x = lastAsyncUpX
            y = lastAsyncUpY
            pressure = 0f
            size = 0f
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

    private fun dispatchAt(
        uiAutomation: UiAutomation,
        props: MotionEvent.PointerProperties,
        coords: MotionEvent.PointerCoords,
        action: Int,
        downTime: Long,
        eventTime: Long,
        sync: Boolean
    ) {
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
        try {
            uiAutomation.injectInputEvent(event, sync)
        } finally {
            event.recycle()
        }
    }
}
