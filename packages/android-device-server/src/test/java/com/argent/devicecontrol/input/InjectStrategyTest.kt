package com.argent.devicecontrol.input

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pure JVM coverage for the phase-3n strategy parse + outcome shape. The actual
 * injection paths (UiAutomation vs the reflective InputManager pipe) are exercised
 * on-device in `android-open-server.device.test.ts`; this only pins the wire
 * contract so a typo in a strategy name can't silently fall through to DEFAULT.
 */
class InjectStrategyTest {

    @Test
    fun `known wire values parse to their strategy`() {
        assertEquals(InjectStrategy.UIA_SYNC, InjectStrategy.fromWire("uia-sync"))
        assertEquals(InjectStrategy.UIA_ASYNC, InjectStrategy.fromWire("uia-async"))
        assertEquals(InjectStrategy.INPUT_MANAGER, InjectStrategy.fromWire("input-manager"))
    }

    @Test
    fun `absent, empty, and unknown values fall back to DEFAULT (unchanged behaviour)`() {
        assertEquals(InjectStrategy.DEFAULT, InjectStrategy.fromWire(null))
        assertEquals(InjectStrategy.DEFAULT, InjectStrategy.fromWire(""))
        assertEquals(InjectStrategy.DEFAULT, InjectStrategy.fromWire("default"))
        assertEquals(InjectStrategy.DEFAULT, InjectStrategy.fromWire("bogus"))
        assertEquals(InjectStrategy.DEFAULT, InjectStrategy.fromWire("UIA-SYNC"))
    }

    @Test
    fun `wire round-trips through the enum`() {
        for (s in InjectStrategy.values()) {
            if (s == InjectStrategy.DEFAULT) continue
            assertEquals(s, InjectStrategy.fromWire(s.wire))
        }
    }

    @Test
    fun `forceUnavailableForTest makes probe report unavailable with the reason (P9 seam)`() {
        try {
            InputManagerInjector.forceUnavailableForTest("blocked by test")
            val a = InputManagerInjector.probe()
            assertEquals(false, a.available)
            assertEquals("blocked by test", a.error)
        } finally {
            InputManagerInjector.resetForTest()
        }
    }

    @Test
    fun `outcome carries strategy and optional fallback fields`() {
        val ok = InjectOutcome(dropped = false, strategy = "uia-async")
        assertEquals("uia-async", ok.strategy)
        assertNull(ok.fellBackTo)
        assertNull(ok.error)

        val unavailable = InjectOutcome(
            dropped = false,
            strategy = InjectOutcome.UNAVAILABLE,
            fellBackTo = "uia-async",
            error = "NoSuchMethodException: getInstance"
        )
        assertEquals("unavailable", unavailable.strategy)
        assertEquals("uia-async", unavailable.fellBackTo)
        assertEquals("NoSuchMethodException: getInstance", unavailable.error)
    }
}
