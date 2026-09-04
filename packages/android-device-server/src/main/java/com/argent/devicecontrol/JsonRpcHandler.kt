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
    private val onShutdown: () -> Unit,
    // Phase 3j: bench-only debug params (`_padTo`, `_benchLegacyEncode`) are honored
    // ONLY when the server was started with `-e benchDebug true`. Off in production,
    // so a crafted request can never reach the padding / legacy-encode paths.
    private val benchDebug: Boolean = false
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
    private val stateHandler = StateHandler(uiDevice, uiAutomation, instrumentation, benchDebug)
    private val waitHandler = WaitHandler(uiDevice)
    private val openAppHandler = OpenAppHandler(instrumentation)

    /**
     * The method of the last request [handle] parsed, or null if parsing failed.
     * [TCPServer] reads it after writing the response to key [reportServerTiming]
     * by method — a response cannot carry the cost of writing itself (phase 3i).
     */
    var lastHandledMethod: String? = null
        private set

    /**
     * The `_padTo` of the last request [handle] parsed (0 if absent). Phase 3j
     * transport diagnostic: [TCPServer] pads the response line with trailing spaces
     * to the next multiple of this many UTF-8 bytes before the newline, to test
     * whether a full-MSS-aligned reply escapes the ~40 ms delayed-ACK stall on the
     * last partial segment. Trailing whitespace after the JSON object is ignored by
     * the host `JSON.parse`, so it never changes the parsed reply.
     */
    var lastPadTo: Int = 0
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
        lastPadTo = 0
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
        // `_padTo` (transport padding diagnostic) is a bench-only debug param —
        // honored only when the server was started with `-e benchDebug true`.
        lastPadTo = if (benchDebug) params.optInt("_padTo", 0) else 0

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
            val body = JsonRpc.successResponse(id, result)
            // Serialize-once splice (phase 3j): getState's default path put a
            // placeholder where the tree goes and exposed the raw pre-serialized tree
            // on the handler. Splice it in verbatim so the tree is encoded exactly
            // once. No-op on the legacy path (lastTreeJson == null) and every other
            // method — the placeholder is absent, and replaceFirst leaves the string
            // untouched when the token is not found.
            val raw = stateHandler.lastTreeJson
            if (method == "getState" && raw != null) {
                JsonRpc.spliceRawMember(body, StateHandler.TREE_TOKEN, raw)
            } else {
                body
            }
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
