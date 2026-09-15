# Adversarial closure review — open-server phase 3k.1 (run 34813849446)

Read-only review of `feat/open-server-3k1` @ `2affd44a` (7 commits on the consolidated
`open/main` @ `8cbd3902`: `edc677c2`, `06bc0768`, `8a969963`, `db19a966`, `6f7e2a6f`,
`f5b6e8ad`, `2affd44a`) in the worktree `../argent-fork-wt-3k1`, against the rewritten
`docs/open-server/2026-09-13-open-server-3k-results-ci.md` and the `## Result (3k.1,
2026-09-14)` of `2026-09-05-open-server-phase3k-fling-pacing-and-gates.md`, with my
prior verdict `2026-09-14-review-3k-findings.md` (REJECT part A / ACCEPT part B), the
ticket `2026-09-14-open-server-phase3k1-fling-status-open.md`,
`2026-09-03-review-final-findings.md`, `README.md`, the screen-graph whitelist
(`2026-09-13-screen-graph-phase-d4-results-ci.md` + `2026-09-14-review-d4-1-findings.md`
"Scoreboard rows allowed") and the current `2026-09-03-scoreboard.md`.

Evidence: CI artifacts `bench-latency` and `bench-screen-graph` of run **34813849446**
(two `gh run download` calls, no other GitHub call) — `fling-block-*.json`,
`fling-interleave-evidence.json`, `pacing-trace.txt`, `fling-ab-*.json`,
`bench-block-*.json`, `scoreboard.md`, `logs/device-test.log`,
`screen-graph/bench-sg-2026-09-14T06-38-20-839Z.json`, `logs/sg-matrix.log`; plus the
already-downloaded artifacts of **33975063607** (run 7), **34800933407**,
**34806342684** and **34801849653** (screen-graph reference). Every published statistic
was recomputed by my own script from the per-sample arrays / per-step records, never read
off the harness output; permutation tests are 20 000 draws on the median difference. Code
checks: `git show 690e66bc:…/scrcpy-inject-backend.ts` diffed against the legacy branch by
hand; `node --test .github/bench-ci/gates.test.js` → **21 passed**;
`npx vitest run --maxWorkers=2 test/open-server-fast-inject-pacing.test.ts` → **7 passed**;
`BENCH_OUT=<scratch> node .github/bench-ci/merge-fling.js` re-run on this run's four block
files. No device, no new CI run, no worktree created, no file in the worktree touched.

## VERDICT: ACCEPT-WITH-CAVEATS

Everything the ticket asked for is done and reproduces to the digit. The pacing default is
`legacy` and the legacy branch is **character-identical** to `690e66bc` (18-line loop,
whitespace-normalized diff empty; the catch path for legacy is the pre-3k one). The gate is
implemented exactly as pre-registered (reference-bimodality keyed on uia/off only, `n >= 10`
on every arm, two-sided ±0.15), its 21 tests run on **byte-identical copies of the real
artifacts** (I diffed the committed fixtures against my own downloads of run 7 and
34800933407 — identical), and the verdict string reproduces character-for-character from my
own re-run: `FAIL (per-cell ±0.15 on scrcpy/uia AND scrcpy/off, NO whitelist, over 4
informative cell(s); 2 of 6 non-informative at the metric floor)`. Every fling median, IQR,
n, ratio and p-value in the tables reproduces; the interleave evidence is real (all 24
cell-arms spread over rounds 0/1/2, spans reproduce to 0.1 s); the drop reason is recorded;
the fling A/B no longer runs through the outcome path (3K-M5 closed); the fling status is
stated as **OPEN** with both acceptance conditions declared unmet. That is an honest report
and a real improvement over the rejected 3k.

The caveats are three, and two of them are load-bearing for the scoreboard. (1) The new
mechanism sentence — "the evidence points … toward the OS VelocityTracker's reading of an
**8-frame scrcpy gesture** vs the uia/proprietary injectors" — is contradicted by this
repo's own code and this run's own data: the **UiAutomation arm emits the identical 8-frame
schedule** (`SwipeHandler.kt:70-107` and `scrcpy-inject-timeline.ts:131-162` share
`HEAD_SAMPLES=2`/`TAIL_SAMPLES=5`/`MOMENTUM_STEP_MS=16`), and uia reads **uia/off = 1.037**
at 400/0.3 while scrcpy reads 0.699 (3K1-H1). (2) "The host trace shows the gesture is
delivered on time … so the deficit is **not** host pacing" is published while the same
section's own dumpsys numbers show the **device** saw 452 ms (drift) and 439 ms (legacy)
for a 416 ms request against uia's 417 ms, with a final MOVE→UP gap of 46/35 ms vs uia's
17 ms — and no host trace exists for the default `legacy` path at all (3K1-H2). (3) The
verb table is a regression diff, not a like-for-like read: it never compares the headline
`tap+describe` row against the OFF arms of its own run, where ON is **+150…+230 ms slower**
against a 57 ms floor (run 7 had scrcpy at parity), and it reports describe as "ON≈OFF"
without saying that the run-7 ON describe win is gone and that ON is now 14–18 ms **slower**
at p95 (3K1-H3). Both are base properties reproduced by 34806342684, not 3k.1 regressions —
but they flip two scoreboard verdicts and must be stated before any row is published.

Nothing here blocks the branch. Fix the mechanism paragraph, add the ON-vs-OFF read of the
headline row and of describe, qualify the "reproduces 34806342684 within the drift floor"
sentence, and the run is publishable as the single scoreboard reference (see
`## Reference run recommendation`).

## Prior findings status

