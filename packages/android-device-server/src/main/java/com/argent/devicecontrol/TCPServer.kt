package com.argent.devicecontrol

import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors

/**
 * TCP server accepting newline-delimited JSON-RPC 2.0 messages. Each line is a
 * complete request; the response is a single JSON line + `\n`.
 *
 * Bind [port] `0` to let the OS pick a free port — read the actual value from
 * [boundPort] after [start]. Listens on loopback only: the host reaches it over
 * `adb forward`, so there is no reason to expose it on the device's network
 * interfaces.
 */
class TCPServer(
    private val port: Int,
    private val handler: JsonRpcHandler
) {
    private companion object {
        const val TAG = "TCPServer"
    }

    private var serverSocket: ServerSocket? = null
    private val executor = Executors.newCachedThreadPool()
    @Volatile private var running = false

    /** Actual bound port, valid after [start]; -1 before. */
    val boundPort: Int
        get() = serverSocket?.localPort ?: -1

    fun start() {
        running = true
        // backlog 50, bound to loopback.
        serverSocket = ServerSocket(port, 50, InetAddress.getByName("127.0.0.1"))
        Log.i(TAG, "Listening on 127.0.0.1:${serverSocket?.localPort}")

        executor.submit {
            while (running) {
                try {
                    val client = serverSocket?.accept() ?: break
                    Log.i(TAG, "New connection from ${client.remoteSocketAddress}")
                    executor.submit { handleConnection(client) }
                } catch (e: Exception) {
                    if (running) Log.e(TAG, "Accept error", e)
                }
            }
        }
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        executor.shutdownNow()
    }

    private fun handleConnection(socket: Socket) {
        try {
            // Disable Nagle on the accepted socket (phase 3i). The host client already
            // sets TCP_NODELAY (android-open-server-client.ts), but the reply side was
            // still Nagling: each describe reply is one small `\n`-terminated line, and
            // with Nagle on the server can hold it ~40 ms waiting to coalesce with a
            // (never-coming) next write or the previous segment's ACK, inflating the
            // idle-describe round-trip over `adb forward`. `flush()` alone does not
            // defeat Nagle; TCP_NODELAY does. Best-effort: a failure here must not drop
            // the connection.
            try {
                socket.tcpNoDelay = true
            } catch (e: Exception) {
                Log.w(TAG, "Could not set TCP_NODELAY on accepted socket", e)
            }
            val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
            val writer = OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8)

            var line: String?
            while (reader.readLine().also { line = it } != null) {
                val trimmed = line!!.trim()
                if (trimmed.isEmpty()) continue

                // Phase 3i timeline: t2 = handler entry (arrival), t3 = response
                // ready, t4 = response written + flushed. readLine already returned
                // (bytes delivered), so t2 is arrival with no pre-handler queue on
                // this single-connection thread. The write+flush span (t4 − t3) is
                // the 31 KB reply cost; reported back for the NEXT same-method reply.
                val t2 = System.nanoTime()
                val response = handler.handle(trimmed)
                val t3 = System.nanoTime()
                writer.write(response)
                writer.write("\n")
                writer.flush()
                val t4 = System.nanoTime()
                handler.lastHandledMethod?.let { m ->
                    handler.reportServerTiming(
                        m,
                        (t3 - t2) / 1_000_000.0,
                        (t4 - t3) / 1_000_000.0,
                        (t4 - t2) / 1_000_000.0
                    )
                }
            }
        } catch (e: Exception) {
            if (running) Log.e(TAG, "Connection error", e)
        } finally {
            try {
                socket.close()
            } catch (_: Exception) {
            }
            Log.i(TAG, "Connection closed")
        }
    }
}
