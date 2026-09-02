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
    }

    fun execute(params: JSONObject): JSONObject {
        val startX = params.getInt("startX")
        val startY = params.getInt("startY")
        val endX = params.getInt("endX")
        val endY = params.getInt("endY")
        val steps = params.optInt("steps", 10)
        // Hold the last pointer position this long before ACTION_UP. A
        // momentum-free swipe passes holdEndMs > 0 so the release velocity decays
        // to ~0 and the OS applies little to no fling; 0 (the default) keeps the
        // fast `uiDevice.swipe()` path whose lift still carries velocity.
        val holdEndMs = params.optLong("holdEndMs", 0)

        val success = if (holdEndMs > 0) {
            injectHeldSwipe(startX, startY, endX, endY, steps, holdEndMs)
            true
        } else {
            uiDevice.swipe(startX, startY, endX, endY, steps)
        }
        return JSONObject().apply { put("success", success) }
    }

    private fun injectHeldSwipe(
        startX: Int,
        startY: Int,
        endX: Int,
        endY: Int,
        steps: Int,
        holdEndMs: Long
    ) {
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

        MotionInjector.inject(uiAutomation, intArrayOf(0), listOf(path))
    }
}