| id                                                          | status                  | evidence                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3K-H1** (no same-run effect; "fix works")                 | **FIXED**               | Claim retracted in both docs; the new run repeats the null — paired legacy→drift permutation p = 1.00 / 0.63 / 0.13 / 0.31 / 0.33 (150/0.3, 250/0.3, 250/0.5, 400/0.3, 400/0.5), my recompute matches the published table exactly; default reverted to `legacy` (`scrcpy-inject-backend.ts:145-147`).                                                                           |
| **3K-H2** (cross-run "resolved")                            | **FIXED**, one residual | Status is OPEN in both docs, the cross-run sentence is the one I asked for. Residual: "the under-scroll _did_ reproduce (unlike run 34800933407)" contradicts the branch's own rewritten 3k doc, which says the 400/0.3 deficit there was real at p = 0.001 (3K1-M5).                                                                                                           |
| **3K-H3** (mechanism asserted, no MOVE timing)              | **PARTIAL**             | Host trace now reaches the artifact (`pacing-trace.txt`, 72 lines, all `frames=8`) and device-side cadence is captured — but only for the **drift** arm, N = 1 per arm on the device side, the parse is not MotionEvent-filtered, the row is labelled "26-frame" when the gesture is 8 frames, and the replacement mechanism sentence is contradicted (3K1-H1, 3K1-H2, 3K1-M8). |
| **3K-H4** (success vs failed acceptance)                    | **FIXED**               | Gate RED published as RED, both acceptance conditions declared unmet, "OPEN, not resolved" in the first line of the Result.                                                                                                                                                                                                                                                     |
| **3K-M1** (n ≠ 12, silent drops)                            | **FIXED**               | `drops[]` per cell (`bench-fling-fidelity.ts` `sampleOnce`/`summarizeCell`), n printed per cell-arm, power floor `n >= 10` on every arm incl. `off` (`merge-fling.js:59`) with a firing test. The one drop this run carries its reason.                                                                                                                                         |
| **3K-M2** (the red is not a distinguishable difference)     | **PARTIAL**             | The two-sided rule means the 150/0.3 red is now carried by `scrcpy/off` 0.515, which **is** distinguishable (my permutation p = 0.009). But `scrcpy/uia` at that same cell is **not** (p = 0.30) and the doc prints 0.644 as an offender without saying so; the cell's informativeness also rests on one order statistic (3K1-M4).                                              |
| **3K-M3** (supersession without numbers)                    | **FIXED**               | Rewritten 3k doc publishes the OFF/ON VERBOSE deltas and the corrected causal wording.                                                                                                                                                                                                                                                                                          |
| **3K-M4** (verb deviations vs run 7)                        | **PARTIAL**             | `tap+describe(settle:true)` restored, `await-*` moved to "changed on this base"; but the OFF `tap+describe` row is now **missing entirely**, `settle:false` is never compared to run 7 (ON-scrcpy 298 → 529), and the "within drift floor ✓" marks do not hold arithmetically (3K1-H3, 3K1-M1).                                                                                 |
| **3K-M5** (fling measured through the regressed swipe path) | **FIXED**               | The outcome fix is on the base and the fling harness never enables screen-graph recording (`applyArmFlags` sets only `open-device-server`/`…-fast-inject`), so `gesture-swipe` takes the `openServerSwipe` pass-through (`gesture-swipe/index.ts:166-179`); the A/B was re-measured on the fixed base.                                                                          |
| **3K-M6** (arm confounded with time)                        | **PARTIAL**             | 3 rotated rounds, evidence file published, drift↔legacy alternate **per swipe**. But uia and off still run as contiguous 24-swipe (~2–4 min) blocks inside each round, and drift is first in all 72 pairs (3K1-M6).                                                                                                                                                             |
| **3K-L1** (drift/legacy naming)                             | **PARTIAL**             | Arms still named drift/legacy everywhere; the code comment now says "drift-corrected … and socket-decoupled", the docs do not. Harmless now that legacy is the default.                                                                                                                                                                                                         |
| **3K-L2** (legacy = re-implementation)                      | **FIXED**               | Verified by hand: `690e66bc` lines 317-334 vs `scrcpy-inject-backend.ts:400-417` are identical after whitespace normalization; no instrumentation on the legacy path; `emitPacingTrace` is called only in the drift branch (`:449`).                                                                                                                                            |
| **3K-L3** (ordering argued from library source)             | unchanged               | Still a mock call-order assertion; not re-raised.                                                                                                                                                                                                                                                                                                                               |
| **3K-L4** (drift keeps queueing after a write error)        | **NOT FIXED**           | The drift loop still has no early break on `writeErr` (`scrcpy-inject-backend.ts:419-448`). Impact is lower now that drift is opt-in.                                                                                                                                                                                                                                           |
| **3K-L5** (F6 logged, not gated)                            | **FIXED**               | Rewritten 3k doc says "logged and surfaced, not gated".                                                                                                                                                                                                                                                                                                                         |
| **3K-L6** ("19/19")                                         | **FIXED**               | Both docs say "17 enforced + 2 measurement-only"; `logs/device-test.log:163` shows 19 passed.                                                                                                                                                                                                                                                                                   |
| **3K-L7** (provenance of 0.642/0.580)                       | **FIXED**               | Cites `2026-09-03-review-final-findings.md:353-360`.                                                                                                                                                                                                                                                                                                                            |
| **3K-L8** (bisect already done)                             | **FIXED**               | "Open items — resolved by phase 3k.1" cross-references the outcome-regression doc.                                                                                                                                                                                                                                                                                              |

## HIGH

