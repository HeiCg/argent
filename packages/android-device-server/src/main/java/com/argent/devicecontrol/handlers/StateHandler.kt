package com.argent.devicecontrol.handlers

import android.app.Instrumentation
import android.app.UiAutomation
import android.graphics.Bitmap
import android.util.Base64
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.accessibility.NestedWindowSerializer
import com.argent.devicecontrol.accessibility.NodeSerializer
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

        // 3. Hierarchy — nested multi-window tree (F12) or the flat compressed list.
        //    Capture the active package from the SAME root we serialize, before it
        //    is recycled, so `info` below never calls uiDevice.currentPackageName
        //    (a waitForIdle caller).
        val rootNode = uiAutomation.rootInActiveWindow
        var activePackage = rootNode?.packageName?.toString() ?: ""
        val hierarchy = if (rootNode != null) {
            try {
                if (nested) {
                    NestedWindowSerializer.serialize(uiAutomation, rootNode, maxOf(maxElements, 3000))
                } else {
                    NodeSerializer.serialize(rootNode, maxElements)
                }
            } finally {
                rootNode.recycle()
            }
        } else {
            JSONArray()
        }
        if (activePackage.isEmpty()) {
            // No active root — fall back to the active entry in the window list.
            val fallbackRoot = try {
                uiAutomation.windows.firstOrNull { it.isActive }?.root
            } catch (_: Exception) {
                null
            }
            activePackage = fallbackRoot?.packageName?.toString() ?: ""
            fallbackRoot?.recycle()
        }

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

        val captureMs = System.currentTimeMillis() - captureStart

        return JSONObject().apply {
            put("screenshot", screenshotBase64)
            put("tree", hierarchy)
            put("info", info)
            put("waitedMs", waitedMs)
            put("captureMs", captureMs)
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
