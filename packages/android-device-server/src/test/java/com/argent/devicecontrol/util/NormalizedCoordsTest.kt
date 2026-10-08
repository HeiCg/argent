package com.argent.devicecontrol.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure JVM coverage for the on-device conversion of normalized gesture coordinates
 * (versionCode 31). The expected pixels are the host's old `toPixels`:
 * `Math.round(n * extent)` against the rotation-aware real metrics, worked by hand.
 */
class NormalizedCoordsTest {

    private val portrait = DisplayReader.Geometry(width = 1080, height = 2400, rotation = 0)

    @Test
    fun `portrait converts against the portrait width and height`() {
        assertEquals(540 to 1200, NormalizedCoords.toPixels(portrait, 0.5, 0.5))
        // 0.25 * 1080 = 270, 0.75 * 2400 = 1800.
        assertEquals(270 to 1800, NormalizedCoords.toPixels(portrait, 0.25, 0.75))
    }

    @Test
    fun `landscape 90 converts against the rotated width and height`() {
        // Real metrics are rotation-aware: at ROTATION_90 the width is the long side.
        val landscape90 = DisplayReader.Geometry(width = 2400, height = 1080, rotation = 1)
        // 0.5 * 2400 = 1200, 0.25 * 1080 = 270.
        assertEquals(1200 to 270, NormalizedCoords.toPixels(landscape90, 0.5, 0.25))
    }

    @Test
    fun `landscape 270 converts against the rotated width and height`() {
        val landscape270 = DisplayReader.Geometry(width = 2400, height = 1080, rotation = 3)
        // 0.125 * 2400 = 300, 0.875 * 1080 = 945.
        assertEquals(300 to 945, NormalizedCoords.toPixels(landscape270, 0.125, 0.875))
    }

    @Test
    fun `edges map to 0 and to the full extent, as the host rounded`() {
        assertEquals(0 to 0, NormalizedCoords.toPixels(portrait, 0.0, 0.0))
        // The host sent Math.round(1 * width) = width, one past the last pixel; kept.
        assertEquals(1080 to 2400, NormalizedCoords.toPixels(portrait, 1.0, 1.0))
    }

    @Test
    fun `a half pixel rounds up, like JavaScript Math round`() {
        // 0.5 * 1081 = 540.5 -> 541; 0.5 * 3 = 1.5 -> 2.
        assertEquals(541, NormalizedCoords.toPixel(0.5, 1081, "nx"))
        assertEquals(2, NormalizedCoords.toPixel(0.5, 3, "ny"))
        // 0.25 * 1082 = 270.5 -> 271.
        assertEquals(271, NormalizedCoords.toPixel(0.25, 1082, "nx"))
    }

    @Test
    fun `out of range or NaN is a clear error naming the parameter`() {
        for (bad in listOf(-0.01, 1.01, Double.NaN, Double.POSITIVE_INFINITY)) {
            val e = assertThrows(IllegalArgumentException::class.java) {
                NormalizedCoords.toPixel(bad, 1080, "nStartX")
            }
            assertTrue(e.message!!, e.message!!.contains("nStartX"))
            assertTrue(e.message!!, e.message!!.contains("[0, 1]"))
        }
    }

    @Test
    fun `a zero display extent is an error, not a tap at the origin`() {
        val e = assertThrows(IllegalStateException::class.java) {
            NormalizedCoords.toPixels(DisplayReader.Geometry(0, 0, 0), 0.5, 0.5)
        }
        assertTrue(e.message!!, e.message!!.contains("0x0"))
    }
}
