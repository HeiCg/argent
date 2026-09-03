package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.input.MotionInjector
import org.json.JSONObject

class SwipeHandler(
    private val uiDevice: UiDevice,
    private val uiAutomation: UiAutomation
) {

    private companion object {
        // Wall-clock spacing between injected samples for a held swipe. Small and
        // constant so the OS velocity tracker reads a clean deceleration curve.
        const val STEP_MS = 8L
        // Cadence for a plain (momentum) swipe. 16 ms/frame mirrors the
        // proprietary simulator-server path (which sleeps 16 ms between host-side
        // Move frames), so the lift velocity — and therefore the fling distance —
        // matches for the same start/end and step count.
        const val MOMENTUM_STEP_MS = 16L
        // A fling's distance is set by the release velocity, which the OS
        // VelocityTracker fits over roughly the last 100 ms before the lift. So
        // the samples that matter are the ones NEAR the lift: this many trailing
        // frames at the proprietary path's 16 ms cadence reproduce its velocity
        // (and thus its fling distance). Earlier travel only needs enough frames
        // to look like motion, not a jump.
        const val TAIL_SAMPLES = 5
        // Coarse frames spread across the run-up before the dense tail. Two is
        // enough for the finger to be visibly travelling; keeping the count low
        // matters because every injected event is an ~4–6 ms IPC into the input
        // pipeline and the finger-down duration (the sleeps) is fixed by the
        // requested duration regardless of how many frames fill it.
        const val HEAD_SAMPLES = 2
    }

    fun execute(params: JSONObject): JSONObject {
        val startX = params.getInt("startX")
        val startY = params.getInt("startY")
        val endX = params.getInt("endX")
        val endY = params.getInt("endY")
        val steps = params.optInt("steps", 10)
        // Hold the last pointer position this long before ACTION_UP. A
        // momentum-free swipe passes holdEndMs > 0 so the release velocity decays
        // to ~0 and the OS applies little to no fling; 0 (the default) is a plain
        // flinging swipe that lifts with the last segment's velocity.
        val holdEndMs = params.optLong("holdEndMs", 0)

        val dropped = if (holdEndMs > 0) {
            injectHeldSwipe(startX, startY, endX, endY, steps, holdEndMs)
        } else {
            injectMomentumSwipe(startX, startY, endX, endY, steps)
        }
        return JSONObject().apply {
            put("success", !dropped)
            if (dropped) put("dropped", true)
        }
    }

    /**
     * Plain flinging swipe injected through [MotionInjector] instead of
     * `uiDevice.swipe()`. UiAutomator's swipe injects every frame synchronously
     * (blocking the RPC thread on each event's full dispatch), which stacked
     * ~15–30 ms per frame and made a 16-step swipe cost ~600 ms. MotionInjector
     * paces frames by wall clock and only blocks on the final ACTION_UP, so the
     * gesture costs ~its own duration. Frames are spaced [MOMENTUM_STEP_MS] apart
     * with no trailing hold, so the finger lifts carrying the last segment's
     * velocity and the OS applies its normal fling.
     */
    private fun injectMomentumSwipe(
        startX: Int,
        startY: Int,
        endX: Int,
        endY: Int,
        steps: Int
    ): Boolean {
        val requested = maxOf(1, steps)
        // Total wall-clock the finger stays down = the requested duration (matches
        // the proprietary path, so the fling reads the same release velocity).
        val durationMs = (requested * MOMENTUM_STEP_MS).toDouble()
        // Wall-clock offsets (ms from Down) of the frames to inject: a Down at 0,
        // a few coarse run-up frames, then a dense tail at 16 ms cadence so the OS
        // velocity fit over the last ~100 ms sees the same motion the proprietary
        // 16 ms-per-frame path produces. Fewer total frames than one-per-16ms, so
        // fewer input-injection IPCs, but the same lift velocity.
        val tailMs = minOf(durationMs, TAIL_SAMPLES * MOMENTUM_STEP_MS.toDouble())
        val headEnd = durationMs - tailMs
        val offsets = sortedSetOf(0L, durationMs.toLong())
        for (h in 1..HEAD_SAMPLES) offsets.add((headEnd * h / (HEAD_SAMPLES + 1)).toLong())
        var t = durationMs
        while (t > headEnd) { offsets.add(t.toLong()); t -= MOMENTUM_STEP_MS }
        val path = ArrayList<MotionInjector.Point>(offsets.size)
        for (ms in offsets) {
            val f = if (durationMs > 0) ms / durationMs else 1.0
            path.add(
                MotionInjector.Point(
                    (startX + (endX - startX) * f).toFloat(),
                    (startY + (endY - startY) * f).toFloat(),
                    ms
                )
            )
        }
        // Final ACTION_UP is dispatched synchronously (F3): the RPC returns only
        // once the finger is actually up, matching the proprietary path's blocking
        // Up. Intermediate frames stay async, paced by the injector's wall clock.
        return MotionInjector.inject(uiAutomation, intArrayOf(0), listOf(path))
    }

    private fun injectHeldSwipe(
        startX: Int,
        startY: Int,
        endX: Int,
        endY: Int,
        steps: Int,
        holdEndMs: Long
    ): Boolean {
        val travelSteps = maxOf(1, steps)
        val path = ArrayList<MotionInjector.Point>(travelSteps + 3)

        // Travel frames: start -> end, one Down frame plus `travelSteps` Moves.
        for (i in 0..travelSteps) {
            val t = i.toFloat() / travelSteps
            val x = startX + (endX - startX) * t
            val y = startY + (endY - startY) * t
            path.add(MotionInjector.Point(x, y, i * STEP_MS))
        }

        // Hold frames at the end point so the velocity tracker reads ~0 at lift.
        // At least two, so the final Move + the Up both sit on the end point.
        val holdFrames = maxOf(2, ((holdEndMs + STEP_MS - 1) / STEP_MS).toInt())
        val baseT = travelSteps * STEP_MS
        for (h in 1..holdFrames) {
            path.add(MotionInjector.Point(endX.toFloat(), endY.toFloat(), baseT + h * STEP_MS))
        }

        return MotionInjector.inject(uiAutomation, intArrayOf(0), listOf(path))
    }
}
