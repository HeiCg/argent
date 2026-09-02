package com.argent.devicecontrol.accessibility

import android.app.UiAutomation
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray

/**
 * Serialize EVERY window's accessibility tree as a nested-root array, shared by
 * `getAccessibilityTree({ nested: true })` and `getState({ nested: true })` so
 * both the describe path and the await-* poll path see byte-identical input to
 * the host-side v2 trim (F12). Kept in one place so the window-ordering rule
 * (F11) cannot drift between the two callers.
 *
 * Order (F11): the ACTIVE window first, then the rest by ascending layer — a
 * deterministic rule that keeps the app's own screen at the top of the describe
 * output and the IME / decor windows after it. Includes the on-screen IME
 * keyboard, which `rootInActiveWindow` omits; the v2 trim drops system chrome
 * (status / nav bar) exactly as `uiautomator dump` does, so the compacted result
 * still matches the proprietary path. Falls back to the active window's root when
 * the window list is empty.
 */
object NestedWindowSerializer {

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
