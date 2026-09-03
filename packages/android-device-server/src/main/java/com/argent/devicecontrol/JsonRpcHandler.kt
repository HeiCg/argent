package com.argent.devicecontrol

import android.app.Instrumentation
import android.app.UiAutomation
import android.util.Log
import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.handlers.ClipboardHandler
import com.argent.devicecontrol.handlers.FlushInputHandler
import com.argent.devicecontrol.handlers.GestureHandler
import com.argent.devicecontrol.handlers.HierarchyHandler
import com.argent.devicecontrol.handlers.InfoHandler
import com.argent.devicecontrol.handlers.KeyHandler
import com.argent.devicecontrol.handlers.LongPressHandler
import com.argent.devicecontrol.handlers.OpenAppHandler
import com.argent.devicecontrol.handlers.ScreenshotHandler
import com.argent.devicecontrol.handlers.StateHandler
import com.argent.devicecontrol.handlers.SwipeHandler
import com.argent.devicecontrol.handlers.TapHandler
import com.argent.devicecontrol.handlers.TypeHandler
import com.argent.devicecontrol.handlers.WaitHandler
import com.argent.devicecontrol.util.JsonRpc
import org.json.JSONArray
import org.json.JSONObject

/**
 * Parses JSON-RPC 2.0 requests, dispatches to action handlers, and returns
 * JSON-RPC responses. One request per line; the caller serialises requests so a
 * single UiAutomation thread is never contended.
 *
 * @param onShutdown invoked by the `shutdown` method so the host can ask the
 * instrumentation to exit cleanly instead of force-killing `am instrument`.
 */
class JsonRpcHandler(
    uiDevice: UiDevice,
    uiAutomation: UiAutomation,
    instrumentation: Instrumentation,
    private val onShutdown: () -> Unit
) {
    private companion object {
        const val TAG = "JsonRpcHandler"
    }

    private val tapHandler = TapHandler(uiAutomation)
    private val swipeHandler = SwipeHandler(uiDevice, uiAutomation)
    private val gestureHandler = GestureHandler(uiAutomation)
    private val flushInputHandler = FlushInputHandler(uiAutomation)
    private val typeHandler = TypeHandler(instrumentation, uiDevice)
    private val clipboardHandler = ClipboardHandler(instrumentation)
    private val longPressHandler = LongPressHandler(uiDevice)
    private val keyHandler = KeyHandler(uiDevice)
    private val screenshotHandler = ScreenshotHandler(uiAutomation)
    private val hierarchyHandler = HierarchyHandler(uiDevice, uiAutomation)
    private val infoHandler = InfoHandler(instrumentation, uiAutomation)
    private val stateHandler = StateHandler(uiDevice, uiAutomation, instrumentation)
    private val waitHandler = WaitHandler(uiDevice)
    private val openAppHandler = OpenAppHandler(instrumentation)

    /**
     * The method of the last request [handle] parsed, or null if parsing failed.
     * [TCPServer] reads it after writing the response to key [reportServerTiming]
     * by method — a response cannot carry the cost of writing itself (phase 3i).
     */
    var lastHandledMethod: String? = null
        private set

    private data class ServerTiming(val handleMs: Double, val writeMs: Double, val totalMs: Double)

    // Per-method server-side timeline of the PREVIOUS request of that method,
    // injected into the next same-method response's `timings`. Single connection
    // thread, so no synchronisation is needed.
    private val prevServerTiming = HashMap<String, ServerTiming>()

    /**
     * Record the just-written request's server-side timeline (phase 3i), keyed by
     * method: `handleMs` = handler entry → response ready (t3 − t2), `writeMs` =
     * response write + flush (t4 − t3), `totalMs` = entry → flush (t4 − t2).
     * Surfaced on the NEXT same-method response.
     */
    fun reportServerTiming(method: String, handleMs: Double, writeMs: Double, totalMs: Double) {
        prevServerTiming[method] = ServerTiming(handleMs, writeMs, totalMs)
    }

    fun handle(line: String): String {
        lastHandledMethod = null
        val json: JSONObject
        val method: String
        try {
            json = JSONObject(line)
            method = json.getString("method")
        } catch (e: Exception) {
            return JsonRpc.errorResponse(null, -32700, "Parse error")
        }
        lastHandledMethod = method

        val id = json.opt("id")
        val params = json.optJSONObject("params") ?: JSONObject()

        Log.d(TAG, "method=$method id=$id")

        return try {
            val result: Any = when (method) {
                "tap" -> tapHandler.execute(params)
                "longPress" -> longPressHandler.execute(params)
                "swipe" -> swipeHandler.execute(params)
                "gesture" -> gestureHandler.execute(params)
                "flushInput" -> flushInputHandler.execute(params)
                "typeText" -> typeHandler.execute(params)
                "setClipboard" -> clipboardHandler.execute(params)
                "key" -> keyHandler.execute(params)
                "screenshot" -> screenshotHandler.execute(params)
                "getAccessibilityTree" -> hierarchyHandler.execute(params)
                "getInfo" -> infoHandler.execute()
                "getScreenSize" -> infoHandler.screenSize()
                "getState" -> stateHandler.execute(params)
                "waitForIdle" -> waitHandler.execute(params)
                "launchApp" -> openAppHandler.execute(params)
                "ping" -> JSONObject().apply { put("status", "ok") }
                "batch" -> executeBatch(params)
                "shutdown" -> {
                    onShutdown()
                    JSONObject().apply { put("status", "ok") }
                }
                else -> return JsonRpc.errorResponse(id, -32601, "Method not found: $method")
            }
            // Phase 3i: fold the PREVIOUS same-method request's server-side timeline
            // into this response's `timings` (a response cannot time its own write).
            if (result is JSONObject) {
                val t = result.optJSONObject("timings")
                if (t != null) {
                    prevServerTiming[method]?.let { prev ->
                        t.put("prevServerHandleMs", prev.handleMs)
                        t.put("prevServerWriteMs", prev.writeMs)
                        t.put("prevServerTotalMs", prev.totalMs)
                    }
                }
            }
            JsonRpc.successResponse(id, result)
        } catch (e: Exception) {
            Log.e(TAG, "Error executing $method", e)
            JsonRpc.errorResponse(id, -32603, e.message ?: "Internal error")
        }
    }

    private fun executeBatch(params: JSONObject): JSONObject {
        val actions = params.optJSONArray("actions")
            ?: throw IllegalArgumentException("Missing 'actions' array")

        val results = JSONArray()
        for (i in 0 until actions.length()) {
            val action = actions.getJSONObject(i)
            val method = action.getString("method")
            val actionParams = action.optJSONObject("params") ?: JSONObject()

            val request = JSONObject().apply {
                put("jsonrpc", "2.0")
                put("method", method)
                put("params", actionParams)
                put("id", 0)
            }

            val responseStr = handle(request.toString())
            try {
                val responseJson = JSONObject(responseStr)
                if (responseJson.has("result")) {
                    results.put(responseJson.get("result"))
                } else if (responseJson.has("error")) {
                    results.put(JSONObject().apply { put("error", responseJson.get("error")) })
                }
            } catch (_: Exception) {
                results.put(JSONObject().apply { put("error", "Failed to parse response") })
            }
        }
        return JSONObject().apply { put("results", results) }
    }
}
