package com.argent.devicecontrol.accessibility

import android.view.accessibility.AccessibilityNodeInfo

/**
 * Emit-filter used by [NodeSerializer]: returns whether a node is worth putting
 * in the serialized tree. It never controls recursion — an empty container is
 * dropped from the output but its children are still visited.
 */
object TreeCompressor {

    private val CONTAINER_TYPES = setOf(
        "FrameLayout",
        "LinearLayout",
        "RelativeLayout",
        "ConstraintLayout",
        "ViewGroup",
        "CoordinatorLayout",
        "AppBarLayout",
        "CollapsingToolbarLayout",
        "NestedScrollView",
        "CardView",
        "MaterialCardView"
    )

    /** Returns true if this node should be emitted into the compressed tree. */
    fun shouldKeep(node: AccessibilityNodeInfo): Boolean {
        // Always keep interactive elements
        if (node.isClickable || node.isScrollable || node.isFocused ||
            node.isCheckable || node.isLongClickable
        ) {
            return true
        }

        // Check if it's an empty container
        val className = node.className?.toString() ?: return true
        val shortName = className.substringAfterLast('.')

        if (shortName in CONTAINER_TYPES) {
            val hasText = !node.text.isNullOrEmpty()
            val hasContentDesc = !node.contentDescription.isNullOrEmpty()
            val hasResourceId = !node.viewIdResourceName.isNullOrEmpty()

            if (!hasText && !hasContentDesc && !hasResourceId) {
                return false
            }
        }

        return true
    }
}
