package com.argent.devicecontrol.handlers

import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.util.DisplayReader
import com.argent.devicecontrol.util.NormalizedCoords
import org.json.JSONObject

/** Long press at pixel `x/y`, or (versionCode 31) normalized `nx/ny` converted here. */
class LongPressHandler(
    private val uiDevice: UiDevice,
    private val displayGeometry: () -> DisplayReader.Geometry
) {

    fun execute(params: JSONObject): JSONObject {
        val (x, y) = NormalizedCoords.pointParam(params, "x", "y", "nx", "ny", displayGeometry)
        val durationMs = params.optInt("durationMs", 1000)
        // swipe with same start/end + steps simulates long press (each step ~5ms)
        val steps = durationMs / 5
        val success = uiDevice.swipe(x, y, x, y, steps)
        return JSONObject().apply { put("success", success) }
    }
}
