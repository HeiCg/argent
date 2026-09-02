package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.uiautomator.UiDevice
import org.json.JSONObject

class InfoHandler(
    private val uiDevice: UiDevice,
    private val uiAutomation: UiAutomation
) {

    fun execute(): JSONObject {
        return JSONObject().apply {
            put("screenWidth", uiDevice.displayWidth)
            put("screenHeight", uiDevice.displayHeight)
            put("currentPackage", uiDevice.currentPackageName ?: "")
            put("currentActivity", getCurrentActivity())
            put("keyboardVisible", isKeyboardVisible())
            put("displayRotation", uiDevice.displayRotation)
        }
    }

    /**
     * Cheap screen geometry for the gesture hot path: reads only `UiDevice`
     * display metrics (rotation-aware), never `uiAutomation.windows` /
     * `rootInActiveWindow`. The full [execute] snapshot costs ~2 ms on an idle
     * screen but ~400 ms while the UI animates (a fling or a pinch-zoom), because
     * those two calls walk the live accessibility tree — and the tap/swipe/pinch
     * tools called it before every gesture only to convert normalized coordinates
     * to pixels. This gives them the width/height without that snapshot.
     */
    fun screenSize(): JSONObject {
        return JSONObject().apply {
            put("screenWidth", uiDevice.displayWidth)
            put("screenHeight", uiDevice.displayHeight)
            put("displayRotation", uiDevice.displayRotation)
        }
    }

    private fun getCurrentActivity(): String {
        return try {
            val root = uiAutomation.rootInActiveWindow
            val windowId = root?.windowId ?: -1
            root?.recycle()
            val windows = uiAutomation.windows
            val activeWindow = windows.firstOrNull { it.id == windowId }
            activeWindow?.title?.toString() ?: ""
        } catch (_: Exception) {
            ""
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
