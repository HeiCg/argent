package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import com.argent.devicecontrol.input.MotionInjector
import org.json.JSONObject

/**
 * `flushInput`: synchronously drain the input dispatcher's touch queue (phase 3f).
 *
 * The scrcpy fast-inject backend injects tap/swipe/gesture over its own control
 * channel (a separate `app_process`), so this server's UiAutomation never sees
 * those events and the tap-async-UP drain would no-op. The host calls this RPC
 * right after a fast-inject action so a following `getNestedState`/describe on
 * this channel observes the settled, finger-up tree — never the mid-press state.
 * See [MotionInjector.flushInput].
 */
class FlushInputHandler(private val uiAutomation: UiAutomation) {

    fun execute(@Suppress("UNUSED_PARAMETER") params: JSONObject): JSONObject {
        MotionInjector.flushInput(uiAutomation)
        return JSONObject().apply { put("success", true) }
    }
}
