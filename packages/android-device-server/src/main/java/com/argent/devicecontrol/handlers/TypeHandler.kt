package com.argent.devicecontrol.handlers

import android.app.Instrumentation
import androidx.test.uiautomator.UiDevice
import org.json.JSONObject

class TypeHandler(
    private val instrumentation: Instrumentation,
    private val uiDevice: UiDevice
) {

    fun execute(params: JSONObject): JSONObject {
        val text = params.getString("text")
        var charsTyped = 0

        try {
            instrumentation.sendStringSync(text)
            charsTyped = text.length
        } catch (e: Exception) {
            for (char in text) {
                try {
                    uiDevice.executeShellCommand("input text '${escapeShell(char.toString())}'")
                    charsTyped++
                } catch (_: Exception) {
                    break
                }
            }
        }

        return JSONObject().apply {
            put("success", charsTyped > 0)
            put("charsTyped", charsTyped)
        }
    }

    private fun escapeShell(s: String): String = s.replace("'", "'\\''")
}
