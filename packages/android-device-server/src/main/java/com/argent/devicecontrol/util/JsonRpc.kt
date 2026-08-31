package com.argent.devicecontrol.util

import org.json.JSONObject

/** JSON-RPC 2.0 response helpers. */
object JsonRpc {

    fun successResponse(id: Any?, result: Any): String {
        return JSONObject().apply {
            put("jsonrpc", "2.0")
            put("result", result)
            put("id", id)
        }.toString()
    }

    fun errorResponse(id: Any?, code: Int, message: String): String {
        val error = JSONObject().apply {
            put("code", code)
            put("message", message)
        }
        return JSONObject().apply {
            put("jsonrpc", "2.0")
            put("error", error)
            put("id", id)
        }.toString()
    }
}
