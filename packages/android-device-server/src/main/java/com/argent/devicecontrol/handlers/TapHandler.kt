package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import com.argent.devicecontrol.input.MotionInjector
import org.json.JSONObject

/**
 * Single tap: raw ACTION_DOWN + ACTION_UP injected through [MotionInjector].
 *
 * The previous `uiDevice.click(x, y)` implicitly waited for the UI to go idle
 * after the tap (UiAutomator's built-in sync), which added ~80–100 ms of dead
 * time to every tap even though settling is the caller's job (the `await-*`
 * tools). Injecting the two events directly — the down async, the up
 * synchronous — returns as soon as the tap has been delivered, with no idle
 * wait. `injectInputEvent` runs against the real input pipeline, so the tap is a
 * genuine touch, same as `click` produced.
 */
class TapHandler(private val uiAutomation: UiAutomation) {

    fun execute(params: JSONObject): JSONObject {
        val x = params.getInt("x").toFloat()
        val y = params.getInt("y").toFloat()
        // Two frames at the same point: a down frame (tMs 0) and an up frame
        // (tMs 0). MotionInjector emits ACTION_DOWN then ACTION_UP, mirroring
        // UiAutomator's own `clickNoSync` (no hold), but without the idle wait.
        val path = listOf(
            MotionInjector.Point(x, y, 0),
            MotionInjector.Point(x, y, 0)
        )
        MotionInjector.inject(uiAutomation, intArrayOf(0), listOf(path))
        return JSONObject().apply { put("success", true) }
    }
}
