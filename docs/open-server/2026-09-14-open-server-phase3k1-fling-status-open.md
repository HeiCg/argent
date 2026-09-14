# Ticket: phase 3k.1 — fling stays OPEN; pacing opt-in, pre-registered gate, one measurement run on the consolidated base

Status: dispatched 2026-09-14. Follows the REJECT of 3k part A in
`2026-09-14-review-3k-findings.md` (every 3K-H*, 3K-M*, 3K-L* item is a work item;
its `## Gate recommendation` is the pre-registered rule; its `## Scoreboard rows
allowed` is the whitelist). Part B of 3k (F5/F6/F7/F12/F13/F19, gate unit tests,
whitelist removal, floor exclusion) is ACCEPT-grade and stays as is.

## Decisions (planner, 2026-09-14)
- Fling deficit status: **OPEN**, not resolved. Run 7's 400 ms under-scroll did not
  reproduce on `open/main` @ 690e66bc in either arm (legacy scrcpy/off 0.90/0.88/0.95
  vs run 7's 0.64/0.58/0.71), and drift vs legacy is indistinguishable (permutation
  p >= 0.08, N = 11–12). That run also carried the outcome-path regression on the
  swipe RPC (settle inside the RPC), which contaminates the scroll measurement, so it
  cannot be the fling reference.
- Pacing: drift-corrected writes become **opt-in** (`ARGENT_SCRCPY_PACING=drift`,
  default `legacy` = the pre-3k code path, byte-equal behaviour). The A/B keeps both
  arms so every run adds a paired sample; no default changes until a same-run paired
  effect clears p < 0.05 with the pre-registered gate green.
- Gate rule (pre-registered now, before the next run): the reviewer's three changes
  to `merge-fling.js` — (1) reference-bimodality exclusion keyed on the reference
  arms only (`q25(uia) <= SCROLL_FLOOR + eps`, likewise `off` when used as a
  denominator), never on scrcpy; (2) power floor `n >= 10` on EVERY arm entering a
  gated ratio, `off` included; (3) two-sided reference on surviving cells:
  `|scrcpy/uia - 1| <= 0.15` AND `|scrcpy/off - 1| <= 0.15`. Verdict string:
  `PASS|FAIL (per-cell ±0.15 on scrcpy/uia AND scrcpy/off, NO whitelist, over k
  informative cell(s); m of 6 non-informative at the metric floor)`. Unit tests must
  show the rule stays RED on run 7's artifact numbers (3 red cells) and yields the
  reviewer's per-cell table on run 34800933407.
- Reference run: the ONE `suite=both` run this ticket triggers on the merged
  `open/main` (3k + regression fix + D.4.1) is the single scoreboard reference for
  latency, fling status and screen-graph. Its verb table is diffed against run 7 and
  run 34806342684 before anything is published.

## Work
Base: merge `feat/open-server-3k` into `open/main` @ ad0f7423 first (the planner does
the merge; it is clean). Then branch `feat/open-server-3k1` off the merged `open/main`,
worktree `../argent-fork-wt-3k1` (never /tmp; root `node_modules` symlinked; no npm
install/gradle; vitest `--maxWorkers=2`; no emulator).

1. `packages/tool-server/src/utils/scrcpy-inject-backend.ts`: `injectTimeline` selects
   legacy vs drift by `ARGENT_SCRCPY_PACING` (default legacy). Legacy must be the
   pre-3k loop verbatim (`git show 690e66bc:packages/tool-server/src/utils/scrcpy-inject-backend.ts`
   is the source of truth). Unit test both paths; keep the loud Kotlin fallback.
2. Fling A/B harness (`bench-fling-fidelity.ts` / workflow): interleave arms per cell
   (round-robin legacy / drift / uia / off within each cell) instead of sequential
   7-minute blocks (3K-M6); record the drop reason for every missing sample and print
   n per cell-arm (3K-M1); N per cell-arm stays 12 unless the job budget allows 24
   (say which in the Result).
3. Mechanism evidence (3K-H3): make the host `[pacing-trace]` lines reach the fling log
   artifact (the harness currently swallows backend stdout/log), and capture device-side
   MotionEvent times for the swipe with `adb shell dumpsys input` (RecentQueue /
   "InputDispatcher recent events" list eventTime per MotionEvent; read it immediately
   after each fling in the device-test step) since `InputDispatcher VERBOSE` logs
   nothing on this image. Label the delivered-duration row by its true source and N.
4. Gate: implement the pre-registered rule in `merge-fling.js`, add tests (run 7 stays
   red on 3 cells; 34800933407 yields 3 PASS / 3 non-informative), and print the
   verdict string above.
5. Docs: rewrite `2026-09-13-open-server-3k-results-ci.md` per the findings (drop
   "resolved"/"fix works"; same-run paired test with p-values; cross-run sentence as the
   reviewer phrased it; delivered-duration row caveated; await-* deviations listed;
   `tap+describe(settle:true)` row included; superseded-run numbers shown). Append
   `## Result (3k.1)` to the 3k ticket.
6. One CI run `suite=both`, `sg_mode=matrix` on `feat/open-server-3k1`. Polling: one
   `gh run view` per 10 min via a single `run_in_background` Bash call
   `sleep 540; gh run view <id> --json status,conclusion,jobs`; never loop. One
   `gh run download` at the end. Report: verb table vs run 7 and run 34806342684 (all
   verbs, both ON arms, OFF drift floors), fling per-cell table with n per arm, the
   paired legacy→drift test, the gate verdict string, screen-graph per-config success
   vs run 34801849653, and device pacing evidence. Do not touch the scoreboard; do not
   fast-forward `open/main`.

## Acceptance
- Default scrcpy pacing byte-equal to pre-3k; drift opt-in and covered by tests.
- Gate rule pre-registered here, implemented, tested against run 7 and 34800933407.
- One run on the consolidated base with interleaved arms and n per cell-arm printed;
  report states fling status honestly (OPEN unless the pre-registered gate is green
  AND the paired test is significant) with every number naming statistic/N/run id.
