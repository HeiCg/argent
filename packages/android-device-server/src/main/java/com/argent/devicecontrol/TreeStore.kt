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
