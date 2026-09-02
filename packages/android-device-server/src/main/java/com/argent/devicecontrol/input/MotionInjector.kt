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
 * pointer happens at the same `eventTime`. That is exactly what the host-side
 * gesture tools (swipe, pinch, rotate, custom) already generate — one Move per
 * frame across all fingers — so requiring equal-length paths keeps the wire
 * shape simple without losing any gesture the proprietary path could send.
 *
 * `uiDevice.swipe()` cannot express a hold before the lift, which is what a
 * momentum-free swipe needs to kill fling: repeating the end point across
 * several trailing frames drives the OS velocity tracker to ~0 before ACTION_UP.
 * Injecting the timeline by hand is the only way to get that, so both the
 * multi-pointer `gesture` RPC and the single-pointer momentum-free swipe route
 * through here.
 */
object MotionInjector {

    /** One sampled point on a pointer's path. `tMs` is relative to gesture start. */
    data class Point(val x: Float, val y: Float, val tMs: Long)

    /**
     * Inject a synchronized multi-pointer gesture. `paths` is one entry per
     * pointer; `ids[i]` is pointer i's stable id. Every path must be the same
     * length (>= 2: a down frame and an up frame). Coordinates are device pixels.
     */
    fun inject(
        uiAutomation: UiAutomation,
        ids: IntArray,
        paths: List<List<Point>>,
        // Whether the final ACTION_UP is injected synchronously. A tap keeps it
        // true so the click is confirmed delivered before the RPC returns. A
        // swipe/pinch passes false: its events are already queued to the input
        // dispatcher in order (a following gesture's DOWN queues strictly after
        // this UP), and blocking on the UP's full dispatch — 20–40 ms while the
        // list is flinging or the page zooming — bought nothing but latency. The
        // proprietary path's Up command likewise returns on ACK, not on dispatch.
        syncFinal: Boolean = true
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

        val downTime = SystemClock.uptimeMillis()
        // Real wall-clock time the last event was dispatched at, so successive
        // frames are spaced by their `tMs` delta. The framework's long-press timer
        // and velocity tracker key off arrival time, not just the event's
        // timestamp, so a held frame must actually take that long to arrive.
        var lastEventTime = downTime

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

        fun send(action: Int, count: Int, eventTime: Long, sync: Boolean = false) {
            // Hold until this event's wall-clock slot before dispatching, so a
            // trailing run of same-position frames really costs its duration
            // (long-press recognition, fling deceleration).
            val waitMs = eventTime - lastEventTime
            if (waitMs > 0) SystemClock.sleep(waitMs)
            lastEventTime = eventTime
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
                // Intermediate DOWN/MOVE/POINTER_UP events are dispatched async
                // (sync=false): the wall-clock `SystemClock.sleep` above already
                // paces arrival, so blocking the RPC thread on each event's full
                // dispatch (sync=true) only stacked ~15–30 ms of idle wait per
                // frame — the dominant cost of swipe/pinch. Only the final
                // ACTION_UP is injected synchronously, so the RPC returns just
                // after the whole gesture has actually been delivered in order.
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
            send(action, k + 1, downTime + paths[0][0].tMs)
        }

        // Moves: every intermediate frame with all pointers at that frame.
        for (f in 1 until frames - 1) {
            setCoords(f, n)
            send(MotionEvent.ACTION_MOVE, n, downTime + paths[0][f].tMs)
        }

        // Ups: lift the highest-indexed pointer first (ACTION_POINTER_UP), then
        // the primary pointer with ACTION_UP.
        val last = frames - 1
        val upTime = downTime + paths[0][last].tMs
        for (k in n - 1 downTo 1) {
            setCoords(last, k + 1)
            send(
                MotionEvent.ACTION_POINTER_UP or (k shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),
                k + 1,
                upTime
            )
        }
        setCoords(last, 1)
        send(MotionEvent.ACTION_UP, 1, upTime, sync = syncFinal)
    }
}
