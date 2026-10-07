package com.argent.churnapp

/**
 * Deterministic seeded content for the Phase E churn experiment (E-1).
 *
 * The ROW TITLE is position-stable (`Story <i>`) so the OFF (control) arm keys a
 * tap edge on stable text — and, because the DETAIL headline it leads to churns
 * with the seed, the same `(from, tap Story i)` edge gains a new destination each
 * session, which is exactly the `duplicateEdgeTargets` break the template arm
 * folds away (E-0 §F4). The ROW SUMMARY / DETAIL HEADLINE churn with the seed so
 * the feed's `stateHash` moves every session (the volatile-content case, R4) and
 * every item's detail screen gets a distinct on-device `H_id` (the explosion
 * regime, E-0 §F2) — linear growth on the OFF arm, one template node on the ON arm.
 */
object Items {
    fun rowTitle(i: Int): String = "Story $i"

    fun rowSummary(seed: Int, i: Int): String = "Headline $seed-$i"
}
