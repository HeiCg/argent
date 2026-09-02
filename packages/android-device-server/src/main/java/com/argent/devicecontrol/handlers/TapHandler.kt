package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import com.argent.devicecontrol.input.MotionInjector
import org.json.JSONObject

/**
 * Tap: one or more raw ACTION_DOWN + ACTION_UP pairs injected through
 * [MotionInjector.injectTaps].
 *
 * The previous `uiDevice.click(x, y)` implicitly waited for the UI to go idle
 * after the tap (UiAutomator's built-in sync), which added ~80–100 ms of dead
 * time to every tap even though settling is the caller's job (the `await-*`
 * tools). Injecting the events directly returns as soon as the tap has been
 * delivered, with no idle wait.
 *
 * Timeline (F1/F8/F9). A tap holds the finger down for `holdMs` (default 50 =
 * the host `TAP_HOLD_MS`) — a real press, not a zero-duration touch — before the
 * up. A multi-tap (`clickCount > 1`) is built server-side as ONE timeline: the
 * server places `clickCount` down/up pairs `gapMs` apart (default 100 =
 * `MULTI_TAP_GAP_MS`) so the whole run lands inside the OS double-tap window,
 * instead of the host firing N separate `tap` RPCs whose spacing it cannot
 * guarantee.
 */
class TapHandler(private val uiAutomation: UiAutomation) {

    private companion object {
        const val DEFAULT_HOLD_MS = 50L
        const val DEFAULT_GAP_MS = 100L
    }

    fun execute(params: JSONObject): JSONObject {
        val x = params.getInt("x").toFloat()
        val y = params.getInt("y").toFloat()
        val clickCount = maxOf(1, params.optInt("clickCount", 1))
        val holdMs = maxOf(0L, params.optLong("holdMs", DEFAULT_HOLD_MS))
        val gapMs = maxOf(0L, params.optLong("gapMs", DEFAULT_GAP_MS))
        MotionInjector.injectTaps(uiAutomation, x, y, clickCount, holdMs, gapMs)
        return JSONObject().apply { put("success", true) }
    }
}
