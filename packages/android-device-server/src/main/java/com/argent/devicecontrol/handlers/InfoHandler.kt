package com.argent.devicecontrol.handlers

import android.app.Instrumentation
import android.app.UiAutomation
import android.view.accessibility.AccessibilityWindowInfo
import com.argent.devicecontrol.util.DisplayReader
import org.json.JSONObject

class InfoHandler(
    private val instrumentation: Instrumentation,
    private val uiAutomation: UiAutomation
) {

    private val context get() = instrumentation.context

    fun execute(): JSONObject {
        val geo = DisplayReader.read(context)
        // Package + activity from ONE active-window walk, NOT
        // uiDevice.currentPackageName — that getter triggers waitForIdle and
        // stalls this call for up to 10 s while the UI animates.
        val (pkg, activity) = activePackageAndActivity()
        return JSONObject().apply {
            put("screenWidth", geo.width)
            put("screenHeight", geo.height)
            put("currentPackage", pkg)
            put("currentActivity", activity)
            put("keyboardVisible", isKeyboardVisible())
            // Rotation from the same Display snapshot, never uiDevice.displayRotation
            // (also a waitForIdle caller).
            put("displayRotation", geo.rotation)
        }
    }

    /**
     * Cheap screen geometry for the gesture hot path: reads real size AND
     * rotation from ONE platform [Display] snapshot ([DisplayReader]), never a
     * `UiDevice` getter. `uiDevice.displayRotation` / `uiDevice.currentPackageName`
     * call `UiAutomation.waitForIdle(500, 10_000)` under the hood, so on a screen
     * that is mid-animation (a fling or a pinch-zoom) they block until it settles
     * — the exact stall the tap/swipe/pinch tools hit when they peeked screen size
     * before every gesture. Reading straight from the `Display` is genuinely
     * ~1 ms even mid-animation because it never touches the accessibility
     * pipeline. Rule: never call a `UiDevice` getter that triggers `waitForIdle`
     * on a hot path.
     */
    fun screenSize(): JSONObject {
        val geo = DisplayReader.read(context)
        return JSONObject().apply {
            put("screenWidth", geo.width)
            put("screenHeight", geo.height)
            put("displayRotation", geo.rotation)
        }
    }

    /**
     * Active window package + activity title from a single `rootInActiveWindow`
     * walk, avoiding `uiDevice.currentPackageName` (a waitForIdle caller). Falls
     * back to the active entry in the window list when there is no active root.
     */
    private fun activePackageAndActivity(): Pair<String, String> {
        return try {
            val root = uiAutomation.rootInActiveWindow
            if (root != null) {
                val pkg = root.packageName?.toString() ?: ""
                val windowId = root.windowId
                root.recycle()
                val windows = uiAutomation.windows
                val activeWindow = windows.firstOrNull { it.id == windowId }
                pkg to (activeWindow?.title?.toString() ?: "")
            } else {
                val activeRoot = uiAutomation.windows.firstOrNull { it.isActive }?.root
                val pkg = activeRoot?.packageName?.toString() ?: ""
                activeRoot?.recycle()
                pkg to ""
            }
        } catch (_: Exception) {
            "" to ""
        }
    }

    private fun isKeyboardVisible(): Boolean {
        return try {
            uiAutomation.windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
        } catch (_: Exception) {
            false
        }
    }
}
