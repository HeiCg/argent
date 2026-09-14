package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import com.argent.devicecontrol.input.MotionInjector
import org.json.JSONObject

/**
 * `flushInput`: synchronously drain the input dispatcher's touch queue (phase 3f).
 *
 * Historically the (now-removed, phase 3n.2) scrcpy fast-inject backend injected
 * tap/swipe/gesture over a separate `app_process`, so this server's UiAutomation never
 * saw those events and the tap-async-UP drain would no-op. This RPC remains generic
 * plumbing: the host may call it right after an out-of-band injection so a following
 * `getNestedState`/describe on this channel observes the settled, finger-up tree —
 * never the mid-press state. See [MotionInjector.flushInput].
 */
class FlushInputHandler(private val uiAutomation: UiAutomation) {

    fun execute(@Suppress("UNUSED_PARAMETER") params: JSONObject): JSONObject {
        MotionInjector.flushInput(uiAutomation)
        return JSONObject().apply { put("success", true) }
    }
}
