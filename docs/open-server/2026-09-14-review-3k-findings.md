# Adversarial closure review — open-server phase 3k (run 34800933407)

Read-only review of `feat/open-server-3k` @ `1b128253` (5 commits on `open/main` @
`690e66bc`: `4ef552f0`, `f419f17b`, `2575d1ad`, `1408e233`, `1b128253` — the task's
"6 commits" is off by one) in the worktree `../argent-fork-wt-3k`, against
`docs/open-server/2026-09-13-open-server-3k-results-ci.md` and the `## Result` of
`2026-09-05-open-server-phase3k-fling-pacing-and-gates.md`, with
`2026-09-03-review-final-findings.md` (F2, F4–F7, F9–F16, F19),
`2026-09-03-open-vs-proprietary-results-final-ci.md` (run 7 = 33975063607),
`2026-09-03-review-3h-3i-c3.md`, `README.md` and
`2026-09-14-open-server-outcome-regression.md` as prior art.

Evidence: CI artifacts `bench-latency` of runs **34800933407** (reported) and
**34795811096** (superseded) — `fling-block-*.json`, `fling-ab-*.json`,
`bench-block-*.json`, `fling-log-*.txt`, `logs/device-test.log`,
`logs/logcat-device-test.txt`, `.bench-results/scoreboard.md`. Every published
statistic was recomputed by my own script from the per-sample arrays, never read off
the harness output; I additionally ran a 20 000-draw permutation test on the medians
of each arm pair. `node --test .github/bench-ci/gates.test.js` → 17 passed;
`npx vitest run --maxWorkers=2 test/open-server-fast-inject-pacing.test.ts` → 4
passed. No device, no new run, two `gh run download` calls total.

## VERDICT: REJECT

The arithmetic reproduces to the digit — all six fling cells, all four latency
blocks, the gate verdict string, the Part B counters and the three delivered-duration
numbers come back exactly from the artifacts. What fails is the headline. The report
says "**the fix works**" / "the reproducible long-duration under-scroll is
**RESOLVED**", but the report's own same-run control arm says otherwise: `legacy` →
`drift` is statistically indistinguishable in every gated cell (permutation p = 0.08 …
1.00, N = 11–12), and at 400 ms/0.3 the fixed arm is *marginally lower* than the
pre-3k arm (0.319 vs 0.324). The "RESOLVED" claim is made instead against **run 7**,
a different run — where the very same pre-3k code path, running as the `legacy` arm in
*this* run, already reads 0.901 / 0.884 against proprietary versus 0.642 / 0.580 in
run 7. Run-to-run variance on this metric is larger than the effect being claimed
(3K-H1, 3K-H2). The mechanism is equally unproven: zero `[pacing-trace]` lines reached
any artifact, the "delivered DOWN→UP" row is one swipe per arm parsed from two
Launcher `TaplEvents` lines (not InputDispatcher), and the pre-3k arm delivered 417 ms
for a 416 ms request — i.e. the host stretch the ticket hypothesised is *absent* on
this runner, so there was nothing for the fix to remove (3K-H3). Against the
proprietary reference scrcpy still under-scrolls at 400/0.3 by a significant −11 %
in **both** arms (p = 0.001), and the ticket's stated acceptance ("all six informative
cells within ±0.15 in one run, no whitelist") is not met — the gate is RED (3K-H4).

This is a REJECT of the **phase-A claim and its `## Result` wording**, not of the
branch. The code is sound and well tested, and **Part B (F5/F6/F7/F12/F13/F19,
whitelist removal, floor exclusion, 17 gate unit tests) is ACCEPT-grade and can land
on its own** — see `## Scoreboard rows allowed`. The path to an accept is: retract the
causal claim, re-word the Result as "run 7's 400 ms deficit did not reproduce on this
base, in either arm", fix the gate design (`## Gate recommendation`), and re-measure
after `fix/open-server-outcome-default-off` lands.

