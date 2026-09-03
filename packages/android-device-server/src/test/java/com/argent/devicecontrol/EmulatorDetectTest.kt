package com.argent.devicecontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Goldens for the phase 3j bind decision (qemu system props -> bind address). Pure,
 * so it runs as a plain JVM unit test — no device. Mirrors the intent that the
 * `0.0.0.0` bind is decided ON DEVICE from qemu props, and the host env is only a
 * loud debug override.
 */
class EmulatorDetectTest {

    @Test fun oldAvdKernelQemuBindsAll() {
        val d = EmulatorDetect.shouldBindAll(qemuKernel = "1", qemuBoot = "", argOverride = false)
        assertTrue(d.bindAll)
        assertTrue(d.reason.startsWith("emulator"))
    }

    @Test fun newAvdBootQemuBindsAll() {
        val d = EmulatorDetect.shouldBindAll(qemuKernel = "", qemuBoot = "1", argOverride = false)
        assertTrue(d.bindAll)
        assertTrue(d.reason.startsWith("emulator"))
    }

    @Test fun physicalDeviceIsLoopbackOnly() {
        val d = EmulatorDetect.shouldBindAll(qemuKernel = "", qemuBoot = "", argOverride = false)
        assertFalse(d.bindAll)
        assertEquals("loopback-only (physical device)", d.reason)
    }

    @Test fun physicalDeviceKernelQemuZeroIsLoopbackOnly() {
        // ro.kernel.qemu present but 0 (not an emulator) stays loopback-only.
        val d = EmulatorDetect.shouldBindAll(qemuKernel = "0", qemuBoot = "", argOverride = false)
        assertFalse(d.bindAll)
    }

    @Test fun overrideForcesBindOnPhysicalButIsFlagged() {
        val d = EmulatorDetect.shouldBindAll(qemuKernel = "", qemuBoot = "", argOverride = true)
        assertTrue(d.bindAll)
        assertTrue(d.reason.contains("FORCED"))
        assertTrue(d.reason.contains("NON-emulator"))
    }

    @Test fun emulatorReasonWinsOverOverride() {
        // On an emulator the reason names the emulator, not the override.
        val d = EmulatorDetect.shouldBindAll(qemuKernel = "1", qemuBoot = "", argOverride = true)
        assertTrue(d.bindAll)
        assertTrue(d.reason.startsWith("emulator"))
    }

    @Test fun whitespaceIsTolerated() {
        val d = EmulatorDetect.shouldBindAll(qemuKernel = " 1 ", qemuBoot = "  ", argOverride = false)
        assertTrue(d.bindAll)
    }
}
