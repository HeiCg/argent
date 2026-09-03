package com.argent.devicecontrol.accessibility

import android.view.accessibility.AccessibilityWindowInfo
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * R2 (phase 3e) golden for the window-selection rule that keeps mid-transition
 * capture cheap: the active window is always serialized, non-active IME / system
 * windows survive, and other non-active `TYPE_APPLICATION` windows (the outgoing
 * activity during a navigation) are dropped.
 *
 * The predicate only reads inlined `AccessibilityWindowInfo.TYPE_*` constants, so
 * this runs as a plain JVM unit test — no device, no Robolectric.
 */
class NestedWindowSerializerTest {

    @Test
    fun activeApplicationWindowIsKept() {
        assertTrue(
            NestedWindowSerializer.shouldSerializeWindow(
                isActive = true,
                type = AccessibilityWindowInfo.TYPE_APPLICATION
            )
        )
    }

    @Test
    fun inactiveApplicationWindowIsDropped() {
        // The outgoing activity during a transition, or the app behind a dialog.
        assertFalse(
            NestedWindowSerializer.shouldSerializeWindow(
                isActive = false,
                type = AccessibilityWindowInfo.TYPE_APPLICATION
            )
        )
    }

    @Test
    fun twoApplicationWindowsOnlyTheActiveOneSurvives() {
        // "Two application windows, one inactive": the incoming (active) window is
        // serialized; the outgoing (inactive) one is dropped.
        val incomingActive = NestedWindowSerializer.shouldSerializeWindow(
            isActive = true,
            type = AccessibilityWindowInfo.TYPE_APPLICATION
        )
        val outgoingInactive = NestedWindowSerializer.shouldSerializeWindow(
            isActive = false,
            type = AccessibilityWindowInfo.TYPE_APPLICATION
        )
        assertTrue(incomingActive)
        assertFalse(outgoingInactive)
    }

    @Test
    fun inactiveImeWindowIsKept() {
        // The soft keyboard is never the active window but must stay in the tree.
        assertTrue(
            NestedWindowSerializer.shouldSerializeWindow(
                isActive = false,
                type = AccessibilityWindowInfo.TYPE_INPUT_METHOD
            )
        )
    }

    @Test
    fun inactiveSystemWindowIsKept() {
        // System / dialog-like chrome.
        assertTrue(
            NestedWindowSerializer.shouldSerializeWindow(
                isActive = false,
                type = AccessibilityWindowInfo.TYPE_SYSTEM
            )
        )
    }
}