1. **3K1-H1 — the offered mechanism ("OS VelocityTracker on an 8-frame scrcpy gesture vs
   the uia/proprietary injectors") is contradicted by the repo's own code and by this
   run's own numbers.** It is correctly labelled a hypothesis ("the evidence points …
   toward", "a candidate for"), so the wording is not a claim-of-fact — but it is a
   hypothesis the available data already refutes as stated, and it will send the next
   phase down a dead end. (a) The **UiAutomation arm emits the same 8 frames**: the open
   server's `SwipeHandler.injectMomentumSwipe` builds `{0, headEnd/3, 2·headEnd/3, and 5
tail offsets at 16 ms}` from `MOMENTUM_STEP_MS = 16`, `TAIL_SAMPLES = 5`,
   `HEAD_SAMPLES = 2` (`packages/android-device-server/…/SwipeHandler.kt:21-34,70-107`),
   and `scrcpy-inject-timeline.ts:108-162` is a line-for-line port of it — so _both_ ON
   arms send 8 frames for a 400 ms swipe, and only the proprietary OFF arm sends one
   frame per 16 ms (`gesture-swipe/index.ts:209,219,279` → 26 frames at 400 ms). (b) The
   8-frame uia arm is **at proprietary parity in the worst cell**: my recompute of run
   34813849446 gives `uia/off` = **1.037** at 400/0.3 (uia 0.369 vs off 0.356, n = 12
   each) while `scrcpy/off` = 0.699 — the frame count is held constant across those two
   arms and the deficit is not. (c) The device cadence in the report's own bullet list
   says the same thing: uia's dumpsys tail is 15/19/13/17 ms, scrcpy's is 14/14/22/**46**
   (drift) and 21/8/19/**35** (legacy). If the schedule were the cause, uia would
   under-scroll with it. Fix: re-word to "the host dispatches on time and drift ≈ legacy,
   so the residual is between the host socket and the MotionEvent the OS sees (scrcpy
   server read-time stamping / arrival jitter on the last frames), not host pacing; the
   uia arm, which sends the identical 8-frame schedule and reaches `uia/off` 1.037 at
   400/0.3, rules the frame count out as the sole cause." Do not state a VelocityTracker
   frame-count hypothesis without an arm that varies the frame count.

2. **3K1-H2 — "the host delivers on time with no stretch to remove" is published next to
   this run's own device-side numbers that show a 5–9 % stretch, and the host trace does
   not cover the default path.** (a) The trace file holds **72 lines, every one
   `mode=drift`** (`pacing-trace.txt`; 12 samples × 6 cells) — by construction
   (`scrcpy-inject-backend.ts:449`, "Only the drift branch is instrumented"). There is no
   host trace for `legacy`, which is now the **shipped default** and the arm the whole
   "no stretch to remove" argument is about. (b) The device-side rows in the same section
   read, for a 416 ms request: uia dumpsys gesture deltas summing to **417 ms**, scrcpy
   drift **452 ms**, scrcpy legacy **439 ms** (`logs/device-test.log:29,131,134`; my sums
   of the published cadence arrays), with the final MOVE→UP gap 46 ms (drift) / 35 ms
   (legacy) against uia's 17 ms — i.e. the device _did_ see a stretched scrcpy tail,
   exactly where the velocity fit lives, in **both** pacing arms. The Result does not read
   its own numbers; it jumps from "host on time" to "not host pacing" to the 8-frame
   hypothesis. (c) The supporting exemplar is cherry-picked: "maxDispatchDrift < 1 ms" is
   true of 16 of 72 trace lines; the distribution is median **2.1 ms**, p90 4.4 ms, max
   **7.9 ms** (my recompute over `pacing-trace.txt`). Fix: publish the drift distribution
   rather than one line; say "host dispatch span == requested duration on the **drift**
   arm (n = 72, median max-drift 2.1 ms, worst 7.9 ms); the legacy/default path is not
   traced"; and add the device-side observation as the live lead: "on the single device
   sample per arm, both scrcpy arms deliver 439–452 ms for a 416 ms request with a
   35–46 ms final gap, vs 417/17 ms for uia (N = 1 per arm, RecentQueue, measurement-only)."

3. **3K1-H3 — the verb table is a regression diff against 34806342684 only; read
   like-for-like inside its own run, two headline verdicts flip and the report does not
   say so.** (a) **Headline tap (`tap+describe`, ON `settle:false`)**: OFF-1 354/831,
   OFF-2 297/654 (floor 57 ms) vs ON-uia **505/728** and ON-scrcpy **529/1029** — ON is
   +150…+230 ms **slower**, a LOSS. Run 7 had ON-scrcpy 298/810 against OFF 305/313, i.e.
   _at parity_, which is the row now in the scoreboard. The harness's own scoreboard even
   states "the headline like-for-like tap row is tap+describe(settle:false)"
   (`.bench-results/scoreboard.md:84`), and the OFF `tap+describe` row is missing from the
   report's table entirely. (b) **describe (idle)**: the report says "ON≈OFF (F1 direction
   only; magnitude non-reproducible)". True at p50 (ON 53/53 vs OFF 52/52, floor 0) — but
   run 7 read ON **39/36** vs OFF 52, i.e. the ON describe win that the current scoreboard
   carries is **gone**, and at p95 ON is 74/73 vs OFF 56/59 against a 3 ms p95 drift floor,
   i.e. ON is now 14–18 ms **slower**. "never slower in 3 same-code runs" is falsified by
   this run and must be retired, not summarised as "direction only". (c) Both deviations
   reproduce in 34806342684 (settle:false ON-scrcpy 548; describe ON-uia 55/74), so they
   are the screen-graph-d base, **not** 3k.1 — which is exactly why they must be written
   down here before the scoreboard cites this run. Fix: add an "ON vs OFF, this run, at
   the drift floor" column (that is what a scoreboard row is), restore the OFF
   `tap+describe` row with its 57 ms floor, and state the two flipped verdicts explicitly.

## MEDIUM

1. **3K1-M1 — "Every verb reproduces run 34806342684 within its OFF-1↔OFF-2 drift floor"
   is false as written.** My recompute of both runs: `gesture-tap` ON-uia 78 vs 83
   (Δ 5) against a 1 ms floor; `await-screen-idle` ON 294 vs 292 (Δ 2) and
   `await-ui-element` ON-uia 45 vs 43 (Δ 2) against a **0 ms** floor; and the ON-only
   verbs have no OFF floor at all — `tap+describe(settle:false)` ON-uia 505 vs 518
   (Δ 13), `settle:true` 843 vs 878 (Δ 35). All the deltas are small and none suggests a
   3k.1 regression, but the sentence states a test that the numbers fail. Fix: "every verb
   is within 5 ms (p50) of 34806342684 except the ON-only settle rows (≤ 35 ms); the
   OFF-1↔OFF-2 floor of this run is 0–4 ms on every verb except paste (142) and
   tap+describe (57)".

2. **3K1-M2 — the blocking gate grades the opt-in arm, not the shipped default.**
   `merge-fling.js` fixes `scrcpyArm: "drift"` and the artifact scoreboard prints "scrcpy
   gate arm pacing: **drift**" (`.bench-results/scoreboard.md:140`), while
   `scrcpyPacingMode()` now defaults to `legacy`. The default path is graded only in the
   ungated transparency row. For the record it would also be red: legacy ratios
   uia/off = 0.688/0.549 (150/0.3), 1.031/1.019 (250/0.3), 0.778/0.806 (400/0.3),
   0.615/0.542 (400/0.5) → 3 offenders, same verdict. Fix: either grade `legacy` (the
   shipped path) and keep drift as the transparency arm, or gate both and say so in the
   verdict string.

3. **3K1-M3 — `INCONCLUSIVE` exits 0: the gate can silently no-op.** `merge-fling.js`
   only `process.exit(1)`s when the verdict starts with `FAIL`; with zero informative
   cells (all references floored, or an arm that lost its samples) the run is green with
   no fling grading at all. This interacts with the new orchestrator, which converts a
   whole-arm-round failure into **silent drops** (`bench-fling-fidelity.ts`, catch →
   `cell.drops.push(...)` + `console.error`) instead of the workflow's per-config
   failure branch — an OFF or uia arm that dies now degrades to "non-informative" rather
   than failing the step. No test covers it (`gates.test.js` covers a _missing file_, not
   an empty arm). Fix: treat `INCONCLUSIVE` as a failure, or require `informativeCells >= 3`.

4. **3K1-M4 — the reference-bimodality exclusion is knife-edge at N = 12, and the run's
   biggest offender sits on the edge.** `refStraddlesFloor` keys on `iqr[0]`, which
   `bench-fling-fidelity.ts:165-170` computes by **nearest rank** (`round(0.25·(n−1))` →
   the 4th of 12). At 150/0.3 the uia reference has **3 of 12 samples at the 0.175 floor**
   (sorted: 0.175, 0.175, 0.175, 0.298, …), so q25 = 0.298 and the cell is informative;
   **one more floored sample** and the gate's largest offender (0.644/0.515) becomes
   non-informative. Same fragility the other way at 400/0.5 (uia 2/12 floored). Fix:
   publish the floored-sample count per arm next to the IQR, and state the quantile
   definition (a linear-interpolation q25 gives 0.267 here, not 0.298).

5. **3K1-M5 — "the scrcpy under-scroll vs proprietary _did_ reproduce (unlike run
   34800933407)" contradicts the branch's own rewritten 3k doc.** That doc says, of run
   34800933407: "400/0.3 is scrcpy 0.319 vs off 0.360, a ~11 % under-scroll that is
   statistically real (p = 0.001) — and equally real for the legacy arm". So the deficit
   did not appear from nowhere; it **grew** (400/0.3 scrcpy/off 0.886 → 0.699) and
   **spread** (now also 150/0.3 0.515 p = 0.009 and 400/0.5 0.717 p = 0.001, my
   recompute; legacy 0.549/0.808/0.542 with p = 0.031/0.014/0.002). Fix: "larger than in
   34800933407 (400/0.3 scrcpy/off 0.699 vs 0.886) and now significant in three cells,
   in both pacing arms".

6. **3K1-M6 — "interleaved" is round-level, not the per-cell round-robin the ticket
   asked for; and the paired arm is confounded with intra-pair order.** From
   `fling-interleave-evidence.json` (288 events, my reconstruction of the arm sequence):
   each round runs `uia ×24 → (drift,legacy)×24 alternating → off ×24` with the group
   order rotated per round (round 0 uia/scrcpy/off, round 1 scrcpy/off/uia, round 2
   off/uia/scrcpy). So uia and off still occupy contiguous ~2–4 min blocks (round 0: uia
   7–130 s, scrcpy 140–385 s, off 395–541 s), three times each in rotated positions —
   much better than 3k's single 7-minute block, and the published spans are exact, but
   the `scrcpy/off` comparison that drives the gate is still block-structured. Separately,
   **drift is always sampled before legacy** in all 72 pairs (`bench-fling-fidelity.ts`
   interleave body), so any within-pair order effect maps onto the arm. Fix: say
   "arms rotate per round in 24-swipe blocks; drift/legacy alternate per swipe with drift
   always first", and randomize the pair order next time.

7. **3K1-M7 — three ON-only failures of the same class are not disclosed, and the verb
   table drops the n it was measured at.** Both ON blocks logged one
   `[Tool:describe] Failed to parse uiautomator dump output` on
   `tap+describe(settle:false)` (`bench-block-ON-uiautomation.json` i=19,
   `bench-block-ON-scrcpy.json` i=2) — so those cells are **n = 19, not 20**, the
   first-attempt landing denominators are 59 not 60, and the harness itself prints
   `505/728 err1` / `529/1029 err1` (`.bench-results/scoreboard.md:41`). The fling drop is
   the same error class. The Result says "everything else is green" and prints the values
   bare. Fix: carry `err1`/`n=19` into the table and add one line: "three ON-side
   `uiautomator dump` parse failures this run (2 latency, 1 fling), same class, 0
   fast-inject fallbacks".

8. **3K1-M8 — the device pacing row is labelled with the wrong frame count and an
   unverified event class.** "Requested 416 ms (**26-frame**) swipe" — 26 is the `steps`
   argument (`android-open-server.device.test.ts`, `const steps = 26`), but the gesture
   actually put on the wire is **8 frames**: the device-test's own trace line reads
   `pacing mode=drift frames=8 intendedDurMs=416` (`logs/device-test.log:128`), and all 72
   fling trace lines read `frames=8`. Since the frame count is the substance of the new
   hypothesis (3K1-H1), this mislabel is material. Also `dumpsysMotionEventTimes` matches
   `\bage=(\d+)ms\b` over a 6000-char window after `RecentQueue|recent events|InboundQueue`
   with **no MotionEvent filter**, so "N=10 MotionEvent times including MOVE frames" is an
   inference from the arithmetic (the last 7 deltas sum to 417/452/439 ms, which does match
   an 8-frame gesture), not something the parser establishes. Fix: "8 frames on the wire
   (26 requested steps); 10 recent-input timestamps, the trailing 8 of which sum to the
   gesture — event class not filtered, N = 1 swipe per arm".

9. **3K1-M9 — the rejected 3k causal story is still alive, unqualified, in the default
   path's doc comment.** `scrcpy-inject-backend.ts:333-340`: "a per-frame consume cost W
   stretches a K-frame swipe to ~K·max(16, W) … so a stretched write cadence feeds the OS
   VelocityTracker a lower release velocity and the fling under-scrolls (the deficit
   reported at 400 ms in review F2)" — stated as fact, about the **legacy default**, in the
   file a future reader will open first. The 3k.1 paragraph at `:355-357` records the null
   result but does not retract the mechanism. Fix: prefix the paragraph with "HYPOTHESIS,
   NOT OBSERVED on the CI runner (3k/3k.1: legacy delivers on time; drift ≈ legacy,
   paired p ≥ 0.13)".

10. **3K1-M10 — the screen-graph section publishes only per-config success, and one row
    of the D.4.1 whitelist does not reproduce on this run.** Recomputed from
    `bench-sg-…json` (7 configs × 20 tasks × 5 reps, seed `0x5eedc0de`, n = 155 non-launch
    steps per config): tokens p50 B1 657 · B2 651 · O1 179 · **O2 54** · O3 627 · O4 21 ·
    O5 21 (the whitelist says O2 68 — inside the declared 54–68 same-code spread, but it
    must be republished, not copied); RTT/step p50 2/2/2/2/2/1/1 identical; H1 = 179/651 =
    0.275× identical; H3 = 21/627 = 0.033× identical; H2 all-steps 0 (FAIL, structural),
    same-screen p50 1 (PASS), means B2 2.00 vs O2 **1.20**; H4 trivially 0 [0,0] for every
    open config (all 100/100); invariants OK, `skippedNoIdHash` 0 (`logs/sg-matrix.log:197`).
    Two differences the report does not mention: the settings store is **10 nodes / 9 edges,
    max out-degree 8** (reference: 11/10/9), and **O5 routes 60/60 with 0 diverged and 0
    fallbacks** (reference: 59/60, 1 hash-mismatch divergence). And one row **fails to
    reproduce**: the D41-H1 post-action-wait symmetry, `actionRttMs + settleMs` p50, is
    B1 2246 · B2 2283 · O1 2328 · O2 2315 · O3 2382 · O4 2348 · O5 2644 — a **17.7 %**
    spread with **B1 the lowest**, against the whitelist's "equal within 5 %" (the
    reference run spreads 5.2 %). Fix: publish this run's screen-graph numbers in full, and
    do not carry the symmetry sentence over (see `## Reference run recommendation`).

