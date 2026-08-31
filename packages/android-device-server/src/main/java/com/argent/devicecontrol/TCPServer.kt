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
            val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
            val writer = OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8)

            var line: String?
            while (reader.readLine().also { line = it } != null) {
                val trimmed = line!!.trim()
                if (trimmed.isEmpty()) continue

                val response = handler.handle(trimmed)
                writer.write(response)
                writer.write("\n")
                writer.flush()
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
