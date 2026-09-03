package com.argent.devicecontrol.accessibility

import android.app.UiAutomation
import android.graphics.Rect
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
 * Selection (R2 phase 3e, refined phase 3g): the active window is always
 * serialized in full. Among NON-active windows the IME (`TYPE_INPUT_METHOD`) and
 * system/dialog-like chrome (`TYPE_SYSTEM`) are always kept. A non-active
 * `TYPE_APPLICATION` window is kept ONLY when it is a popup drawn OVER the active
 * window — it overlaps the active window's bounds AND is either focused or on a
 * higher layer than the active window (an AutoCompleteTextView dropdown, an
 * overflow menu, a spinner list — exactly what the next tap targets). A
 * fully-behind non-active application window (the outgoing activity during a
 * navigation, or the app behind a dialog) is dropped: walking it in full was the
 * bulk of the mid-transition `captureMs` with no describe value, since the caller
 * only wants the screen the tap is navigating TO plus any popup/IME on top of it.
 * Per-stage timing is collected into [WindowTimings] for the bench.
 */
object NestedWindowSerializer {

    private const val TAG = "NestedWindowSerializer"

    /**
     * Whether a window should be serialized. Pure so it can be unit-tested
     * off-device: the caller computes [overlapsActive] (does this window's bounds
     * intersect the active window's), [layer] and [activeLayer] from the live
     * [AccessibilityWindowInfo]s.
     *
     * - active window: always kept.
     * - non-active IME / system chrome: always kept.
     * - non-active `TYPE_APPLICATION`: kept only as a popup OVER the active window
     *   (`overlapsActive && (isFocused || layer > activeLayer)`); a fully-behind
     *   window is dropped.
     * - anything else non-active: dropped.
     */
    fun shouldSerializeWindow(
        isActive: Boolean,
        type: Int,
        isFocused: Boolean,
        layer: Int,
        activeLayer: Int,
        overlapsActive: Boolean
    ): Boolean {
        if (isActive) return true
        if (type == AccessibilityWindowInfo.TYPE_INPUT_METHOD ||
            type == AccessibilityWindowInfo.TYPE_SYSTEM
        ) {
            return true
        }
        if (type == AccessibilityWindowInfo.TYPE_APPLICATION) {
            return overlapsActive && (isFocused || layer > activeLayer)
        }
        return false
    }

    /** The active window's root plus which path produced it (see [activeRoot]). */
    data class ActiveRoot(val root: AccessibilityNodeInfo?, val source: String)

    /**
     * Resolve the active window's root WITHOUT `uiAutomation.rootInActiveWindow`.
     * That binder call blocks ~170-210 ms mid-transition (phase 3g bench: after-tap
     * `rootMs` p50) while the active window settles. Reading the root from the
     * already-enumerated interactive-windows snapshot
     * (`windows.firstOrNull { it.isActive }?.root`) returns the current active root
     * coherently mid-transition instead, so a describe issued right after a tap no
     * longer pays that transitional block. Requires `FLAG_RETRIEVE_INTERACTIVE_WINDOWS`
     * on the UiAutomation service info (set at startup in
     * `DeviceControlInstrumentation`); falls back to `rootInActiveWindow` only when
     * the window list has no active entry with a root. `source` is surfaced as
     * `timings.rootSource` so the bench can tell which path served the capture.
     */
    fun activeRoot(uiAutomation: UiAutomation): ActiveRoot {
        val fromWindows = try {
            uiAutomation.windows.firstOrNull { it.isActive }?.root
        } catch (_: Exception) {
            null
        }
        if (fromWindows != null) return ActiveRoot(fromWindows, "windows")
        return ActiveRoot(uiAutomation.rootInActiveWindow, "activeWindow")
    }

    fun serialize(
        uiAutomation: UiAutomation,
        activeRoot: AccessibilityNodeInfo,
        cap: Int,
        timings: WindowTimings? = null,
        // Phase 3j: when true each window subtree is compacted (scaffold hoist +
        // zero-area empty leaf drop) before serialization, shrinking the wire
        // payload to the byte-identical DescribeNode. See [NodeSerializer.serializeNested].
        compact: Boolean = false
    ): JSONArray {
        val out = JSONArray()
        val enumStart = SystemClock.uptimeMillis()
        val windows = try {
            uiAutomation.windows.sortedWith(
                compareBy({ if (it.isActive) 0 else 1 }, { it.layer })
            )
        } catch (_: Exception) {
            emptyList()
        }
        timings?.windowsMs = SystemClock.uptimeMillis() - enumStart

        // The active window's layer + bounds anchor the popup-vs-behind decision.
        val active = windows.firstOrNull { it.isActive }
        val activeLayer = active?.layer ?: Int.MIN_VALUE
        val activeBounds = Rect().also { active?.getBoundsInScreen(it) }

        for (w in windows) {
            val overlaps = if (w.isActive) {
                true
            } else {
                val wb = Rect().also { w.getBoundsInScreen(it) }
                Rect.intersects(activeBounds, wb)
            }
            if (!shouldSerializeWindow(w.isActive, w.type, w.isFocused, w.layer, activeLayer, overlaps)) {
                Log.d(TAG, "captureWindow skip type=${w.type} active=${w.isActive} layer=${w.layer} overlaps=$overlaps focused=${w.isFocused}")
                continue
            }
            val rootStart = SystemClock.uptimeMillis()
            val root = try { w.root } catch (_: Exception) { null }
            timings?.rootsMs?.add(SystemClock.uptimeMillis() - rootStart)
            if (root == null) continue
            val t0 = SystemClock.uptimeMillis()
            try {
                out.put(NodeSerializer.serializeNested(root, cap, compact))
            } finally {
                root.recycle()
            }
            val ser = SystemClock.uptimeMillis() - t0
            timings?.let { it.serializeMs += ser }
            Log.d(
                TAG,
                "captureWindow keep type=${w.type} active=${w.isActive} layer=${w.layer} " +
                    "serializeMs=$ser"
            )
        }
        if (out.length() == 0) {
            val t0 = SystemClock.uptimeMillis()
            out.put(NodeSerializer.serializeNested(activeRoot, cap, compact))
            timings?.let { it.serializeMs += SystemClock.uptimeMillis() - t0 }
        }
        return out
    }
}
