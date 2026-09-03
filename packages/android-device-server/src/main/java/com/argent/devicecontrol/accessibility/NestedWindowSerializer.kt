package com.argent.devicecontrol.accessibility

import android.app.UiAutomation
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray

/**
 * Serialize the relevant windows' accessibility trees as a nested-root array,
 * shared by `getAccessibilityTree({ nested: true })` and `getState({ nested: true })`
 * so both the describe path and the await-* poll path see byte-identical input to
 * the host-side v2 trim (F12). Kept in one place so the window-selection + ordering
 * rules cannot drift between the two callers.
 *
 * Order (F11): the ACTIVE window first, then the rest by ascending layer — a
 * deterministic rule that keeps the app's own screen at the top of the describe
 * output and the IME / decor windows after it. Includes the on-screen IME
 * keyboard, which `rootInActiveWindow` omits; the v2 trim drops system chrome
 * (status / nav bar) exactly as `uiautomator dump` does, so the compacted result
 * still matches the proprietary path. Falls back to the active window's root when
 * the window list is empty.
 *
 * Selection (R2, phase 3e): the active window is always serialized in full. Among
 * NON-active windows only the IME (`TYPE_INPUT_METHOD`) and system/dialog-like
 * chrome (`TYPE_SYSTEM`) are kept; other non-active `TYPE_APPLICATION` windows are
 * skipped. During a navigation the accessibility tree transiently carries the
 * OUTGOING activity alongside the incoming one, and walking that outgoing window
 * in full was the bulk of the mid-transition `captureMs` (~179 ms) with no describe
 * value — the caller only wants the screen the tap is navigating TO (the active
 * window) plus any IME. Per-window serialize timing is logged for the bench.
 */
object NestedWindowSerializer {

    private const val TAG = "NestedWindowSerializer"

    /**
     * Whether a window should be serialized. The active window always is; among
     * non-active windows only the IME and system/dialog-like chrome survive, so a
     * transitional outgoing `TYPE_APPLICATION` window is dropped (R2). Pure so it
     * can be unit-tested off-device.
     */
    fun shouldSerializeWindow(isActive: Boolean, type: Int): Boolean {
        if (isActive) return true
        return type == AccessibilityWindowInfo.TYPE_INPUT_METHOD ||
            type == AccessibilityWindowInfo.TYPE_SYSTEM
    }

    fun serialize(
        uiAutomation: UiAutomation,
        activeRoot: AccessibilityNodeInfo,
        cap: Int
    ): JSONArray {
        val out = JSONArray()
        val windows = try {
            uiAutomation.windows.sortedWith(
                compareBy({ if (it.isActive) 0 else 1 }, { it.layer })
            )
        } catch (_: Exception) {
            emptyList()
        }
        for (w in windows) {
            if (!shouldSerializeWindow(w.isActive, w.type)) {
                Log.d(TAG, "captureWindow skip type=${w.type} active=${w.isActive} layer=${w.layer}")
                continue
            }
            val root = try { w.root } catch (_: Exception) { null } ?: continue
            val t0 = SystemClock.uptimeMillis()
            try {
                out.put(NodeSerializer.serializeNested(root, cap))
            } finally {
                root.recycle()
            }
            Log.d(
                TAG,
                "captureWindow keep type=${w.type} active=${w.isActive} layer=${w.layer} " +
                    "serializeMs=${SystemClock.uptimeMillis() - t0}"
            )
        }
        if (out.length() == 0) out.put(NodeSerializer.serializeNested(activeRoot, cap))
        return out
    }
}
