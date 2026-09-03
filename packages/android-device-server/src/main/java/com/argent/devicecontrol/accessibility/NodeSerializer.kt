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
    fun serializeNested(
        rootNode: AccessibilityNodeInfo,
        maxElements: Int = 3000,
        // Phase 3j: drop the descendants the host v2 trim discards anyway (scaffold
        // layout/ImageView wrappers it passes through, zero-area empty leaves it
        // drops), so the wire payload shrinks while lowering to the byte-identical
        // DescribeNode. Mirrors the host `compactNestedRoots` (open-server-tree.ts);
        // the golden proves the host lowering is identical for compact vs full. The
        // WINDOW ROOT is always kept (only its subtree is compacted) so the
        // `truncated` flag and window count are preserved.
        compact: Boolean = false
    ): JSONObject {
        val counter = intArrayOf(0)
        val truncated = booleanArrayOf(false)
        val root = nodeToNestedJson(rootNode, maxElements, counter, truncated)
        // Surface the runaway-guard hit (F13): when the cap is reached the tree is
        // incomplete, so the host can warn the agent instead of silently rendering
        // a partial screen. Only the window root carries the flag.
        if (truncated[0]) root.put("truncated", true)
        if (compact) compactChildrenInPlace(root)
        return root
    }

    // ---- compact payload (phase 3j) --------------------------------------

    // The v2 trim's layout-passthrough set (`LAYOUT_CONTAINERS` in
    // uiautomator-parser.ts / `COMPACT_LAYOUT_CONTAINERS` in open-server-tree.ts).
    // Kept byte-for-byte in sync. The empty class ("") is deliberately absent: the
    // trim's passthrough uses `LAYOUT_CONTAINERS.has(cls)`, false for "", so an
    // empty-class node is not hoisted.
    private val COMPACT_LAYOUT_CONTAINERS = setOf(
        "android.widget.FrameLayout",
        "android.widget.LinearLayout",
        "android.widget.RelativeLayout",
        "androidx.constraintlayout.widget.ConstraintLayout",
        "androidx.coordinatorlayout.widget.CoordinatorLayout",
        "android.view.ViewGroup",
        "android.view.View"
    )

    /** Label the trim derives: content-desc wins, else text (both trimmed). Pure. */
    fun compactLabelOf(text: String, contentDesc: String): String {
        val cd = contentDesc.trim()
        if (cd.isNotEmpty()) return cd
        return text.trim()
    }

    /** Whether the trim treats the node as interactive (mirrors `isInteractive`). Pure. */
    fun compactIsInteractive(
        clickable: Boolean,
        longClickable: Boolean,
        checkable: Boolean,
        scrollable: Boolean,
        focusable: Boolean,
        label: String
    ): Boolean {
        if (clickable || longClickable || checkable || scrollable) return true
        if (focusable && label.isNotEmpty()) return true
        return false
    }

    /**
     * The trim's pure-passthrough case: a layout container or decorative ImageView
     * that is non-interactive and carries no label of its own. `computeNodeOutput`
     * inlines such a node's kept children in its place, so dropping the wrapper and
     * hoisting its children is output-preserving. Pure (primitives only) so a JVM
     * unit test can pin it without a device.
     */
    fun compactIsScaffold(
        className: String,
        clickable: Boolean,
        longClickable: Boolean,
        checkable: Boolean,
        scrollable: Boolean,
        focusable: Boolean,
        text: String,
        contentDesc: String
    ): Boolean {
        val label = compactLabelOf(text, contentDesc)
        if (label.isNotEmpty()) return false
        if (compactIsInteractive(clickable, longClickable, checkable, scrollable, focusable, label)) {
            return false
        }
        return COMPACT_LAYOUT_CONTAINERS.contains(className) || className.endsWith(".ImageView")
    }

    /**
     * A zero-area rect with no text/content-desc: the trim always drops it
     * (invisible, no kept children) and it feeds no descendantText aggregation, so
     * a childless such node is safe to drop. Pure.
     */
    fun compactIsZeroAreaEmptyLeaf(
        x1: Int,
        y1: Int,
        x2: Int,
        y2: Int,
        text: String,
        contentDesc: String
    ): Boolean {
        return (x2 <= x1 || y2 <= y1) && compactLabelOf(text, contentDesc).isEmpty()
    }

    private fun compactIsScaffoldNode(node: JSONObject): Boolean =
        compactIsScaffold(
            node.optString("className", ""),
            node.optBoolean("clickable", false),
            node.optBoolean("longClickable", false),
            node.optBoolean("checkable", false),
            node.optBoolean("scrollable", false),
            node.optBoolean("focusable", false),
            node.optString("text", ""),
            node.optString("contentDesc", "")
        )

    private fun compactIsZeroAreaEmptyLeafNode(node: JSONObject): Boolean {
        val b = node.optJSONObject("bounds") ?: return false
        return compactIsZeroAreaEmptyLeaf(
            b.optInt("x1", 0),
            b.optInt("y1", 0),
            b.optInt("x2", 0),
            b.optInt("y2", 0),
            node.optString("text", ""),
            node.optString("contentDesc", "")
        )
    }

    /** Compact a node's `children` array in place (bottom-up). */
    private fun compactChildrenInPlace(node: JSONObject) {
        val children = node.optJSONArray("children") ?: return
        val out = JSONArray()
        for (i in 0 until children.length()) {
            val child = children.optJSONObject(i) ?: continue
            for (kept in compactNode(child)) out.put(kept)
        }
        node.put("children", out)
    }

    /** The nodes that take `node`'s place in its parent: hoisted children, [], or [node]. */
    private fun compactNode(node: JSONObject): List<JSONObject> {
        compactChildrenInPlace(node)
        val children = node.optJSONArray("children") ?: JSONArray()
        if (compactIsScaffoldNode(node)) {
            return (0 until children.length()).mapNotNull { children.optJSONObject(it) }
        }
        if (children.length() == 0 && compactIsZeroAreaEmptyLeafNode(node)) return emptyList()
        return listOf(node)
    }

    private fun nodeToNestedJson(
        node: AccessibilityNodeInfo,
        maxElements: Int,
        counter: IntArray,
        truncated: BooleanArray
    ): JSONObject {
        counter[0]++
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        // Emit only the fields that carry information: true booleans and non-empty
        // strings are written; everything else is omitted, cutting the ~15
        // booleans/node the nested tree used to ship on every node. The host
        // (`nestedToParsed` in `open-server-tree.ts`) restores the defaults —
        // a missing boolean is false, a missing string is "" — so the trimmed
        // payload lowers to a byte-identical DescribeNode. `enabled` is the one
        // inverse case: it defaults TRUE (matching `uiautomator dump`, where only
        // `enabled="false"` is notable), so it is emitted ONLY when the node is
        // disabled.
        val obj = JSONObject().apply {
            val className = node.className?.toString() ?: ""
            if (className.isNotEmpty()) put("className", className)
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
            if (node.isClickable) put("clickable", true)
            if (node.isLongClickable) put("longClickable", true)
            if (node.isScrollable) put("scrollable", true)
            if (node.isCheckable) put("checkable", true)
            if (node.isChecked) put("checked", true)
            if (node.isFocusable) put("focusable", true)
            if (node.isFocused) put("focused", true)
            if (node.isSelected) put("selected", true)
            if (!node.isEnabled) put("enabled", false)
            if (node.isPassword) put("password", true)
        }
        val children = JSONArray()
        for (i in 0 until node.childCount) {
            if (counter[0] >= maxElements) {
                // Stopped before walking every child — the serialized tree is a
                // prefix of the real one.
                truncated[0] = true
                break
            }
            val child = node.getChild(i) ?: continue
            try {
                children.put(nodeToNestedJson(child, maxElements, counter, truncated))
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
