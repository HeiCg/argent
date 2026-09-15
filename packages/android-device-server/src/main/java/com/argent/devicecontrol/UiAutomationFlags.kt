package com.argent.devicecontrol

/**
 * Instrumentation-arg parsing for the UiAutomation connection.
 *
 * The DEFAULT (arg unset) keeps the suppressing UiAutomation, which is what makes
 * describe reads cheap and is byte-identical to the pre-AW-1 driver. The opt-in
 * `-e dontSuppressA11y true` is set ONLY by the AndroidWorld harness, where AW's
 * a11y forwarder must coexist with our UiAutomation on one emulator (AW-1 probe
 * 34946274170 / re-probe 34947435250). Kept pure (no Android deps) so it runs as a
 * plain JVM unit test, mirroring [EmulatorDetect].
 */
object UiAutomationFlags {
    /** Instrumentation arg name: `am instrument -e dontSuppressA11y true`. */
    const val ARG_DONT_SUPPRESS_A11Y = "dontSuppressA11y"

    /** True only when the arg value is exactly "true"; unset/any other value = false. */
    fun dontSuppressA11y(argValue: String?): Boolean = argValue == "true"
}
