package com.argent.devicecontrol.accessibility

/**
 * Per-stage timing collector for one nested multi-window capture (phase 3g).
 *
 * Filled by [NestedWindowSerializer.serialize] and surfaced by the state /
 * hierarchy handlers as `timings` in the RPC response, so the bench can attribute
 * the after-tap `captureMs` to a concrete stage (window enumeration vs each
 * `w.root` binder call vs the node serialization) instead of guessing from
 * logcat. Pure (no Android types).
 */
class WindowTimings {
    /** Time to enumerate `uiAutomation.windows` (the sorted snapshot). */
    var windowsMs: Long = 0

    /** Time of each kept window's `w.root` binder call, in serialize order. */
    val rootsMs: MutableList<Long> = mutableListOf()

    /** Total time spent in `NodeSerializer.serializeNested` across kept windows. */
    var serializeMs: Long = 0
}
