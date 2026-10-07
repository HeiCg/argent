package com.argent.devicecontrol.input

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure JVM coverage for the held-swipe hold anchor (review E-1 2026-10-07
 * finding 4). The injection itself runs on-device only; this pins the timing
 * rule: frames after the anchor are pushed back by however late the anchor
 * frame actually went out, so the hold before the UP is never shorter than
 * scheduled, measured on the device clock.
 */
class HoldAnchorTest {

    @Test
    fun `an on-time anchor adds no delay`() {
        assertEquals(0L, HoldAnchor.shiftMs(scheduledAt = 1_152L, actualAt = 1_152L))
    }

    @Test
    fun `an early anchor adds no delay (never pulls frames forward)`() {
        assertEquals(0L, HoldAnchor.shiftMs(scheduledAt = 1_152L, actualAt = 1_150L))
    }

    @Test
    fun `a late anchor shifts every later frame by its lateness`() {
        // Travel ran 248 ms late under load: the hold frames and the UP that were
        // scheduled 8..120 ms after the anchor stay 8..120 ms after its real arrival.
        val shift = HoldAnchor.shiftMs(scheduledAt = 1_152L, actualAt = 1_400L)
        assertEquals(248L, shift)
        val downTime = 1_000L
        val upSlotMs = 272L // 152 travel + 120 hold
        val upAt = downTime + upSlotMs + shift
        assertEquals(120L, upAt - 1_400L)
    }

    @Test
    fun `delivered span is UP minus DOWN, -1 when either is unknown`() {
        assertEquals(272L, HoldAnchor.spanMs(from = 1_000L, to = 1_272L))
        assertEquals(-1L, HoldAnchor.spanMs(from = -1L, to = 1_272L))
        assertEquals(-1L, HoldAnchor.spanMs(from = 1_000L, to = -1L))
    }
}
