package com.argent.devicecontrol.handlers

import androidx.test.uiautomator.UiDevice
import org.json.JSONObject

class TapHandler(private val uiDevice: UiDevice) {

    fun execute(params: JSONObject): JSONObject {
        val x = params.getInt("x")
        val y = params.getInt("y")
        val success = uiDevice.click(x, y)
        return JSONObject().apply { put("success", success) }
    }
}
