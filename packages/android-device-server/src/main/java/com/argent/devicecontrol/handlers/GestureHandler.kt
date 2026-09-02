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
            val path = ArrayList<MotionInjector.Point>(pts.length())
            for (j in 0 until pts.length()) {
                val pt = pts.getJSONObject(j)
                path.add(
                    MotionInjector.Point(
                        pt.getDouble("x").toFloat(),
                        pt.getDouble("y").toFloat(),
                        pt.optLong("tMs", 0)
                    )
                )
            }
            paths.add(path)
        }

        MotionInjector.inject(uiAutomation, ids, paths)
        return JSONObject().apply { put("success", true) }
    }
}