## LOW

1. **3K1-L1 — the fling artifacts are now misleadingly named.** Because `run-fling.js`
   claims the interleave on the first invocation and no-ops the rest
   (`.bench-results/.fling-interleave.lock`), three of the four `fling-log-*.txt` are
   one-line no-ops (153–166 B) and three `logcat-fling-*.txt` are **0 B**; all evidence
   sits in `fling-log-ON-uiautomation.txt` (26.8 KB) and `logcat-fling-ON-uiautomation.txt`
   (33 MB). Anyone grepping `fling-log-ON-scrcpy.txt` will conclude the arm did not run.
2. **3K1-L2 — `ARGENT_SCRCPY_PACING` is read per gesture, not once per process.**
   `scrcpyPacingMode()` (`:145-147`) is called at the top of every `injectTimeline`. That
   is deliberate (the A/B flips it per swipe) and safe — pure env read, no throw,
   default-closed (any value other than the exact string `drift` → legacy, covered by a
   test) — but it means the wire path of a _product_ process can be changed by a stray
   environment variable, and that two concurrent gestures in one process would race the
   mode. The bench is sequential, so nothing is wrong in this run.
3. **3K1-L3 — 150/0.5 is missing from the paired p-value table** (degenerate: every arm
   floored, Δ 0, p = 1.00). Say so rather than dropping the row.
