package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import android.graphics.Bitmap
import android.os.Build
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream

class ScreenshotHandler(private val uiAutomation: UiAutomation) {

    fun execute(params: JSONObject): JSONObject {
        val quality = params.optInt("quality", 80)
        val scale = params.optDouble("scale", 1.0).toFloat()
        val format = params.optString("format", "jpeg")

        val bitmap = uiAutomation.takeScreenshot()
            ?: throw RuntimeException("Failed to take screenshot")

        val scaledBitmap = if (scale < 1.0f) {
            val w = (bitmap.width * scale).toInt()
            val h = (bitmap.height * scale).toInt()
            Bitmap.createScaledBitmap(bitmap, w, h, true).also {
                if (it !== bitmap) bitmap.recycle()
            }
        } else {
            bitmap
        }

        // PNG is lossless, so the host `screenshot` tool can keep its image/png
        // output contract (and downstream diffs get exact pixels); webp/jpeg stay
        // for callers that want a smaller frame.
        val usePng = format == "png"
        val useWebp = !usePng && format == "webp" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
        val compressFormat = when {
            usePng -> Bitmap.CompressFormat.PNG
            useWebp -> Bitmap.CompressFormat.WEBP_LOSSY
            else -> Bitmap.CompressFormat.JPEG
        }
        val mimeType = when {
            usePng -> "image/png"
            useWebp -> "image/webp"
            else -> "image/jpeg"
        }

        val stream = ByteArrayOutputStream()
        scaledBitmap.compress(compressFormat, quality, stream)
        scaledBitmap.recycle()

        val bytes = stream.toByteArray()
        val data = Base64.encodeToString(bytes, Base64.NO_WRAP)

        return JSONObject().apply {
            put("data", data)
            put("mimeType", mimeType)
            put("width", if (scale < 1.0f) (bitmap.width * scale).toInt() else bitmap.width)
            put("height", if (scale < 1.0f) (bitmap.height * scale).toInt() else bitmap.height)
        }
    }
}
