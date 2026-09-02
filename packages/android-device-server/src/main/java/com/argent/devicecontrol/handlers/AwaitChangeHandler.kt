package com.argent.devicecontrol.handlers

import com.argent.devicecontrol.TreeStore
import com.argent.devicecontrol.accessibility.ScreenSelector
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * `awaitChange { fromVersion, timeoutMs, until? }` — block on the AX-event clock
 * and return as soon as `version > fromVersion` (and, when `until` selector is
 * given, when it matches, re-checked on each event). Returns `{ version, hash,
 * stateHash, changed, timedOut }`.
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
                if (until == null) return result(snap.version, snap.hash, snap.stateHash, changed = true, timedOut = false)
                if (ScreenSelector.matchesAny(snap.roots, until)) {
                    return result(snap.version, snap.hash, snap.stateHash, changed = true, timedOut = false)
                }
                // Matched nothing yet: wait for the next event past this version.
                baseline = v
            }
        } finally {
            active.decrementAndGet()
        }
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
