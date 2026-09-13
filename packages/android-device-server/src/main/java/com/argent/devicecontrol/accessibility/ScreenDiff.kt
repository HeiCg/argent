package com.argent.devicecontrol.accessibility

import org.json.JSONArray
import org.json.JSONObject

/**
 * Keyed tree diff for the `diff` RPC (design §3). Nodes are keyed by their
 * child-index path (the `(class, resourceId, indexInParent)` position chain);
 * output is `{ added: [compactNode], removed: [path], changed: [{path,
 * changedFields}] }`. Mirrors the host diff in
 * `packages/tool-server/src/utils/screen-diff.ts` so `patch(a, diff(a,b)) == b`
 * holds for the flattened compact-record space.
 */
object ScreenDiff {

    fun diff(prev: List<AxNode>?, cur: List<AxNode>): JSONObject {
        val prevMap = LinkedHashMap<String, Pair<AxNode, List<Int>>>()
        val curMap = LinkedHashMap<String, Pair<AxNode, List<Int>>>()
        if (prev != null) for ((i, r) in prev.withIndex()) flatten(r, listOf(i), prevMap)
        for ((i, r) in cur.withIndex()) flatten(r, listOf(i), curMap)

        val added = JSONArray()
        val removed = JSONArray()
        val changed = JSONArray()

        for ((key, node) in curMap) {
            val old = prevMap[key]
            if (old == null) {
                added.put(AxRecords.compact(node.first, node.second))
            } else {
                val cf = changedFields(old.first, node.first)
                if (cf.length() > 0) {
                    changed.put(JSONObject().apply {
                        put("path", AxRecords.pathArray(node.second))
                        put("changedFields", cf)
                    })
                }
            }
        }
        for ((key, node) in prevMap) {
            if (!curMap.containsKey(key)) removed.put(AxRecords.pathArray(node.second))
        }

        return JSONObject().apply {
            put("added", added)
            put("removed", removed)
            put("changed", changed)
        }
    }

    private fun flatten(n: AxNode, path: List<Int>, into: MutableMap<String, Pair<AxNode, List<Int>>>) {
        into[path.joinToString(".")] = n to path
        for ((i, c) in n.children.withIndex()) flatten(c, path + i, into)
    }

    private fun changedFields(a: AxNode, b: AxNode): JSONObject {
        val o = JSONObject()
        if (a.className != b.className) o.put("class", b.className)
        if (a.resourceId != b.resourceId) o.put("id", b.resourceId)
        if (a.text != b.text) o.put("text", b.text)
        if (a.contentDesc != b.contentDesc) o.put("cd", b.contentDesc)
        if (a.x1 != b.x1 || a.y1 != b.y1 || a.x2 != b.x2 || a.y2 != b.y2) {
            o.put("bounds", JSONObject().apply {
                put("x1", b.x1); put("y1", b.y1); put("x2", b.x2); put("y2", b.y2)
            })
        }
        if (ScreenHash.flagsOf(a) != ScreenHash.flagsOf(b)) o.put("flags", ScreenHash.flagsOf(b))
        return o
    }
}
