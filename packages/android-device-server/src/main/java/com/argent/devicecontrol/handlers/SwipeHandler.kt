package com.argent.devicecontrol.handlers

import androidx.test.uiautomator.UiDevice
import org.json.JSONObject

class SwipeHandler(private val uiDevice: UiDevice) {

    fun execute(params: JSONObject): JSONObject {
        val startX = params.getInt("startX")
        val startY = params.getInt("startY")
        val endX = params.getInt("endX")
        val endY = params.getInt("endY")
        val steps = params.optInt("steps", 10)
        val success = uiDevice.swipe(startX, startY, endX, endY, steps)
        return JSONObject().apply { put("success", success) }
    }
}
