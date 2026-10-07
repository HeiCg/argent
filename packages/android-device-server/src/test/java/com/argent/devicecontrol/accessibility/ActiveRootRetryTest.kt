package com.argent.devicecontrol.accessibility

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The active-root re-read is bounded by a retry count and a time budget, costs
 * nothing when the first read has a root, and reports how many reads it made.
 * A fake clock advances only on sleep (plus a per-read cost when given), so the
 * tests are deterministic.
 */
class ActiveRootRetryTest {

    private class FakeClock(private val readCostMs: Long = 0) {
        var now = 1_000L
        val sleeps = mutableListOf<Long>()
        val sleep: (Long) -> Unit = { ms -> sleeps.add(ms); now += ms }
        val clock: () -> Long = { now }
        fun readOnce() { now += readCostMs }
    }

    @Test fun firstReadWithRootDoesNotRetry() {
        val c = FakeClock()
        var reads = 0
        val r = ActiveRootRetry.resolve({ reads++; "root" }, c.sleep, c.clock)
        assertEquals("root", r.value)
        assertEquals(1, r.attempts)
        assertEquals(0L, r.retryMs)
        assertEquals(1, reads)
        assertEquals(emptyList<Long>(), c.sleeps)
    }

    @Test fun rootAppearingOnThirdReadIsReturnedWithItsCost() {
        val c = FakeClock()
        val answers = listOf<String?>(null, null, "root")
        var i = 0
        val r = ActiveRootRetry.resolve({ answers[i++] }, c.sleep, c.clock)
        assertEquals("root", r.value)
        assertEquals(3, r.attempts)
        assertEquals(listOf(50L, 50L), c.sleeps)
        assertEquals(100L, r.retryMs)
    }

    @Test fun alwaysNullStopsAfterMaxRetries() {
        val c = FakeClock()
        var reads = 0
        val r = ActiveRootRetry.resolve<String>({ reads++; null }, c.sleep, c.clock)
        assertNull(r.value)
        // 1 first read + 10 re-reads, each preceded by a 50 ms sleep.
        assertEquals(1 + ActiveRootRetry.MAX_RETRIES, r.attempts)
        assertEquals(1 + ActiveRootRetry.MAX_RETRIES, reads)
        assertEquals(ActiveRootRetry.MAX_RETRIES, c.sleeps.size)
        assertEquals(500L, r.retryMs)
    }

    @Test fun slowReadsStopAtTheTimeBudget() {
        // Each read blocks 200 ms (rootInActiveWindow mid-transition): the 500 ms
        // budget allows far fewer than 10 re-reads.
        val c = FakeClock(readCostMs = 200)
        var reads = 0
        val r = ActiveRootRetry.resolve<String>(
            { reads++; c.readOnce(); null },
            c.sleep,
            c.clock
        )
        assertNull(r.value)
        // re-read at t=250 and t=500 from the retry start, then the budget is spent.
        assertEquals(3, r.attempts)
        assertEquals(3, reads)
        assertEquals(500L, r.retryMs)
    }

    @Test fun zeroRetriesReadsOnce() {
        val c = FakeClock()
        val r = ActiveRootRetry.resolve<String>({ null }, c.sleep, c.clock, maxRetries = 0)
        assertNull(r.value)
        assertEquals(1, r.attempts)
        assertEquals(0L, r.retryMs)
    }
}
