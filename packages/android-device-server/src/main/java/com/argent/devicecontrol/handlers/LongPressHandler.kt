package com.argent.devicecontrol.handlers

import androidx.test.uiautomator.UiDevice
import org.json.JSONObject

class LongPressHandler(private val uiDevice: UiDevice) {

    fun execute(params: JSONObject): JSONObject {
        val x = params.getInt("x")
        val y = params.getInt("y")
        val durationMs = params.optInt("durationMs", 1000)
        // swipe with same start/end + steps simulates long press (each step ~5ms)
        val steps = durationMs / 5
        val success = uiDevice.swipe(x, y, x, y, steps)
        return JSONObject().apply { put("success", success) }
    }
}
