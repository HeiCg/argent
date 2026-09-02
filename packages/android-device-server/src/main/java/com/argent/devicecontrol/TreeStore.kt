package com.argent.devicecontrol

import android.app.UiAutomation
import android.view.accessibility.AccessibilityEvent
import androidx.test.uiautomator.UiDevice
import com.argent.devicecontrol.accessibility.AxNode
import com.argent.devicecontrol.accessibility.ScreenHash
import com.argent.devicecontrol.accessibility.ScreenTree

/**
 * Versioned accessibility-tree store (Screen-graph Phase A, design §2.1).
 *
 * A single [UiAutomation] event listener bumps [version] on every content /
 * state / scroll / text change; the tree is (re)built lazily by [ensure] and
 * cached until the next event, so reading the tree when nothing changed is a
 * cache hit with NO UiAutomation traversal ([traversals] is unchanged). The
 * same listener is the condition source for [awaitVersionChange] and
 * [waitForQuiet], letting `awaitChange` and action outcomes settle on real AX
 * events rather than a host poll.
 */
object TreeStore {

    /**
     * Structural hash of an EMPTY tree. `ScreenHash.structural(emptyList, …)`
     * folds no bytes, so `fnv1a("")` returns the bare FNV-1a 64-bit offset basis
     * (`0xcbf29ce484222325`). A settle that lands on this (or a 0-node forest) is
     * a transient mid-transition frame, not a real screen — see [awaitNonEmptyTree].
     */
    const val EMPTY_TREE_HASH = "cbf29ce484222325"

    /** Monotonic AX clock. Bumped by the listener; never decreases. */
    @Volatile
    var version: Long = 0L
        private set

    /** Number of real tree builds. Exposed via `getInfo` so tests assert cache hits. */
    @Volatile
    var traversals: Long = 0L
        private set

    @Volatile
    private var lastEventAtMs: Long = 0L

    // Guards version bumps + the awaitChange / waitForQuiet condition waits.
    private val waitLock = Object()

    // Serialises tree builds so two connections never traverse concurrently.
    private val buildLock = Any()

    private var uiDevice: UiDevice? = null
    private var uiAutomation: UiAutomation? = null

    private var lastBuiltAtVersion: Long = -1L
    private var lastSnapshot: Snapshot? = null
    private var prevSnapshot: Snapshot? = null

    class Snapshot(
        val version: Long,
        val roots: List<AxNode>,
        val hash: String,
        val stateHash: String,
        val screenW: Int,
        val screenH: Int
    )

    /**
     * Register the AX-event listener. Called once at server start.
     *
     * NOTE (ticket "beware the UiAutomation flag setup"): setting an
     * OnAccessibilityEventListener does NOT break `UiDevice.waitForIdle` —
     * UiAutomation keeps updating its internal last-event timestamp regardless of
     * a registered listener, and `executeAndWaitForEvent`/`waitForIdle` read that,
     * not this callback. We only READ `eventType` and never retain the event.
     */
    fun init(uiDevice: UiDevice, uiAutomation: UiAutomation) {
        this.uiDevice = uiDevice
        this.uiAutomation = uiAutomation
        lastEventAtMs = System.currentTimeMillis()
        uiAutomation.setOnAccessibilityEventListener { event ->
            when (event?.eventType) {
                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
                AccessibilityEvent.TYPE_VIEW_SCROLLED,
                AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> onEvent()
                else -> { /* ignore other event types */ }
            }
        }
    }

    private fun onEvent() {
        synchronized(waitLock) {
            version++
            lastEventAtMs = System.currentTimeMillis()
            waitLock.notifyAll()
        }
    }

    /** Build-or-cache the current tree. Only a real rebuild increments [traversals]. */
    fun ensure(): Snapshot {
        synchronized(buildLock) {
            val v = version
            val cached = lastSnapshot
            if (cached != null && lastBuiltAtVersion == v) return cached

            val ui = uiAutomation ?: throw IllegalStateException("TreeStore not initialized")
            val dev = uiDevice ?: throw IllegalStateException("TreeStore not initialized")
            val w = dev.displayWidth
            val h = dev.displayHeight
            val root = ui.rootInActiveWindow
            val roots = if (root != null) {
                try {
                    ScreenTree.build(root, w, h)
                } finally {
                    root.recycle()
                }
            } else {
                emptyList()
            }
            traversals++
            val snap = Snapshot(
                version = v,
                roots = roots,
                hash = ScreenHash.structural(roots, w, h),
                stateHash = ScreenHash.state(roots, w, h),
                screenW = w,
                screenH = h
            )
            prevSnapshot = lastSnapshot
            lastSnapshot = snap
            lastBuiltAtVersion = v
            return snap
        }
    }

