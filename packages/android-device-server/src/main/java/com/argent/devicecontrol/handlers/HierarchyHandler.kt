package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.accessibility.NestedWindowSerializer
import com.argent.devicecontrol.accessibility.NodeSerializer
import com.argent.devicecontrol.accessibility.WindowTimings
import com.argent.devicecontrol.input.MotionInjector
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
        // `flush` (phase 3f): a preceding scrcpy fast-inject touch came from another
        // process this UiAutomation cannot see, so `drainAsyncUp` would no-op.
        val flush = params.optBoolean("flush", false)

        // 0. Order any preceding touch's UP ahead of this capture (R1). getAccessibility-
        //    Tree can be called directly after a tap (not only via getState), so it
        //    must drain too, using the SAME shared helper StateHandler uses, or it
        //    would serialize the mid-press (finger-down) state. Fast-inject path
        //    (flush=true) drains the whole input queue synchronously; the default path
        //    drains only this server's own async ACTION_UP. Both are idle-wait-free and
        //    no-op when nothing is outstanding.
        if (flush) {
            MotionInjector.flushInput(uiAutomation)
        } else {
            MotionInjector.drainAsyncUp(uiAutomation)
        }

        // Settle before serializing so describe isn't racing an in-flight
        // layout pass — mirrors StateHandler's waitForIdle.
        val idleStart = System.currentTimeMillis()
        uiDevice.waitForIdle(waitTimeoutMs)
        val idleMs = System.currentTimeMillis() - idleStart

        val windowTimings = WindowTimings()
        // Read the active window's root from the interactive-windows snapshot rather
        // than `rootInActiveWindow`, which blocks ~170-210 ms mid-transition (phase
        // 3g bench). `rootSource` records which path served it.
        val rootStart = System.currentTimeMillis()
        val resolved = NestedWindowSerializer.activeRoot(uiAutomation)
        val rootNode = resolved.root
            ?: throw RuntimeException("No active window")
        val rootMs = System.currentTimeMillis() - rootStart

        try {
            var serializeMsFlat = 0L
            val tree = if (nested) {
                buildNestedWindows(maxOf(maxElements, 3000), rootNode, windowTimings)
            } else {
                val t0 = System.currentTimeMillis()
                val flat = NodeSerializer.serialize(rootNode, maxElements)
                serializeMsFlat = System.currentTimeMillis() - t0
                flat
            }
            val encStart = System.currentTimeMillis()
            tree.toString()
            val encodeMs = System.currentTimeMillis() - encStart
            val timings = JSONObject().apply {
                put("idleMs", idleMs)
                put("rootMs", rootMs)
                put("windowsMs", windowTimings.windowsMs)
                put("rootsMs", JSONArray(windowTimings.rootsMs))
                put("serializeMs", if (nested) windowTimings.serializeMs else serializeMsFlat)
                put("encodeMs", encodeMs)
                put("rootSource", resolved.source)
            }
            return JSONObject().apply {
                put("tree", tree)
                put("timings", timings)
            }
        } finally {
            rootNode.recycle()
        }
    }

    /**
     * Nested roots for EVERY relevant window (active-first, then by layer — see
     * [NestedWindowSerializer]), shared with the `getState` nested path so the
     * describe and await-* tools trim identical input (F12).
     */
    private fun buildNestedWindows(
        cap: Int,
        activeRoot: android.view.accessibility.AccessibilityNodeInfo,
        timings: WindowTimings
    ): JSONArray {
        return NestedWindowSerializer.serialize(uiAutomation, activeRoot, cap, timings)
    }
}
