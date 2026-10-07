package com.argent.devicecontrol.handlers

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure JVM coverage for the `scrollContainer` request and target rules. The
 * ACTION_SCROLL_* call itself runs on-device only (device test 3g).
 */
class ScrollTargetTest {

    @Test
    fun `forward and backward map to the action direction`() {
        assertTrue(ScrollTarget.request(null, "list", "forward", 1).forward)
        assertFalse(ScrollTarget.request(null, "list", "backward", 1).forward)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `an unknown direction is refused`() {
        ScrollTarget.request(null, "list", "down", 1)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a request without nodeId or resourceId is refused`() {
        ScrollTarget.request(null, null, "forward", 1)
    }

    @Test
    fun `count is clamped to 1 through MAX_COUNT`() {
        assertEquals(1, ScrollTarget.request(null, "list", "forward", 0).count)
        assertEquals(1, ScrollTarget.request(null, "list", "forward", -3).count)
        assertEquals(3, ScrollTarget.request(null, "list", "forward", 3).count)
        assertEquals(
            ScrollTarget.MAX_COUNT,
            ScrollTarget.request(null, "list", "forward", 500).count
        )
    }

    @Test
    fun `nodeId parses as screen bounds`() {
        val req = ScrollTarget.request("0, 366,1080,2274", null, "forward", 1)
        assertArrayEquals(intArrayOf(0, 366, 1080, 2274), req.nodeBounds)
        assertNull(req.resourceId)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a malformed nodeId is refused`() {
        ScrollTarget.request("0,366,1080", null, "forward", 1)
    }

    @Test
    fun `resource ids compare without the package prefix`() {
        assertEquals("list", ScrollTarget.stripId("com.example:id/list"))
        assertEquals("list", ScrollTarget.stripId("list"))
        assertEquals("", ScrollTarget.stripId(null))
        val req = ScrollTarget.request(null, "com.example:id/list", "forward", 1)
        assertTrue(ScrollTarget.matches("com.other:id/list", 0, 0, 10, 10, req))
        assertFalse(ScrollTarget.matches("com.example:id/carousel", 0, 0, 10, 10, req))
        assertFalse(ScrollTarget.matches(null, 0, 0, 10, 10, req))
    }

    @Test
    fun `nodeId and resourceId must both match when both are given`() {
        val req = ScrollTarget.request("0,366,1080,2274", "list", "forward", 1)
        assertTrue(ScrollTarget.matches("x:id/list", 0, 366, 1080, 2274, req))
        assertFalse(ScrollTarget.matches("x:id/list", 0, 200, 1080, 366, req))
        assertFalse(ScrollTarget.matches("x:id/carousel", 0, 366, 1080, 2274, req))
    }

    @Test
    fun `pick takes the largest scrollable and reports a non-scrollable match`() {
        assertEquals(ScrollTarget.PICK_NONE, ScrollTarget.pick(emptyList()))
        assertEquals(
            ScrollTarget.PICK_NOT_SCROLLABLE,
            ScrollTarget.pick(listOf(ScrollTarget.Candidate(false, 900)))
        )
        assertEquals(
            2,
            ScrollTarget.pick(
                listOf(
                    ScrollTarget.Candidate(true, 100),
                    ScrollTarget.Candidate(false, 5_000),
                    ScrollTarget.Candidate(true, 900),
                    ScrollTarget.Candidate(true, 900)
                )
            )
        )
    }
}
