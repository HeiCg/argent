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
        // Cap on injected frames per pointer. The host emits ~60 fps timelines
        // (a 300 ms pinch is ~20 frames), but each frame is a binder round-trip
        // into the input pipeline per pointer, so 20 frames × 2 fingers spent
        // ~50 ms just injecting. Downsampling to this many evenly-spaced frames —
        // first and last always kept, so the gesture's endpoints and its total
        // duration (the last frame's tMs, which the injector paces to) are
        // preserved — keeps the motion faithful (a pinch still zooms, a rotate
        // still turns) while cutting the per-event cost.
        const val MAX_FRAMES = 8
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
            paths.add(downsample(full))
        }

        // Async final Up: the events are queued to the dispatcher in order and a
        // following gesture's Down queues strictly after this Up, so there's no
        // need to block the RPC on the Up's full dispatch (20–40 ms mid-animation).
        MotionInjector.inject(uiAutomation, ids, paths, syncFinal = false)
        return JSONObject().apply { put("success", true) }
    }

    /**
     * Downsample a pointer path to at most [MAX_FRAMES] evenly-spaced frames,
     * always keeping the first and last (so endpoints and total duration hold).
     */
    private fun downsample(path: List<MotionInjector.Point>): List<MotionInjector.Point> {
        val size = path.size
        if (size <= MAX_FRAMES) return path
        val out = ArrayList<MotionInjector.Point>(MAX_FRAMES)
        val last = size - 1
        for (k in 0 until MAX_FRAMES) {
            val idx = Math.round(k.toDouble() * last / (MAX_FRAMES - 1)).toInt()
            out.add(path[idx])
        }
        return out
    }
}
