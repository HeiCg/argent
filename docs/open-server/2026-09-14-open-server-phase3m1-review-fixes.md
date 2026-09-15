# Ticket: phase 3m.1 — fix the 3m REJECT findings, rebase on the consolidated base, one run

Status: dispatched 2026-09-14. Read first: `2026-09-14-review-3m-findings.md` (every
3M-H*, 3M-M*, 3M-L\* item is a work item), the 3m ticket + `## Result`, the root-cause doc,
`README.md` rules. Base: rebase (or merge) `fix/open-server-fingerprints-opt-in` onto
`open/main` @ a75ad75d (3k.1 merged: pacing default legacy, pre-registered fling gate,
current device-test suite). Same worktree `../argent-fork-wt-3m`. Never touch the main
checkout or /tmp; no npm install/gradle/emulator; vitest `--maxWorkers=2`; Kotlin compiles
in CI only — read every Kotlin edit twice.

## Work

1. **3M-H1 — screen-graph store integrity.** Find why a node was minted from an empty
   tree (`structuralHash == stateHash == EMPTY_TREE_HASH`, `skippedNoIdHash` 1, edge
   `taptext=Internet` with 2 destinations) on the fingerprints-ON path: likely
   `ensure(providedRoot)` receiving a root whose forest is empty/stale at the moment the
   opt-in caller (navigate-to / wiring / harness) reads it, or a caller that lost its
   opt-in and fell back to an empty fingerprint. Rule: a fingerprint is NEVER computed
   from an empty forest — return no fingerprint (absent) and let the caller retry, and
   the store must refuse to mint a node from `EMPTY_TREE_HASH`. Unit-test both (Kotlin
   logic mirrored in the host store test with the run's JSON). The D.3 invariants gate
   (`bench-screen-graph.ts:2781-2786`) must be green and its exit code honoured.
2. **3M-H4 — snapshot version.** `version` and `unchanged` come from the capture's
   snapshot (taken once, before/with the forest walk), never from a live volatile read
   after the capture; hash and version must describe the same tree. Version before the
   clock is armed is reported as absent (or a distinct sentinel), never overloaded with 0.
   Document the monotonicity guarantee in the Kotlin comment; unit test.
3. **3M-H5 — arm the clock everywhere a wait depends on it.** `await-ui-element`
   (`open-server-describe.ts:49`, `await-ui-element/index.ts:482-493`) and any other
   awaiter must arm (`fingerprints`/`sinceVersion`) before relying on `awaitChange`.
   Grep every `awaitChange` / `sinceVersion` caller and list them in the Result.
4. **3M-M6 — cache invalidation while unarmed.** `ensure()` must not serve a
   root-source-heterogeneous cache; key the cache on (root source, version) and
   invalidate when unarmed reads happen; unit test.
5. **3M-H2 — like-for-like.** After the rebase the default pacing is legacy; the latency
   bench and fling A/B pin `ARGENT_SCRCPY_PACING` explicitly per arm so no run can
   silently change it; state the pacing mode in every block's JSON.
6. **3M-M1 — gates as pre-registered.** Report the six 3m gates exactly as written in
   the 3m ticket (no redefinition): G3 describe idle ON ≤ OFF+10 on BOTH arms, G6 ratio
   ≤ 1.15 on BOTH arms. A failing gate is reported as failing.
7. **3M-M2 / M4 / M5.** Per-block ON-uia shift (ping, encode, describe) reported as a
   whole-block shift with the listener hypothesis still marked inference; add a bench
   variant that requests `fingerprints:true` for one describe block so `fingerprintMs`
   is measured, not tautologically 0; persist per-sample stage arrays (not only p50/p95)
   in the block JSON so residuals can be recomputed.
8. **3M-H3 attribution.** In the report, split the headline move by arm (scrcpy −267,
   uia −30 inside floor) and state what the fix explains and what it does not; do not
   claim the Kotlin fix explains a scrcpy-only move without evidence (candidate: the
   scrcpy read path's deferred flush + fingerprint rebuild interaction — measure with the
   3g stages per arm).
9. One CI run `suite=both`, `sg_mode=matrix` on the rebased branch. Polling: one
   `gh run view` per 10 min as a single `run_in_background` Bash call
   `sleep 540; gh run view <id> --json status,conclusion,jobs`; never loop; one
   `gh run download` per artifact. Append `## Result (3m.1)` to the 3m ticket with a
   finding-by-finding table, the six gates as pre-registered, the stage table per arm
   with per-sample residuals, verb table vs run 34813849446 (both ON arms, drift
   floors), fling per-cell under the pre-registered rule, screen-graph per-config success
   - tokens + invariants line + store shapes vs 34813849446. Scoreboard untouched;
     `open/main` not fast-forwarded.

## Acceptance

Invariants gate green with `skippedNoIdHash` 0 and no `EMPTY_TREE_HASH` node; all
awaiters arm the clock; version/hash from one snapshot; pacing pinned and legacy; six
gates reported as pre-registered; headline attributed per arm honestly.