    /** The one retained previous snapshot (for `diff`); null before the second build. */
    fun previous(): Snapshot? = prevSnapshot

    /**
     * Wait until no AX event has arrived for [quietMs], bounded by [timeoutMs].
     * Returns ms actually waited. Observes for at least [quietMs] so events the
     * action is about to emit are not missed by an early return.
     */
    fun waitForQuiet(quietMs: Long, timeoutMs: Long): Long {
        val start = System.currentTimeMillis()
        synchronized(waitLock) {
            while (true) {
                val now = System.currentTimeMillis()
                val elapsed = now - start
                if (elapsed >= timeoutMs) return elapsed
                val sinceEvent = now - lastEventAtMs
                if (sinceEvent >= quietMs && elapsed >= quietMs) return elapsed
                val waitMs = minOf(quietMs - sinceEvent, timeoutMs - elapsed).coerceAtLeast(1L)
                try {
                    waitLock.wait(waitMs)
                } catch (_: InterruptedException) {
                    return System.currentTimeMillis() - start
                }
            }
        }
    }

    /** Result of the two-phase outcome settle ([settleAfterAction]). */
    class SettleResult(
        /** "no-event" (phase 1 timed out), "quiet" (went idle), or "timeout". */
        val settled: String,
        /** ms from action to the first AX event; -1 when none arrived. */
        val firstEventMs: Long,
        /** ms spent in phase 2 waiting for quiet; 0 when settled == "no-event". */
        val idleMs: Long
    )

    /**
     * Two-phase outcome settle (ticket §2). On a cold emulator the navigation's
     * first AX event can arrive ~1.3 s after the tap, so a single short quiet
     * window trips before the screen has even begun to change and the outcome
     * falsely reports `after == before`. Split the wait:
     *
     *  - Phase 1: wait up to [firstEventTimeoutMs] for the AX clock to advance
     *    past [fromVersion] — the first event the just-run action caused. If none
     *    arrives, the action didn't move the UI: return settled="no-event"
     *    (firstEventMs = -1), and the caller keeps `after == before`.
     *  - Phase 2: wait for [quietMs] of no events, bounded by [idleTimeoutMs]
     *    (measured separately from phase 1). settled="quiet" if it went idle,
     *    "timeout" if the bound hit first.
     */
    fun settleAfterAction(
        fromVersion: Long,
        firstEventTimeoutMs: Long,
        quietMs: Long,
        idleTimeoutMs: Long
    ): SettleResult {
        val start = System.currentTimeMillis()
        synchronized(waitLock) {
            while (version <= fromVersion) {
                val remaining = firstEventTimeoutMs - (System.currentTimeMillis() - start)
                if (remaining <= 0) return SettleResult("no-event", -1L, 0L)
                try {
                    waitLock.wait(remaining)
                } catch (_: InterruptedException) {
                    return SettleResult("no-event", -1L, 0L)
                }
            }
        }
        val firstEventMs = System.currentTimeMillis() - start
        val idleMs = waitForQuiet(quietMs, idleTimeoutMs)
        // waitForQuiet returns as soon as it detects quiet (elapsed < timeout) and
        // only returns elapsed >= timeout when the bound was hit first.
        val settled = if (idleMs >= idleTimeoutMs) "timeout" else "quiet"
        return SettleResult(settled, firstEventMs, idleMs)
    }

    /**
     * Rebuild the tree until it is non-empty (has nodes and isn't [EMPTY_TREE_HASH]),
     * bounded by [timeoutMs]. Used after a settle that landed on a transient empty
     * frame (a screen caught mid-transition) so the outcome hashes a real screen.
     * Waits on the AX clock between rebuilds; returns the first non-empty snapshot,
     * or the last (still-empty) one if the bound elapses.
     */
    fun awaitNonEmptyTree(timeoutMs: Long): Snapshot {
        val deadline = System.currentTimeMillis() + timeoutMs
        var snap = ensure()
        while (snap.roots.isEmpty() || snap.hash == EMPTY_TREE_HASH) {
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) return snap
            val v = awaitVersionChange(snap.version, remaining)
            if (v <= snap.version) return snap
            snap = ensure()
        }
        return snap
    }

    /**
     * Block until [version] advances past [fromVersion], bounded by [timeoutMs].
     * Returns the version observed on wake — `<= fromVersion` means it timed out.
     */
    fun awaitVersionChange(fromVersion: Long, timeoutMs: Long): Long {
        val deadline = System.currentTimeMillis() + timeoutMs
        synchronized(waitLock) {
            while (version <= fromVersion) {
                val remaining = deadline - System.currentTimeMillis()
                if (remaining <= 0) return version
                try {
                    waitLock.wait(remaining)
                } catch (_: InterruptedException) {
                    return version
                }
            }
            return version
        }
    }
}
