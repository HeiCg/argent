package com.argent.devicecontrol.handlers

import android.app.Instrumentation
import android.app.UiAutomation
import android.graphics.Bitmap
import android.util.Base64
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.accessibility.NestedWindowSerializer
import com.argent.devicecontrol.accessibility.WindowTimings
import com.argent.devicecontrol.accessibility.NodeSerializer
import com.argent.devicecontrol.input.MotionInjector
import com.argent.devicecontrol.util.DisplayReader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Combined state capture: waitForIdle + screenshot + hierarchy + info.
 * Single RPC call replaces multiple round-trips.
 */
class StateHandler(
    private val uiDevice: UiDevice,
    private val uiAutomation: UiAutomation,
    private val instrumentation: Instrumentation,
    // Phase 3j: honor the bench-only `_benchLegacyEncode` toggle ONLY when the server
    // was started with `-e benchDebug true`. Off in production.
    private val benchDebug: Boolean = false
) {

    private val context get() = instrumentation.context

    companion object {
        // Placeholder the serialize-once path (phase 3j) puts in place of the tree.
        // JsonRpcHandler splices the raw pre-serialized tree JSON over
        // `"<TREE_TOKEN>"` in the finished response, so the tree is encoded exactly
        // once (the old successResponse re-serialize is gone). Distinctive and
        // underscore-bearing so it cannot collide with base64 screenshot data,
        // package names, or numbers elsewhere in the envelope.
        const val TREE_TOKEN = "__ARGENT_RAW_TREE_9f83c1__"
    }

    /**
     * Raw, pre-serialized tree JSON for the last [execute] on the serialize-once
     * path, or null on the legacy path / before the first call. [JsonRpcHandler]
     * reads it immediately after `execute` to splice it into the response. Requests
     * run serially on one connection thread, so no synchronisation is needed.
     */
    var lastTreeJson: String? = null
        private set

    fun execute(params: JSONObject): JSONObject {
        // Cleared each call so a stale value from a previous getState can never be
        // spliced if this one takes the legacy path or throws.
        lastTreeJson = null
        val quality = params.optInt("quality", 80)
        val scale = params.optDouble("scale", 1.0).toFloat()
        val maxElements = params.optInt("maxElements", 50)
        val waitTimeoutMs = params.optLong("waitTimeoutMs", 1000)
        // `nested` (F12): return the full multi-window nested tree — the SAME shape
        // `getAccessibilityTree({ nested: true })` returns — so the await-*/describe
        // poll path runs the identical host-side v2 trim the describe tool runs, and
        // their label sets / id forms match. A nested capture never includes a
        // screenshot (the poll loops don't read it).
        val nested = params.optBoolean("nested", false)
        // The describe-tree poll loops (await-screen-idle / await-ui-element) want
        // the idle+tree+info in one round-trip but never read the screenshot;
        // skipping the capture makes getState a strict latency win for them
        // instead of paying a full-frame JPEG encode on every poll.
        val includeScreenshot = !nested && params.optBoolean("includeScreenshot", true)
        // `flush` (phase 3f): the caller injected a scrcpy fast-inject touch from a
        // separate process this UiAutomation cannot see, so `drainAsyncUp` would
        // no-op. When set, run the full synchronous input-queue flush inline here
        // instead — it orders every touch enqueued ahead of it (scrcpy's included)
        // before the capture below, so the tree is never the mid-press state. Folded
        // into this read so fast-inject costs no extra `flushInput` round-trip.
        val flush = params.optBoolean("flush", false)
        // Phase 3j: drop the trim-discarded nodes before serializing (describe /
        // getNestedState pass compact:true; a raw `getAccessibilityTree` dump leaves
        // it false). Only the nested path honours it. See NodeSerializer.serializeNested.
        val compact = params.optBoolean("compact", false)
        // Phase 3j before/after toggle: force the OLD double-encode (serialize the
        // tree once to time encodeMs, discard it, then let successResponse
        // re-serialize the whole tree) so the bench can measure legacy vs
        // serialize-once IN THE SAME RUN. Bench-only: honored only under
        // `benchDebug` (server started with `-e benchDebug true`). Default false =
        // the single-pass path (always, in production).
        val legacyEncode = benchDebug && params.optBoolean("_benchLegacyEncode", false)

        // 0. Order any preceding touch's UP ahead of the capture. Fast-inject path
        //    (flush=true) drains the whole input queue synchronously; the default
        //    path drains only this server's own async ACTION_UP (R1, phase 3e). Both
        //    are idle-wait-free and no-op when nothing is outstanding.
        if (flush) {
            MotionInjector.flushInput(uiAutomation)
        } else {
            MotionInjector.drainAsyncUp(uiAutomation)
        }

        // 1. Explicit idle wait (the caller owns the timeout; the describe path
        //    passes 500 to match the proprietary comparator's cap). This is the ONLY
        //    idle gate on the path — the info block below reads geometry/package
        //    without any UiDevice getter that would trigger a second, hidden one.
        val waitStart = System.currentTimeMillis()
        uiDevice.waitForIdle(waitTimeoutMs)
        val waitedMs = System.currentTimeMillis() - waitStart

        // captureMs isolates the post-idle capture cost (screenshot + tree + info)
        // from the idle wait above, so the host can report the idle-vs-capture split.
        val captureStart = System.currentTimeMillis()

        // 2. Screenshot
        val bitmap = if (includeScreenshot) uiAutomation.takeScreenshot() else null
        val screenshotBase64 = if (bitmap != null) {
            val scaledBitmap = if (scale < 1.0f) {
                val w = (bitmap.width * scale).toInt()
                val h = (bitmap.height * scale).toInt()
                Bitmap.createScaledBitmap(bitmap, w, h, true).also {
                    if (it !== bitmap) bitmap.recycle()
                }
            } else {
                bitmap
            }
            val stream = ByteArrayOutputStream()
            scaledBitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream)
            scaledBitmap.recycle()
            Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
        } else {
            ""
        }

        // 3. Hierarchy — nested multi-window tree (F12) or the flat compressed list.
        //    Capture the active package from the SAME root we serialize, before it
        //    is recycled, so `info` below never calls uiDevice.currentPackageName
        //    (a waitForIdle caller).
        //    Per-stage timings (phase 3g) attribute the after-tap captureMs:
        //    `rootMs` is the active-root read, the rest come from the multi-window
        //    serializer. The root comes from the interactive-windows snapshot
        //    (`windows.firstOrNull { it.isActive }?.root`) rather than
        //    `rootInActiveWindow`, which blocks ~170-210 ms mid-transition (phase 3g
        //    bench); `timings.rootSource` records which path served it.
        val windowTimings = WindowTimings()
        val rootStart = System.currentTimeMillis()
        val resolved = NestedWindowSerializer.activeRoot(uiAutomation)
        val rootNode = resolved.root
        val rootMs = System.currentTimeMillis() - rootStart
        val activePackage = rootNode?.packageName?.toString() ?: ""
        var serializeMsFlat = 0L
        val hierarchy = if (rootNode != null) {
            try {
                if (nested) {
                    NestedWindowSerializer.serialize(uiAutomation, rootNode, maxOf(maxElements, 3000), windowTimings, compact)
                } else {
                    val t0 = System.currentTimeMillis()
                    val flat = NodeSerializer.serialize(rootNode, maxElements)
                    serializeMsFlat = System.currentTimeMillis() - t0
                    flat
                }
            } finally {
                rootNode.recycle()
            }
        } else {
            JSONArray()
        }
        // No separate window-list fallback for the package: `activeRoot` above
        // already reads the active window from the interactive-windows snapshot
        // before falling back to rootInActiveWindow, so a null root here means
        // neither path had one.

        // 4. Info — geometry from one idle-free Display snapshot, package from the
        //    accessibility root above; never a UiDevice getter that waits for idle.
        val geo = DisplayReader.read(context)
        val info = JSONObject().apply {
            put("screenWidth", geo.width)
            put("screenHeight", geo.height)
            put("currentPackage", activePackage)
            put("keyboardVisible", isKeyboardVisible())
            put("displayRotation", geo.rotation)
        }

        // encodeMs: the cost of serializing the tree to its JSON wire form.
        // Serialize-once (phase 3j): on the default path this is the ONLY tree
        // serialization — the resulting string is spliced verbatim into the response
        // by JsonRpcHandler, so successResponse never re-encodes the tree (the old
        // ~27 ms second pass is gone) and `encodeMs` now measures the single pass
        // whose output actually ships. The legacy toggle reproduces the old
        // throwaway-then-re-encode so the bench can A/B both in one run.
        val encStart = System.currentTimeMillis()
        val treeValue: Any
        if (legacyEncode) {
            hierarchy.toString() // throwaway pass (measured, discarded — old behavior)
            lastTreeJson = null // no splice: successResponse re-serializes `hierarchy`
            treeValue = hierarchy
        } else {
            lastTreeJson = hierarchy.toString() // the single serialization pass
            treeValue = TREE_TOKEN // placeholder; JsonRpcHandler splices the tree in
        }
        val encodeMs = System.currentTimeMillis() - encStart

        val captureMs = System.currentTimeMillis() - captureStart

        val timings = JSONObject().apply {
            put("idleMs", waitedMs)
            put("rootMs", rootMs)
            put("windowsMs", windowTimings.windowsMs)
            put("rootsMs", JSONArray(windowTimings.rootsMs))
            put("serializeMs", if (nested) windowTimings.serializeMs else serializeMsFlat)
            put("encodeMs", encodeMs)
            put("rootSource", resolved.source)
        }

        return JSONObject().apply {
            put("screenshot", screenshotBase64)
            put("tree", treeValue)
            put("info", info)
            put("waitedMs", waitedMs)
            put("captureMs", captureMs)
            put("timings", timings)
        }
    }

    private fun isKeyboardVisible(): Boolean {
        return try {
            uiAutomation.windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
        } catch (_: Exception) {
            false
        }
    }
}
