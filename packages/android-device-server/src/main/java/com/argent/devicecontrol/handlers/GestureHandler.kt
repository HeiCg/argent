package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import com.argent.devicecontrol.input.MotionInjector
import org.json.JSONObject

/**
 * Multi-pointer gesture handler: injects an arbitrary synchronized touch
 * timeline via [MotionInjector]. This is the open-server backend for the
 * host-side pinch / rotate / custom gestures, which `uiDevice.swipe()` (a
 * single-pointer straight line) cannot express.
 *
 * params:
 *   pointers: [ { id: Int, points: [ { x: Int, y: Int, tMs: Long } ] } ]
 *
 * Every pointer's `points` array must be the same length (the host tools emit
 * one frame per pointer per tick), pixels for x/y, and `tMs` the frame's offset
 * from gesture start. Returns { success: true }.
 */
class GestureHandler(private val uiAutomation: UiAutomation) {

    private companion object {
        // Resample cadence for the injected timeline (F18). The host emits ~60 fps
        // timelines, but each frame is a binder round-trip into the input pipeline
        // per pointer, so a 300 ms pinch's ~20 frames × 2 fingers spent ~50 ms just
        // injecting. Rather than dropping frames by INDEX (which warps the velocity
        // profile the OS fits near the lift), we thin by TIME: keep a frame only
        // when its `tMs` is at least this far past the last kept frame. First and
        // last frames are always kept (endpoints + total duration), and dwell
        // frames — a run of same-position keyframes, i.e. a hold — are kept intact
        // so a momentum-free hold still decelerates the velocity tracker to ~0.
        const val STEP_MS = 16L
    }

    fun execute(params: JSONObject): JSONObject {
        val pointersJson = params.optJSONArray("pointers")
            ?: throw IllegalArgumentException("Missing 'pointers' array")
        val n = pointersJson.length()
        if (n < 1) throw IllegalArgumentException("'pointers' must contain at least one pointer")

        val ids = IntArray(n)
        val paths = ArrayList<List<MotionInjector.Point>>(n)
        for (i in 0 until n) {
            val pointer = pointersJson.getJSONObject(i)
            ids[i] = pointer.optInt("id", i)
            val pts = pointer.optJSONArray("points")
                ?: throw IllegalArgumentException("pointer $i is missing its 'points' array")
            val full = ArrayList<MotionInjector.Point>(pts.length())
            for (j in 0 until pts.length()) {
                val pt = pts.getJSONObject(j)
                full.add(
                    MotionInjector.Point(
                        pt.getDouble("x").toFloat(),
                        pt.getDouble("y").toFloat(),
                        pt.optLong("tMs", 0)
                    )
                )
            }
            paths.add(resample(full))
        }

        MotionInjector.inject(uiAutomation, ids, paths)
        return JSONObject().apply { put("success", true) }
    }

    /**
     * Thin a pointer path to a time-uniform subset (F18): keep the first and last
     * frame (endpoints + total duration), keep any dwell frame (same position as
     * the previous frame — part of a hold), and otherwise keep a frame only once
     * at least [STEP_MS] has elapsed since the last kept frame's `tMs`. Original
     * keyframe timestamps are preserved; nothing is resynthesized.
     */
    private fun resample(path: List<MotionInjector.Point>): List<MotionInjector.Point> {
        val size = path.size
        if (size <= 2) return path
        val out = ArrayList<MotionInjector.Point>(size)
        out.add(path[0])
        var lastKeptT = path[0].tMs
        for (i in 1 until size - 1) {
            val p = path[i]
            val prev = path[i - 1]
            val isDwell = p.x == prev.x && p.y == prev.y
            if (isDwell || p.tMs - lastKeptT >= STEP_MS) {
                out.add(p)
                lastKeptT = p.tMs
            }
        }
        out.add(path[size - 1])
        return out
    }
}
