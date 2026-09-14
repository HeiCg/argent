package com.argent.devicecontrol

import android.app.UiAutomation
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
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

    /**
     * Monotonic AX clock. Bumped only by [onEvent] (`version++`); never decreases,
     * and only advances while the clock is armed.
     *
     * Phase 3m.1 (3M-H4) — the reporting guarantee the read RPCs must honour: a
     * reply's `version` describes the SAME tree as its `hash`. Handlers therefore
     * read this clock ONCE, before the capture, and — when a fingerprint is built —
     * report the snapshot's own [Snapshot.version] (captured under [buildLock] with
     * the hash), NEVER a live volatile read taken after the capture (which can have
     * advanced past the tree the reply carries). While the clock is UNARMED this
     * counter is pinned at 0 and carries no information, so it is reported ABSENT,
     * never as a literal 0 a host could replay as `sinceVersion: 0`.
     */
    @Volatile
    var version: Long = 0L
        private set

    /** Number of real tree builds. Exposed via `getInfo` so tests assert cache hits. */
    @Volatile
    var traversals: Long = 0L
        private set

    @Volatile
    private var lastEventAtMs: Long = 0L

    // Phase 3m (C2): the AX event listener is registered LAZILY, on the first RPC
    // that needs the version clock or fingerprints (see [armClock]), not at
    // instrumentation start. The default open path (plain describe / tap latency)
    // then runs the pre-0.1.21 process shape with no always-on `UiAutomation`
    // event dispatch. `version` stays 0 and `unchanged` is not reported while the
    // clock is unarmed; callers that need the clock arm it explicitly.
    @Volatile
    private var clockArmed: Boolean = false
    private val armLock = Any()

    // Guards version bumps + the awaitChange / waitForQuiet condition waits.
    private val waitLock = Object()

    // Serialises tree builds so two connections never traverse concurrently.
    private val buildLock = Any()

    private var uiDevice: UiDevice? = null
    private var uiAutomation: UiAutomation? = null

    private var lastBuiltAtVersion: Long = -1L
    // Phase 3m.1 (3M-M6): the cache is keyed on (root source, version), so a
    // snapshot built from a capture's provided windows-snapshot root is never
    // served to a root-less internal caller (query / diff / outcome) that expects a
    // `rootInActiveWindow` build. `true` when [lastSnapshot] was built from a
    // caller-provided root.
    private var lastBuiltFromProvidedRoot: Boolean = false
    private var lastSnapshot: Snapshot? = null
    private var prevSnapshot: Snapshot? = null

    class Snapshot(
        val version: Long,
        val roots: List<AxNode>,
        /**
         * Structural (`H`), state (`H_text`) and identity (`H_id`) fingerprints —
         * or `null` when the forest is EMPTY. Phase 3m.1 (3M-H1): a fingerprint is
         * NEVER computed from an empty forest. An empty `ScreenTree.build` folds no
         * bytes, so [ScreenHash.structural] / [ScreenHash.state] return the bare
         * FNV offset ([EMPTY_TREE_HASH]) and [ScreenHash.identity] a package-only
         * hash that *looks* like a real screen — either one mints a transient
         * mid-transition frame as a graph node (the run-34827025184 store failure).
         * Instead the snapshot carries no fingerprint; the read RPCs omit
         * `hash`/`stateHash`/`idHash` (absent ⇒ not a screen) and the caller retries.
         */
        val hash: String?,
        val stateHash: String?,
        /**
         * `H_id` — the SCREEN IDENTITY (screen-graph Phase D §1): stable across
         * scroll/focus, distinct across sibling screens. The host graph keys nodes
         * by this, not by [hash] (which collapses every Settings detail screen onto
         * one value). See [ScreenHash.identity]. `null` on an empty forest.
         */
        val idHash: String?,
        val screenW: Int,
        val screenH: Int
    ) {
        /** No kept nodes — a transient mid-transition frame, not a real screen. */
        val isEmpty: Boolean get() = roots.isEmpty()
    }

    /**
     * Record the [UiDevice] / [UiAutomation] handles at server start. Phase 3m:
     * this NO LONGER registers the AX-event listener — see [armClock]. Until the
     * clock is armed the process carries no `OnAccessibilityEventListener`, so the
     * default open path (plain describe, tap latency) never pays the always-on
     * event-dispatch tax the screen-graph merge introduced (C2).
     */
    fun init(uiDevice: UiDevice, uiAutomation: UiAutomation) {
        this.uiDevice = uiDevice
        this.uiAutomation = uiAutomation
        lastEventAtMs = System.currentTimeMillis()
    }

    /**
     * Register the AX-event listener so the version clock advances. Idempotent and
     * lazy: called by the first RPC that needs versions / fingerprints (opt-in
     * `getState` / `getAccessibilityTree`), by `query` / `diff` / `awaitChange`,
     * and by the outcome-bearing actions. A no-op once armed.
     *
     * NOTE (ticket "beware the UiAutomation flag setup"): setting an
     * OnAccessibilityEventListener does NOT break `UiDevice.waitForIdle` —
     * UiAutomation keeps updating its internal last-event timestamp regardless of
     * a registered listener, and `executeAndWaitForEvent`/`waitForIdle` read that,
     * not this callback. We only READ `eventType` and never retain the event.
     */
    fun armClock() {
        if (clockArmed) return
        synchronized(armLock) {
            if (clockArmed) return
            val ui = uiAutomation ?: return
            lastEventAtMs = System.currentTimeMillis()
            ui.setOnAccessibilityEventListener { event ->
                when (event?.eventType) {
                    AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
                    AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
                    AccessibilityEvent.TYPE_VIEW_SCROLLED,
                    AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> onEvent()
                    else -> { /* ignore other event types */ }
                }
            }
            clockArmed = true
        }
    }

    /** Whether the AX-event listener is registered (the clock is advancing). */
    fun isClockArmed(): Boolean = clockArmed

    /**
     * Count a full active-window forest walk performed by a CAPTURE path
     * (`getState` / `getAccessibilityTree` serialization) that did not go through
     * [ensure]. Together with the [ensure] build counter this makes [traversals]
     * the number of real forest walks, so a test around an after-tap describe reads
     * 1 (the capture only) with the phase-3m fix and 2 on the pre-fix build (the
     * forced [ensure] rebuild + the capture). Diagnostic; not on any hot lock.
     */
    fun recordCaptureTraversal() {
        traversals++
    }

    private fun onEvent() {
        synchronized(waitLock) {
            version++
            lastEventAtMs = System.currentTimeMillis()
            waitLock.notifyAll()
        }
    }

    /**
     * Build-or-cache the current tree. Only a real rebuild increments [traversals].
     *
     * Phase 3m (C1/C2): when [providedRoot] is non-null the rebuild uses THAT root
     * — the one the capture already resolved from the interactive-windows snapshot
     * (`NestedWindowSerializer.activeRoot`) — instead of calling
     * `uiAutomation.rootInActiveWindow`, so a fingerprint rebuild on the capture
     * path never re-enters the ~170-210 ms mid-transition binder block the phase-3g
     * fix removed from the hot path. The caller owns [providedRoot] (it is NOT
     * recycled here); the same node the describe serialized is hashed. With no
     * [providedRoot] (the internal `query` / `diff` / outcome paths) the behaviour
     * is unchanged.
     */
    fun ensure(providedRoot: AccessibilityNodeInfo? = null): Snapshot {
        synchronized(buildLock) {
            val v = version
            val fromProvided = providedRoot != null
            val cached = lastSnapshot
            // Phase 3m.1 (3M-M6): serve the cache only when the clock is ARMED, the
            // version matches AND the cached snapshot came from the same root source.
            //  - Root source: a windows-snapshot (capture) build and a
            //    `rootInActiveWindow` (query/diff/outcome) build resolve different
            //    roots; serving one to the other can produce a spurious `diff`.
            //  - Armed gate: while the clock is unarmed `version` is pinned at 0, so
            //    `lastBuiltAtVersion == 0 == v` would hold forever and serve the very
            //    first snapshot regardless of what is on screen. Requiring
            //    [clockArmed] makes the cache reachable only once the version clock
            //    is real; an unarmed caller always gets a fresh build.
            if (cached != null &&
                clockArmed &&
                lastBuiltAtVersion == v &&
                lastBuiltFromProvidedRoot == fromProvided
            ) return cached

            val dev = uiDevice ?: throw IllegalStateException("TreeStore not initialized")
            val w = dev.displayWidth
            val h = dev.displayHeight
            // Reuse the capture's already-resolved root, or fall back to a fresh
            // rootInActiveWindow (recycled here) for the internal callers.
            val ownsRoot = providedRoot == null
            val root = providedRoot
                ?: (uiAutomation ?: throw IllegalStateException("TreeStore not initialized")).rootInActiveWindow
            var pkg = ""
            val roots = if (root != null) {
                try {
                    // Cheap: the active-window package off the root we already hold,
                    // no extra traversal / idle wait. Part of H_id (design D §1).
                    pkg = root.packageName?.toString() ?: ""
                    ScreenTree.build(root, w, h)
                } finally {
                    if (ownsRoot) root.recycle()
                }
            } else {
                emptyList()
            }
            traversals++
            // Phase 3m.1 (3M-H1): an empty forest gets NO fingerprint — see [Snapshot].
            val isEmpty = roots.isEmpty()
            val snap = Snapshot(
                version = v,
                roots = roots,
                hash = if (isEmpty) null else ScreenHash.structural(roots, w, h),
                stateHash = if (isEmpty) null else ScreenHash.state(roots, w, h),
                idHash = if (isEmpty) null else ScreenHash.identity(roots, pkg),
                screenW = w,
                screenH = h
            )
            prevSnapshot = lastSnapshot
            lastSnapshot = snap
            lastBuiltAtVersion = v
            lastBuiltFromProvidedRoot = fromProvided
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
        // Phase 3m.1 (3M-H1): an empty forest now yields a null hash; guard on
        // [Snapshot.isEmpty] (and keep the EMPTY_TREE_HASH belt-and-suspenders for a
        // legacy build that still folds the bare offset).
        while (snap.isEmpty || snap.hash == null || snap.hash == EMPTY_TREE_HASH) {
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
