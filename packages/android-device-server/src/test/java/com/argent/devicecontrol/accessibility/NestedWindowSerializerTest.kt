package com.argent.devicecontrol.accessibility

import android.view.accessibility.AccessibilityWindowInfo
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Window-selection goldens for the transitional-capture rule (R2 phase 3e,
 * refined phase 3g). The active window is always serialized; non-active IME /
 * system chrome is kept; a non-active `TYPE_APPLICATION` window is kept ONLY when
 * it is a popup drawn OVER the active window (overlaps + focused or higher layer)
 * and dropped when it is fully behind (the outgoing activity, or the app behind a
 * dialog).
 *
 * The predicate reads only inlined `AccessibilityWindowInfo.TYPE_*` constants and
 * primitives, so this runs as a plain JVM unit test — no device, no Robolectric.
 */
class NestedWindowSerializerTest {

    private val APP = AccessibilityWindowInfo.TYPE_APPLICATION
    private val IME = AccessibilityWindowInfo.TYPE_INPUT_METHOD
    private val SYS = AccessibilityWindowInfo.TYPE_SYSTEM
    private val ACCESSIBILITY = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY

    private fun keep(
        isActive: Boolean,
        type: Int,
        isFocused: Boolean = false,
        layer: Int = 0,
        activeLayer: Int = 0,
        overlaps: Boolean = false
    ) = NestedWindowSerializer.shouldSerializeWindow(isActive, type, isFocused, layer, activeLayer, overlaps)

    @Test
    fun activeApplicationWindowIsKept() {
        assertTrue(keep(isActive = true, type = APP))
    }

    @Test
    fun inactiveApplicationWindowFullyBehindIsDropped() {
        // The outgoing activity during a transition, or the app behind a dialog:
        // non-active, no overlap-driven popup role → dropped.
        assertFalse(keep(isActive = false, type = APP, layer = 5, activeLayer = 10, overlaps = false))
    }

    @Test
    fun twoApplicationWindowsOnlyTheActiveOneSurvives() {
        assertTrue(keep(isActive = true, type = APP, layer = 10, activeLayer = 10))
        // Outgoing (inactive) app window below the active layer, non-overlapping.
        assertFalse(keep(isActive = false, type = APP, layer = 5, activeLayer = 10, overlaps = false))
    }

    @Test
    fun inactiveImeWindowIsKept() {
        assertTrue(keep(isActive = false, type = IME))
    }

    @Test
    fun inactiveSystemWindowIsKept() {
        assertTrue(keep(isActive = false, type = SYS))
    }

    // --- phase 3g: popups / dropdowns drawn over the active window --------------

    @Test
    fun nonFocusablePopupOnAHigherLayerIsKept() {
        // AutoCompleteTextView dropdown / overflow menu: not focusable, not active,
        // but overlaps the active window and is drawn on a higher layer — exactly
        // what the next tap targets. Must survive.
        assertTrue(
            keep(isActive = false, type = APP, isFocused = false, layer = 20, activeLayer = 10, overlaps = true)
        )
    }

    @Test
    fun focusedPopupOverlappingTheActiveWindowIsKept() {
        // A focused sub-window (e.g. a spinner list) on the same or lower layer but
        // overlapping and focused is still a popup the user interacts with.
        assertTrue(
            keep(isActive = false, type = APP, isFocused = true, layer = 10, activeLayer = 10, overlaps = true)
        )
    }

    @Test
    fun higherLayerAppWindowThatDoesNotOverlapIsDropped() {
        // Overlap is required: a higher-layer app window that shares no bounds with
        // the active window is not a popup over it → dropped.
        assertFalse(
            keep(isActive = false, type = APP, isFocused = false, layer = 20, activeLayer = 10, overlaps = false)
        )
    }

    @Test
    fun overlappingButUnfocusedSameLayerAppWindowIsDropped() {
        // Overlaps but neither focused nor above the active layer → not a popup on
        // top; treated as behind and dropped.
        assertFalse(
            keep(isActive = false, type = APP, isFocused = false, layer = 10, activeLayer = 10, overlaps = true)
        )
    }

    @Test
    fun unknownNonActiveWindowTypeIsDropped() {
        assertFalse(keep(isActive = false, type = ACCESSIBILITY, overlaps = true, layer = 99, activeLayer = 1))
    }
}
