package com.argent.devicecontrol

import android.app.Instrumentation
import android.app.UiAutomation
import android.util.Log
import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.handlers.AwaitChangeHandler
import com.argent.devicecontrol.handlers.ClipboardHandler
import com.argent.devicecontrol.handlers.DiffHandler
import com.argent.devicecontrol.handlers.GestureHandler
import com.argent.devicecontrol.handlers.HierarchyHandler
import com.argent.devicecontrol.handlers.InfoHandler
import com.argent.devicecontrol.handlers.KeyHandler
import com.argent.devicecontrol.handlers.LongPressHandler
import com.argent.devicecontrol.handlers.OpenAppHandler
import com.argent.devicecontrol.handlers.QueryHandler
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
    private val queryHandler = QueryHandler()
    private val diffHandler = DiffHandler()
    private val awaitChangeHandler = AwaitChangeHandler()

    fun handle(line: String): String {
        val json: JSONObject
        val method: String
        try {
            json = JSONObject(line)
            method = json.getString("method")
        } catch (e: Exception) {
            return JsonRpc.errorResponse(null, -32700, "Parse error")
        }

        val id = json.opt("id")
        val params = json.optJSONObject("params") ?: JSONObject()

        Log.d(TAG, "method=$method id=$id")

        return try {
            val result: Any = when (method) {
                "tap" -> runAction(params) { tapHandler.execute(params) }
                "longPress" -> runAction(params) { longPressHandler.execute(params) }
                "swipe" -> runAction(params) { swipeHandler.execute(params) }
                "gesture" -> runAction(params) { gestureHandler.execute(params) }
                "typeText" -> runAction(params) { typeHandler.execute(params) }
                "setClipboard" -> clipboardHandler.execute(params)
                "key" -> runAction(params) { keyHandler.execute(params) }
                "screenshot" -> screenshotHandler.execute(params)
                "getAccessibilityTree" -> hierarchyHandler.execute(params)
                "getInfo" -> infoHandler.execute()
                "getScreenSize" -> infoHandler.screenSize()
                "getState" -> stateHandler.execute(params)
                "query" -> queryHandler.execute(params)
                "diff" -> diffHandler.execute(params)
                "awaitChange" -> awaitChangeHandler.execute(params)
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
            JsonRpc.successResponse(id, result)
        } catch (e: Exception) {
            Log.e(TAG, "Error executing $method", e)
            JsonRpc.errorResponse(id, -32603, e.message ?: "Internal error")
        }
    }

    /**
     * Screen-graph Phase A action outcomes with the Phase A.1 settle heuristic
     * (ticket §2). When a `tap`/`swipe`/… call carries an
     * `outcome { firstEventTimeoutMs?, quietMs?, idleTimeoutMs? }` object, capture
     * the fingerprint before the action, run it, then settle in two phases:
     *
     *  1. wait up to `firstEventTimeoutMs` (default 600) for the FIRST AX event
     *     the action causes. If none arrives, the UI didn't move: report
     *     `changed:false`, `settled:'no-event'`, `after == before`.
     *  2. otherwise wait for the AX clock to go quiet (no event for `quietMs`,
     *     default 80), bounded by `idleTimeoutMs` (default 1500 — phase 1 is
     *     bounded separately), reporting `settled:'quiet'|'timeout'`.
     *
     * If the settled tree is a transient empty frame (0 nodes / [TreeStore.EMPTY_TREE_HASH]),
     * keep waiting up to `idleTimeoutMs` for a non-empty tree before hashing `after`.
     * The result carries `{ before, after, changed, newScreen, settled,
     * firstEventMs, idleMs }`. Without `outcome`, behaviour is unchanged.
     */
    private fun runAction(params: JSONObject, action: () -> JSONObject): JSONObject {
        val outcome = params.optJSONObject("outcome") ?: return action()
        val firstEventTimeoutMs = outcome.optLong("firstEventTimeoutMs", 600L)
        val quietMs = outcome.optLong("quietMs", 80L)
        val idleTimeoutMs = outcome.optLong("idleTimeoutMs", 1500L)

        val before = TreeStore.ensure()
        val fromVersion = TreeStore.version
        val res = action()

        val settle = TreeStore.settleAfterAction(fromVersion, firstEventTimeoutMs, quietMs, idleTimeoutMs)
        val after = if (settle.settled == "no-event") {
            // No AX event after the action: the UI is unchanged, so `after` is the
            // pre-action snapshot (changed:false, newScreen:false fall out below).
            before
        } else {
            var a = TreeStore.ensure()
            if (a.roots.isEmpty() || a.hash == TreeStore.EMPTY_TREE_HASH) {
                a = TreeStore.awaitNonEmptyTree(idleTimeoutMs)
            }
            a
        }

        val changed = before.hash != after.hash || before.stateHash != after.stateHash
        res.put("before", fingerprintOf(before))
        res.put("after", fingerprintOf(after))
        res.put("changed", changed)
        res.put("newScreen", before.hash != after.hash)
        res.put("settled", settle.settled)
        res.put("firstEventMs", settle.firstEventMs)
        res.put("idleMs", settle.idleMs)
        return res
    }

    private fun fingerprintOf(snap: TreeStore.Snapshot): JSONObject =
        JSONObject().apply {
            put("version", snap.version)
            put("hash", snap.hash)
            put("stateHash", snap.stateHash)
            put("idHash", snap.idHash)
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
