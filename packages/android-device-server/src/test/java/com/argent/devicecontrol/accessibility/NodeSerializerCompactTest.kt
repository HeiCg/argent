package com.argent.devicecontrol.accessibility

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Goldens for the phase 3j compact-payload drop predicates (NodeSerializer). They
 * read only primitives (no AccessibilityNodeInfo, no org.json), so this runs as a
 * plain JVM unit test — no device, no Robolectric. The predicates mirror the host
 * v2 trim's passthrough / drop rules (`open-server-tree.ts` +
 * `uiautomator-parser.ts`); the byte-identity of the compacted describe output is
 * proved end-to-end by the host golden (`open-server-trim-golden.test.ts`).
 */
class NodeSerializerCompactTest {

    // ---- label ----
    @Test fun labelPrefersContentDescThenText() {
        assertEquals("Email", NodeSerializer.compactLabelOf(text = "x@y", contentDesc = "Email"))
        assertEquals("x@y", NodeSerializer.compactLabelOf(text = "x@y", contentDesc = ""))
        assertEquals("", NodeSerializer.compactLabelOf(text = "  ", contentDesc = "  "))
    }

    // ---- interactive ----
    @Test fun clickableIsInteractive() {
        assertTrue(
            NodeSerializer.compactIsInteractive(
                clickable = true, longClickable = false, checkable = false,
                scrollable = false, focusable = false, label = ""
            )
        )
    }

    @Test fun focusableAloneIsNotInteractiveWithoutLabel() {
        assertFalse(
            NodeSerializer.compactIsInteractive(
                clickable = false, longClickable = false, checkable = false,
                scrollable = false, focusable = true, label = ""
            )
        )
        assertTrue(
            NodeSerializer.compactIsInteractive(
                clickable = false, longClickable = false, checkable = false,
                scrollable = false, focusable = true, label = "Menu"
            )
        )
    }

    // ---- scaffold passthrough (hoist) ----
    private fun scaffold(
        className: String,
        clickable: Boolean = false,
        scrollable: Boolean = false,
        text: String = "",
        contentDesc: String = ""
    ) = NodeSerializer.compactIsScaffold(
        className = className, clickable = clickable, longClickable = false,
        checkable = false, scrollable = scrollable, focusable = false,
        text = text, contentDesc = contentDesc
    )

    @Test fun layoutContainerWithNoLabelIsScaffold() {
        assertTrue(scaffold("android.widget.FrameLayout"))
        assertTrue(scaffold("android.widget.LinearLayout"))
        assertTrue(scaffold("androidx.constraintlayout.widget.ConstraintLayout"))
        assertTrue(scaffold("android.view.ViewGroup"))
        assertTrue(scaffold("android.view.View"))
    }

    @Test fun decorativeImageViewIsScaffold() {
        // The trim's ImageView-drop is `cls.endsWith(".ImageView")` exactly, so only
        // a bare `*.ImageView` is a passthrough…
        assertTrue(scaffold("android.widget.ImageView"))
        // …and AppCompatImageView is NOT (it ends with "ImageView" but not
        // ".ImageView"): the trim keeps it as an Image role, so compaction must too.
        assertFalse(scaffold("androidx.appcompat.widget.AppCompatImageView"))
    }

    @Test fun labelledOrInteractiveContainerIsNotScaffold() {
        // A layout container with a label of its own is kept (it carries info).
        assertFalse(scaffold("android.widget.FrameLayout", contentDesc = "Card"))
        // A clickable container is kept (a tap target, and duplicate-wrapper logic).
        assertFalse(scaffold("android.widget.FrameLayout", clickable = true))
        // A scrollable container is kept (it sets the scroll-clip window).
        assertFalse(scaffold("android.widget.FrameLayout", scrollable = true))
        // An ImageView with a content-desc is a real labelled image, kept.
        assertFalse(scaffold("android.widget.ImageView", contentDesc = "Avatar"))
    }

    @Test fun nonScaffoldClassesAreKept() {
        assertFalse(scaffold("android.widget.Button"))
        assertFalse(scaffold("android.widget.TextView"))
        // Empty class is NOT a passthrough (the trim's LAYOUT_CONTAINERS.has("") is
        // false), so it must not be hoisted.
        assertFalse(scaffold(""))
    }

    // ---- zero-area empty leaf (drop) ----
    @Test fun zeroAreaNoLabelIsDropped() {
        assertTrue(NodeSerializer.compactIsZeroAreaEmptyLeaf(0, 0, 0, 0, "", ""))
        assertTrue(NodeSerializer.compactIsZeroAreaEmptyLeaf(10, 20, 10, 200, "", "")) // zero width
        assertTrue(NodeSerializer.compactIsZeroAreaEmptyLeaf(10, 20, 200, 20, "", "")) // zero height
    }

    @Test fun zeroAreaWithTextIsKept() {
        // Its text can feed an ancestor clickable's descendantText aggregation.
        assertFalse(NodeSerializer.compactIsZeroAreaEmptyLeaf(0, 0, 0, 0, "Total", ""))
        assertFalse(NodeSerializer.compactIsZeroAreaEmptyLeaf(0, 0, 0, 0, "", "Icon"))
    }

    @Test fun positiveAreaIsNeverDroppedByThisRule() {
        assertFalse(NodeSerializer.compactIsZeroAreaEmptyLeaf(0, 0, 100, 50, "", ""))
    }
}
