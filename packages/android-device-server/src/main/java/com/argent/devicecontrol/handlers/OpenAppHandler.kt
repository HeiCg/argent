package com.argent.devicecontrol.handlers

import android.app.Instrumentation
import android.content.Intent
import org.json.JSONObject

class OpenAppHandler(private val instrumentation: Instrumentation) {

    fun execute(params: JSONObject): JSONObject {
        val packageName = params.getString("packageName")
        val context = instrumentation.targetContext
        val launchIntent = context.packageManager.getLaunchIntentForPackage(packageName)
            ?: throw IllegalArgumentException("No launch intent for package: $packageName")

        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        context.startActivity(launchIntent)

        return JSONObject().apply {
            put("success", true)
            put("packageName", packageName)
        }
    }
}
