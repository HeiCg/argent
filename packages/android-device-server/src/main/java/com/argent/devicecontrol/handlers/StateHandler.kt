package com.argent.devicecontrol.handlers

import android.app.Instrumentation
import android.app.UiAutomation
import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Base64
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.TreeStore
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

        // Transient member carrying the raw pre-serialized tree JSON on the serialize-
        // once path (phase 3j). [execute] attaches it to the result it RETURNS, and
        // [JsonRpcHandler] removes it (so it never ships) and splices it over the
        // [TREE_TOKEN] placeholder. Per-REQUEST state (finding 14): the previous
        // instance field `lastTreeJson` was shared across the cached thread pool, so
        // two concurrent getState calls on separate connections could splice the wrong
        // tree — or ship the literal token — since one execute() overwrote the other's
        // field between execute and the splice. Carrying it on the per-call result
        // object removes the shared field entirely.
        const val RAW_TREE_MEMBER = "__argentRawTreeJson__"
    }

    fun execute(params: JSONObject): JSONObject {
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
        // Screen-graph Phase A: when the caller passes the version it last saw and
        // nothing has changed, the caller already holds the tree; `unchanged` in the
        // response lets it short-circuit re-reading the body.
        val sinceVersion = params.optLong("sinceVersion", -1L)
        // The describe-tree poll loops (await-screen-idle / await-ui-element) want
        // the idle+tree+info in one round-trip but never read the screenshot;
        // skipping the capture makes getState a strict latency win for them
        // instead of paying a full-frame JPEG encode on every poll.
        val includeScreenshot = !nested && params.optBoolean("includeScreenshot", true)
        // `flush` (phase 3f): the caller injected an out-of-band touch from a
        // separate process this UiAutomation cannot see, so `drainAsyncUp` would
        // no-op. When set, run the full synchronous input-queue flush inline here
        // instead — it orders every touch enqueued ahead of it
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
        // Phase 3m: fingerprints (`hash` / `stateHash` / `idHash` / `unchanged`) are
        // OPT-IN. The screen-graph host wiring passes `fingerprints: true` (or a
        // `sinceVersion`, which needs them); the plain describe / latency path does
        // not, so the capture never forces a `TreeStore.ensure()` rebuild (the C1
        // after-tap `rootInActiveWindow` block) and the process never arms the AX
        // event listener (the C2 always-on tax). `version` is ALWAYS returned (a
        // free volatile read); an absent hash means "not requested", never "empty".
        val hasSinceVersion = params.has("sinceVersion")
        val wantFingerprints = params.optBoolean("fingerprints", false) || hasSinceVersion
        // Arming the clock is what makes `version` advance; only callers that read
        // versions/fingerprints pay for it (lazy, idempotent).
        if (wantFingerprints) TreeStore.armClock()

        // Phase 3m.1 (3M-H4): the reported `version` must describe the SAME tree as
        // the reply — read the AX clock ONCE here, BEFORE the capture, never a live
        // volatile read after it. A post-capture read can be newer than the tree the
        // reply carries (an AX event landed during the ~400 ms capture), so a later
        // `sinceVersion == that` would falsely report `unchanged` and the host would
        // never learn about the change it never saw. When fingerprints are computed
        // the authoritative version is the snapshot's own (`fpSnap.version`, read
        // under the build lock with the hash), which cannot disagree with the hash.
        // While the clock is UNARMED `version` is meaningless (pinned at 0) and is
        // reported ABSENT — never overloaded with 0, which a host could store and
        // later replay as `sinceVersion: 0` to get a spurious `unchanged: true`.
        val clockArmedAtCapture = TreeStore.isClockArmed()
        val versionAtCapture = TreeStore.version

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
        // Phase 3n.2 (review 3N1-L2): every stage clock in this capture — and
        // `captureMs` itself — uses SystemClock.uptimeMillis(), the SAME monotonic
        // clock NestedWindowSerializer already uses for windowsMs/rootsMs/serializeMs.
        // Mixing currentTimeMillis (wall, NTP-steppable) with the serializer's
        // uptimeMillis on either side of a 1 ms-resolution residual subtraction added
        // avoidable noise to the stage-accounting gate; a single clock makes
        // `otherMs = captureMs − Σ(stages)` exact.
        val waitStart = SystemClock.uptimeMillis()
        uiDevice.waitForIdle(waitTimeoutMs)
        val waitedMs = SystemClock.uptimeMillis() - waitStart

        // captureMs isolates the post-idle capture cost (screenshot + tree + info)
        // from the idle wait above, so the host can report the idle-vs-capture split.
        val captureStart = SystemClock.uptimeMillis()

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

        // 3. Hierarchy — the nested raw multi-window tree (F12 token parity, its own
        //    traversal for raw class names/ids) or the flat compressed list. Capture
        //    the active package from the SAME accessibility root we serialize, before
        //    it is recycled, so `info` below never calls uiDevice.currentPackageName
        //    (a waitForIdle caller).
        //    Per-stage timings (phase 3g) attribute the after-tap captureMs: `rootMs`
        //    is the active-root read, the rest come from the multi-window serializer.
        //    The root comes from the interactive-windows snapshot rather than
        //    `rootInActiveWindow`, which blocks ~170-210 ms mid-transition (phase 3g
        //    bench); `timings.rootSource` records which path served it.
        val windowTimings = WindowTimings()
        val rootStart = SystemClock.uptimeMillis()
        val resolved = NestedWindowSerializer.activeRoot(uiAutomation)
        val rootNode = resolved.root
        val rootMs = SystemClock.uptimeMillis() - rootStart
        val activePackage = rootNode?.packageName?.toString() ?: ""
        var serializeMsFlat = 0L
        // Screen-graph Phase A: the flat compressed list can be cut short by
        // `maxElements`; report `truncated` so the caller knows the list is partial.
        // NodeSerializer stops adding only when it reaches the cap, so length == cap
        // is an exact truncation signal. The nested token-parity path is never capped
        // below 3000, so it stays false.
        var truncated = false
        // Phase 3m: fingerprints computed here (opt-in), from the SAME `rootNode`
        // this capture serialized — one active-root resolution, no second
        // `rootInActiveWindow`. `fingerprintMs` is a first-class stage so no
        // fingerprint work can hide in the capture residual. 0 when not requested.
        var fpSnap: TreeStore.Snapshot? = null
        var fingerprintMs = 0L
        // Phase 3n.2 (residual gate): time the forest recycle() — it runs in the
        // `finally` below, after serializeMs is closed, and scales with tree size, so
        // it was unaccounted work inside captureMs on the after-tap (larger) tree.
        var recycleMs = 0L
        val hierarchy = if (rootNode != null) {
            try {
                val tree = if (nested) {
                    NestedWindowSerializer.serialize(uiAutomation, rootNode, maxOf(maxElements, 3000), windowTimings, compact)
                } else {
                    val t0 = SystemClock.uptimeMillis()
                    val flat = NodeSerializer.serialize(rootNode, maxElements)
                    serializeMsFlat = SystemClock.uptimeMillis() - t0
                    truncated = flat.length() >= maxElements
                    flat
                }
                // Count this capture's own forest walk. Together with `ensure()`'s
                // build counter, `traversals` becomes the real forest-walk count:
                // an after-tap describe reads 1 here (capture only) with the fix and
                // 2 on the pre-fix build (the forced ensure rebuild + this capture).
                TreeStore.recordCaptureTraversal()
                if (wantFingerprints) {
                    val fpStart = SystemClock.uptimeMillis()
                    fpSnap = TreeStore.ensure(rootNode)
                    fingerprintMs = SystemClock.uptimeMillis() - fpStart
                }
                tree
            } finally {
                val recycleStart = SystemClock.uptimeMillis()
                rootNode.recycle()
                recycleMs = SystemClock.uptimeMillis() - recycleStart
            }
        } else {
            JSONArray()
        }
        // No separate window-list fallback for the package: `activeRoot` above
        // already reads the active window from the interactive-windows snapshot
        // before falling back to rootInActiveWindow, so a null root here means
        // neither path had one.

        // 5. Info — geometry from one idle-free Display snapshot, package from the
        //    accessibility root above; never a UiDevice getter that waits for idle.
        //    Phase 3n.2 (residual gate): `infoMs` times this whole block — the
        //    `DisplayReader.read` IPC AND `isKeyboardVisible()`'s SECOND full
        //    accessibility-window enumeration (`uiAutomation.windows`, a separate IPC
        //    round-trip from the serializer's own). Both sat inside captureMs with no
        //    stage; on the after-tap `waitTimeoutMs:0` capture the window set is
        //    mid-churn and the enumeration costs several ms, which is what pushed the
        //    stage-accounting residual to 11 ms. This accounts for the cost rather than
        //    removing it, so `captureMs` is unchanged; the work now lands in `infoMs`.
        val infoStart = SystemClock.uptimeMillis()
        val geo = DisplayReader.read(context)
        val info = JSONObject().apply {
            put("screenWidth", geo.width)
            put("screenHeight", geo.height)
            put("currentPackage", activePackage)
            put("keyboardVisible", isKeyboardVisible())
            put("displayRotation", geo.rotation)
        }
        val infoMs = SystemClock.uptimeMillis() - infoStart

        // encodeMs: the cost of serializing the tree to its JSON wire form.
        // Serialize-once (phase 3j): on the default path this is the ONLY tree
        // serialization — the resulting string is spliced verbatim into the response
        // by JsonRpcHandler, so successResponse never re-encodes the tree (the old
        // ~27 ms second pass is gone) and `encodeMs` now measures the single pass
        // whose output actually ships. The legacy toggle reproduces the old
        // throwaway-then-re-encode so the bench can A/B both in one run.
        val encStart = SystemClock.uptimeMillis()
        val treeValue: Any
        // Per-REQUEST raw tree (finding 14): carried on the returned object, never a
        // shared field. null on the legacy path (successResponse re-serializes it).
        var rawTreeJson: String? = null
        if (legacyEncode) {
            hierarchy.toString() // throwaway pass (measured, discarded — old behavior)
            treeValue = hierarchy
        } else {
            rawTreeJson = hierarchy.toString() // the single serialization pass
            treeValue = TREE_TOKEN // placeholder; JsonRpcHandler splices the tree in
        }
        val encodeMs = SystemClock.uptimeMillis() - encStart

        val captureMs = SystemClock.uptimeMillis() - captureStart

        // Phase 3n.2 (residual gate): decompose the residual ON-DEVICE instead of
        // inferring it host-side. `otherMs` is captureMs minus every NAMED stage (all
        // now on one clock). The nested describe/state path skips the screenshot, so
        // Σ(named) should account for captureMs to within a sample or two; the
        // device-test gate asserts |captureMs − Σ(named)| ≤ 10, and with infoMs +
        // recycleMs now measured, otherMs is that leftover.
        val serializeMsStage = if (nested) windowTimings.serializeMs else serializeMsFlat
        val rootsMsSum = windowTimings.rootsMs.sum()
        val namedStagesMs =
            rootMs + windowTimings.windowsMs + rootsMsSum + serializeMsStage +
                encodeMs + fingerprintMs + infoMs + recycleMs
        val otherMs = captureMs - namedStagesMs

        val timings = JSONObject().apply {
            put("idleMs", waitedMs)
            put("rootMs", rootMs)
            put("windowsMs", windowTimings.windowsMs)
            put("rootsMs", JSONArray(windowTimings.rootsMs))
            put("serializeMs", serializeMsStage)
            put("encodeMs", encodeMs)
            // Phase 3m: fingerprint build cost, its own stage so Σ(stages) ≈ captureMs.
            put("fingerprintMs", fingerprintMs)
            // Phase 3n.2 (residual gate): the two stages that were unaccounted inside
            // captureMs — the `info` block (DisplayReader.read + isKeyboardVisible's
            // window enumeration) and the forest recycle — plus the server-computed
            // leftover so the residual is decomposed on-device, not inferred host-side.
            put("infoMs", infoMs)
            put("recycleMs", recycleMs)
            put("otherMs", otherMs)
            put("rootSource", resolved.source)
        }

        return JSONObject().apply {
            put("screenshot", screenshotBase64)
            put("tree", treeValue)
            // Screen-graph Phase A: flat-list truncation flag (false for nested).
            put("truncated", truncated)
            put("info", info)
            put("waitedMs", waitedMs)
            put("captureMs", captureMs)
            put("timings", timings)
            // Phase 3m.1 (3M-H4): the reported version comes from ONE source,
            // consistent with the hash — the snapshot's when we built one, else the
            // single pre-capture read. ABSENT while the clock is unarmed (see above).
            val reportedVersion: Long? =
                if (!clockArmedAtCapture) null else (fpSnap?.version ?: versionAtCapture)
            reportedVersion?.let { put("version", it) }
            // Phase 3m: fingerprints + `unchanged` ONLY when requested
            // (`fingerprints: true` or `sinceVersion`). Absent ⇒ not computed, never
            // an EMPTY_TREE_HASH the host must not synthesise. Phase 3m.1 (3M-H1): an
            // empty forest carries no fingerprint (`fpSnap.isEmpty`) — omit the hash
            // entirely so the host never mints a transient empty frame as a screen.
            if (wantFingerprints) {
                fpSnap?.let {
                    if (!it.isEmpty) {
                        put("hash", it.hash)
                        put("stateHash", it.stateHash)
                        put("idHash", it.idHash)
                    }
                }
                reportedVersion?.let { put("unchanged", sinceVersion == it) }
            }
            // Serialize-once splice payload (phase 3j), per-request: JsonRpcHandler
            // removes this member (so it never ships) and splices it over TREE_TOKEN.
            if (rawTreeJson != null) put(RAW_TREE_MEMBER, rawTreeJson)
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
