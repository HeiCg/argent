package com.argent.devicecontrol.handlers

import com.argent.devicecontrol.TreeStore
import com.argent.devicecontrol.accessibility.ScreenSelector
import org.json.JSONObject

/**
 * `query { selector, limit?, fields? }` — match the current (cached-or-rebuilt)
 * tree server-side and return only the matching compact node records, instead of
 * shipping the whole tree. See [ScreenSelector] for the selector grammar.
 */
class QueryHandler {
    fun execute(params: JSONObject): JSONObject {
        val selector = params.optJSONObject("selector") ?: JSONObject()
        val limit = params.optInt("limit", 0)
        val fieldsArr = params.optJSONArray("fields")
        val fields = fieldsArr?.let { arr ->
            (0 until arr.length()).map { arr.getString(it) }.toSet()
        }

        val snap = TreeStore.ensure()
        val nodes = ScreenSelector.query(snap.roots, selector, limit, fields)
        return JSONObject().apply {
            put("version", snap.version)
            put("hash", snap.hash)
            put("stateHash", snap.stateHash)
            put("idHash", snap.idHash)
            put("nodes", nodes)
        }
    }
}
