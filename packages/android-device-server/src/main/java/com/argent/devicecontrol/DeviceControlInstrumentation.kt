package com.argent.devicecontrol

import android.accessibilityservice.AccessibilityServiceInfo
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
    // Optional 0.0.0.0 listener for the phase 3j redir experiment (gated by bindAll).
    @Volatile private var allServer: TCPServer? = null
    // Instrumentation args captured in onCreate (onStart has no access to them).
    private var startArgs: Bundle? = null
    private val shutdownLatch = CountDownLatch(1)

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        startArgs = arguments
        // `start()` schedules onStart() on the instrumentation thread.
        start()
    }

    override fun onStart() {
        super.onStart()
        val uiDevice = UiDevice.getInstance(this)
        val uiAutomation = uiAutomation

        // Enable the interactive-windows API so `uiAutomation.windows` is populated
        // and the active window's root can be read from that snapshot instead of via
        // `rootInActiveWindow`, which blocks ~170-210 ms mid-transition (phase 3g
        // bench). FLAG_REPORT_VIEW_IDS keeps resource-id view ids on serialized
        // nodes. UiAutomator may already set these; the OR is a no-op if so.
        try {
            val info = uiAutomation.serviceInfo
            if (info != null) {
                info.flags = info.flags or
                    AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
                    AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                uiAutomation.serviceInfo = info
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not set UiAutomation service flags", e)
        }

        val handler = JsonRpcHandler(uiDevice, uiAutomation, this) { requestShutdown() }
        // Port 0 → the OS picks a free port; we read the bound value below.
        val tcp = TCPServer(0, handler)
        tcp.start()
        server = tcp

        val port = tcp.boundPort
        Log.i(TAG, "Device control server listening on ephemeral port $port")

        // Phase 3j redir experiment (gated by `-e bindAll true`): also bind a second
        // listener on 0.0.0.0 so the emulator console `redir add tcp:h:allPort` — which
        // connects to the guest's routable IP, not loopback — can reach the server, and
        // the host can measure that transport against `adb forward`. Its own handler so
        // its per-request state never interleaves with the loopback one's (the host uses
        // one transport at a time). Off by default; never exposed in normal operation.
        var allPort = -1
        val bindAll = startArgs?.getString("bindAll") == "true"
        if (bindAll) {
            try {
                val allHandler = JsonRpcHandler(uiDevice, uiAutomation, this) { requestShutdown() }
                val tcpAll = TCPServer(0, allHandler, "0.0.0.0")
                tcpAll.start()
                allServer = tcpAll
                allPort = tcpAll.boundPort
                Log.i(TAG, "Device control server ALSO listening on 0.0.0.0:$allPort (bindAll)")
            } catch (e: Exception) {
                Log.w(TAG, "Could not start bindAll listener", e)
            }
        }

        // Handshake. Send `allPort` FIRST (its own status) when present, so the host
        // has captured it by the time the `port=` line — the one it greps to trigger
        // the `adb forward` + connect — arrives (phase 3j redir experiment).
        if (allPort > 0) {
            sendStatus(STATUS_RUNNING, Bundle().apply { putInt("allPort", allPort) })
        }
        // Report the bound port so the host can `adb forward tcp:0`.
        sendStatus(STATUS_RUNNING, Bundle().apply { putInt("port", port) })

        // Block the instrumentation until a `shutdown` RPC (or process kill) ends it.
        try {
            shutdownLatch.await()
        } catch (_: InterruptedException) {
            Log.i(TAG, "Interrupted, shutting down")
        } finally {
            tcp.stop()
            allServer?.stop()
        }

        finish(Activity.RESULT_OK, Bundle())
    }

    private fun requestShutdown() {
        Log.i(TAG, "Shutdown requested")
        server?.stop()
        allServer?.stop()
        shutdownLatch.countDown()
    }
}
