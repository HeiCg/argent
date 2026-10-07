package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import android.util.Log
import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.input.InjectOutcome
import com.argent.devicecontrol.input.InjectStrategy
import com.argent.devicecontrol.input.MotionInjector
import java.util.Locale
import org.json.JSONObject

class SwipeHandler(
    private val uiDevice: UiDevice,
    private val uiAutomation: UiAutomation
) {

    private companion object {
        const val TAG = "SwipeHandler"
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
        // Phase 3n: per-RPC injection strategy (absent → DEFAULT = today's blocking
        // final UP). Shared by both the momentum and held paths.
        val strategy = InjectStrategy.fromWire(params.optString("inject", ""))

        val (outcome, path) = if (holdEndMs > 0) {
            injectHeldSwipe(startX, startY, endX, endY, steps, holdEndMs, strategy)
        } else {
            injectMomentumSwipe(startX, startY, endX, endY, steps, strategy)
        }
        // Review E-1 2026-10-07 finding 4: the delivered DOWN-to-UP span (and, for a
        // held swipe, the delivered hold) on the device clock, logged per swipe and
        // returned so the host can record what the OS actually received. `injectMs`
        // is the DOWN-to-UP span under the name the host reads (0.1.25).
        // `releaseVelocityLsqPxPerS` is the least-squares speed along the swipe over
        // the MOVE samples of the last 100 ms before the UP, hold frames included:
        // the window the OS VelocityTracker fits. Computed on the SCHEDULED
        // timeline, so it says what the gesture asks for, not what was delivered.
        val releaseLsq = ReleaseVelocity.lsqPxPerS(path, startX, startY, endX, endY)
        Log.i(
            TAG,
            "swipe steps=$steps holdEndMs=$holdEndMs deliveredMs=${outcome.deliveredMs} " +
                "heldMs=${outcome.heldMs} releaseVelocityLsqPxPerS=${String.format(Locale.US, "%.1f", releaseLsq)}"
        )
        return JSONObject().apply {
            put("success", !outcome.dropped)
            if (outcome.dropped) put("dropped", true)
            if (outcome.deliveredMs >= 0) {
                put("deliveredMs", outcome.deliveredMs)
                put("injectMs", outcome.deliveredMs)
            }
            if (outcome.heldMs >= 0) put("heldMs", outcome.heldMs)
            put("releaseVelocityLsqPxPerS", Math.round(releaseLsq * 10) / 10.0)
            put("strategy", outcome.strategy)
            outcome.fellBackTo?.let { put("fellBackTo", it) }
            outcome.error?.let { put("injectError", it) }
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
        steps: Int,
        strategy: InjectStrategy
    ): Pair<InjectOutcome, List<MotionInjector.Point>> {
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
        // Under DEFAULT the final ACTION_UP is dispatched synchronously (F3): the RPC
        // returns only once the finger is actually up, matching the proprietary
        // path's blocking Up. Intermediate frames stay async, paced by the injector's
        // wall clock. The explicit strategies override the final-UP mode.
        return MotionInjector.inject(uiAutomation, intArrayOf(0), listOf(path), strategy) to path
    }

    private fun injectHeldSwipe(
        startX: Int,
        startY: Int,
        endX: Int,
        endY: Int,
        steps: Int,
        holdEndMs: Long,
        strategy: InjectStrategy
    ): Pair<InjectOutcome, List<MotionInjector.Point>> {
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

        // Anchor the hold on the last travel frame (index travelSteps) so a late
        // travel cannot collapse the hold before the lift (HoldAnchor).
        return MotionInjector.inject(
            uiAutomation,
            intArrayOf(0),
            listOf(path),
            strategy,
            holdAnchorFrame = travelSteps
        ) to path
    }
}

/**
 * Release velocity as the OS reads it, for telemetry (review round 2): a
 * least-squares line (degree 1) through the MOVE samples of the last
 * [HORIZON_MS] before the UP, stationary hold frames included, in px/s along the
 * swipe direction (negative = backward). Android's VelocityTracker fits the same
 * horizon (degree 2 by default; degree 1 is enough to tell "at rest" from "still
 * travelling"). Pure, so it is unit-tested on the JVM.
 */
object ReleaseVelocity {

    /** The VelocityTracker's fit horizon. */
    const val HORIZON_MS = 100L

    /**
     * [path] is the injected timeline: frame 0 the DOWN, the last frame the UP,
     * everything between a MOVE. Returns 0 with fewer than two MOVEs in the
     * horizon, or for a zero-length swipe.
     */
    fun lsqPxPerS(
        path: List<MotionInjector.Point>,
        startX: Int,
        startY: Int,
        endX: Int,
        endY: Int
    ): Double {
        if (path.size < 3) return 0.0
        val dx = (endX - startX).toDouble()
        val dy = (endY - startY).toDouble()
        val len = Math.hypot(dx, dy)
        if (len == 0.0) return 0.0
        val ux = dx / len
        val uy = dy / len
        val upT = path.last().tMs
        val ts = ArrayList<Double>()
        val ss = ArrayList<Double>()
        for (i in 1 until path.size - 1) {
            val p = path[i]
            if (upT - p.tMs > HORIZON_MS) continue
            ts.add(p.tMs / 1000.0)
            ss.add((p.x - startX) * ux + (p.y - startY) * uy)
        }
        val n = ts.size
        if (n < 2) return 0.0
        val mt = ts.average()
        val ms = ss.average()
        var num = 0.0
        var den = 0.0
        for (k in 0 until n) {
            num += (ts[k] - mt) * (ss[k] - ms)
            den += (ts[k] - mt) * (ts[k] - mt)
        }
        return if (den == 0.0) 0.0 else num / den
    }
}
