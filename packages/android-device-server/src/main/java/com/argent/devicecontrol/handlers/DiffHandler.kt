package com.argent.devicecontrol.handlers

import com.argent.devicecontrol.TreeStore
import com.argent.devicecontrol.accessibility.ScreenDiff
import org.json.JSONArray
import org.json.JSONObject

/**
 * `diff { sinceVersion }` — keyed diff of the retained previous snapshot against
 * the current tree. `sinceVersion == version` short-circuits to empty lists with
 * no diff work. Only one previous snapshot is kept (memory bound), so the diff is
 * always previous→current; `fromVersion` reports which version that was.
 */
class DiffHandler {
    fun execute(params: JSONObject): JSONObject {
        val sinceVersion = params.optLong("sinceVersion", -1L)
        val snap = TreeStore.ensure()

        if (sinceVersion == snap.version) {
            return JSONObject().apply {
                put("version", snap.version)
                put("fromVersion", sinceVersion)
                put("hash", snap.hash)
                put("stateHash", snap.stateHash)
                put("idHash", snap.idHash)
                put("added", JSONArray())
                put("removed", JSONArray())
                put("changed", JSONArray())
            }
        }

        val prev = TreeStore.previous()
        val d = ScreenDiff.diff(prev?.roots, snap.roots)
        return JSONObject().apply {
            put("version", snap.version)
            put("fromVersion", prev?.version ?: -1L)
            put("hash", snap.hash)
            put("stateHash", snap.stateHash)
            put("idHash", snap.idHash)
            put("added", d.getJSONArray("added"))
            put("removed", d.getJSONArray("removed"))
            put("changed", d.getJSONArray("changed"))
        }
    }
}
