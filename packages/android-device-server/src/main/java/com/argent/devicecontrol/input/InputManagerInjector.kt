package com.argent.devicecontrol.input

import android.view.InputEvent
import java.lang.reflect.Method

/**
 * Reflective bridge to the hidden framework input pipe
 * `android.hardware.input.InputManager.injectInputEvent(InputEvent, int)` with
 * `INJECT_INPUT_EVENT_MODE_ASYNC` — the same call the scrcpy server makes to
 * inject a device-timestamped touch timeline without going through the
 * UiAutomation instrumentation hop (phase 3n).
 *
 * This process runs with shell uid (instrumentation), so the hidden API is
 * reachable when the device's `hidden_api_policy` allows it. When it is blocked
 * (a stock image with the policy enforced, no `-e disable-hidden-api-checks`),
 * the reflective resolution throws; [probe] captures that once and [available]
 * stays false, so the caller reports `strategy: "unavailable"` and falls back to
 * `uia-async`. We NEVER change `hidden_api_policy` from here — that is a separate,
 * documented CI step if it is ever wanted.
 *
 * Everything here is defensive: resolution and every injection are wrapped so a
 * blocked or absent API degrades to a reported failure, never a crash of the RPC
 * thread. The resolved handles are cached for the process lifetime (the policy is
 * constant per boot), guarded by a lock so concurrent RPCs probe at most once.
 */
object InputManagerInjector {

    /** `InputManager.INJECT_INPUT_EVENT_MODE_ASYNC` — fire-and-forget, no dispatch wait. */
    private const val INJECT_INPUT_EVENT_MODE_ASYNC = 0

    /** Resolution outcome: whether the hidden pipe is usable, and why not if not. */
    data class Availability(val available: Boolean, val error: String?)

    private data class Resolved(val instance: Any, val method: Method)

    private val lock = Any()
    @Volatile private var probed = false
    @Volatile private var resolved: Resolved? = null
    @Volatile private var probeError: String? = null

    /**
     * Resolve (once) the InputManager singleton and its `injectInputEvent`
     * method. Idempotent and thread-safe. Never throws — a failure is captured in
     * the returned [Availability.error].
     */
    fun probe(): Availability {
        if (!probed) {
            synchronized(lock) {
                if (!probed) {
                    try {
                        resolved = resolve()
                        probeError = null
                    } catch (t: Throwable) {
                        resolved = null
                        probeError = describe(t)
                    }
                    probed = true
                }
            }
        }
        val r = resolved
        return if (r != null) Availability(true, null) else Availability(false, probeError)
    }

    /**
     * Inject one event through the hidden pipe in ASYNC mode. Returns true iff the
     * framework accepted it (its `injectInputEvent` boolean). Returns false — never
     * throws — when the API is unavailable or the reflective call fails, so the
     * caller records it as a drop like a rejected UiAutomation injection.
     */
    fun injectAsync(event: InputEvent): Boolean {
        val r = resolved ?: return false
        return try {
            r.method.invoke(r.instance, event, INJECT_INPUT_EVENT_MODE_ASYNC) as? Boolean ?: false
        } catch (t: Throwable) {
            false
        }
    }

    /** Reset the cached resolution — test seam only; production probes once per boot. */
    fun resetForTest() {
        synchronized(lock) {
            probed = false
            resolved = null
            probeError = null
        }
    }

    private fun resolve(): Resolved {
        val instance = resolveInstance()
        // The injectInputEvent(InputEvent, int) overload is declared on InputManager
        // (API <= 33) or InputManagerGlobal (API 34+); it is on the instance's own
        // class in both cases, so look it up there.
        val method = instance.javaClass.getMethod(
            "injectInputEvent",
            InputEvent::class.java,
            Int::class.javaPrimitiveType
        )
        method.isAccessible = true
        return Resolved(instance, method)
    }

    /**
     * The InputManager singleton. API 34 moved the singleton to
     * `InputManagerGlobal.getInstance()`; earlier images expose
     * `InputManager.getInstance()`. Try the newer holder first, then the legacy
     * one; both are static no-arg factories reachable via the hidden API.
     */
    private fun resolveInstance(): Any {
        val candidates = listOf(
            "android.hardware.input.InputManagerGlobal",
            "android.hardware.input.InputManager"
        )
        var last: Throwable? = null
        for (className in candidates) {
            try {
                val cls = Class.forName(className)
                val getInstance = cls.getMethod("getInstance")
                getInstance.isAccessible = true
                val instance = getInstance.invoke(null)
                if (instance != null) return instance
            } catch (t: Throwable) {
                last = t
            }
        }
        throw last ?: NoSuchMethodException("InputManager.getInstance() not resolvable")
    }

    private fun describe(t: Throwable): String {
        // Reflection wraps the real cause in InvocationTargetException; unwrap so the
        // reported text names the actual hiddenapi / policy failure.
        val cause = (t as? java.lang.reflect.InvocationTargetException)?.targetException ?: t
        val msg = cause.message
        return if (msg.isNullOrBlank()) cause.javaClass.name else "${cause.javaClass.simpleName}: $msg"
    }
}
