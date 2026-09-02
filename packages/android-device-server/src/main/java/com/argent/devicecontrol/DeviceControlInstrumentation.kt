package com.argent.devicecontrol

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import android.util.Log
import androidx.test.uiautomator.UiDevice
import java.util.concurrent.CountDownLatch

/**
 * Persistent on-device control server, launched by the host with
 * `adb shell am instrument -w com.argent.devicecontrol/.DeviceControlInstrumentation`.
 *
 * The host does NOT assume a fixed port. The server binds an ephemeral TCP port,
 * then reports it back through the instrumentation status channel as
 * `INSTRUMENTATION_STATUS: port=<n>`; the host greps that line and runs
 * `adb forward tcp:0 tcp:<n>` to reach it. This mirrors argent's
 * `native-devtools-android` handshake and avoids the `:9008`-in-use failures the
 * device-stream original hit when two servers raced for the same fixed port.
 *
 * Runs as a custom [Instrumentation] (single APK) rather than an androidTest +
 * JUnit runner, matching argent's `SnapshotInstrumentation` pattern so the install
 * gate ships exactly one APK.
 */
class DeviceControlInstrumentation : Instrumentation() {

    private companion object {
        const val TAG = "DeviceControl"
        // Any status code streams the bundle through `am instrument`; the host
        // only greps the `port=` line. START keeps AndroidJUnit-style tooling calm.
        const val STATUS_RUNNING = 1
    }

    @Volatile private var server: TCPServer? = null
    private val shutdownLatch = CountDownLatch(1)

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        // `start()` schedules onStart() on the instrumentation thread.
        start()
    }

    override fun onStart() {
        super.onStart()
        val uiDevice = UiDevice.getInstance(this)
        val uiAutomation = uiAutomation

        // Screen-graph Phase A: start the versioned tree store + AX-event listener
        // before serving requests, so the version clock is live from the first RPC.
        TreeStore.init(uiDevice, uiAutomation)

        val handler = JsonRpcHandler(uiDevice, uiAutomation, this) { requestShutdown() }
        // Port 0 → the OS picks a free port; we read the bound value below.
        val tcp = TCPServer(0, handler)
        tcp.start()
        server = tcp

        val port = tcp.boundPort
        Log.i(TAG, "Device control server listening on ephemeral port $port")

        // Handshake: report the bound port so the host can `adb forward tcp:0`.
        val status = Bundle().apply { putInt("port", port) }
        sendStatus(STATUS_RUNNING, status)

        // Block the instrumentation until a `shutdown` RPC (or process kill) ends it.
        try {
            shutdownLatch.await()
        } catch (_: InterruptedException) {
            Log.i(TAG, "Interrupted, shutting down")
        } finally {
            tcp.stop()
        }

        finish(Activity.RESULT_OK, Bundle())
    }

    private fun requestShutdown() {
        Log.i(TAG, "Shutdown requested")
        server?.stop()
        shutdownLatch.countDown()
    }
}
