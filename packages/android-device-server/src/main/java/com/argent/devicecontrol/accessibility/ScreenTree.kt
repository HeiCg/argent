package com.argent.devicecontrol.accessibility

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * One recycled-free accessibility node kept by
 * [com.argent.devicecontrol.TreeStore]. Built once per version and reused for
 * hashing, query, diff and flat serialization, so a cache hit costs no
 * UiAutomation traversal.
 */
class AxNode(
    val className: String,
    val resourceId: String,
    val text: String,
    val contentDesc: String,
    val x1: Int,
    val y1: Int,
    val x2: Int,
    val y2: Int,
    val clickable: Boolean,
    val scrollable: Boolean,
    val editable: Boolean,
    val checkable: Boolean,
    val checked: Boolean,
    val enabled: Boolean,
    val focused: Boolean,
    val selected: Boolean,
    val password: Boolean,
    val visible: Boolean,
    val children: List<AxNode>
)

/**
 * Builds the compressed kept-node forest from a live root, and lowers it back to
 * the same flat, 1-indexed JSON list [NodeSerializer] emits (so
 * `getAccessibilityTree` / `getState` keep their wire shape while being served
 * from the version cache).
 */
object ScreenTree {
    private val classNameCache = HashMap<String, String>()
    private fun shortClassName(fullName: String): String =
        classNameCache.getOrPut(fullName) { fullName.substringAfterLast('.') }

    /**
     * Apply the same emit-filter as [TreeCompressor.shouldKeep]: a node the
     * compressor rejects is dropped, but its kept descendants are hoisted to the
     * nearest kept ancestor, so the forest carries only meaningful nodes while
     * preserving containment. Recycles every child it fetches; the caller owns
     * [root]. [maxNodes] bounds memory on pathological trees.
     */
    fun build(root: AccessibilityNodeInfo, screenW: Int, screenH: Int, maxNodes: Int = 1200): List<AxNode> {
        val count = intArrayOf(0)
        return collect(root, screenW, screenH, maxNodes, count)
    }

    private fun collect(
        node: AccessibilityNodeInfo,
        w: Int,
        h: Int,
        maxNodes: Int,
        count: IntArray
    ): List<AxNode> {
        if (count[0] >= maxNodes) return emptyList()
        val childForest = ArrayList<AxNode>()
        for (i in 0 until node.childCount) {
            if (count[0] >= maxNodes) break
            val child = node.getChild(i) ?: continue
            try {
                childForest.addAll(collect(child, w, h, maxNodes, count))
            } finally {
                child.recycle()
            }
        }
        return if (TreeCompressor.shouldKeep(node)) {
            count[0]++
            listOf(toAxNode(node, w, h, childForest))
        } else {
            childForest
        }
    }

    private fun toAxNode(node: AccessibilityNodeInfo, w: Int, h: Int, children: List<AxNode>): AxNode {
        val b = Rect()
        node.getBoundsInScreen(b)
        val className = shortClassName(node.className?.toString() ?: "")
        val rawId = node.viewIdResourceName ?: ""
        val resourceId = if (rawId.contains("/")) rawId.substringAfter("/") else rawId
        val visible =
            b.width() > 0 && b.height() > 0 && b.left < w && b.right > 0 && b.top < h && b.bottom > 0
        return AxNode(
            className = className,
            resourceId = resourceId,
            text = node.text?.toString() ?: "",
            contentDesc = node.contentDescription?.toString() ?: "",
            x1 = b.left,
            y1 = b.top,
            x2 = b.right,
            y2 = b.bottom,
            clickable = node.isClickable,
            scrollable = node.isScrollable,
            editable = node.isEditable,
            checkable = node.isCheckable,
            checked = node.isChecked,
            enabled = node.isEnabled,
            focused = node.isFocused,
            selected = node.isSelected,
            password = node.isPassword,
            visible = visible,
            children = children
        )
    }

    data class SerializeResult(val tree: JSONArray, val truncated: Boolean)

    /** Flat, 1-indexed list matching [NodeSerializer]'s element shape. */
    fun serializeFlat(roots: List<AxNode>, maxElements: Int): SerializeResult {
        val out = JSONArray()
        val idx = intArrayOf(0)
        val truncated = booleanArrayOf(false)
        for (r in roots) {
            if (idx[0] >= maxElements) { truncated[0] = true; break }
            flatten(r, out, maxElements, idx, truncated)
        }
        return SerializeResult(out, truncated[0])
    }

    private fun flatten(n: AxNode, out: JSONArray, max: Int, idx: IntArray, truncated: BooleanArray) {
        if (idx[0] >= max) { truncated[0] = true; return }
        idx[0]++
        out.put(JSONObject().apply {
            put("index", idx[0])
            put("className", n.className)
            if (n.resourceId.isNotEmpty()) put("resourceId", n.resourceId)
            if (n.text.isNotEmpty()) put("text", n.text)
            if (n.contentDesc.isNotEmpty()) put("contentDesc", n.contentDesc)
            put("bounds", JSONObject().apply {
                put("x1", n.x1); put("y1", n.y1); put("x2", n.x2); put("y2", n.y2)
            })
            put("clickable", n.clickable)
            put("scrollable", n.scrollable)
            put("focused", n.focused)
            put("enabled", n.enabled)
            if (n.checked) put("checked", true)
            if (n.selected) put("selected", true)
            if (n.password) put("isPassword", true)
        })
        for (c in n.children) {
            if (idx[0] >= max) { truncated[0] = true; break }
            flatten(c, out, max, idx, truncated)
        }
    }
}
