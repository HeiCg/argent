package com.argent.devicecontrol.util

import org.json.JSONException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A bad request (a missing or malformed parameter) answers JSON-RPC -32602 Invalid
 * params, so the host can tell it from a device failure (-32603) and warn instead
 * of falling back in silence.
 */
class JsonRpcErrorCodeTest {

    @Test
    fun `an argument error is invalid params`() {
        assertEquals(-32602, JsonRpc.errorCodeFor(IllegalArgumentException("nx must be in [0, 1]")))
    }

    @Test
    fun `a missing JSON key is invalid params`() {
        val e = try {
            JSONObject("{}").getInt("x")
            null
        } catch (e: JSONException) {
            e
        }
        assertEquals(-32602, JsonRpc.errorCodeFor(e!!))
    }

    @Test
    fun `anything else is an internal error`() {
        assertEquals(-32603, JsonRpc.errorCodeFor(IllegalStateException("display geometry is 0x0")))
        assertEquals(-32603, JsonRpc.errorCodeFor(RuntimeException("boom")))
    }
}