## HIGH

1. **3K-H1 — the same-run before/after shows no effect: `legacy` → `drift` is
   indistinguishable in every gated cell, and at 400/0.3 the fix is slightly worse.**
   My recompute from `fling-block-ON-scrcpy-legacy.json` / `fling-block-ON-scrcpy.json`
   (run 34800933407), medians with a 20 000-draw permutation test on the median
   difference: 150/0.3 Δ −0.145 p = 0.401; 250/0.3 Δ +0.017 p = 0.582; 400/0.3 Δ
   **−0.005 p = 0.282**; 400/0.5 Δ +0.054 p = 0.081. Not one cell reaches p < 0.05.
   The report's own table carries the same message and does not read it: 400/0.3
   scrcpy/uia `1.035 → 1.019`, 400/0.5 `0.993 → 1.085`
   (`2026-09-13-open-server-3k-results-ci.md`, fling table rows 400/0.3 and 400/0.5) —
   the "before" arm was already at parity with uia before the fix.
   Fix: delete "**Fix works**" / "RESOLVED" from the ticket `## Result` and the
   results file. The defensible in-run sentence is: *"the same-run before/after
   (legacy → drift, N = 11–12 per cell) shows no distinguishable change in scroll
   distance in any cell (permutation p ≥ 0.08); the pacing change is neutral on this
   runner."* Note also that with N = 12 on a 2-level metric this test has low power —
   "no distinguishable change" is not "proven equal", which is exactly why the claim
   cannot be run the other way either.

2. **3K-H2 — "resolved vs run 7" compares across runs while the in-run control
   contradicts it; the run-7 deficit simply did not reproduce on this base.**
   Run 7 (33975063607) pre-3k: 400/0.3 scrcpy/off 0.642, 400/0.5 0.580, 250/0.3 0.712
   (`2026-09-03-review-final-findings.md:353-360`). The **same pre-3k code** as the
   `legacy` arm of run 34800933407 gives 400/0.3 **0.901**, 400/0.5 **0.884**, 250/0.3
   **0.946** (my recompute). The change between runs on unchanged code (+0.26, +0.30,
   +0.23) is far larger than the change the fix is credited with. The report's
   sentence "Against run 7 (legacy pacing) the 400 ms cells read scrcpy/uia 0.717 and
   0.710 … this run they read 1.019 and 1.085 — parity" attributes a cross-run
   difference to the fix while a same-run control was available and says the opposite.
   Confounds between the two runs: different emulator session, and this base carries
   the always-on `outcome`/`settleAfterAction` path on `gesture-swipe`
   (`2026-09-14-open-server-outcome-regression.md`), which run 7 did not have.
   Fix: state the cross-run line as *"run 7's 400 ms under-scroll did not reproduce on
   `open/main` @ 690e66bc in either arm"* and keep the deficit **open**, not resolved.

