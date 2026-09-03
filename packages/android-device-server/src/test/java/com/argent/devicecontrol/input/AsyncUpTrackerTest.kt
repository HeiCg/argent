package com.argent.devicecontrol.input

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * R1 flag-ordering unit (phase 3g). The correctness rule is that the outstanding
 * flag is cleared only AFTER the synchronous drain/flush inject actually returns,
 * so a failed flush leaves the flag set for the next capture to retry instead of
 * silently letting a following describe read the mid-press (finger-down) tree.
 *
 * Pure JVM — [AsyncUpTracker] has no Android dependencies.
 */
class AsyncUpTrackerTest {

    @Test
    fun drainIsANoOpWhenNothingOutstanding() {
        val t = AsyncUpTracker()
        var injected = false
        t.drainWith { _, _ -> injected = true }
        assertFalse("drain must not inject when no async UP is outstanding", injected)
        assertFalse(t.hasOutstanding())
    }

    @Test
    fun markThenDrainInjectsAtLastPointAndClears() {
        val t = AsyncUpTracker()
        t.markOutstanding(12f, 34f)
        assertTrue(t.hasOutstanding())
        var seenX = -1f
        var seenY = -1f
        t.drainWith { x, y -> seenX = x; seenY = y }
        assertEquals(12f, seenX, 0f)
        assertEquals(34f, seenY, 0f)
        assertFalse("flag must be cleared after a successful drain", t.hasOutstanding())
    }

    @Test
    fun flagStaysSetWhenTheSyncInjectThrows() {
        // The R1 bug: clearing the flag BEFORE the inject meant a thrown/dropped
        // flush left the tracker believing the UP was drained, so the next capture
        // skipped the drain and read a stale finger-down tree. Clearing AFTER keeps
        // the flag set so the next capture retries.
        val t = AsyncUpTracker()
        t.markOutstanding(1f, 2f)
        var attempts = 0
        try {
            t.drainWith { _, _ -> attempts++; throw RuntimeException("dispatcher rejected") }
        } catch (_: RuntimeException) {
        }
        assertTrue("flag must remain set after a throwing drain", t.hasOutstanding())
        // A retry now runs the inject again and, on success, clears.
        t.drainWith { _, _ -> attempts++ }
        assertEquals(2, attempts)
        assertFalse(t.hasOutstanding())
    }

    @Test
    fun flushAlwaysInjectsAndClearsAfterwards() {
        val t = AsyncUpTracker()
        // flushInput runs even when the flag is false (a cross-process fast-inject
        // whose UP this tracker never saw); it must still order-and-clear.
        var injected = 0
        t.flushWith { injected++ }
        assertEquals(1, injected)
        assertFalse(t.hasOutstanding())

        t.markOutstanding(5f, 6f)
        t.flushWith { injected++ }
        assertEquals(2, injected)
        assertFalse("flush clears the flag after injecting", t.hasOutstanding())
    }

    @Test
    fun clearResetsWithoutInjecting() {
        val t = AsyncUpTracker()
        t.markOutstanding(9f, 9f)
        t.clear()
        assertFalse(t.hasOutstanding())
    }
}
