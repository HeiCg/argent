package com.argent.devicecontrol.handlers

import com.argent.devicecontrol.input.MotionInjector
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure JVM coverage for the release-velocity telemetry (review round 2): a
 * least-squares line over the MOVE samples of the last 100 ms before the UP.
 */
class ReleaseVelocityTest {

    // Constant-speed travel 1600 -> 1000 px in 19 steps of 8 ms (the held swipe's
    // travel cadence), DOWN at t = 0.
    private fun travel(): List<MotionInjector.Point> =
        (0..19).map { i -> MotionInjector.Point(500f, 1600f - 600f * i / 19, i * 8L) }

    @Test
    fun `constant travel plus a 120 ms hold reads about zero`() {
        val t = travel()
        val hold = (1..15).map { h -> MotionInjector.Point(500f, 1000f, t.last().tMs + h * 8L) }
        val v = ReleaseVelocity.lsqPxPerS(t + hold, 500, 1600, 500, 1000)
        assertEquals(0.0, v, 1.0)
    }

    @Test
    fun `constant travel with no hold reads the travel speed`() {
        // 600 px over 19 * 8 ms = 152 ms: 3947 px/s along the swipe.
        val v = ReleaseVelocity.lsqPxPerS(travel(), 500, 1600, 500, 1000)
        assertEquals(600.0 / 0.152, v, 5.0)
    }
}