3. **3K-H3 — the mechanism ("the fix is in the intermediate MOVE cadence") is asserted;
   the artifact contains no MOVE timing at all, and the endpoint data refutes the
   stretch hypothesis.** (a) `grep -c pacing-trace fling-log-ON-scrcpy.txt
   fling-log-ON-scrcpy-legacy.txt` → **0 / 0**: the host per-frame trace
   (`scrcpy-inject-backend.ts:481-483`) never reached an artifact; the report concedes
   this only in "Open items 4". (b) The delivered-duration row is **N = 1 per arm** and
   its "2 touch events" are not InputDispatcher: `deliveredSpanMs`
   (`android-open-server.device.test.ts`, added hunk) matches
   `/InputDispatcher|InputReader|MotionEvent/` + `/\b(DOWN|…|ACTION_UP)\b`, and in
   `logs/logcat-device-test.txt` the only lines matching that pair are Launcher's
   `D TaplEvents: TIS / TouchInteractionService.onInputEvent: MotionEvent {
   action=ACTION_DOWN|ACTION_UP }` — which by construction logs *only* the two
   endpoints. I reproduced the three numbers from exactly those pairs (405 ms at
   03:03:57.202→.607, 416 ms at 03:07:08.322→.738, 417 ms at 03:07:11.862→12.279);
   `setprop log.tag.InputDispatcher VERBOSE` (yml:278-279) produced no dispatch lines
   on this image, so the measurement works by accident through a different logger.
   (c) The legacy arm delivered **417 ms for a 416 ms request** — no host stretch at
   all — which contradicts the ticket's premise that the await-per-frame loop stretches
   the gesture on this runner, and therefore leaves the fix without an observed defect
   to fix.
   Fix: label the row "delivered DOWN→UP endpoints, 1 swipe per arm, from Launcher
   `TaplEvents` ACTION_DOWN/ACTION_UP (InputDispatcher VERBOSE produced nothing on this
   image)"; drop "the fix is in the intermediate MOVE cadence" until either the host
   trace reaches the fling-log (route it through the harness logger, Open item 4) or
   device-side MOVE `eventTime` deltas are captured (step 2(b)).

4. **3K-H4 — the phase is presented as a success against its own failed acceptance,
   and "400 ms at parity vs proprietary" hides a significant residual deficit.**
   The ticket's acceptance is "all six informative cells within ±0.15 of the reference
   in one run, no whitelist" (`2026-09-05-…-phase3k…md`, A.3). Result: the gate is
   **FAIL**, and only **4 of 6** cells are informative at all (150/0.5 and 250/0.5
   excluded at the floor) — so "all six" was not even testable. Against the proprietary
   arm, 400/0.3 is scrcpy 0.319 vs off 0.360, a **−11 %** difference that is
   statistically real in my permutation test (**p = 0.001**) — and equally real for the
   legacy arm (0.324 vs 0.360, p = 0.001). The report calls this cell "parity".
   Fix: the honest summary line is *"phase-3k acceptance NOT met: the gate is red on
   150/0.3, two cells are non-informative at the metric floor, and a significant
   ~11 % scrcpy under-scroll vs proprietary persists at 400/0.3 in both arms"*.

## MEDIUM

1. **3K-M1 — "N = 12 per cell per backend" is not true, and the single number that
   carries the defence of the red cell rests on n = 8.** Per-arm n from the block
   JSONs: OFF 150/0.3 **n = 8**, OFF 150/0.5 n = 11; uia 150/0.5 n = 11, uia 250/0.5
   n = 11; scrcpy 250/0.3 n = 11, scrcpy 400/0.3 n = 11 (9 of 24 cell-arms below 12).
   `bench-fling-fidelity.ts` drops a sample silently when the anchor displacement is
   null (`if (d !== null) samples.push(d)`), and `fling-log-OFF.txt` carries no error
   line for the four missing OFF samples — no reason recorded. The report's header
   ("fling A/B N = 12 per cell per backend") and its table caption ("N=12") state
   otherwise, and the sentence "scrcpy/off = 0.722 is *closer* to proprietary than uia
   is" is computed against that n = 8 median (0.443).
   Fix: print n per arm per cell in the report table; require n ≥ 10 on **every** arm
   used in a gate or in a transparency ratio (`merge-fling.js:55-64` checks only uia
   and scrcpy), and log the drop reason.

2. **3K-M2 — the gate's only red is not a distinguishable difference either.** At
   150/0.3 drift vs uia: Δ median +0.088, permutation **p = 0.741**; both sample sets
   are the same two-level mixture (`{0.175, 0.464, …}`). A ±0.15 band on a ratio of
   medians of a bimodal 2-state metric at N = 12 is not a test — it fires on which side
   of the 50th percentile the coin landed. Same cell, run 34795811096: uia 0.175,
   scrcpy 0.445, ratio 2.540; run 7: 0.449 / 0.466, ratio 1.038. Three runs, three
   verdicts, one code path.
   Fix: see `## Gate recommendation`.

