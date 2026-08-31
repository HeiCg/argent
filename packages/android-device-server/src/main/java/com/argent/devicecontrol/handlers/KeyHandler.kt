package com.argent.devicecontrol.handlers

import android.view.KeyEvent
import androidx.test.uiautomator.UiDevice
import org.json.JSONObject

class KeyHandler(private val uiDevice: UiDevice) {

    private val keyNameMap = mapOf(
        "home" to KeyEvent.KEYCODE_HOME,
        "back" to KeyEvent.KEYCODE_BACK,
        "enter" to KeyEvent.KEYCODE_ENTER,
        "delete" to KeyEvent.KEYCODE_DEL,
        "tab" to KeyEvent.KEYCODE_TAB,
        "escape" to KeyEvent.KEYCODE_ESCAPE,
        "menu" to KeyEvent.KEYCODE_MENU,
        "search" to KeyEvent.KEYCODE_SEARCH,
        "volume_up" to KeyEvent.KEYCODE_VOLUME_UP,
        "volume_down" to KeyEvent.KEYCODE_VOLUME_DOWN,
        "power" to KeyEvent.KEYCODE_POWER,
        "camera" to KeyEvent.KEYCODE_CAMERA,
        "dpad_up" to KeyEvent.KEYCODE_DPAD_UP,
        "dpad_down" to KeyEvent.KEYCODE_DPAD_DOWN,
        "dpad_left" to KeyEvent.KEYCODE_DPAD_LEFT,
        "dpad_right" to KeyEvent.KEYCODE_DPAD_RIGHT,
        "dpad_center" to KeyEvent.KEYCODE_DPAD_CENTER,
        "recent_apps" to KeyEvent.KEYCODE_APP_SWITCH,
        "space" to KeyEvent.KEYCODE_SPACE
    )

    fun execute(params: JSONObject): JSONObject {
        val success = when {
            params.has("keyCode") -> {
                uiDevice.pressKeyCode(params.getInt("keyCode"))
            }
            params.has("key") -> {
                val keyName = params.getString("key").lowercase()
                val keyCode = keyNameMap[keyName]
                    ?: throw IllegalArgumentException("Unknown key: $keyName. Known: ${keyNameMap.keys}")
                uiDevice.pressKeyCode(keyCode)
            }
            else -> throw IllegalArgumentException("Provide 'key' or 'keyCode'")
        }
        return JSONObject().apply { put("success", success) }
    }
}