4. **3K1-L4 — the latency ON-scrcpy block now runs the `legacy` default** (no
   `ARGENT_SCRCPY_PACING` anywhere in the latency step of
   `bench-open-vs-proprietary.yml`), whereas in run 34800933407 the same block ran `drift`
   because drift was then the default. Good — the scoreboard now measures the shipped
   path — but it is a code-path difference when comparing scrcpy verbs across those two
   runs, and it is not noted.
5. **3K1-L5 — the clearer statement of the defect is the floor rate, not the median
   ratio.** My count of samples at the 0.175 floor, n = 12 per cell-arm, run 34813849446:
   150/0.3 — off **1**, uia 3, drift **4**, legacy **6**; 400/0.5 — off **0**, uia 2,
   drift **2**, legacy **5**. The scrcpy arms simply fail to produce a fling on a third to
   a half of the short/long swipes; a ratio of medians on a two-level metric hides that.
   Worth publishing next to the table (and it is what makes `n >= 10` insufficient power).
6. **3K1-L6 — describe fidelity dropped to Jaccard 0.889** this run (`scoreboard.md:59`,
   OFF "Storage / 36 % used - 5.08 GB free" vs ON "37 % used - 5.01 GB") — live-content
   churn between blocks, not a regression, but the scoreboard's "identical; fidelity
   Jaccard 1.0" cannot be copied onto this run.
