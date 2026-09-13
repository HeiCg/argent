# Ticket: screen-graph phase C.4 — make H4 valid: live B1, pure O5, working navigate-to, oracle-independent tokens

Repo: ARGENT FORK. Same worktrees as C.3 (`argent-c3` on `feat/screen-graph-c3`,
`argent-c3-ci` on `feat/bench-ci-c3`); continue on those branches. NO local
emulator/adb; CI only. Review findings driving this ticket:
`/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-03-review-c3-findings.md`
(read it first; verdict REJECT on the headline, plumbing accepted).

## What is wrong (from the review of run 33786304637)

1. **B1 replays stale coordinates.** `precomputeB1Coords` locates every tap once
   (~133 s before the run) and B1 replays fixed x/y for all reps, while every
   open config re-locates live per step. All four B1 failures are on the two
   tasks that swipe before tapping. B1's 0.933 is a harness artifact, so H4
   ("open ≥ B1") is invalid.
2. **O5 is a mixed strategy.** The fallback counter scans a monkey-patched
   `console.debug` (`bench-screen-graph.ts:162`) but the navigate message goes
   through `realDebug`, so `fallbacks 0` is printed while `navigate-to` was
   used on only 9 of 153 steps (two tasks); 27 of 36 known-target taps ran plain
   locate+tap (= O4). Where navigate-to routed, task success was 0/9. The
   harness discards `completedSteps` and `error`, so "no route" is unverifiable.
   `settings-sound` is misattributed in the doc (`usedNavigate=false` all reps).
   Likely mechanism: `runNavigation` (`src/screen-graph/navigate.ts:44`) executes
   plan steps before returning `ok:false`, so the fallback tap fires on a screen
   the failed route already moved.
3. **Tokens/step for O1/O2 depend on the oracle.** `bench-screen-graph.ts:1040`
   feeds `task.assertion` as the `query` selector on every non-tap step, so the
   needle change moved O1 from 67 to 43 chars/4 per step and H1 from 0.182× to
   0.107× with identical tier code.
4. **Noise floor.** Two runs of identical code differ by 3.4–8.3 percentage
   points per config with 3 reps (effective N ≈ 20 tasks). Any H4 verdict inside
   that band is noise; only O5's deficit survives.
5. **Needle "brightness"** is in the Settings root tree ("Dark theme, font size,
   brightness") and passes the gate only because it is below the fold at dump
   time; the two tasks using it swipe the root first. Replace with a needle
   absent from the whole root tree, not just the visible part; make the gate
   check the full tree (visible or not) for navigating tasks.
6. **Asymmetry:** every settings task sets `navTarget == assertion`, handing O5
   the exact oracle string.

## Work

A. **B1 live.** Remove `precomputeB1Coords`; B1 locates its tap target from the
   describe it just paid for, every step, every rep (that is what a plain
   describe+tap agent does). Keep "no centre taps"; a locate failure is an
   exclusion with its reason, counted, never a centre tap.
B. **O5 truthful.** Per step record `strategy: "navigate" | "locate-tap"`, the
   navigate result (`ok`, `completedSteps`, `error`, plan length), and count
   fallbacks from the structured record, not from console text. Report O5 as two
   rows: `O5-pure` (steps where navigate-to routed) and `O5-mixed` (all steps),
   each with success, tokens/step, RTT/step and N. Fix the fallback ordering:
   on `ok:false` after partial execution, re-observe (describe) before the
   fallback tap; never tap blind.
C. **navigate-to must route.** Find why routing failed on 27/36: read the graph
   JSON in the artifact and list which fields make the root hash differ across
   runs (clock, battery, notification text, scroll offsets, ...). Routing must
   key on the structural hash `H` (resource-ids, classes, tree shape), never on
   `H_text`, and tolerate volatile nodes: define a `stable(H)` that excludes the
   status bar window and any node whose text matches a volatile pattern (time,
   percentage, dates, counters) or use a Jaccard ≥ 0.9 match on the resource-id
   multiset when the exact hash misses. Unit-test the matcher with two captured
   roots from different runs (the artifact has them). After the fix, O5-pure
   must cover ≥ 30 of the 36 known-target taps or the doc says why not.
D. **Oracle-independent tokens.** The query selector on non-tap steps must not
   be the assertion. Use the step's own target (the element the step acts on)
   or, for read steps, a fixed per-task `query` declared in the task list that
   is not the oracle needle. Then tokens/step for O1/O2 no longer move when
   needles change; state this in the doc and recompute H1.
E. **Needle gate over the full tree** (item 5) and replace "brightness" for its
   two tasks with a justified needle. Remove `navTarget == assertion`: `navTarget`
   is a screen identity (structural selector or resource-id), not the oracle
   string.
F. **Reps and noise.** `BENCH_REPS=5`; report per-config success with a 95 %
   Wilson interval and the two-run delta; H4 verdict only when the interval
   excludes B1's; otherwise "indistinguishable at N".
G. One matrix run; write the results into
   `/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-03-screen-graph-results-ci.md`
   (replace the C.3 tables; keep C.3's numbers in a "superseded" section with
   the reason per number). Tables: per config success + interval, exclusions,
   fallbacks (structured), tokens/step, RTT/step, N; H1–H4 with statistic and
   run id; O5-pure vs O5-mixed; the root-hash instability list.

## Acceptance
- B1 live-locates every step (no precompute code path left).
- O5 rows split; fallback count from structured records; navigate ok/error
  persisted in the JSON.
- Root-hash instability fields listed; matcher unit-tested; O5-pure coverage
  reported.
- Tokens/step for O1/O2 shown to be needle-independent (same value before/after
  swapping one needle in a unit test of the tier renderer).
- Run green, `PROBLEM needles: 0` over the full tree, results doc written,
  branches pushed, run URL in the final message.
