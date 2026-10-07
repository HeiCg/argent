package com.argent.devicecontrol.handlers

import android.app.UiAutomation
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import com.argent.devicecontrol.TreeStore
import org.json.JSONObject

/**
 * `scrollContainer { nodeId?, resourceId?, direction, count? }`: scroll a
 * container by accessibility action (ACTION_SCROLL_FORWARD / BACKWARD) instead
 * of a touch swipe. No MotionEvent reaches the app, so no VelocityTracker reads a
 * release velocity and no fling follows: the list moves by the view's own page
 * step. This is the momentum-free scroll a held swipe could not guarantee (device
 * test 3d: the held swipe moved 491 px against 384 px for the plain fling).
 *
 * The node is resolved on the live tree by `nodeId` (its screen bounds,
 * `"x1,y1,x2,y2"`, as `getState` reports them) and/or `resourceId` (compared
 * without the package prefix); several matches take the largest scrollable. Each
 * action is followed by the outcome settle ([TreeStore.settleAfterAction]), and
 * it counts as performed only when the state fingerprint changed (the content
 * moved). The loop stops at the first refused action (`reason: "refused"`, the
 * list end) or at an action that left the content unchanged
 * (`reason: "no-change"`). Reply: `{ accepted, performed, stableHash, settledMs,
 * reason? }`; `accepted` is `performed > 0`.
 */
class ScrollHandler(private val uiAutomation: UiAutomation) {

    private companion object {
        const val TAG = "ScrollHandler"
        // Settle bounds per action. The quiet window is above Android's 100 ms
        // TYPE_VIEW_SCROLLED throttle, so a smooth scroll still animating between
        // two throttled events is not read as quiet.
        const val FIRST_EVENT_TIMEOUT_MS = 600L
        const val QUIET_MS = 150L
        const val IDLE_TIMEOUT_MS = 1500L
        // Runaway guard for the node walk.
        const val MAX_NODES = 3000
    }

    fun execute(params: JSONObject): JSONObject {
        val req = ScrollTarget.request(
            params.optString("nodeId", "").ifEmpty { null },
            params.optString("resourceId", "").ifEmpty { null },
            params.optString("direction", ""),
            params.optInt("count", 1)
        )
        // The settle reads the AX version clock (phase 3m lazy-arm).
        TreeStore.armClock()

        val held = ArrayList<AccessibilityNodeInfo>()
        try {
            val matches = ArrayList<AccessibilityNodeInfo>()
            val active = uiAutomation.rootInActiveWindow
            if (active != null) {
                held.add(active)
                collect(active, req, matches, held)
            }
            // Not in the active window (a dialog or a second pane): try the other
            // interactive windows.
            if (matches.isEmpty()) {
                for (w in uiAutomation.windows) {
                    val r = w.root ?: continue
                    held.add(r)
                    collect(r, req, matches, held)
                    if (matches.isNotEmpty()) break
                }
            }
            val rect = Rect()
            val idx = ScrollTarget.pick(matches.map { n ->
                n.getBoundsInScreen(rect)
                ScrollTarget.Candidate(n.isScrollable, rect.width().toLong() * rect.height().toLong())
            })
            val what = describeRequest(req)
            if (idx == ScrollTarget.PICK_NONE) {
                throw IllegalArgumentException("scrollContainer: no node matches $what")
            }
            if (idx == ScrollTarget.PICK_NOT_SCROLLABLE) {
                throw IllegalArgumentException("scrollContainer: the node $what is not scrollable")
            }
            return scroll(matches[idx], req)
        } finally {
            for (n in held) n.recycle()
        }
    }

    private fun scroll(target: AccessibilityNodeInfo, req: ScrollTarget.Request): JSONObject {
        val action = if (req.forward) {
            AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        } else {
            AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        }
        var performed = 0
        var settledMs = 0L
        var reason: String? = null
        var snap = TreeStore.ensure()
        for (i in 0 until req.count) {
            val beforeHash = snap.stateHash ?: ""
            val fromVersion = TreeStore.version
            // false: the node refused (no further content in that direction).
            if (!target.performAction(action)) {
                reason = "refused"
                break
            }
            val t0 = SystemClock.uptimeMillis()
            val settle = TreeStore.settleAfterAction(
                fromVersion,
                FIRST_EVENT_TIMEOUT_MS,
                QUIET_MS,
                IDLE_TIMEOUT_MS
            )
            settledMs += SystemClock.uptimeMillis() - t0
            // An accepted action counts only when the content moved: no AX event,
            // or the same state fingerprint after the settle, is the list end.
            snap = if (settle.settled == "no-event") snap else TreeStore.ensure()
            if ((snap.stateHash ?: "") == beforeHash) {
                reason = "no-change"
                break
            }
            performed++
        }
        Log.i(
            TAG,
            "scroll forward=${req.forward} count=${req.count} performed=$performed " +
                "reason=${reason ?: "-"} settledMs=$settledMs"
        )
        return JSONObject().apply {
            put("accepted", performed > 0)
            put("performed", performed)
            put("stableHash", snap.stateHash ?: "")
            put("settledMs", settledMs)
            put("version", snap.version)
            reason?.let { put("reason", it) }
        }
    }

