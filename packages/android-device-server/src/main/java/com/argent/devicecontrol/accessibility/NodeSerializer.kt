package com.argent.devicecontrol.accessibility

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * Traverses AccessibilityNodeInfo tree and serializes to IndexedElement JSON array.
 * Applies [TreeCompressor] as an emit-filter — a node the compressor rejects is
 * skipped but its subtree is still walked, so meaningful descendants under an
 * id-less scaffold root are never lost.
 */
object NodeSerializer {

    private val classNameCache = HashMap<String, String>()

    private fun shortClassName(fullName: String): String {
        return classNameCache.getOrPut(fullName) { fullName.substringAfterLast('.') }
    }

    /**
     * Serialize the FULL accessibility subtree under [rootNode] as one nested
     * JSON node (each node carries a `children` array). Unlike [serialize] this
     * does NO pruning and strips nothing: raw `className`, package-qualified
     * `resourceId`, and every attribute the host-side v2 trim reads are kept, so
     * the tool-server can run the same interactables-only trim the proprietary
     * `android-devtools` XML path runs and reach byte-for-byte parity with it
     * (the token-parity goal). Bounded by [maxElements] as a runaway guard.
     *
     * The wire cost is a few KB over the adb-forwarded loopback socket; the
     * trim/compaction itself happens host-side where the identical algorithm
     * already lives, which is what keeps the rendered label set identical to the
     * proprietary path rather than re-deriving it here and risking drift.
     */
    fun serializeNested(rootNode: AccessibilityNodeInfo, maxElements: Int = 3000): JSONObject {
        val counter = intArrayOf(0)
        return nodeToNestedJson(rootNode, maxElements, counter)
    }

    private fun nodeToNestedJson(
        node: AccessibilityNodeInfo,
        maxElements: Int,
        counter: IntArray
    ): JSONObject {
        counter[0]++
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        val obj = JSONObject().apply {
            put("className", node.className?.toString() ?: "")
            val rid = node.viewIdResourceName
            if (!rid.isNullOrEmpty()) put("resourceId", rid)
            val text = node.text?.toString() ?: ""
            if (text.isNotEmpty()) put("text", text)
            val cd = node.contentDescription?.toString() ?: ""
            if (cd.isNotEmpty()) put("contentDesc", cd)
            val pkg = node.packageName?.toString() ?: ""
            if (pkg.isNotEmpty()) put("packageName", pkg)
            put("bounds", JSONObject().apply {
                put("x1", bounds.left)
                put("y1", bounds.top)
                put("x2", bounds.right)
                put("y2", bounds.bottom)
            })
            put("clickable", node.isClickable)
            put("longClickable", node.isLongClickable)
            put("scrollable", node.isScrollable)
            put("checkable", node.isCheckable)
            put("checked", node.isChecked)
            put("focusable", node.isFocusable)
            put("focused", node.isFocused)
            put("selected", node.isSelected)
            put("enabled", node.isEnabled)
            put("password", node.isPassword)
        }
        val children = JSONArray()
        for (i in 0 until node.childCount) {
            if (counter[0] >= maxElements) break
            val child = node.getChild(i) ?: continue
            try {
                children.put(nodeToNestedJson(child, maxElements, counter))
            } finally {
                child.recycle()
            }
        }
        obj.put("children", children)
        return obj
    }

    /**
     * Serialize the accessibility tree starting from [rootNode].
     * Returns a JSONArray of IndexedElement objects (1-indexed).
     */
    fun serialize(rootNode: AccessibilityNodeInfo, maxElements: Int = 50): JSONArray {
        val elements = mutableListOf<JSONObject>()
        traverse(rootNode, elements, maxElements)

        // Apply 1-based indexing
        val result = JSONArray()
        for ((i, element) in elements.withIndex()) {
            element.put("index", i + 1)
            result.put(element)
        }
        return result
    }

    private fun traverse(
        node: AccessibilityNodeInfo,
        elements: MutableList<JSONObject>,
        maxElements: Int
    ) {
        if (elements.size >= maxElements) return

        // Emit-filter: keep meaningful nodes, but ALWAYS recurse. A skippable
        // node (e.g. the id-less root FrameLayout) carries meaningful
        // descendants, so pruning its whole subtree would drop the entire
        // screen. `maxElements` is the only traversal stop.
        if (TreeCompressor.shouldKeep(node)) {
            elements.add(nodeToJson(node))
        }

        // Recurse into children
        for (i in 0 until node.childCount) {
            if (elements.size >= maxElements) break
            val child = node.getChild(i) ?: continue
            try {
                traverse(child, elements, maxElements)
            } finally {
                child.recycle()
            }
        }
    }

    private fun nodeToJson(node: AccessibilityNodeInfo): JSONObject {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)

        val className = node.className?.toString() ?: ""
        val shortName = shortClassName(className)

        // Strip package prefix from resource ID (e.g., "com.app:id/btn" -> "btn")
        val rawResourceId = node.viewIdResourceName ?: ""
        val resourceId = if (rawResourceId.contains("/")) {
            rawResourceId.substringAfter("/")
        } else {
            rawResourceId
        }

        val text = node.text?.toString() ?: ""
        val contentDesc = node.contentDescription?.toString() ?: ""

        return JSONObject().apply {
            put("index", 0) // Will be set later
            put("className", shortName)
            if (resourceId.isNotEmpty()) put("resourceId", resourceId)
            if (text.isNotEmpty()) put("text", text)
            if (contentDesc.isNotEmpty()) put("contentDesc", contentDesc)
            put("bounds", JSONObject().apply {
                put("x1", bounds.left)
                put("y1", bounds.top)
                put("x2", bounds.right)
                put("y2", bounds.bottom)
            })
            put("clickable", node.isClickable)
            put("scrollable", node.isScrollable)
            put("focused", node.isFocused)
            put("enabled", node.isEnabled)
            if (node.isChecked) put("checked", true)
            if (node.isSelected) put("selected", true)
        }
    }
}