7. **3K1-L7 — 3K-L4 is still open**: the drift loop keeps sleeping and queueing after the
   first write rejection (`scrcpy-inject-backend.ts:419-448`, no `break` on `writeErr`), so
   the Kotlin fallback still arrives one full gesture duration late. Lower priority now
   that drift is opt-in.

## Reference run recommendation

**Use run 34813849446 as the single scoreboard reference for latency, fling and
screen-graph — but derive the screen-graph rows from THIS run's records, do not copy the
D.4.1 whitelist wording, and drop the settle-symmetry row.**

Why one run works: it is the only run on the consolidated base (3k Part B +
outcome-regression fix + D.4.1), it carries all four fling arms interleaved, its ON-scrcpy
latency block runs the **shipped default** pacing, and its screen-graph job is the same
code as 34801849653 at the same seed/reps/tasks — success is at or above the reference in
every config (O2 99→100), tokens, RTT/step, H1 and H3 reproduce to the digit, H2's
same-screen structure reproduces (mean 1.22 → 1.20), invariants are clean and O5 routing
improves to 60/60. A scoreboard that cites two run ids for two halves of the same base is
harder to defend than one that cites 34813849446 and names 34801849653/34806342684 as
same-code replications.

The three exceptions, all mandatory:

1. **The D41-H1 post-action-wait symmetry row must NOT be carried over.** On
   34813849446 `actionRttMs + settleMs` p50 spreads 2246 (B1) … 2644 (O5) = 17.7 %, with
   **B1 the cheapest** — the opposite shape of the reference run's 5.2 %. Either publish
   the row from 34801849653 only, explicitly labelled with that run id, or publish this
   run's numbers and state that post-action wait is **not** equal within 5 % here. Do not
   publish "symmetric settle" as a property of run 34813849446.
2. **The store-shape / O5 routing / O2-token values change**: settings store 10/9 (max
   out-degree 8) not 11/10/9; O5 60/60 routed, 0 diverged, 0 fallbacks; O2 tokens 54 not 68. Recompute, do not copy.
3. **The B1 caveat and the token run-to-run spread stay sourced to D.4.1** (they are
   statements _about_ run-to-run behaviour and reference 34788497583 / 34794414764).

