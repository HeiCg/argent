package com.argent.devicecontrol

/**
 * On-device decision for the phase 3j redir transport: whether the server should
 * ALSO bind a `0.0.0.0` listener (so the emulator console's `redir` — which
 * connects to the guest's routable IP, not loopback — can reach it).
 *
 * The decision is made ON DEVICE from the qemu system properties, never from a
 * host env var: the env only arrives as [shouldBindAll]'s `argOverride` (a
 * CI/debug force) and is called out loudly by the caller. Physical devices keep
 * the loopback-only bind unless the override forces otherwise.
 *
 * Threat note: inside the guest the port is already reachable by other apps over
 * loopback; binding `0.0.0.0` on an EMULATOR additionally exposes it to qemu's
 * user-mode network, which the host reaches solely through hostfwd / `redir`
 * (there is no external NIC path to the guest). On real hardware that extra
 * exposure would be a routable interface, so the loopback-only bind is kept there.
 */
object EmulatorDetect {

    data class BindDecision(val bindAll: Boolean, val reason: String)

    /**
     * Whether to bind `0.0.0.0` in addition to loopback. Pure (no Android calls) so
     * a JVM unit test can pin it. `qemuKernel` is `ro.kernel.qemu`, `qemuBoot` is
     * `ro.boot.qemu`; an emulator sets `ro.kernel.qemu=1` (older AVDs) or a
     * non-empty `ro.boot.qemu` (newer). `argOverride` is the `-e bindAll true`
     * debug/CI force.
     */
    fun shouldBindAll(qemuKernel: String, qemuBoot: String, argOverride: Boolean): BindDecision {
        val isEmulator = qemuKernel.trim() == "1" || qemuBoot.trim().isNotEmpty()
        if (isEmulator) {
            return BindDecision(true, "emulator (ro.kernel.qemu='${qemuKernel.trim()}' ro.boot.qemu='${qemuBoot.trim()}')")
        }
        if (argOverride) {
            return BindDecision(true, "FORCED by bindAll debug override on a NON-emulator device")
        }
        return BindDecision(false, "loopback-only (physical device)")
    }

    /**
     * Read an Android system property via reflection (`android.os.SystemProperties`),
     * returning "" on any failure. Not unit-tested (the pure decision above is).
     */
    fun systemProperty(key: String): String {
        return try {
            val cls = Class.forName("android.os.SystemProperties")
            val get = cls.getMethod("get", String::class.java)
            (get.invoke(null, key) as? String) ?: ""
        } catch (_: Throwable) {
            ""
        }
    }
}
