package com.argent.devicecontrol.handlers

import androidx.test.uiautomator.UiDevice
import org.json.JSONObject

class WaitHandler(private val uiDevice: UiDevice) {

    fun execute(params: JSONObject): JSONObject {
        val timeoutMs = params.optLong("timeoutMs", 2000)
        val start = System.currentTimeMillis()
        uiDevice.waitForIdle(timeoutMs)
        val waitedMs = System.currentTimeMillis() - start
        return JSONObject().apply {
            put("idle", true)
            put("waitedMs", waitedMs)
        }
    }
}