Latency rows may now move off run 7 (the outcome regression is gone: tap ON-uia 78 vs run
7's 77, swipe ON-uia 292 vs 296, ON-scrcpy 259 vs 257), provided 3K1-H3 is fixed first —
two verdicts flip and the scoreboard must say so. Fling rows stay **open** (gate RED,
paired null).

## Scoreboard rows allowed

Reference run **34813849446** (`feat/open-server-3k1` @ `6f7e2a6f`, base `open/main` @
`8cbd3902`, `suite=both`, `sg_mode=matrix`, ubuntu-latest KVM, Android 14 / SDK 34,
1080x2400 @ 420dpi). Latency: **N = 20 per verb per block**, p50/p95 ms, blocks
OFF-1 → ON-uiautomation → ON-scrcpy → OFF-2, verdicts judged at the **within-run
OFF-1↔OFF-2 p50 drift floor** of that verb. Fling: **n = 12 per cell-arm** (one uia cell
n = 11), median normalized scroll, interleaved in 3 rotated rounds. Screen-graph:
7 configs × 20 tasks × 5 reps, n = 155 non-launch steps per config, o200k_base, bootstrap
B = 10000 seed `0x5eedc0de`. Every row below supersedes the run-7 (33975063607) row of the
same name; name both run ids.

### Latency verbs (run 34813849446, N = 20, p50/p95)

| row                                                                                             | required wording                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| describe (idle) — **verdict CHANGES: win → parity/loss**                                        | "OFF-1 52/56 · ON-uia 53/74 · ON-scrcpy 53/73 · OFF-2 52/59; drift floor 0 ms (p50) / 3 ms (p95). **At parity at p50 (+1 ms) and 14–18 ms SLOWER at p95.** The run-7 ON describe advantage (39/36 vs 52) does not reproduce on this base; 34806342684 reads the same (ON-uia 55/74). Retire 'open never slower in 3 same-code runs'."                                              |
| gesture-tap (tap RPC only)                                                                      | "OFF-1 53/60 · ON-uia 78/116 · ON-scrcpy 51/53 · OFF-2 54/56; floor 1 ms. scrcpy **at parity** (−2…−3 ms, the harness judges ±2 ms); UiAutomation **+25 ms slower**, the same +25 as run 7. Not like-for-like across ON variants (scrcpy defers the input drain)."                                                                                                                 |
| tap+describe (headline like-for-like tap; ON settle:false) — **verdict CHANGES: parity → loss** | "OFF-1 354/831 · OFF-2 297/654 (drift floor **57 ms**) · ON-uia 505/728 (n = 19) · ON-scrcpy 529/1029 (n = 19). **Open loses: +150…+230 ms on both ON variants.** Run 7 had ON-scrcpy at parity (298/810 vs OFF 305/313); the deviation is present in 34806342684 (ON-scrcpy 548) and therefore belongs to the screen-graph-d base, not to phase 3k/3k.1 — cause not established." |
| gesture-swipe (250 ms)                                                                          | "OFF-1 300/312 · ON-uia 292/309 · ON-scrcpy 259/261 · OFF-2 296/305; floor 4 ms. **Open wins (scrcpy −37…−41)**; UiAutomation at parity. Reproduces run 7 (257) and 34806342684 (258)."                                                                                                                                                                                            |
| gesture-pinch                                                                                   | "OFF-1 358/373 · ON-uia 346/372 · ON-scrcpy 307/311 · OFF-2 346/365; floor 12 ms. **Open wins (scrcpy −39…−51)**; UiAutomation at parity. scrcpy 307 in all three runs."                                                                                                                                                                                                           |
| await-screen-idle — **magnitude changes**                                                       | "OFF-1 501/507 · ON 294/297 (uia) and 294/308 (scrcpy) · OFF-2 501/511; floor 0 ms. **Open wins −207 ms**, against −35 ms in run 7 (ON 463/461): the base changed with the screen-graph-d tree (34806342684 reads 292/293), not with 3k.1; cause not established."                                                                                                                 |
| await-ui-element                                                                                | "OFF-1 80/84 · ON-uia 45/51 · ON-scrcpy 47/53 · OFF-2 80/81; floor 0 ms. **Open wins −33…−35 ms** (run 7: −41 on a 72 ms OFF baseline; both OFF and ON moved on this base, 34806342684 reads 43/43)."                                                                                                                                                                              |
| paste                                                                                           | "OFF-1 804/1122 · ON-uia 291/1086 · ON-scrcpy 385/990 · OFF-2 662/1057; OFF drift floor **142 ms**. Directional only: −277…−371 ms clears the floor; p95 does not separate."                                                                                                                                                                                                       |
| first-attempt tap landing                                                                       | "OFF 40/40 and 40/40 · ON-uia **59/59** · ON-scrcpy **59/59** = 100 % on every block (each ON denominator is 59, not 60: one `uiautomator dump` parse error per ON block). No scrcpy async drop this run; run 7's 1/60 is not reproduced."                                                                                                                                         |
| tokens (describe, o200k)                                                                        | "657 in all four blocks. Fidelity Jaccard **0.889** this run (live text churn: OFF 'Storage / 36 % used - 5.08 GB free' vs ON '37 % used - 5.01 GB'), not the 1.0 of run 7."                                                                                                                                                                                                       |

Mandatory footnote on the latency block: _"ON-scrcpy ran the shipped default pacing
(`legacy`); run 34800933407's ON-scrcpy verbs ran `drift`, which was then the default."_

### Fling status row (replaces the run-7 "open loses" fling row; status stays OPEN)

> **Fling parity (run 34813849446, n = 12 per cell-arm, interleaved over 3 rotated
> rounds, median normalized scroll):** the scrcpy under-scroll vs the proprietary
> reference is **real and significant in 3 of 4 informative cells** — `scrcpy(drift)/off`
> 0.515 at 150 ms/0.3 (permutation p = 0.009), **0.699** at 400 ms/0.3 (p = 0.001), 0.717
> at 400 ms/0.5 (p = 0.001); 250 ms/0.3 passes (0.899). The pre-3k `legacy` arm shows the
> same deficit (0.549 / 0.808 / 0.542, p = 0.031 / 0.014 / 0.002), and the same-run paired
> legacy→drift test is **not significant in any cell** (Δ −0.020 / −0.053 / −0.266 /
> −0.038 / +0.115, permutation p = 1.00 / 0.63 / 0.13 / 0.31 / 0.33, 20 000 draws). The
> deficit is **larger** than in run 34800933407 (400/0.3 scrcpy/off 0.699 vs 0.886) and it
> did not reproduce at all as a run-7-sized effect in that run — run-to-run variance on
> this metric is of the order of the effect. **Status: OPEN.** Host pacing is not the
> cause: `drift` ≈ `legacy` and the host dispatch span equals the requested duration on the
> drift arm (n = 72 swipes, median worst-frame drift 2.1 ms, max 7.9 ms). Mechanism
> unresolved — the 8-frame schedule alone is ruled out (the UiAutomation arm sends the
> identical 8 frames and reads `uia/off` 1.037 at 400 ms/0.3).

Optional supporting line (allowed, label as measurement-only): _"floor rate, samples at
the 0.175 metric floor out of 12: 150 ms/0.3 — off 1, uia 3, scrcpy drift 4, scrcpy legacy
6; 400 ms/0.5 — off 0, uia 2, drift 2, legacy 5."_

**Not allowed:** any "fling fixed/improved" row; any `legacy → drift` improvement claim;
"the deficit is not present in 34800933407"; the "26-frame" label; and the VelocityTracker
frame-count hypothesis stated as a finding (3K1-H1).

### Gate / process row (no measurement)

> **Fling parity gate (phase 3k.1, run 34813849446):** pre-registered before the run in
> `2026-09-14-open-server-phase3k1-fling-status-open.md` from the 3k review's "Gate
> recommendation" — per-cell **two-sided** `|scrcpy/uia − 1| <= 0.15` AND
> `|scrcpy/off − 1| <= 0.15`, **blocking, no whitelist**, reference-bimodality exclusion
> keyed on the **reference arms only** (`q25(uia|off) <= 0.175 + eps`, never on scrcpy),
> power floor **n >= 10 on every arm** entering a gated ratio. Verdict on this run:
> `FAIL (per-cell ±0.15 on scrcpy/uia AND scrcpy/off, NO whitelist, over 4 informative
cell(s); 2 of 6 non-informative at the metric floor)` — offenders 150/0.3 (0.644/0.515),
> 400/0.3 (0.675/0.699), 400/0.5 (0.813/0.717). **21 gate unit tests**
> (`.github/bench-ci/gates.test.js`, `unit-tests.yml`), of which the two fling
> regression tests run on **byte-identical copies of the real artifacts** of run
> 33975063607 (stays RED, 3 informative cells all red) and 34800933407 (3 PASS / 3
> non-informative). Known holes, not covered by a firing test: the gate grades the
> **opt-in `drift`** arm while the shipped default is `legacy`, and a verdict of
> `INCONCLUSIVE` (zero informative cells) exits 0.

### Bench-honesty row (run 34813849446)

> F5 locate split published per block: **dump 0 / describe 40, 60, 60, 40** — `locateVia =
describe` 100 % in every block; F6 dump short-circuit logged and surfaced, **not gated**;
> F7 first-attempt no-effect **0/40, 0/59, 0/59, 0/40**, oracle self-test pass in all four
> blocks, transport `redir` on both ON blocks, 0 degraded blocks, **0 fast-inject
> fallbacks**; F12 per-block ready gate blocking; F13 an executable OFF baseline failure
> fails the run; F19 `destinationVisible` probe removed. Device suite **17 enforced + 2
> measurement-only** (19 passed). Disclosure: **three ON-side `uiautomator dump` parse
> failures** this run (one per ON block on `tap+describe(settle:false)`, so those cells are
> n = 19, and one fling sample dropped with its reason recorded).

### Pacing default row (new, process)

> scrcpy host pacing default is **`legacy`** — verified **character-identical** to
> `690e66bc`'s `injectTimeline` loop (18 lines, whitespace-normalized diff empty; the
> legacy catch path is the pre-3k one; no instrumentation on the default path).
> `ARGENT_SCRCPY_PACING=drift` is opt-in, read per gesture, any other value falls back to
> legacy (7 unit tests, `open-server-fast-inject-pacing.test.ts`). No default change until
> a same-run paired effect clears p < 0.05 with the pre-registered gate green.

