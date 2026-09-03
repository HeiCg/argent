package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.TreeStore
import com.argent.devicecontrol.accessibility.NestedWindowSerializer
import com.argent.devicecontrol.accessibility.NodeSerializer
import com.argent.devicecontrol.accessibility.ScreenTree
import org.json.JSONArray
import org.json.JSONObject

class HierarchyHandler(
    private val uiDevice: UiDevice,
    @Suppress("unused") private val uiAutomation: UiAutomation
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

        // `nested` keeps the phase-3 token-parity path: walk every window's raw
        // subtree so the host can run its own interactables-only trim. This path
        // bypasses the version cache because it needs raw class names / ids.
        if (nested) {
            val rootNode = uiAutomation.rootInActiveWindow
                ?: throw RuntimeException("No active window")
            try {
                val tree = buildNestedWindows(maxOf(maxElements, 3000), rootNode)
                return JSONObject().apply { put("tree", tree) }
            } finally {
                rootNode.recycle()
            }
        }

        // Screen-graph Phase A: serve the default flat list from the version
        // cache. When the tree is unchanged since the last build
        // (lastBuiltAtVersion == version) this is a cache hit with no
        // UiAutomation traversal; the flat list is lowered from the cached node
        // forest in the same shape NodeSerializer emitted.
        val snap = TreeStore.ensure()
        val serialized = ScreenTree.serializeFlat(snap.roots, maxElements)
        return JSONObject().apply {
            put("tree", serialized.tree)
            put("truncated", serialized.truncated)
            put("hash", snap.hash)
            put("stateHash", snap.stateHash)
            put("idHash", snap.idHash)
            put("version", snap.version)
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
