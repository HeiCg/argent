package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import com.argent.devicecontrol.input.InjectStrategy
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
        // Phase 3n: per-RPC injection strategy. Absent / unknown → DEFAULT (today's
        // async-UP tap). uia-sync / uia-async / input-manager select the explicit
        // pipes; input-manager degrades to uia-async when the hidden API is blocked.
        val strategy = InjectStrategy.fromWire(params.optString("inject", ""))
        // `dropped` is true when the framework rejected an injected event (no
        // injectable window mid-transition, secure surface, contended input pipe).
        // Surface it so the host fails the tap and falls back rather than reporting
        // a tap that never landed (R1, phase 3g).
        // Step tap-latency: `timing:true` adds the device-side `stages` (JsonRpcHandler
        // adds the parse / handle / previous-write stages to the same object).
        val timing = params.optBoolean("timing", false)
        val injectStart = System.nanoTime()
        val outcome = MotionInjector.injectTaps(uiAutomation, x, y, clickCount, holdMs, gapMs, strategy)
        val injectNs = System.nanoTime() - injectStart
        return JSONObject().apply {
            put("success", !outcome.dropped)
            if (outcome.dropped) put("dropped", true)
            put("strategy", outcome.strategy)
            outcome.fellBackTo?.let { put("fellBackTo", it) }
            outcome.error?.let { put("injectError", it) }
            if (timing) {
                val injectMs = TapTimeline.ms(injectNs)
                put("stages", JSONObject().apply {
                    put("injectMs", injectMs)
                    put("injectOverheadMs", TapTimeline.overheadMs(injectMs, clickCount, holdMs, gapMs))
                })
            }
        }
    }
}

/**
 * Tap timeline arithmetic for the `timing` stages (step tap-latency). Pure, so it is
 * unit-tested on the JVM.
 */
object TapTimeline {

    /** Scheduled DOWN-to-last-UP span: a hold per press and a gap between presses. */
    fun scheduledMs(clickCount: Int, holdMs: Long, gapMs: Long): Long =
        clickCount * holdMs + (clickCount - 1) * gapMs

    /** The injected span beyond the schedule: dispatch cost plus sleep overshoot. */
    fun overheadMs(injectMs: Double, clickCount: Int, holdMs: Long, gapMs: Long): Double =
        Math.round((injectMs - scheduledMs(clickCount, holdMs, gapMs)) * 100) / 100.0

    /** Nanoseconds to milliseconds, rounded to hundredths. */
    fun ms(ns: Long): Double = Math.round(ns / 10_000.0) / 100.0
}
