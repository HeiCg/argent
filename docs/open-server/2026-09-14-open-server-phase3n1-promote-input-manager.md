# Ticket: phase 3n.1 — promote `input-manager` as the default injector (run 2, gates vs proprietary)

Status: dispatched 2026-09-14. Follows `2026-09-14-review-3n-run1-findings.md` (read it in
full; 3N-H1..H6, 3N-M1..M11 are work items; its "Promotion recommendation (b)" gates
P0–P10 are the pre-registered acceptance, copied verbatim into the `## Result` of the 3n
ticket BEFORE the run). Base: `feat/open-server-3n-kotlin-injector` @ a61c47d5, same
worktree `../argent-fork-wt-3n`; merge `open/main` @ 10fb1ea6 first (docs only since
8315e396, clean).

## Decisions (planner, from the review)
- Default injection strategy = `input-manager` for tap, swipe, pinch and multi-pointer
  gesture; automatic fallback `uia-async` on a hiddenapi block (already implemented).
  The earlier "input-manager for tap/pinch, uia for swipe" split is dropped: not
  supported by run 34853156073.
- scrcpy is NOT removed in this ticket. Removal ships in the PR after run 2 is green
  (3n.2), so the flip is revertible in one commit.
- Fling: instrument first. The fling section of run 2 is REPORTED, never gating (P8); no
  fling claim either way. Fling metric repair (censored/quantized anchor-displacement,
  3N-H3) is a separate ticket (3o).
- Every gate references the PROPRIETARY blocks, never ON-scrcpy. Drift floors are
  measured, never defaulted (P1) — fix `scoreboard.js` / `merge-blocks.js` so a missing
  comparator yields `N/A`, not `±2`.

## Work
1. Default flip: `open-server-input.ts` resolves `input-manager` when no strategy is set
   (`ARGENT_OPEN_INJECT_STRATEGY` still overrides; `uia-sync` = the old default remains
   selectable). Kotlin default unchanged (host sends `inject` explicitly). Unit tests:
   default path now sends `inject:"input-manager"`; forced-fallback test that makes
   `InputManagerInjector.probe()` fail and asserts `strategy=="unavailable"`,
   `fellBackTo=="uia-async"`, unchanged outcome (P9) — device-test case plus a host test
   with a stubbed reply.
2. Per-RPC strategy echo: every tap/swipe/gesture reply carries `strategy`; the bench
   counts `injectStrategyReported` as `input-manager: n/n` per block (P7, 3N-M1).
3. Per-sample latency arrays for every verb in the block JSON (3N-H5), and a 10 000-draw
   bootstrap 95 % CI on the p50 difference vs OFF in the scoreboard for gated verbs.
4. Blocks for run 2: `OFF-1, ON-uiautomation, ON-input-manager, ON-scrcpy, OFF-2`
   (P0 control block mandatory); strategy arms' `bench-log-*.txt` staged in the artifact
   (3N-M5); fling arms `ON-uia-A, ON-uia-B, ON-input-manager, ON-scrcpy, off`
   interleaved per sample (P8, 3N-M7), grading written to `fling-ab-*.json` for every
   arm (3N-M4), per-cell inter-arrival histogram from dumpsys where available.
5. Gates P0–P10 implemented in `merge-blocks.js` / `scoreboard.js` / `gates.test.js`
   (tests on the run-34853156073 artifact must reproduce the review's per-verb table:
   tap +2 parity, swipe −39 win, pinch −28 win, headline −45 parity/win at floor 103).
6. One CI run `suite=both`, `sg_mode=matrix`, blocks as above. Polling: one `gh run view`
   per 10 min as a single `run_in_background` Bash call `sleep 540; gh run view <id>
   --json status,conclusion,jobs`; never loop; one `gh run download` per artifact. If a
   harness defect surfaces, fix and STOP (planner decides on a re-run). If the latency job
   risks the 120-min limit with 5 blocks + 5 fling arms, say so BEFORE triggering and
   propose the split (e.g. fling N=8 per cell-arm) — do not silently shrink N.
7. `## Result (3n.1)` on the 3n ticket: P0–P10 with PASS/FAIL/N/A as pre-registered,
   verb table vs OFF with CIs and vs run 34853156073, landing/fallback counts with
   denominators, strategy echo counts, fling A/B instrument verdict then per-arm
   numbers (reported), screen-graph vs 34813849446 and 34853156073 side by side,
   `skippedNoIdHash`. Scoreboard untouched; `open/main` not fast-forwarded.

## Acceptance
P0–P7 + P9 + P10 green as pre-registered → `input-manager` is the default on the
branch, ready for review and the 3n.2 scrcpy-removal PR. Otherwise: report which gate
failed by how much with its CI; no default flip.
