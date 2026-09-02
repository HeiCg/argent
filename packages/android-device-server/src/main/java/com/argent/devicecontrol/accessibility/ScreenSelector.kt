package com.argent.devicecontrol.accessibility

import org.json.JSONArray
import org.json.JSONObject

/**
 * Server-side selector matching for the `query` RPC (design §2.1 / §3).
 *
 * Selector JSON is the DSL selector shape:
 *   `id`, `text`, `class`  — a bare string (exact) OR
 *                            `{ contains | regex | equals, caseInsensitive? }`
 *   `containsDescendant`   — nested selector
 *   `index`                — pick the Nth match (0-based)
 *   `visible`              — when true, require a known-visible node
 *
 * Mirrors the host matcher (`packages/dsl` matcher.ts / argent ui-tree-match):
 * every provided field must hold, and `visible` only excludes known-invisible
 * nodes.
 */
object ScreenSelector {

    fun query(roots: List<AxNode>, selector: JSONObject, limit: Int, fields: Set<String>?): JSONArray {
        val matches = ArrayList<Pair<AxNode, List<Int>>>()
        for ((i, r) in roots.withIndex()) walk(r, listOf(i), selector, matches)

        val chosen: List<Pair<AxNode, List<Int>>> = when {
            selector.has("index") -> {
                val idx = selector.optInt("index")
                if (idx in matches.indices) listOf(matches[idx]) else emptyList()
            }
            limit > 0 -> matches.take(limit)
            else -> matches
        }

        val out = JSONArray()
        for ((n, path) in chosen) out.put(project(AxRecords.compact(n, path), fields))
        return out
    }

    private fun walk(
        n: AxNode,
        path: List<Int>,
        selector: JSONObject,
        matches: MutableList<Pair<AxNode, List<Int>>>
    ) {
        if (matchesNode(n, selector)) matches.add(n to path)
        for ((i, c) in n.children.withIndex()) walk(c, path + i, selector, matches)
    }

    fun matchesNode(n: AxNode, sel: JSONObject): Boolean {
        if (sel.has("id") && !matchString(n.resourceId, sel.get("id"))) return false
        if (sel.has("text") && !matchString(n.text, sel.get("text"))) return false
        if (sel.has("class") && !matchString(n.className, sel.get("class"))) return false
        if (sel.optBoolean("visible", false) && !n.visible) return false
        if (sel.has("containsDescendant")) {
            val d = sel.optJSONObject("containsDescendant") ?: return false
            if (!anyDescendant(n, d)) return false
        }
        return true
    }

    fun matchesAny(roots: List<AxNode>, sel: JSONObject): Boolean {
        for (r in roots) if (matchesTree(r, sel)) return true
        return false
    }

    private fun matchesTree(n: AxNode, sel: JSONObject): Boolean {
        if (matchesNode(n, sel)) return true
        for (c in n.children) if (matchesTree(c, sel)) return true
        return false
    }

    private fun anyDescendant(n: AxNode, sel: JSONObject): Boolean {
        for (c in n.children) if (matchesTree(c, sel)) return true
        return false
    }

    /** Match a value against a bare string (exact) or a StringMatch object. */
    private fun matchString(value: String, m: Any?): Boolean {
        if (m == null || m == JSONObject.NULL) return true
        if (m is String) return value == m
        if (m is JSONObject) {
            val ci = m.optBoolean("caseInsensitive", false)
            val hay = if (ci) value.lowercase() else value
            if (m.has("equals")) {
                val needle = m.getString("equals").let { if (ci) it.lowercase() else it }
                if (hay != needle) return false
            }
            if (m.has("contains")) {
                val needle = m.getString("contains").let { if (ci) it.lowercase() else it }
                if (!hay.contains(needle)) return false
            }
            if (m.has("regex")) {
                val opts = if (ci) setOf(RegexOption.IGNORE_CASE) else emptySet()
                if (!Regex(m.getString("regex"), opts).containsMatchIn(value)) return false
            }
            return true
        }
        return false
    }

    private fun project(record: JSONObject, fields: Set<String>?): JSONObject {
        if (fields == null) return record
        val out = JSONObject()
        // `path` always rides along so callers can address the node.
        out.put("path", record.opt("path"))
        for (key in fields) if (record.has(key)) out.put(key, record.get(key))
        return out
    }
}
