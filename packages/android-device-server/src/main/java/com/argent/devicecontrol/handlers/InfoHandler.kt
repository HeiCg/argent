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
