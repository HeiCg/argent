package com.argent.devicecontrol.handlers

import android.app.Instrumentation
import android.app.UiAutomation
import android.graphics.Bitmap
import android.util.Base64
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.TreeStore
import com.argent.devicecontrol.accessibility.NestedWindowSerializer
import com.argent.devicecontrol.accessibility.ScreenTree
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
    private val instrumentation: Instrumentation
) {

    private val context get() = instrumentation.context

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

        // 3. Fingerprints + version from the AX cache (cache hit → no traversal, so
        //    the Phase A traversals counter is unchanged across unchanged reads).
        val snap = TreeStore.ensure()
        val unchanged = sinceVersion == snap.version

        // 4. Hierarchy — the nested raw multi-window tree (F12 token parity, its own
        //    traversal for raw class names/ids) or the flat compressed list lowered
        //    from the cached forest (no traversal on a hit). Capture the active
        //    package from the accessibility root, never uiDevice.currentPackageName
        //    (a waitForIdle caller).
        val hierarchy: JSONArray
        val truncated: Boolean
        val activePackage: String
        if (nested) {
            val rootNode = uiAutomation.rootInActiveWindow
            var pkg = rootNode?.packageName?.toString() ?: ""
            hierarchy = if (rootNode != null) {
                try {
                    NestedWindowSerializer.serialize(uiAutomation, rootNode, maxOf(maxElements, 3000))
                } finally {
                    rootNode.recycle()
                }
            } else {
                JSONArray()
            }
            truncated = false
            if (pkg.isEmpty()) {
                val fallbackRoot = try {
                    uiAutomation.windows.firstOrNull { it.isActive }?.root
                } catch (_: Exception) {
                    null
                }
                pkg = fallbackRoot?.packageName?.toString() ?: ""
                fallbackRoot?.recycle()
            }
            activePackage = pkg
        } else {
            val serialized = ScreenTree.serializeFlat(snap.roots, maxElements)
            hierarchy = serialized.tree
            truncated = serialized.truncated
            activePackage = activePackageName()
        }

        // 5. Info — geometry from one idle-free Display snapshot, package from the
        //    accessibility root above; never a UiDevice getter that waits for idle.
        val geo = DisplayReader.read(context)
        val info = JSONObject().apply {
            put("screenWidth", geo.width)
            put("screenHeight", geo.height)
            put("currentPackage", activePackage)
            put("keyboardVisible", isKeyboardVisible())
            put("displayRotation", geo.rotation)
        }

        val captureMs = System.currentTimeMillis() - captureStart

        return JSONObject().apply {
            put("screenshot", screenshotBase64)
            put("tree", hierarchy)
            put("truncated", truncated)
            put("info", info)
            put("waitedMs", waitedMs)
            put("captureMs", captureMs)
            // Screen-graph Phase A fingerprints + version.
            put("hash", snap.hash)
            put("stateHash", snap.stateHash)
            put("idHash", snap.idHash)
            put("version", snap.version)
            put("unchanged", unchanged)
        }
    }

    /**
     * Active window package from a single `rootInActiveWindow` walk (falling back
     * to the active window-list entry), avoiding `uiDevice.currentPackageName`
     * which triggers a hidden `waitForIdle`. Never touches [TreeStore], so it
     * does not perturb the traversal counter used by the cache-hit tests.
     */
    private fun activePackageName(): String {
        return try {
            val root = uiAutomation.rootInActiveWindow
            if (root != null) {
                val pkg = root.packageName?.toString() ?: ""
                root.recycle()
                if (pkg.isNotEmpty()) return pkg
            }
            val fallbackRoot = uiAutomation.windows.firstOrNull { it.isActive }?.root
            val pkg = fallbackRoot?.packageName?.toString() ?: ""
            fallbackRoot?.recycle()
            pkg
        } catch (_: Exception) {
            ""
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
