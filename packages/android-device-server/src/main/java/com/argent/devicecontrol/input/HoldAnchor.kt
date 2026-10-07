package com.argent.devicecontrol.input

/**
 * Timing rule for a held (momentum-free) swipe's hold (review E-1 2026-10-07
 * finding 4). Pure, so it is unit-tested on the JVM.
 *
 * [MotionInjector] paces every frame against `downTime + tMs`. When the travel
 * frames dispatch late (a loaded emulator), every hold frame's slot is already in
 * the past by the time travel ends, so the hold frames and the UP go out back to
 * back: the 120 ms hold collapses to a few ms of IPC and the VelocityTracker still
 * reads the travel velocity at the lift (the fling the CI runs showed). The
 * anchor rule makes the hold absolute: frames after the last travel frame are
 * shifted by that frame's lateness, so the UP is never earlier than the anchor's
 * REAL arrival plus the scheduled hold, which also keeps it no earlier than
 * `downTime + durationMs + holdMs` on the device clock.
 */
object HoldAnchor {

    /** Delay to add to every frame after the anchor: its lateness, never negative. */
    fun shiftMs(scheduledAt: Long, actualAt: Long): Long = maxOf(0L, actualAt - scheduledAt)

    /** `to - from` on the device clock, or -1 when either end was not recorded. */
    fun spanMs(from: Long, to: Long): Long = if (from < 0 || to < 0) -1L else to - from
}
