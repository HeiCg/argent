package com.argent.devicecontrol.handlers

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure JVM coverage for the tap stage timings (step tap-latency): the scheduled
 * DOWN-to-last-UP span of a tap timeline and the injection overhead beyond it.
 */
class TapTimelineTest {

    @Test
    fun `single tap is scheduled for its hold only`() {
        assertEquals(50L, TapTimeline.scheduledMs(clickCount = 1, holdMs = 50, gapMs = 100))
    }

    @Test
    fun `multi-tap adds a hold per press and a gap between presses`() {
        // DOWN@0 UP@50 DOWN@150 UP@200 DOWN@300 UP@350.
        assertEquals(350L, TapTimeline.scheduledMs(clickCount = 3, holdMs = 50, gapMs = 100))
    }

    @Test
    fun `overhead is the injected span beyond the schedule`() {
        assertEquals(0.75, TapTimeline.overheadMs(50.75, clickCount = 1, holdMs = 50, gapMs = 100), 1e-9)
        assertEquals(1.5, TapTimeline.overheadMs(201.5, clickCount = 2, holdMs = 50, gapMs = 100), 1e-9)
    }

    @Test
    fun `nanoseconds round to hundredths of a millisecond`() {
        assertEquals(1.23, TapTimeline.ms(1_234_567L), 1e-9)
        assertEquals(0.0, TapTimeline.ms(4_000L), 1e-9)
        assertEquals(50.01, TapTimeline.ms(50_005_000L), 1e-9)
    }
}
