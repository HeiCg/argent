# Open server phase 3k — scrcpy fling pacing + bench-gate hardening (CI results)

> **Corrected 2026-09-14 after the adversarial review
> (`2026-09-14-review-3k-findings.md`, VERDICT REJECT of part A).** The earlier
> version of this file claimed the long-duration under-scroll was "RESOLVED" / "the
> fix works". That claim is **retracted**: it rested on a cross-run comparison while
> this run's own same-run control arm shows no distinguishable effect (see
> [Fling A/B](#fling-ab)). Part B (F5/F6/F7/F12/F13/F19, whitelist removal, floor
> exclusion, gate unit tests) is ACCEPT-grade and stands. The pacing default is now
> `legacy` (byte-equal to pre-3k) with `drift` opt-in, and the fling deficit is
> **OPEN**, handled in phase 3k.1.

Repo: **HeiCg/argent** fork. Branch `feat/open-server-3k` off `open/main` @ `690e66bc`.
Reported run: **34800933407** (`feat/open-server-3k` @ `1408e233`), workflow
`bench-open-vs-proprietary.yml`, `-f suite=latency -f blocks="OFF-1,ON-uiautomation,
ON-scrcpy,OFF-2" -f n=20`. Runner: **ubuntu-latest, x86_64, KVM-accelerated emulator**,
`system-images;android-34;google_apis;x86_64`, Android 14 / SDK 34, 1080x2400 @ 420dpi.
**N = 20 per verb per block; fling A/B N = 11–12 per cell per backend** (not 12 on every
cell — see [n per arm](#fling-ab)). Not comparable to a local arm64/HVF host. The fling
A/B carries the pre-3k `ON-scrcpy-legacy` (await-per-frame) and the `ON-scrcpy` drift
arm in the SAME run — the phase-3k before/after.

First 3k run **34795811096 is superseded** — with numbers. It enabled `InputDispatcher/
InputReader VERBOSE` during the latency+fling steps (added for F7). VERBOSE inflated
latency on **all four blocks**, not only ON: OFF-1 paste **894/1471** vs **507/1223**
clean, OFF-1 describe p95 **131** vs **53** clean; and it floored the uia fling arm only
at **150/0.3** (0.175 vs 0.232 clean) while at 400/0.3 the contaminated uia arm was
_higher_ (0.340 vs 0.313) and at 400/0.5 unchanged (0.593 vs 0.585). So the run is
superseded because **VERBOSE input logging inflated latency on all four blocks**, not
because it "pushed the uia fling arm to the floor" (the one floored cell is the same
bimodal 150/0.3 that flips between every run). VERBOSE was removed from the latency and
fling steps (kept only in the isolated device-test step); run 34800933407 is the clean
measurement. Do not blend the two.

Read with `2026-09-03-review-final-findings.md` (F2, F4–F7, F9–F16, F19) and
`2026-09-03-open-vs-proprietary-results-final-ci.md` (run 7 = 33975063607, the before
baseline). **No scoreboard rows until adversarial review** (done: see the findings'
"Scoreboard rows allowed").

## What changed (code)

- **scrcpy host pacing (A).** `scrcpy-inject-backend.ts injectTimeline` gained a
  drift-corrected, socket-decoupled pacing mode: it dispatches each MOVE frame at its
  wall-clock slot (`anchor + tMs`) and INITIATES the `injectTouch` write there without
  awaiting its consume. The pre-3k await-per-frame loop is kept as `legacy`, selected
  per process by `ARGENT_SCRCPY_PACING`. **No velocity tuning.** (Phase 3k.1 makes
  `legacy` the DEFAULT and `drift` opt-in — see that ticket.)
- **Measurement (option i).** A per-swipe host pacing trace and a local unit test that
  proves drift decouples the write span from the dispatch span while legacy couples
  them. Device-test `3k pacing` reads the delivered MotionEvent DOWN→UP span from
  logcat. Caveat below: on this image the host trace never reached the artifact and the
  logcat span sees only the two Launcher endpoints (3K-H3).
- **Gate (A.3 / F4 / F9).** `merge-fling.js`: value-bounded whitelist **removed**; the
  gate is per-cell `scrcpy(drift)/uia ±0.15`, blocking, no whitelist; both-arms
  floor-pinned exclusion kept; transparency rows `scrcpy/off`, `uia/off` and
  `legacy→drift` printed. (The gate DESIGN is superseded by the pre-registered 3k.1
  rule; see the findings' "Gate recommendation".)
- **Part B honesty.** F7, F6, F12, F13, F19 and 17 gate unit tests wired into
  `unit-tests.yml`. All ACCEPT-grade.

## Result

Reported run **34800933407**. The phase-3k **causal claim is not supported** by this
run; Part B is sound. Point by point:

### Fling A/B — the pacing before/after (per-cell, median normalized scroll + IQR + n)

before = `ON-scrcpy-legacy` (await-per-frame), after = `ON-scrcpy` (drift), same run.
Every statistic recomputed from the per-sample arrays; paired legacy→drift is a
20 000-draw permutation test on the median difference.

| cell    | uia (IQR, n)             | scrcpy drift (IQR, n)        | scrcpy legacy (n) | off (n)       | scrcpy/uia leg→drift | scrcpy/off leg→drift | Δ(drift−legacy) | paired perm p |
| ------- | ------------------------ | ---------------------------- | ----------------- | ------------- | -------------------- | -------------------- | --------------- | ------------- |
| 150/0.3 | 0.232 [0.175,0.461] (12) | 0.320 [0.175,0.464] (12)     | 0.464 (12)        | 0.443 (**8**) | 2.000→1.379          | 1.048→0.722          | −0.145          | **0.40**      |
| 150/0.5 | 0.175 [floor] (11)       | 0.175 [floor] (12)           | 0.175 (12)        | 0.175 (11)    | 1.000→1.000          | 1.000→1.000          | 0.000           | 1.00          |
| 250/0.3 | 0.473 [0.452,0.483] (12) | 0.459 [0.426,0.468] (**11**) | 0.442 (12)        | 0.467 (12)    | 0.934→0.970          | 0.947→0.983          | +0.017          | 0.58          |
| 250/0.5 | 0.175 [floor] (11)       | 0.175 [0.175,0.464] (12)     | 0.175 (12)        | 0.320 (12)    | 1.000→1.000          | 0.547→0.547          | 0.000           | 1.00          |
| 400/0.3 | 0.313 [0.29,0.318] (12)  | 0.319 [0.296,0.324] (**11**) | 0.324 (12)        | 0.360 (12)    | 1.035→1.019          | 0.900→0.886          | −0.005          | **0.28**      |
| 400/0.5 | 0.585 [0.573,0.648] (12) | 0.635 [0.589,0.643] (12)     | 0.581 (12)        | 0.657 (12)    | 0.993→1.085          | 0.884→0.967          | +0.054          | **0.08**      |

**The long-duration under-scroll is NOT resolved by this run.** The same-run before/after
(legacy → drift, N = 11–12 per cell) shows **no distinguishable change** in scroll
distance in any cell (permutation p ≥ 0.08); the pacing change is **neutral on this
runner**. At 400/0.3 the drift arm is if anything marginally lower than legacy (0.319 vs
0.324, Δ −0.005). With N = 12 on a 2-level metric this test has low power — "no
distinguishable change" is not "proven equal", which is exactly why the claim cannot be
run the other way either.

**The run-7 deficit did not reproduce — cross-run, not fixed.** Run 7 (33975063607) pre-3k
read 400/0.3 scrcpy/off **0.642**, 400/0.5 **0.580**, 250/0.3 **0.712**
(`2026-09-03-review-final-findings.md:353-360`). The **same pre-3k code** running as the
`legacy` arm of THIS run reads 400/0.3 **0.901**, 400/0.5 **0.884**, 250/0.3 **0.946** —
a +0.26/+0.30/+0.23 change on unchanged code, far larger than the change the fix is
credited with. The defensible cross-run sentence is: _"run 7's 400 ms under-scroll did
not reproduce on `open/main` @ 690e66bc in either arm"_ — the deficit is **OPEN, not
resolved**. Confounds between the two runs: a different emulator session, and this base
carries the always-on `outcome`/`settleAfterAction` path on `gesture-swipe`
(`2026-09-14-open-server-outcome-regression.md`), which run 7 did not have — so the fling
A/B here was measured through the regressed swipe path.

**Residual vs proprietary is real.** Against the OFF arm, 400/0.3 is scrcpy **0.319** vs
off **0.360**, a ~11 % under-scroll that is statistically real in the permutation test
(**p = 0.001**) — and equally real for the legacy arm (0.324 vs 0.360, p = 0.001). This
cell is not "parity".

**Gate (old design):** `FAIL (1 informative cell outside ±0.15: 150ms/0.3=1.379)`. The
one red is a short-duration **bimodal** cell where the uia REFERENCE straddles the 0.175
floor (uia [0.175,0.461], scrcpy [0.175,0.464], off [0.175,0.464], off n = 8) and the two
distributions are not distinguishable (drift vs uia Δ +0.088, p = 0.74) — the "uia is the
unstable arm" F2 effect tripping the no-whitelist gate, not a scrcpy defect. This is a
**gate-design** problem, fixed by the pre-registered 3k.1 rule (reference-bimodality
exclusion keyed on the reference arms, power floor on every arm, two-sided scrcpy/uia AND
scrcpy/off). Under that rule this run reads **3 PASS / 3 non-informative** — a
_conditional_ green that must be published WITH the disclosure that half the grid is
ungradable at N = 12, and the deficit stays OPEN because the same-run paired test is not
significant.

### Delivered swipe duration (device logcat, `3k pacing`, 26-frame ≈416 ms swipe) — caveated

| arm           | delivered DOWN→UP | requested | source                                            |
| ------------- | ----------------- | --------- | ------------------------------------------------- |
| UiAutomation  | 405 ms            | 416 ms    | Launcher `TaplEvents` ACTION_DOWN/UP, **1 swipe** |
| scrcpy drift  | 416 ms            | 416 ms    | Launcher `TaplEvents` ACTION_DOWN/UP, **1 swipe** |
| scrcpy legacy | 417 ms            | 416 ms    | Launcher `TaplEvents` ACTION_DOWN/UP, **1 swipe** |

**This row does not prove the mechanism.** `grep -c pacing-trace fling-log-*.txt` → 0/0:
the host per-frame trace never reached an artifact (the fling harness swallows the
backend log/stdout). The delivered row is **N = 1 per arm** and its "2 touch events" are
**Launcher `TaplEvents`**, which by construction log only the two endpoints — NOT
InputDispatcher (`setprop log.tag.InputDispatcher VERBOSE` produced no dispatch lines on
this image), so **no intermediate MOVE cadence was captured in any artifact**. The legacy
arm delivered **417 ms for a 416 ms request** — no host stretch at all — which contradicts
the ticket's premise that the await-per-frame loop stretches the gesture on this runner.
The claim "the fix is in the intermediate MOVE cadence" is **not evidenced**. (Phase 3k.1
routes the host trace to a file and reads device-side MotionEvent eventTimes via
`dumpsys input`, which include the MOVE frames.)

### Latency verbs vs run 7 (p50/p95 ms) — corrected

| verb                       | OFF-1    | ON-uia        | ON-scrcpy     | OFF-2    | vs run 7                                                                                                                                        |
| -------------------------- | -------- | ------------- | ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| describe (idle)            | 52/53    | 33/57         | 35/55         | 52/53    | unchanged (ON ≤ OFF; direction only, F1)                                                                                                        |
| await-screen-idle          | 496/537  | **287/292**   | **287/289**   | 495/502  | **CHANGED on this base, cause not established**: ON −176 ms vs run 7 (463/472, 461/474) against a 1 ms OFF drift floor (OFF 496/495 vs 498/497) |
| await-ui-element           | 73/76    | 37/34         | 34/41         | 72/80    | **CHANGED**: ON 37/34 vs run 7 32/31, outside its 1 ms floor (small)                                                                            |
| paste                      | 507/1223 | 290/476       | 286/442       | 521/1094 | unchanged (directional; 110 ms floor, F16)                                                                                                      |
| gesture-pinch              | 347/358  | 345/378       | 308/315       | 350/375  | unchanged (ON-scrcpy pinch 308 vs run 7 307)                                                                                                    |
| gesture-tap                | 52/53    | **723/828**   | **721/881**   | 53/54    | **base regression** (outcome path)                                                                                                              |
| gesture-swipe              | 293/306  | **1152/1238** | **1100/1149** | 290/317  | **base regression** (outcome path)                                                                                                              |
| tap+describe               | 401/842  | —             | —             | 274/1016 | **OFF not comparable**: 401 vs 274 within-run (127 ms drift vs run 7's 8 ms floor)                                                              |
| tap+describe(settle:false) | —        | 736/914       | 777/884       | —        | inflated by the base regression                                                                                                                 |
| tap+describe(settle:true)  | —        | **1111/1236** | **1105/1277** | —        | vs run 7 788/1100, 774/1039 — inflated by the base regression (was omitted before)                                                              |

The **tap/swipe/settle inflation IS the known base regression and nothing else**: it hits
ON-uiautomation (which uses no scrcpy), OFF is normal, fallbacks = 0, and it matches
`2026-09-14-open-server-outcome-regression.md` (`gesture-tap/index.ts`,
`gesture-swipe/index.ts` → `settleAfterAction`). Confirmed, not re-diagnosed. **No latency
verb rows from this run enter the scoreboard** — they stay at run 7 until the fix run
lands (the outcome fix has since merged; 3k.1 re-measures).

### F5 / F6 / F7 / transport (per block)

| block           | locateVia dump/describe | first-attempt no-effect | transport | oracle |
| --------------- | ----------------------- | ----------------------- | --------- | ------ |
| OFF-1           | 0 / 40                  | 0                       | n/a       | pass   |
| ON-uiautomation | 0 / 60                  | 0                       | redir     | pass   |
| ON-scrcpy       | 0 / 60                  | 0                       | redir     | pass   |
| OFF-2           | 0 / 40                  | 0                       | n/a       | pass   |

`locateVia = describe 100%` in every block; the F6 short-circuit fired and is **logged
and surfaced, not gated**. No first-attempt no-effect taps this run (scrcpy 60/60), so no
F7 identities to print. Device suite: **17/17 enforced + 2 measurement-only records** (the
two 3k pacing tests `record(…, "PASS", …)` unconditionally and assert only `isReady()`),
not "19/19" comparable to run 7's 17/17.

## Open items — carried into / addressed by phase 3k.1

1. **Fling gate design** → pre-registered rule (findings "Gate recommendation"),
   implemented in 3k.1 `merge-fling.js`.
2. **Base ON tap/swipe latency regression** → root-caused and fixed in
   `fix/open-server-outcome-default-off` (merged).
3. **Host pacing trace in CI** → routed to a file (3k.1); device-side MotionEvent cadence
   read from `dumpsys input`. What 3k.1 then FOUND: the deficit is **not** resolved. The
   host dispatch span equals the requested duration on the traced (`drift`) arm, but the
   device-side `dumpsys` read shows **both** scrcpy arms delivering a stretched tail
   (452/439 ms for a 416 ms request, final MOVE→UP gap 46/35 ms vs uia's 417/17 ms). The
   mechanism is **OPEN**, and the 8-frame-schedule explanation is **ruled out** — the uia
   arm sends the identical 8 wire frames and reads `uia/off` 1.037 at 400/0.3
   (`2026-09-05-open-server-phase3k-fling-pacing-and-gates.md` "Result (3k.1)",
   review 3K1-H1/H2).
4. **Pacing default** → `legacy` (byte-equal pre-3k) with `drift` opt-in; the A/B keeps
   both arms so every run adds a paired sample, and no default changes until a same-run
   paired effect clears p < 0.05 with the pre-registered gate green.
