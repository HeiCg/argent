package com.argent.devicecontrol.handlers

import android.app.Instrumentation
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import org.json.JSONObject

/**
 * Set the DEVICE clipboard via [ClipboardManager] (F20).
 *
 * The `paste` tool's open path sets the clipboard here and then triggers
 * `KEYCODE_PASTE` on the host, so the text lands in the focused field exactly as
 * a user's paste would — and, unlike `input text`, this carries arbitrary
 * Unicode (URLs, emoji) that the virtual KeyCharacterMap cannot type.
 *
 * `ClipboardManager` must be touched from a Looper thread, so the write runs on
 * the app main thread via [Instrumentation.runOnMainSync]. Android silently drops
 * a background app's clipboard write on some API levels; we read the clip back on
 * the same thread and only report `success` when it round-trips, so the host can
 * fall back (to on-device `typeText`, then the proprietary clipboard path) rather
 * than paste nothing while reporting success.
 *
 * R3 (phase 3g): a caught EXCEPTION (a transient failure — a Looper hiccup, a
 * `SecurityException` while another app owns the primary clip) is reported
 * distinctly from a DEFINITIVE non-round-trip (`setPrimaryClip` returned but the
 * readback did not match). The result carries `error` ONLY for the exception
 * case; the host must NOT mark a device "clipboard unsupported" on an error-
 * carrying false, so a one-off transient can no longer permanently disable the
 * genuine-clipboard paste path. A definitive `success:false` (no `error`) is what
 * signals the API-level clipboard-drop the cache is meant to remember.
 */
class ClipboardHandler(private val instrumentation: Instrumentation) {

    fun execute(params: JSONObject): JSONObject {
        val text = params.getString("text")
        var ok = false
        var readback = ""
        var error: String? = null
        instrumentation.runOnMainSync {
            try {
                val ctx: Context = instrumentation.targetContext ?: instrumentation.context
                val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("argent", text))
                readback = cm.primaryClip?.getItemAt(0)?.text?.toString() ?: ""
                ok = readback == text
            } catch (e: Exception) {
                // Transient: surface the message so the host treats this false as a
                // blip, not proof the clipboard is unsupported on this device.
                ok = false
                error = e.message ?: e.javaClass.simpleName
            }
        }
        return JSONObject().apply {
            put("success", ok)
            put("text", readback)
            if (error != null) put("error", error)
        }
    }
}
