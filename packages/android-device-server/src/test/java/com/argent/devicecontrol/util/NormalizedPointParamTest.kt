package com.argent.devicecontrol.util

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [NormalizedCoords.pointParam] and the 0x0 re-read against REAL org.json objects
 * (`testImplementation("org.json:json")`; android.jar's stubs would return defaults).
 */
class NormalizedPointParamTest {

    private val portrait = DisplayReader.Geometry(width = 1080, height = 2400, rotation = 0)

    /** A geometry supplier that counts its reads. */
    private class CountingGeometry(private val geo: DisplayReader.Geometry) : () -> DisplayReader.Geometry {
        var reads = 0
        override fun invoke(): DisplayReader.Geometry {
            reads++
            return geo
        }
    }

    @Test
    fun `a normalized pair converts against the display`() {
        val geo = CountingGeometry(portrait)
        val p = JSONObject("""{"nx":0.25,"ny":0.75}""")
        // 0.25 * 1080 = 270, 0.75 * 2400 = 1800.
        assertEquals(270 to 1800, NormalizedCoords.pointParam(p, "x", "y", "nx", "ny", geo))
        assertEquals(1, geo.reads)
    }

    @Test
    fun `an integer-valued normalized pair (0 and 1 on the wire) still converts`() {
        val p = JSONObject("""{"nx":1,"ny":0}""")
        assertEquals(1080 to 0, NormalizedCoords.pointParam(p, "x", "y", "nx", "ny") { portrait })
    }

    @Test
    fun `a pixel pair passes through without reading the display`() {
        val geo = CountingGeometry(portrait)
        val p = JSONObject("""{"x":12,"y":34}""")
        assertEquals(12 to 34, NormalizedCoords.pointParam(p, "x", "y", "nx", "ny", geo))
        assertEquals(0, geo.reads)
    }

    @Test
    fun `half a normalized pair is an error`() {
        for (json in listOf("""{"nx":0.5}""", """{"ny":0.5,"x":1,"y":2}""")) {
            val e = assertThrows(IllegalArgumentException::class.java) {
                NormalizedCoords.pointParam(JSONObject(json), "x", "y", "nx", "ny") { portrait }
            }
            assertTrue(e.message!!, e.message!!.contains("together"))
        }
    }

    @Test
    fun `out of range is an error naming the key`() {
        val e = assertThrows(IllegalArgumentException::class.java) {
            NormalizedCoords.pointParam(
                JSONObject("""{"nStartX":0.5,"nStartY":1.5}"""),
                "startX",
                "startY",
                "nStartX",
                "nStartY"
            ) { portrait }
        }
        assertTrue(e.message!!, e.message!!.contains("nStartY"))
        assertTrue(e.message!!, e.message!!.contains("[0, 1]"))
    }

    @Test
    fun `a transient 0x0 display is read again after 50 ms`() {
        val reads = ArrayDeque(listOf(DisplayReader.Geometry(0, 0, 0), portrait))
        val sleeps = mutableListOf<Long>()
        val geo = NormalizedCoords.readGeometry({ reads.removeFirst() }, { sleeps.add(it) })
        assertEquals(portrait, geo)
        assertEquals(listOf(50L), sleeps)
    }

    @Test
    fun `a good first read does not wait`() {
        val sleeps = mutableListOf<Long>()
        assertEquals(portrait, NormalizedCoords.readGeometry({ portrait }, { sleeps.add(it) }))
        assertEquals(emptyList<Long>(), sleeps)
    }

    @Test
    fun `a display still 0x0 after the re-read fails the conversion`() {
        val zero = DisplayReader.Geometry(0, 0, 0)
        var reads = 0
        val geo = NormalizedCoords.readGeometry({ reads++; zero }, { })
        assertEquals(2, reads)
        assertThrows(IllegalStateException::class.java) {
            NormalizedCoords.toPixels(geo, 0.5, 0.5)
        }
    }
}
