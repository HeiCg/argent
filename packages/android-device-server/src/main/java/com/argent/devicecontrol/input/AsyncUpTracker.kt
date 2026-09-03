package com.argent.devicecontrol.input

/**
 * Tracks a `tap`'s asynchronously-queued final ACTION_UP and enforces the R1
 * ordering rule (phase 3g).
 *
 * A `tap` returns as soon as its final ACTION_UP is queued (async), so a
 * following capture must flush that pending UP before reading the tree or it
 * would see the mid-press (finger-down) state. The flush is a single
 * SYNCHRONOUS no-op injection: because the input dispatcher delivers FIFO,
 * blocking on the no-op guarantees the UP queued ahead of it was delivered.
 *
 * The correctness bug this class fixes (R1): the flag MUST be cleared only
 * AFTER the synchronous flush actually returns. The phase-3e code cleared it
 * first, so if the flush injection threw (or was dropped) the tracker would
 * wrongly believe the UP was drained and the NEXT capture would skip the flush,
 * reading a stale finger-down tree. Clearing after the inject means a failed
 * flush leaves the flag set for the next capture to retry.
 *
 * Pure (no Android types) so the ordering is unit-testable off-device.
 */
class AsyncUpTracker {

    @Volatile private var outstanding = false
    @Volatile var lastX = 0f
        private set
    @Volatile var lastY = 0f
        private set

    /** Whether a tap's final ACTION_UP is still queued but not yet drained. */
    fun hasOutstanding(): Boolean = outstanding

    /** Record that a tap left an async ACTION_UP in flight at (x, y). */
    fun markOutstanding(x: Float, y: Float) {
        lastX = x
        lastY = y
        outstanding = true
    }

    /**
     * Drain a pending async UP: run [syncInject] (the synchronous no-op flush)
     * and clear the flag ONLY after it returns normally (R1). No-op when nothing
     * is outstanding. If [syncInject] throws, the flag stays set so the next
     * capture retries the drain rather than reading a mid-press tree.
     */
    fun drainWith(syncInject: (Float, Float) -> Unit) {
        if (!outstanding) return
        syncInject(lastX, lastY)
        outstanding = false
    }

    /**
     * Force a flush regardless of the flag (the `flushInput` RPC after a
     * cross-process fast-inject action, whose UP this tracker never saw): run
     * [syncInject] and clear the flag AFTER it returns (R1 ordering, same rule).
     */
    fun flushWith(syncInject: () -> Unit) {
        syncInject()
        outstanding = false
    }

    /** Clear the flag directly — a gesture's own synchronous final UP drained the queue. */
    fun clear() {
        outstanding = false
    }
}