    /**
     * Depth-first walk from [root]: every node [ScrollTarget.matches] goes to
     * [out]. Every node fetched here is added to [held] for the caller to recycle.
     */
    private fun collect(
        root: AccessibilityNodeInfo,
        req: ScrollTarget.Request,
        out: MutableList<AccessibilityNodeInfo>,
        held: MutableList<AccessibilityNodeInfo>
    ) {
        val rect = Rect()
        val stack = ArrayList<AccessibilityNodeInfo>()
        stack.add(root)
        var visited = 0
        while (stack.isNotEmpty() && visited < MAX_NODES) {
            val n = stack.removeAt(stack.size - 1)
            visited++
            n.getBoundsInScreen(rect)
            if (ScrollTarget.matches(n.viewIdResourceName, rect.left, rect.top, rect.right, rect.bottom, req)) {
                out.add(n)
            }
            for (i in 0 until n.childCount) {
                val c = n.getChild(i) ?: continue
                held.add(c)
                stack.add(c)
            }
        }
    }

    private fun describeRequest(req: ScrollTarget.Request): String {
        val parts = ArrayList<String>()
        req.nodeBounds?.let { parts.add("nodeId=${it.joinToString(",")}") }
        req.resourceId?.let { parts.add("resourceId=$it") }
        return parts.joinToString(" ")
    }
}

/**
 * Pure request and target rules of the `scrollContainer` RPC, kept free of
 * android.jar calls so they are unit-tested on the JVM.
 */
object ScrollTarget {

    /** Upper bound on `count`: each action settles for up to ~2 s. */
    const val MAX_COUNT = 10

    /** A parsed `scrollContainer` request. */
    class Request(
        /** `[x1, y1, x2, y2]` from `nodeId`, or null when not given. */
        val nodeBounds: IntArray?,
        /** Stripped resource id, or null when not given. */
        val resourceId: String?,
        val forward: Boolean,
        val count: Int
    )

    /** One node that matched the request: whether it scrolls, and its area. */
    class Candidate(val scrollable: Boolean, val area: Long)

    /** No candidate at all. */
    const val PICK_NONE = -1

    /** Candidates matched, but none of them is scrollable. */
    const val PICK_NOT_SCROLLABLE = -2

    /**
     * Parse and validate a request. `direction` is `forward` (later content) or
     * `backward`; `count` is clamped to `1..MAX_COUNT`; at least one of `nodeId`
     * and `resourceId` is required.
     */
    fun request(nodeId: String?, resourceId: String?, direction: String, count: Int): Request {
        val forward = when (direction) {
            "forward" -> true
            "backward" -> false
            else -> throw IllegalArgumentException(
                "scrollContainer: direction must be \"forward\" or \"backward\", got \"$direction\""
            )
        }
        val id = resourceId?.let { stripId(it) }?.ifEmpty { null }
        val bounds = nodeId?.let { parseBounds(it) }
        if (bounds == null && id == null) {
            throw IllegalArgumentException("scrollContainer needs nodeId or resourceId")
        }
        return Request(bounds, id, forward, count.coerceIn(1, MAX_COUNT))
    }

    /** `x1,y1,x2,y2` (spaces allowed) to four ints. */
    private fun parseBounds(nodeId: String): IntArray {
        val parts = nodeId.split(",").map { it.trim().toIntOrNull() }
        if (parts.size != 4 || parts.any { it == null }) {
            throw IllegalArgumentException(
                "scrollContainer: nodeId must be \"x1,y1,x2,y2\" screen bounds, got \"$nodeId\""
            )
        }
        return IntArray(4) { parts[it]!! }
    }

    /** The resource id without its `package:id/` prefix (as [ScreenTree] reports it). */
    fun stripId(raw: String?): String {
        val r = raw?.trim() ?: return ""
        return if (r.contains("/")) r.substringAfter("/") else r
    }

    /** Whether a live node with [rawId] and bounds matches every key [req] names. */
    fun matches(rawId: String?, x1: Int, y1: Int, x2: Int, y2: Int, req: Request): Boolean {
        val b = req.nodeBounds
        if (b != null && (b[0] != x1 || b[1] != y1 || b[2] != x2 || b[3] != y2)) return false
        val id = req.resourceId
        if (id != null && stripId(rawId) != id) return false
        return true
    }

    /**
     * The candidate to scroll: the largest scrollable (the first on a tie), else
     * [PICK_NOT_SCROLLABLE] when every match is static, or [PICK_NONE] when
     * nothing matched.
     */
    fun pick(candidates: List<Candidate>): Int {
        if (candidates.isEmpty()) return PICK_NONE
        var best = PICK_NOT_SCROLLABLE
        var bestArea = -1L
        for ((i, c) in candidates.withIndex()) {
            if (c.scrollable && c.area > bestArea) {
                best = i
                bestArea = c.area
            }
        }
        return best
    }
}
