package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.accessibility.NodeSerializer
import org.json.JSONObject

class HierarchyHandler(
    private val uiDevice: UiDevice,
    private val uiAutomation: UiAutomation
) {

    fun execute(params: JSONObject): JSONObject {
        val maxElements = params.optInt("maxElements", 50)
        val waitTimeoutMs = params.optLong("waitTimeoutMs", 2000)

        // Settle before serializing so describe isn't racing an in-flight
        // layout pass — mirrors StateHandler's waitForIdle.
        uiDevice.waitForIdle(waitTimeoutMs)

        val rootNode = uiAutomation.rootInActiveWindow
            ?: throw RuntimeException("No active window")

        try {
            val elements = NodeSerializer.serialize(rootNode, maxElements)
            return JSONObject().apply { put("tree", elements) }
        } finally {
            rootNode.recycle()
        }
    }
}
