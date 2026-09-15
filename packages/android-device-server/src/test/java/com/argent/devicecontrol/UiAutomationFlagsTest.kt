package com.argent.devicecontrol

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The default (arg unset, or anything but "true") keeps the suppressing
 * UiAutomation — byte-identical to the pre-AW-1 driver, so merging needs no
 * describe-latency re-measure. Only an explicit `-e dontSuppressA11y true` opts
 * into FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES (the AndroidWorld harness path).
 */
class UiAutomationFlagsTest {

    @Test fun unsetArgDefaultsToSuppressing() {
        assertFalse(UiAutomationFlags.dontSuppressA11y(null))
    }

    @Test fun explicitTrueOptsIn() {
        assertTrue(UiAutomationFlags.dontSuppressA11y("true"))
    }

    @Test fun anyOtherValueStaysSuppressing() {
        assertFalse(UiAutomationFlags.dontSuppressA11y("false"))
        assertFalse(UiAutomationFlags.dontSuppressA11y(""))
        assertFalse(UiAutomationFlags.dontSuppressA11y("TRUE"))
        assertFalse(UiAutomationFlags.dontSuppressA11y("1"))
    }
}
