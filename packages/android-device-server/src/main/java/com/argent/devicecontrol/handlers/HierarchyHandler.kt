package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.accessibility.NestedWindowSerializer
import com.argent.devicecontrol.accessibility.NodeSerializer
import org.json.JSONArray
import org.json.JSONObject

class HierarchyHandler(
    private val uiDevice: UiDevice,
    private val uiAutomation: UiAutomation
) {

    fun execute(params: JSONObject): JSONObject {
        val maxElements = params.optInt("maxElements", 50)
        val waitTimeoutMs = params.optLong("waitTimeoutMs", 2000)
        // `nested`: return the full, un-pruned subtree as one nested node (with
        // raw class names and package-qualified ids) so the host can run the same
        // interactables-only trim the proprietary android-devtools path runs and
        // match its token count. The default (flat, compressed list) is unchanged
        // for the flow / await consumers.
        val nested = params.optBoolean("nested", false)

        // Settle before serializing so describe isn't racing an in-flight
        // layout pass — mirrors StateHandler's waitForIdle.
        uiDevice.waitForIdle(waitTimeoutMs)

        val rootNode = uiAutomation.rootInActiveWindow
            ?: throw RuntimeException("No active window")

        try {
            val tree = if (nested) {
                buildNestedWindows(maxOf(maxElements, 3000), rootNode)
            } else {
                NodeSerializer.serialize(rootNode, maxElements)
            }
            return JSONObject().apply { put("tree", tree) }
        } finally {
            rootNode.recycle()
        }
    }

    /**
     * Nested roots for EVERY window (active-first, then by layer — see
     * [NestedWindowSerializer]), shared with the `getState` nested path so the
     * describe and await-* tools trim identical input (F12).
     */
    private fun buildNestedWindows(cap: Int, activeRoot: android.view.accessibility.AccessibilityNodeInfo): JSONArray {
        return NestedWindowSerializer.serialize(uiAutomation, activeRoot, cap)
    }
}
