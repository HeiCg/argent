package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import androidx.test.uiautomator.UiDevice
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
     * Nested roots for EVERY window (in layer order), not just the active one, so
     * the host sees what `uiautomator dump` sees — including the on-screen IME
     * keyboard, which lives in its own window that `rootInActiveWindow` omits. The
     * host-side v2 trim drops system chrome (status/nav bar) exactly as the dump
     * path does, so the compacted result still matches. Falls back to the active
     * window's root if the window list is empty.
     */
    private fun buildNestedWindows(cap: Int, activeRoot: android.view.accessibility.AccessibilityNodeInfo): JSONArray {
        val out = JSONArray()
        val windows = try {
            uiAutomation.windows.sortedBy { it.layer }
        } catch (_: Exception) {
            emptyList()
        }
        for (w in windows) {
            val root = try { w.root } catch (_: Exception) { null } ?: continue
            try {
                out.put(NodeSerializer.serializeNested(root, cap))
            } finally {
                root.recycle()
            }
        }
        if (out.length() == 0) out.put(NodeSerializer.serializeNested(activeRoot, cap))
        return out
    }
}
