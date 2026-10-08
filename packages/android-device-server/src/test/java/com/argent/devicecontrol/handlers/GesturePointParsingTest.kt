package com.argent.devicecontrol.handlers

import com.argent.devicecontrol.input.MotionInjector
import com.argent.devicecontrol.util.DisplayReader
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * The RPC parameter parsing each gesture handler hands to the injector, against
 * REAL org.json objects: pixel keys pass through, normalized keys convert against
 * one display read per request (versionCode 31). Expected pixels worked by hand.
 */
class GesturePointParsingTest {

    private val landscape = DisplayReader.Geometry(width = 2400, height = 1080, rotation = 1)

    private class CountingGeometry(private val geo: DisplayReader.Geometry) : () -> DisplayReader.Geometry {
        var reads = 0
        override fun invoke(): DisplayReader.Geometry {
            reads++
            return geo
        }
    }

    // ---- tap / long-press --------------------------------------------------

    @Test
    fun `tap reads nx ny as normalized and converts`() {
        val geo = CountingGeometry(landscape)
        val params = JSONObject("""{"nx":0.5,"ny":0.25,"clickCount":2,"holdMs":50}""")
        // 0.5 * 2400 = 1200, 0.25 * 1080 = 270.
        assertEquals(1200 to 270, TapPoint.read(params, geo))
        assertEquals(1, geo.reads)
    }

    @Test
    fun `tap still reads pixel x y`() {
        val geo = CountingGeometry(landscape)
        assertEquals(500 to 1000, TapPoint.read(JSONObject("""{"x":500,"y":1000}"""), geo))
        assertEquals(0, geo.reads)
    }

    @Test
    fun `tap with neither pair is an error`() {
        assertThrows(Exception::class.java) {
            TapPoint.read(JSONObject("""{"clickCount":1}""")) { landscape }
        }
    }

    // ---- swipe -------------------------------------------------------------

    @Test
    fun `swipe reads the four normalized ends against ONE display read`() {
        val geo = CountingGeometry(landscape)
        val params = JSONObject(
            """{"nStartX":0.5,"nStartY":0.75,"nEndX":0.125,"nEndY":0.25,"steps":10}"""
        )
        // 1200, 810 -> 300, 270.
        assertEquals(SwipeEnds(1200, 810, 300, 270), SwipeEnds.read(params, geo))
        assertEquals(1, geo.reads)
    }

    @Test
    fun `swipe still reads pixel ends`() {
        val geo = CountingGeometry(landscape)
        val params = JSONObject("""{"startX":1,"startY":2,"endX":3,"endY":4}""")
        assertEquals(SwipeEnds(1, 2, 3, 4), SwipeEnds.read(params, geo))
        assertEquals(0, geo.reads)
    }

    @Test
    fun `swipe with an out-of-range normalized end is an error`() {
        val params = JSONObject("""{"nStartX":0.5,"nStartY":0.5,"nEndX":-0.5,"nEndY":0.5}""")
        assertThrows(IllegalArgumentException::class.java) { SwipeEnds.read(params) { landscape } }
    }

    // ---- multi-pointer gesture ---------------------------------------------

    @Test
    fun `gesture converts normalized points against ONE display read`() {
        val geo = CountingGeometry(landscape)
        val params = JSONObject(
            """{"pointers":[
                {"id":3,"points":[{"nx":0.5,"ny":0.5,"tMs":0},{"nx":0.25,"ny":0.5,"tMs":300}]},
                {"points":[{"nx":0.5,"ny":0.5,"tMs":0},{"nx":0.75,"ny":0.5,"tMs":300}]}
            ]}"""
        )
        val (ids, paths) = GesturePointers.read(params, geo)
        assertArrayEquals(intArrayOf(3, 1), ids)
        assertEquals(
            listOf(
                listOf(MotionInjector.Point(1200f, 540f, 0), MotionInjector.Point(600f, 540f, 300)),
                listOf(MotionInjector.Point(1200f, 540f, 0), MotionInjector.Point(1800f, 540f, 300))
            ),
            paths
        )
        assertEquals(1, geo.reads)
    }

    @Test
    fun `gesture still reads pixel points as given`() {
        val geo = CountingGeometry(landscape)
        val params = JSONObject("""{"pointers":[{"points":[{"x":10.5,"y":20,"tMs":16}]}]}""")
        val (ids, paths) = GesturePointers.read(params, geo)
        assertArrayEquals(intArrayOf(0), ids)
        assertEquals(listOf(listOf(MotionInjector.Point(10.5f, 20f, 16))), paths)
        assertEquals(0, geo.reads)
    }

    @Test
    fun `gesture without pointers is an error`() {
        assertThrows(IllegalArgumentException::class.java) {
            GesturePointers.read(JSONObject("{}")) { landscape }
        }
    }
}
