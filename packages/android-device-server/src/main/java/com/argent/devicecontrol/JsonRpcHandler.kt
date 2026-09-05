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
     * The per-request result of [handle]: the response `line` to write, the parsed
     * `method` (null if parsing failed) that [TCPServer] keys [reportServerTiming] by,
     * and `padTo` — the phase 3j transport diagnostic's padding target (0 if absent /
     * not benchDebug). All three are RETURNED per call rather than stashed on shared
     * fields, so concurrent connections on the cached thread pool cannot read each
     * other's method / padTo (finding 14). Trailing padding whitespace after the JSON
     * object is ignored by the host `JSON.parse`, so it never changes the parsed reply.
     */
    data class HandleResult(val line: String, val method: String?, val padTo: Int)

    private data class ServerTiming(val handleMs: Double, val writeMs: Double, val totalMs: Double)

    // Per-method server-side timeline of the PREVIOUS request of that method, injected
    // into the next same-method response's `timings`. Shared by design (it carries
    // cross-request timing), so it is a thread-safe map: multiple connection threads
    // may report concurrently (finding 14).
    private val prevServerTiming = java.util.concurrent.ConcurrentHashMap<String, ServerTiming>()

    /**
     * Record the just-written request's server-side timeline (phase 3i), keyed by
     * method: `handleMs` = handler entry → response ready (t3 − t2), `writeMs` =
     * response write + flush (t4 − t3), `totalMs` = entry → flush (t4 − t2).
     * Surfaced on the NEXT same-method response.
     */
    fun reportServerTiming(method: String, handleMs: Double, writeMs: Double, totalMs: Double) {
        prevServerTiming[method] = ServerTiming(handleMs, writeMs, totalMs)
    }

    fun handle(line: String): HandleResult {
        val json: JSONObject
        val method: String
        try {
            json = JSONObject(line)
            method = json.getString("method")
        } catch (e: Exception) {
            return HandleResult(JsonRpc.errorResponse(null, -32700, "Parse error"), null, 0)
        }

        val id = json.opt("id")
        val params = json.optJSONObject("params") ?: JSONObject()
        // `_padTo` (transport padding diagnostic) is a bench-only debug param —
        // honored only when the server was started with `-e benchDebug true`. Local
        // to this call (finding 14) — TCPServer reads it off the returned HandleResult.
        val padTo = if (benchDebug) params.optInt("_padTo", 0) else 0

        Log.d(TAG, "method=$method id=$id")

        val bodyLine = try {
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
                else -> return HandleResult(
                    JsonRpc.errorResponse(id, -32601, "Method not found: $method"),
                    method,
                    padTo
                )
            }
            // Serialize-once splice payload (phase 3j), carried per-request on the
            // getState result object (finding 14): pull it off and REMOVE it so it
            // never ships, then splice it over the TREE_TOKEN placeholder below.
            var rawTree: String? = null
            if (result is JSONObject) {
                val r = result.opt(StateHandler.RAW_TREE_MEMBER)
                if (r is String) {
                    rawTree = r
                    result.remove(StateHandler.RAW_TREE_MEMBER)
                }
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
            // placeholder where the tree goes and carried the raw pre-serialized tree
            // on the result. Splice it in verbatim so the tree is encoded exactly once.
            // No-op on the legacy path (rawTree == null) and every other method — the
            // placeholder is absent, and replaceFirst leaves the string untouched when
            // the token is not found.
            if (method == "getState" && rawTree != null) {
                JsonRpc.spliceRawMember(body, StateHandler.TREE_TOKEN, rawTree)
            } else {
                body
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error executing $method", e)
            JsonRpc.errorResponse(id, -32603, e.message ?: "Internal error")
        }
        return HandleResult(bodyLine, method, padTo)
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

            // Recurse through the full handle() so each batched getState's tree is
            // spliced into its own sub-response (per-request; the raw-tree member is
            // removed there, never shipped). `.line` is that sub-response's JSON.
            val responseStr = handle(request.toString()).line
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