3. **3K-M3 — the supersession of run 34795811096 is asserted with no numbers, and the
   causal story it does give is not what the data shows.** The removal itself is
   complete and verified: VERBOSE `setprop` survives only in the device-test step
   (`bench-open-vs-proprietary.yml:278-279`) and is explicitly refused in the latency
   (yml:319-324) and fling (yml:400-404) steps. But the report prints no evidence.
   My recompute: VERBOSE slowed **both** arms, not only ON — OFF-1 paste 894/1471 vs
   507/1223 clean, OFF-1 describe p95 131 vs 53 — and the uia fling arm was floored
   only at **150/0.3** (0.175 vs 0.232 clean); at 400/0.3 the contaminated uia arm is
   *higher* (0.340 vs 0.313) and at 400/0.5 unchanged (0.593 vs 0.585). So "perturbed
   the ON path's synced UiAutomation inject and pushed the uia fling arm to the floor"
   is not supported as stated; the one floored cell is the same bimodal cell that
   flips between every run (3K-M2).
   Fix: publish the two-run comparison that justifies the supersession (ON and OFF
   latency deltas), and re-word to "VERBOSE input logging inflated latency on all four
   blocks; the run is superseded for that reason".

4. **3K-M4 — "unchanged verbs vs run 7 within drift floors" does not hold for
   `await-screen-idle`, and one ON row is missing from the table.** Recompute
   (p50/p95, from `bench-block-*.json`): ON `await-screen-idle` **287/292** (uia) and
   **287/289** (scrcpy) against run 7's 463/472 and 461/474, while OFF is unchanged
   (496/495 vs 498/497) — a **−176 ms** ON-only change against a **1 ms** drift floor,
   labelled "unchanged direction (ON win)". `await-ui-element` ON 37/34 vs run 7 32/31
   is also outside its 1 ms floor (small, but not "unchanged"). OFF `tap+describe` is
   401 vs 274 **within this run** (drift 127 ms vs run 7's floor of 8), reported as
   "OFF comparable". And `tap+describe(settle:true)` (ON-uia 1111/1236, ON-scrcpy
   1105/1277 vs run 7's 788/1100 and 774/1039) is omitted from the report's table
   entirely. The tap/swipe deviation itself **is** the known base regression and
   nothing else: it hits ON-uiautomation (723/828) which uses no scrcpy, OFF is normal
   (52/53, 53/54), fallbacks = 0, and it matches
   `2026-09-14-open-server-outcome-regression.md` root cause
   (`gesture-tap/index.ts:136-138`, `gesture-swipe/index.ts:154-164` →
   `settleAfterAction`) — confirmed, do not re-diagnose.
   Fix: add a per-verb "vs run 7 / drift floor" column with the arithmetic, restore the
   settle:true row, and move `await-screen-idle` + `await-ui-element` out of
   "unchanged" into "changed on this base, cause not established".

5. **3K-M5 — the fling A/B was measured through the regressed swipe path, so these
   rows may not survive the pending fix.** `bench-fling-fidelity.ts:133` drives each
   swipe with `reg.invokeTool("gesture-swipe", …)`, i.e. the tool path that on this
   base unconditionally takes `openServerSwipeWithOutcome` +
   `TreeStore.ensure()/settleAfterAction`. `fix/open-server-outcome-default-off`
   changes exactly that path.
   Fix: state in the report that the fling A/B is conditional on the outcome-path base,
   and re-run the A/B (drift + legacy + uia + off) after the regression fix before any
   fling row is published.

6. **3K-M6 — arm is confounded with time: the four fling arms are sequential blocks,
   never interleaved.** `startedAt`/`finishedAt` in the block JSONs: uia 03:34:38 →
   03:41:26, drift 03:41:32 → 03:48:19, legacy 03:48:24 → 03:55:11, off 03:55:16 →
   04:02:03. Every cell's 11–12 samples are contiguous inside one arm's 7-minute
   window, so any emulator drift over the 27 minutes maps directly onto an arm
   difference. With the effect size at or below noise (3K-H1) this matters.
   Fix: interleave arms per cell (round-robin) or run two passes in reversed arm order
   and report both; at minimum disclose the block ordering next to the table.

## LOW

1. **3K-L1 — the `drift` / `legacy` naming misdescribes the change.** The pre-3k loop
   was already drift-corrected (`690e66bc:packages/tool-server/src/utils/
   scrcpy-inject-backend.ts:318`: `const wait = anchor + f.tMs - performance.now()`
   recomputed per frame, with the comment "so a slow write does not push the rest of
   the gesture late"). The only delta is dropping the per-frame `await` — socket
   decoupling. Call the arms `awaited` / `decoupled`, or say "drift-corrected (as
   before) + socket-decoupled (new)" in the tables, not just "drift".

2. **3K-L2 — the "legacy" arm is a faithful re-implementation, not the byte-identical
   pre-3k code.** `scrcpy-inject-backend.ts:388-396` reproduces the old loop exactly
   (same wait, same `await controller.injectTouch`, same `applyDown` after the await,
   same catch → `cancelDownPointers` → `dropClient` → rethrow), adding only two
   `performance.now()` calls and one array push per frame plus one log line per
   gesture. Behaviourally equivalent; worth one sentence of disclosure in the report,
   which currently calls it "the pre-3k await-per-frame loop is kept".

3. **3K-L3 — ordering under concurrent writes is argued from library source, not
   tested; the claim holds, but the test does not prove it.** The chain is real:
   `ScrcpyControlMessageWriter.injectTouch` serialises synchronously and calls
   `Consumable.WritableStream.write(#writer, msg)`
   (`node_modules/@yume-chan/scrcpy/esm/control/writer.js:10,22`), which does
   `writer.write(consumable)` on a `WritableStreamDefaultWriter` obtained from
   `controlStream.writable.getWriter()`
   (`node_modules/@yume-chan/adb-scrcpy/esm/client.js:206`) over the platform
   `WritableStream` (`@yume-chan/stream-extra/esm/stream.js`), so WHATWG FIFO queueing
   applies and frames reach the socket in dispatch order. The unit test's ordering
   assertion (`open-server-fast-inject-pacing.test.ts`, "frames in order (DOWN…UP)")
   records *call* order on a mock, which cannot fail. Queue growth is bounded by the
   frame count of one gesture (`await Promise.all(pending)` before return), so there is
   no unbounded queue; backpressure is deliberately ignored, which is the point of the
   fix. Multi-pointer/pinch semantics are unchanged (same frames, same order, per-slot
   dispatch), and ON-scrcpy pinch p50 308 ms matches run 7's 307 ms.

4. **3K-L4 — in `drift` a write failure no longer aborts the gesture.** The loop has no
   early break on `writeErr` (`scrcpy-inject-backend.ts:402-425`): after the first
   rejection it keeps sleeping to every remaining slot and queueing writes, so the
   throw — and therefore the loud Kotlin fallback
   (`blueprints/android-open-server.ts:1116-1128`, `console.warn` + `console.debug` +
   `fastInjectFallbacks++`, unchanged and still counted/gated at 0) — arrives only
   after the full gesture duration, on a partially landed gesture. The catch
   compensates correctly by rebuilding `down` from all non-UP frames (:429-440).
   Suggest breaking out of the loop once `writeErr !== null`.

5. **3K-L5 — F6 is logged, not gated.** `bench-open-vs-proprietary.ts` `noteShortCircuit`
   emits one `[bench][locate] uiautomator-dump short-circuited …` line per block (it
   fired once in all four blocks of this run — `grep -c short-circuited
   bench-log-*.txt` → 1,1,1,1) and the scoreboard renders the locate split
   (`scoreboard.js`, "Locate source & no-effect taps (F5 / F7)"), but nothing fails on
   it. Report wording "the dump short-circuit is a logged/gated event" → "logged and
   surfaced; not gated".

6. **3K-L6 — "device suite 19/19" is not comparable to run 7's 17/17.** The two new
   tests are the 3k pacing measurements, which `record(…, "PASS", …)` unconditionally
   and assert only `isReady()` (device test additions). Say "17/17 enforced + 2
   measurement-only records".

7. **3K-L7 — provenance of `scrcpy/off 0.642 / 0.580`.** They come from
   `2026-09-03-review-final-findings.md:359-360`, not from the cited
   `2026-09-03-open-vs-proprietary-results-final-ci.md` (whose run-7 fling table has no
   OFF column). Cite the review file.

8. **3K-L8 — the report asks for a bisect that is already done.** "Worth bisecting the
   `feat/screen-graph-d` merge" (Open items 2) predates
   `2026-09-14-open-server-outcome-regression.md`, which already names the root cause
   and has a branch. Cross-reference it on merge.

## Gate recommendation

Keep the ±0.15 band and the no-whitelist rule; fix **what counts as a gradable cell**
and **what the denominator is**. Concretely, three changes to `merge-fling.js`:

1. **Reference-bimodality exclusion (new).** A cell is non-informative when the
   *reference* distribution straddles the metric floor — `q25(uia) <= SCROLL_FLOOR +
   eps` (and likewise for `off` when `off` is used as a denominator). Key it on the
   **reference arms only, never on the scrcpy arm**, so a scrcpy defect can never
   exempt its own cell. This replaces "both arms pinned at the floor" (which is the
   degenerate case of the same rule) and is the honest answer to option (a) in the
   report's Open items.
2. **Power floor.** Require `n >= 10` on **every** arm that enters a gated ratio,
   including `off` (today `reliable` checks only uia and scrcpy,
   `merge-fling.js:55-64`); otherwise the cell is non-informative and is reported as
   such, not passed.
3. **Two-sided reference.** On the cells that survive, require **both**
   `|scrcpy/uia − 1| <= 0.15` **and** `|scrcpy/off − 1| <= 0.15` when the OFF arm is
   present. This is what stops "uia is the unstable arm" from ever being an excuse, and
   it keeps the gate able to catch the original defect.

Validation that the rule is not a whitewash — applied to **run 7 (33975063607)** it
stays red: 150/0.3 excluded (uia IQR [0.175, 0.509] straddles the floor), 250/0.5
excluded (uia floored), and 250/0.3 (0.908 / **0.712**), 400/0.3 (**0.717** / 0.642),
400/0.5 (**0.710** / 0.580) all fail on at least one side — 3 red cells, versus the 1
the old gate named.

Resulting verdict per cell for run **34800933407** under this rule (my recompute):

| cell | scrcpy/uia | scrcpy/off | status under the proposed rule |
|---|---|---|---|
| 150 / 0.3 | 1.379 | 0.720 | **NON-INFORMATIVE** — uia q25 = 0.175 (IQR [0.175, 0.461]) and off q25 = 0.175, and off n = 8 < 10 |
| 150 / 0.5 | 1.000 | 1.000 | non-informative (all arms at the floor) |
| 250 / 0.3 | 0.970 | 0.983 | **PASS** |
| 250 / 0.5 | 1.000 | 0.548 | non-informative (uia floored) |
| 400 / 0.3 | 1.019 | 0.886 | **PASS** (dev 0.114 on the off side — inside the band, but see 3K-H4: the −11 % is real at p = 0.001) |
| 400 / 0.5 | 1.085 | 0.967 | **PASS** |

Verdict string it should produce: `PASS (per-cell ±0.15 on scrcpy/uia AND scrcpy/off,
NO whitelist, over 3 informative cell(s); 3 of 6 cells non-informative at the metric
floor)`. That is a *conditional* green and must be published with the disclosure that
half the grid is ungradable on this runner at N = 12 — the right follow-up is to raise
N per cell (≥ 24) or replace the anchor-displacement metric whose 0.175 floor causes
the bimodality, not to celebrate the pass. A gate that flips a red to a green must be
pre-registered before the next run, not chosen after seeing 150/0.3.

## Scoreboard rows allowed

Reference run ids: **34800933407** for everything below; **33975063607 (run 7)** stays
the accepted latency/fling reference until the outcome-regression fix lands.

Allowed now:

1. Gate/process row (no measurement): *"Fling parity gate (phase 3k, run 34800933407):
   per-cell `scrcpy(drift)/uia ±0.15`, **blocking, no whitelist** (the value-bounded
   whitelist is removed); cells with both arms at the 0.175 scroll floor excluded;
   `scrcpy/off` and `uia/off` printed as transparency; 17 gate unit tests
   (`.github/bench-ci/gates.test.js`) run in `unit-tests.yml` — tap-timeline parity,
   oracle self-test, vacuous arm, degraded arm, redir, zero fast-inject fallback,
   landing-rate (firing and non-firing), missing ON block, fling no-whitelist FAIL,
   floor exclusion, missing drift arm, all with failing inputs. Not covered by a firing
   test: the device-test enforcement step (still evidence-free)."*
2. Bench-honesty row: *"F5 locate split published per block (0 dump / 40–60 describe in
   all four blocks, run 34800933407); F6 dump short-circuit logged (fired in all four
   blocks) — logged, not gated; F7 no-effect identity captured (0 misses this run);
   F12 per-block ready gate blocking; F13 an executable OFF baseline failure fails the
   run; F19 `destinationVisible` probe removed."*
3. Fling status row **replacing** the run-7 "open loses" row's status, with the deficit
   left OPEN: *"Run 7's 400 ms scrcpy under-scroll did not reproduce in run 34800933407
   on this base: the pre-3k `legacy` arm itself reads scrcpy/off 0.901 (400/0.3) and
   0.884 (400/0.5) versus 0.642 / 0.580 in run 7 (N = 11–12 per cell). The phase-3k
   drift/decoupled pacing shows no distinguishable change against the legacy arm in any
   cell (permutation p ≥ 0.08). A ~11 % scrcpy under-scroll vs proprietary persists at
   400/0.3 in both arms (0.319 / 0.324 vs off 0.360, p = 0.001). Status: open, not
   resolved; gate RED on 150/0.3 (ratio 1.379) — a cell where the two distributions are
   not distinguishable (p = 0.74) and the OFF reference has n = 8."*

Not allowed:

4. **No "fling pacing fixed / under-scroll resolved" row**, and no `legacy → drift`
   improvement row (3K-H1, 3K-H2).
5. **No pacing-measurement row** from the delivered-duration table as written. If the
   planner wants it, only in this form and outside the results table: *"delivered
   DOWN→UP endpoints, one swipe per arm, parsed from Launcher `TaplEvents`
   ACTION_DOWN/UP: uia 405, scrcpy drift 416, scrcpy legacy 417 (requested 416);
   InputDispatcher VERBOSE produced no dispatch lines on this image; no intermediate
   MOVE timing was captured in any artifact."*
6. **No latency verb rows** from this run: the base carries the tap/swipe outcome-path
   regression (`2026-09-14-open-server-outcome-regression.md`) and, separately,
   `await-screen-idle` moved −176 ms ON-only against a 1 ms floor with no established
   cause (3K-M4). Latency rows stay at run 7 until the fix run lands.
7. **No fling rows at all** once `fix/open-server-outcome-default-off` is merged
   without a re-run — the A/B drives `gesture-swipe` through the path that fix changes
   (3K-M5).