### Screen-graph rows (run 34813849446; supersede the D.2 run-33964414774 table and restate the D.4.1 run-34801849653 table, naming all three run ids)

| row                                                                                                                          | required wording                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| success, full 100 denominator, Wilson (n = 100) + paired task-cluster bootstrap (n = 20 tasks, B = 10000, seed `0x5eedc0de`) | "B1 100/100 [96,100] · B2 100/100 · O1 100/100 · O2 100/100 · O3 100/100 · O4 100/100 · O5 100/100 — **success is at parity across all seven configs; the differentiator is tokens, not success.** Replication: run 34801849653, same code, 99/100 on O2 and 100/100 elsewhere."                                                                                             |
| B1 caveat (mandatory, carried from D41-H2, sourced to its own runs)                                                          | "B1 100/100 holds under a harness that performs an explicit post-action settle for every config and splits B1's collapsed `\"<title> / <summary>\"` describe labels into text/cd before resolution. The same B1 code without those two was 81/100 (run 34788497583) and 82/100 (run 34794414764); the D.4 82 % must not be read as a capability gap."                        |
| tokens/agent-step, o200k p50, n = 155 non-launch steps each                                                                  | "B1 657 · B2 651 · O1 179 · **O2 54** · O3 627 · O4 21 · O5 21. Launch-step observation excluded; each config observes its own sequence. Same-code run-to-run spread on these p50s: O1 138–179, O2 **54–68**, O3 598–627."                                                                                                                                                   |
| RTT count/step, p50, same n                                                                                                  | "B1 2 · B2 2 · O1 2 · O2 2 · O3 2 · O4 1 · O5 1. Not a latency column; modelled as action + observation, excludes the settle RPC."                                                                                                                                                                                                                                           |
| H1 tokens ratio                                                                                                              | "O1/B2 o200k p50 over all non-launch steps = 179/651 = **0.275×** (target ≤ 0.5×), PASS — identical to run 34801849653."                                                                                                                                                                                                                                                     |
| H2                                                                                                                           | "p50 over all non-launch steps: B2 − O2 = 0, **FAIL (structural)**. Same-screen steps (task-structural subset, n = 50 per arm): p50 2 − 1 = 1, PASS; means B2 2.00 vs O2 **1.20** (34801849653: 1.22)."                                                                                                                                                                      |
| H3 warm/cold                                                                                                                 | "O4/O3 o200k p50 = 21/627 = **0.033×** (target ≤ 0.2×), PASS."                                                                                                                                                                                                                                                                                                               |
| H4 non-inferiority, paired task-cluster bootstrap, B = 10000, seed `0x5eedc0de`, full 100 denominator                        | "vs B1 (100/100) and vs B2 (100/100): none inferior — O1 +0 [0,0] · O2 +0 [0,0] · O3 +0 [0,0] · O4 +0 [0,0] · O5 +0 [0,0]. Every arm is 100/100 on this run, so the comparison is unremarkable by construction; the informative version is run 34801849653 (O2 −1 [−3,0])."                                                                                                  |
| invariants gate                                                                                                              | "Store invariants OK: 0 duplicate screens, 0 multi-destination edges (`logs/sg-matrix.log:197`); `skippedNoIdHash` 0; three stores — `com.android.settings` **10 nodes / 9 edges, max out-degree 8, mean 0.9**, `com.android.chrome` 1/1, `com.google.android.settings.intelligence` 2/1. (Run 34801849653 built 11/10/9 for settings — the store shape is not run-stable.)" |
| O5 routing coverage, n = 60 known-target taps                                                                                | "**60/60 one-step routed** · 0 zero-step no-op · 0 mis-landed · **0 diverged** · 0 no-route · 0 nav fallbacks (run 34801849653: 59/60 with one hash-mismatch divergence)."                                                                                                                                                                                                   |
| O5 measured RPCs per one-step routed tap, n = 60                                                                             | "min 7 / p50 7 / max 7 — a LOWER bound."                                                                                                                                                                                                                                                                                                                                     |

**Screen-graph rows explicitly NOT allowed from this run:** the D41-H1 **post-action-wait
symmetry** row ("equal within 5 %") — on 34813849446 `actionRttMs + settleMs` p50 spreads
**2246 (B1) … 2644 (O5), 17.7 %, with B1 the cheapest**; publish it only from
34801849653 with that run id attached, or publish this run's spread as a caveat. Also
still not allowed (carried from D.4.1): `settleMs` alone as symmetry evidence, "B1's 82 %
was not a rendering property" unqualified, "O2 same-screen mean RTT/step 1.74", O5
`fallbacks` from the harness `results-ci.md`, and any token ×-factor without its statistic.
