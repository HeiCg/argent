package com.argent.devicecontrol.accessibility

import org.json.JSONArray
import org.json.JSONObject

/**
 * Compact node records shared by `query` and `diff`:
 * `{ id, text, cd, class, bounds, flags, path }`. `path` is the child-index path
 * from the root forest (stable within a version), `flags` the [ScreenHash]
 * actionability bitmask. Empty string fields are omitted to keep records small.
 */
object AxRecords {
    fun pathArray(path: List<Int>): JSONArray = JSONArray().apply { for (p in path) put(p) }

    fun compact(n: AxNode, path: List<Int>): JSONObject = JSONObject().apply {
        if (n.resourceId.isNotEmpty()) put("id", n.resourceId)
        if (n.text.isNotEmpty()) put("text", n.text)
        if (n.contentDesc.isNotEmpty()) put("cd", n.contentDesc)
        put("class", n.className)
        put("bounds", JSONObject().apply {
            put("x1", n.x1); put("y1", n.y1); put("x2", n.x2); put("y2", n.y2)
        })
        put("flags", ScreenHash.flagsOf(n))
        put("path", pathArray(path))
    }
}
