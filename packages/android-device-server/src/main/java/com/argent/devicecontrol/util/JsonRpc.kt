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

    /**
     * Serialize-once splice (phase 3j): replace the first occurrence of the quoted
     * placeholder [token] in an already-built response string with [rawJson]
     * verbatim, so a large member (the accessibility tree) is JSON-encoded exactly
     * once rather than twice. [rawJson] must itself be valid JSON. A literal
     * (non-regex) replacement — [rawJson]'s `$`/`\` are inserted as-is.
     */
    fun spliceRawMember(response: String, token: String, rawJson: String): String {
        return response.replaceFirst("\"$token\"", rawJson)
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
