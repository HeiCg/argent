package com.argent.devicecontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The key a request's server timeline is recorded under (step tap-latency): a
 * start warm-up read (`warmup:true`) records nothing, so the first real describe
 * does not carry the warm-up's `prevServer*`.
 */
class ServerTimingKeyTest {

    @Test
    fun `a normal request is recorded under its method`() {
        assertEquals("getState", ServerTimingKey.of("getState", warmup = false))
        assertEquals("tap", ServerTimingKey.of("tap", warmup = false))
    }

    @Test
    fun `a warm-up request is not recorded`() {
        assertNull(ServerTimingKey.of("getState", warmup = true))
    }
}
