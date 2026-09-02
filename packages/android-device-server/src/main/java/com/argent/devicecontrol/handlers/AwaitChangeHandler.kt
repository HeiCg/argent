package com.argent.devicecontrol.handlers

import com.argent.devicecontrol.TreeStore
import com.argent.devicecontrol.accessibility.ScreenSelector
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * `awaitChange { fromVersion, timeoutMs, until?, settle?, quietMs? }` — block on
 * the AX-event clock and return as soon as `version > fromVersion` (and, when
 * `until` selector is given, when it matches, re-checked on each event). Returns
 * `{ version, hash, stateHash, changed, timedOut }`.
 *
 * With `settle: true` (ticket §3), after the first event (or the matching event)
 * it ALSO waits for the AX clock to go quiet — no event for `quietMs` (default
 * 80), bounded by the remaining await budget — then re-hashes, so a caller that
 * wants the "next stable state" gets it in one call. Default (`settle` absent)
 * is unchanged: return on the first event.
 *
 * The TCP server runs one thread per connection, so a blocking await only holds
 * ITS connection — other clients are unaffected. As a safety valve against a
 * client opening many parallel awaits, at most [MAX_CONCURRENT] run at once.
 */
class AwaitChangeHandler {

    private companion object {
        const val MAX_CONCURRENT = 4
    }

    private val active = AtomicInteger(0)

    fun execute(params: JSONObject): JSONObject {
        val fromVersion = params.optLong("fromVersion", TreeStore.version)
        val timeoutMs = params.optLong("timeoutMs", 5_000L)
        val until = params.optJSONObject("until")
        val settle = params.optBoolean("settle", false)
        val quietMs = params.optLong("quietMs", 80L)

        if (!tryAcquire()) {
            throw IllegalStateException("too many concurrent awaitChange (max $MAX_CONCURRENT)")
        }
        try {
            val deadline = System.currentTimeMillis() + timeoutMs
            var baseline = fromVersion
            while (true) {
                val remaining = deadline - System.currentTimeMillis()
                if (remaining <= 0) return timedOut(fromVersion)

                val v = TreeStore.awaitVersionChange(baseline, remaining)
                if (v <= baseline) return timedOut(fromVersion)

                // Version advanced. With no `until`, that's the answer.
                val snap = TreeStore.ensure()
                if (until == null) return settled(snap, settle, quietMs, deadline)
                if (ScreenSelector.matchesAny(snap.roots, until)) {
                    return settled(snap, settle, quietMs, deadline)
                }
                // Matched nothing yet: wait for the next event past this version.
                baseline = v
            }
        } finally {
            active.decrementAndGet()
        }
    }

    /**
     * Finish an await hit. When [doSettle], wait for quiet (no event for
     * [quietMs], bounded by the await [deadline]) then re-hash the settled tree
     * so the result reflects the next stable state rather than the first frame.
     */
    private fun settled(snap: TreeStore.Snapshot, doSettle: Boolean, quietMs: Long, deadline: Long): JSONObject {
        if (!doSettle) {
            return result(snap.version, snap.hash, snap.stateHash, changed = true, timedOut = false)
        }
        val remaining = (deadline - System.currentTimeMillis()).coerceAtLeast(0L)
        TreeStore.waitForQuiet(quietMs, remaining)
        val stable = TreeStore.ensure()
        return result(stable.version, stable.hash, stable.stateHash, changed = true, timedOut = false)
    }

    private fun timedOut(fromVersion: Long): JSONObject {
        val snap = TreeStore.ensure()
        return result(snap.version, snap.hash, snap.stateHash, changed = snap.version > fromVersion, timedOut = true)
    }

    private fun result(version: Long, hash: String, stateHash: String, changed: Boolean, timedOut: Boolean): JSONObject =
        JSONObject().apply {
            put("version", version)
            put("hash", hash)
            put("stateHash", stateHash)
            put("changed", changed)
            put("timedOut", timedOut)
        }

    private fun tryAcquire(): Boolean {
        while (true) {
            val c = active.get()
            if (c >= MAX_CONCURRENT) return false
            if (active.compareAndSet(c, c + 1)) return true
        }
    }
}
