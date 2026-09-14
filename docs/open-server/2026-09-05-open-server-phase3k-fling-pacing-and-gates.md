# Ticket: phase 3k — scrcpy fling pacing (long-duration momentum deficit) + bench gate hardening

Repo: ARGENT FORK. Code branch from `feat/android-open-server-final` (head after the
consolidation), CI branch from `feat/bench-ci-final`. Worktrees `argent-final` /
`argent-final-ci`. NO local emulator/adb; CI only; one `gh run view` per 10 minutes in
the foreground (`sleep 540` in the same Bash call), never a background monitor.
Read first: `2026-09-03-review-final-findings.md` (F2, F4–F7, F9–F16, F19) and
`2026-09-03-open-vs-proprietary-results-final-ci.md`.

## A. The real loss: scrcpy under-scrolls at long durations
Evidence (runs 33963464784 and 33975063607, scroll-distance ratio vs proprietary):
400 ms/0.3 → 0.66 / 0.64; 400 ms/0.5 → 0.57 / 0.58; 150 ms cells at parity;
deficit monotone in duration. Inferred mechanism (verify first): `gesture-swipe`
builds `round(duration/16)` frames (gesture-swipe/index.ts:177); the scrcpy backend
paces them HOST-side, awaiting one `injectTouch` write per frame over the socket
(scrcpy-inject-backend.ts:306-326, `MOMENTUM_STEP_MS` 16 in scrcpy-inject-timeline.ts:109),
so 26 frames at 400 ms stretch the gesture and lower the release velocity;
UiAutomation and the proprietary path hand the whole gesture to the device in one call.
1. Measure before changing: log per frame the intended `tMs` vs the actual wall-clock
   write time and the total gesture wall time for 150/250/400 ms swipes (host side),
   plus `MotionEvent` eventTime deltas from logcat (InputDispatcher verbose, device
   test step) — prove the stretch.
2. Fix candidates, in order: (a) schedule frame writes on a drift-corrected timer and
   do not await the socket per frame (write all frames whose `tMs` has elapsed, keep
   the DOWN→UP total equal to `duration`), verifying the server injects in order;
   (b) if the socket/adb hop still stretches, send the whole timeline to the device
   and inject it there with device-side timestamps (a small on-device "timeline"
   message in the Kotlin server used by the scrcpy backend for MOVE frames, or fall
   back to the Kotlin swipe for durations ≥ 250 ms and say so); (c) tune release
   velocity only if (a)/(b) leave a residual and only symmetrically.
3. Acceptance: all six informative cells within ±0.15 of the proprietary reference in
   one run, no whitelist; the gate's whitelist (merge-fling.js:57-60) removed.

## B. Bench honesty items queued by the final review (no numbers change)
- F7: log the no-effect iteration's identity (block, verb, iteration, before/after
  fingerprints, timings) and capture logcat during bench blocks, so a 59/60 can be
  diagnosed.
- F4/F9: fling gate — whitelist gets value bounds or is removed (see A.3); cells
  with either arm pinned at the 0.175 metric floor are excluded, not counted as parity.
- F5/F6: `locateVia` printed per block in the scoreboard; the dump short-circuit is a
  logged, gated event; state that locate is per-backend and the fingerprint is not.
- F12/F13: per-block ready gate blocking (no `|| true`); a missing OFF baseline fails
  the run instead of a warning.
- F19: `destinationVisible` probe locates fresh per iteration or is removed; an
  all-zero oracle-adjacent probe must fail loudly.
- Gates never observed to fire: unit tests in `.github/bench-ci/` for tap-timeline
  parity, oracle self-test, vacuous-arm, degraded-arm, redir, zero-fallback and the
  device-test enforcement step (a forced failure in a throwaway run is acceptable
  evidence for the last one).
- F3: scoreboard.js prints "at parity" when a difference does not clear the OFF-1/OFF-2
  drift floor for that verb.

## Output
One CI latency run; results appended as "v12 / phase 3k" to
`2026-09-02-open-vs-proprietary-results-v4.md` (working tree; no device-farm commits):
the per-frame pacing measurement before/after, the six fling cells before/after with
IQR, and the unchanged verbs vs run 33975063607 within their drift floors. Push; report.

## Addendum 2026-09-13 — refreshed base, decisions, what already landed

- Base: `open/main` AFTER the merge of `feat/screen-graph-d` (ticket
  `2026-09-13-merge-screen-graph-d-into-open-main.md`). One branch `feat/open-server-3k`
  off `open/main`; code and CI live in the same tree now (no separate CI branch).
  Worktree under the parent dir (`../argent-fork-wt-3k`), never /tmp — the previous 3k
  WIP (pacing measurement, drift-corrected writes, `gates.test.js`) was lost there on
  2026-09-10 and must be redone from this ticket.
- Decision (owner, 2026-09-05): option (i) — measure delivered-vs-requested duration and
  distance for ALL THREE arms (scrcpy, UiAutomation, proprietary) from logcat; fix scrcpy
  pacing with drift-corrected writes without per-frame socket await, else a device-side
  timeline; gate scrcpy/uia at ±0.15 with NO whitelist; add transparency rows scrcpy/off
  and uia/off. NO velocity tuning toward the proprietary curve (A.2(c) is dropped).
- Code pointers on `open/main` (verify after the merge): host pacing loop
  `packages/tool-server/src/utils/scrcpy-inject-backend.ts` (`await controller.injectTouch`
  per frame near lines 320 and 352); `MOMENTUM_STEP_MS = 16` and `durationMs` in
  `scrcpy-inject-timeline.ts:109-154`; frame count `Math.round(duration / 16)` in
  `tools/gesture-swipe/index.ts:147`.
- Part B already on `open/main` (`f76f5d24`, `8e968298`): F3 tap verdict "at parity"
  at the OFF-1/OFF-2 drift floor (`scoreboard.js`), F4/F9 value-bound whitelist plus
  floor-pinned cell exclusion (`merge-fling.js`), symmetric >=95 % first-attempt
  landing-rate gate (`merge-blocks.js`). Still open: A.3 whitelist removal (replaces the
  value bound), F7, F5/F6, F12/F13, F19, the gate unit tests (redo `gates.test.js` under
  `.github/bench-ci/`), device-test enforcement evidence.
- Output location: results go to a new file `docs/open-server/2026-09-13-open-server-3k-results-ci.md`
  in this repo (not device-farm; the v4 results file referenced above now lives in
  `docs/open-server/` as read-only history). Scoreboard rows only after adversarial
  review.

## Result (2026-09-14, phase 3k)

Branch `feat/open-server-3k` @ `1408e233` off `open/main` @ `690e66bc`. Reported CI run
**34800933407** (`-f suite=latency`, N=20, fling N=12). Full write-up:
`docs/open-server/2026-09-13-open-server-3k-results-ci.md`. First run **34795811096** is
superseded (it enabled InputDispatcher VERBOSE during the latency+fling steps, which
perturbed the ON synced-inject and floored the uia fling arm; VERBOSE removed).

**Fix works — the reproducible long-duration under-scroll is resolved.** Fling A/B, scrcpy
before(legacy)→after(drift), scrcpy/uia (and scrcpy/off), N=12, median + IQR:

| cell | uia (IQR) | scrcpy drift (IQR) | scrcpy legacy | off | scrcpy/uia leg→drift | scrcpy/off leg→drift | gate |
|---|---|---|---|---|---|---|---|
| 150/0.3 | 0.232 [0.175,0.461] | 0.320 [0.175,0.464] | 0.464 | 0.443 | 2.000→1.379 | 1.048→0.722 | **FAIL** |
| 150/0.5 | 0.175 | 0.175 | 0.175 | 0.175 | 1.000→1.000 | 1.000→1.000 | excluded (floor) |
| 250/0.3 | 0.473 | 0.459 | 0.442 | 0.467 | 0.934→0.970 | 0.947→0.983 | OK |
| 250/0.5 | 0.175 | 0.175 [0.175,0.464] | 0.175 | 0.320 | 1.000→1.000 | 0.547→0.547 | excluded (uia+scrcpy floor) |
| 400/0.3 | 0.313 | 0.319 | 0.324 | 0.360 | 1.035→1.019 | 0.900→0.886 | OK |
| 400/0.5 | 0.585 | 0.635 | 0.581 | 0.657 | 0.993→1.085 | 0.884→0.967 | OK |

Verdict: `FAIL (1 informative cell outside ±0.15: 150ms/0.3=1.379)`. Run 7 (before) had
400/0.3=0.717 and 400/0.5=0.710 vs uia (0.642/0.580 vs off); both are now at parity
(1.019/1.085 vs uia, 0.886/0.967 vs off). The **only** red is 150/0.3, a short-duration
bimodal cell where the uia REFERENCE under-scrolled (uia/off 0.524) — scrcpy/off 0.722 is
closer to proprietary than uia — i.e. the "uia is the unstable arm" F2 effect, not a scrcpy
defect. Delivered DOWN→UP span (device logcat): uia 405, scrcpy drift 416, legacy 417 ms
(requested 416) — endpoints equal; the fix is in the MOVE cadence (the scroll A/B).

**Everything else green:** device suite 19/19; latency merge passed all gates (redir on
both ON blocks; first-attempt landing 40/40, 60/60, 60/60 scrcpy, 40/40; oracle pass ×4;
clean 2-frame DOWN→UP tap; 0 fast-inject fallbacks; OFF baseline present, F13).

**Unchanged verbs vs run 7 (within drift floors):** describe (52/33/35/52), await-screen-
idle, await-ui-element, paste, gesture-pinch all reproduce run 7 direction/magnitude. NOT
reproduced: ON `gesture-tap` (77→~722) and `gesture-swipe` (257→~1100) are inflated ~10x —
a **base `open/main` regression** on on-device UiAutomation tap/swipe inject (affects
ON-uiautomation, which uses no scrcpy; OFF and describe/pinch normal; identical across both
3k runs), **not the 3k change**. Flagged for the planner (bisect the screen-graph-d merge).

**Part B landed:** F7 (no-effect identity log+record; bench-block logcat), F6 (dump
short-circuit logged/gated — fired this run), F12 (blocking ready gate), F13 (executable OFF
failure fails the run), F19 (destinationVisible removed), gate unit tests
`.github/bench-ci/gates.test.js` (17) wired into `unit-tests.yml`. Whitelist removed
(A.3); floor-pinned exclusion kept; scrcpy/off + uia/off transparency + legacy→drift rows
added.

**Not done / open:** the fling gate is RED on 150/0.3 (uia short-duration reference noise) —
gate-design decision left to the planner (see results file "Open items"); device-side
timeline 2(b) not needed for the resolved 400 ms cells; the base ON tap/swipe latency
regression is out of scope. CI budget (2 latency runs) exhausted; `open/main` NOT
fast-forwarded.

## Result (3k.1, 2026-09-14)

Branch `feat/open-server-3k1` off the consolidated `open/main` @ `8cbd3902` (3k Part B +
outcome-regression fix + D.4.1). Reference CI run **34813849446** (`suite=both`,
`sg_mode=matrix`, on `6f7e2a6f`). Commits: `edc677c2` (pacing default→legacy, byte-equal),
`06bc0768` (pre-registered two-sided gate + tests), `8a969963` (interleaved fling +
drop reasons + trace file), `db19a966` (dumpsys MotionEvent cadence), `6f7e2a6f`
(run-fling.js drives the interleave — the push token lacked the `workflow` OAuth scope,
so the workflow file itself is unchanged from `open/main`), `f5b6e8ad` (3k results
rewrite). **The run is red solely on the blocking fling parity gate; everything else is
green.** N=20 per verb; fling N=12 per cell-arm (3 rounds × 4 samples; job budget did
not allow 24).

**Fling status: OPEN, not resolved.** The pre-registered two-sided gate is **RED** and
the same-run paired legacy→drift test is **not significant in any cell**, so neither
acceptance condition is met. On this run the scrcpy under-scroll vs proprietary is real
and significant in three of four informative cells; the deficit is **larger** than in run
34800933407 (400/0.3 scrcpy/off 0.699 vs 0.886) and appears in **both** pacing arms — it
did not appear from nowhere (34800933407 already carried it at 400/0.3 for both arms,
p = 0.001), it grew and spread (3K1-M5). Drift does not remove it (paired legacy→drift not
significant, p ≥ 0.13). Host pacing is **not** the cause — but the reason is that
`drift ≈ legacy` and the host dispatch span already equals the requested duration on the
**drift** arm (the only arm traced), **not** that "the gesture is delivered on time"
end-to-end: the device-side `dumpsys` numbers below show both scrcpy arms delivering a
stretched tail (452/439 ms for a 416 ms request, final MOVE→UP gap 46/35 ms vs uia's
417/17 ms). Mechanism unresolved; the 8-frame schedule alone is ruled out (3K1-H1).

### Pacing default byte-equal to pre-3k
`scrcpyPacingMode()` defaults to `legacy`; `drift` is opt-in (`ARGENT_SCRCPY_PACING=drift`).
The legacy branch of `injectTimeline` is byte-equal to `690e66bc` (whitespace-normalized
diff of the loop body is empty, 18 lines each). The drift branch alone carries the trace.

### Gate rule tests (pre-registered, on real artifacts)
`node --test .github/bench-ci/gates.test.js` → 22 passed (21 in the reference run;
+1 after 3K1-M3 closed the `INCONCLUSIVE`-exits-0 hole). Fixtures are the downloaded
`fling-block-*.json` of each run: run 7 (33975063607) → **FAIL**, 3 informative cells
(250/0.3, 400/0.3, 400/0.5) all red, 3 non-informative; run 34800933407 → **3 PASS**
(250/0.3, 400/0.3, 400/0.5) / **3 non-informative**, reproducing the reviewer's per-cell
table exactly.

**The gate grades the opt-in `drift` arm, the shipped default is `legacy` (3K1-M2).**
`merge-fling.js` fixes `scrcpyArm: "drift"`, but `scrcpyPacingMode()` defaults to
`legacy`. So the blocking gate does not grade the wire path a product process actually
runs. For the record the **default `legacy` arm is red too**: scrcpy(legacy)/uia · /off =
0.688/0.549 (150/0.3), 1.031/1.019 (250/0.3), 0.778/0.806 (400/0.3), 0.615/0.542 (400/0.5)
→ 3 offenders, same verdict. Both arms are graded in the verb/fling tables below; the
gate itself grading only `drift` is a known hole (Part 1 did not change which arm the gate
grades — only the `INCONCLUSIVE` exit).

### Verb table — read like-for-like (ON vs OFF, this run), p50/p95 ms
Blocks OFF-1 → ON-uiautomation → ON-scrcpy → OFF-2, N = 20 (n = 19 on the two ON
`tap+describe(settle:false)` cells, one `uiautomator dump` parse error each — 3K1-M7). The
verdict is judged against the **within-run OFF-1↔OFF-2 p50 drift floor** of that verb, not
against another run. Run 7 (33975063607) and 34806342684 are cited only as replications.

| verb | OFF-1 | ON-uia | ON-scrcpy | OFF-2 | drift floor | verdict (ON vs OFF, this run) |
|---|---|---|---|---|---|---|
| describe (idle) | 52/56 | 53/74 | 53/73 | 52/59 | 0 (p50) / 3 (p95) | **parity at p50 (+1), 14–18 ms SLOWER at p95** — the run-7 ON win (39/36 vs 52) is GONE; 34806342684 reads the same (ON-uia 55/74). "Never slower in 3 same-code runs" RETIRED (3K1-H3) |
| gesture-tap | 53/60 | 78/116 | 51/53 | 54/56 | 1 | scrcpy **parity** (−2…−3); uia **+25 slower**. Not like-for-like across ON variants (scrcpy defers the input drain) |
| tap+describe (settle:false, headline) | **354/831** | 505/728 (n=19) | 529/1029 (n=19) | **297/654** | **57** | **LOSS: ON +150…+230 ms** on both variants. Run 7 had ON-scrcpy at parity (298/810 vs OFF 305/313); present in 34806342684 (ON-scrcpy 548) → screen-graph-d base, not 3k/3k.1 — cause open (3K1-H3) |
| gesture-swipe (250 ms) | 300/312 | 292/309 | 259/261 | 296/305 | 4 | **WIN (scrcpy −37…−41)**; uia parity. Reproduces run 7 (257), 34806342684 (258) |
| gesture-pinch | 358/373 | 346/372 | 307/311 | 346/365 | 12 | **WIN (scrcpy −39…−51)**; uia parity. scrcpy 307 in all three runs |
| await-screen-idle | 501/507 | 294/297 | 294/308 | 501/511 | 0 | **WIN −207**; the base changed with the screen-graph-d tree (34806342684 reads 292/293), NOT with 3k.1 — cause open |
| await-ui-element | 80/84 | 45/51 | 47/53 | 80/81 | 0 | **WIN −33…−35** (34806342684 reads 43/43; both OFF and ON moved on this base) |
| paste | 804/1122 | 291/1086 | 385/990 | 662/1057 | 142 | directional only: −277…−371 clears the floor; p95 does not separate |
| tap+describe (settle:true, ON-only) | — | 843/981 | 842/990 | — | — | ON-only feature; vs 34806342684 878/839 (in range), > run 7 788/774 (base) |

The tap/swipe **outcome-path** regression of 3k is **gone** on this base (tap ON-uia p50 78
vs run 7's 77; swipe ON-uia 292 vs 296; ON-scrcpy 259 vs 257). But two verdicts the current
scoreboard carries **flip** on this run (3K1-H3), both because the screen-graph-d tree is
already on `open/main` (they reproduce in 34806342684, so they are the base, not 3k.1):
`describe` is no longer an open win (parity at p50, slower at p95), and the headline
`tap+describe(settle:false)` is a **loss** ON vs OFF at a 57 ms floor. The earlier claim
"every verb reproduces 34806342684 within its OFF-1↔OFF-2 drift floor" is **false as
written** (3K1-M1): p50 deltas vs 34806342684 are within 5 ms on the OFF-floored verbs, but
the ON-only settle rows differ by up to 35 ms and have no OFF floor to be "within"; the
OFF-1↔OFF-2 floor of this run is 0–4 ms on every verb except paste (142) and
tap+describe (57).

### Fling A/B — per-cell median + IQR + n per arm (interleaved, N=12)
| cell | uia (IQR, n) | scrcpy drift (IQR, n) | scrcpy legacy (IQR, n) | off (IQR, n) | scrcpy/uia | scrcpy/off | gate |
|---|---|---|---|---|---|---|---|
| 150/0.3 | 0.464 [0.298,0.464] (12) | 0.299 [0.175,0.464] (12) | 0.319 [0.175,0.464] (12) | 0.581 [0.567,0.657] (12) | 0.644 | 0.515 | **FAIL** |
| 150/0.5 | 0.175 [floor] (11) | 0.175 [floor] (12) | 0.175 (12) | 0.175 [floor] (12) | 1.000 | 1.000 | non-informative |
| 250/0.3 | 0.442 [0.346,0.456] (12) | 0.402 [0.313,0.515] (12) | 0.456 [0.35,0.493] (12) | 0.447 [0.401,0.464] (12) | 0.910 | 0.899 | **PASS** |
| 250/0.5 | 0.175 [floor] (12) | 0.175 [0.175,0.355] (12) | 0.441 [0.175,0.593] (12) | 0.175 [floor] (12) | 1.000 | 1.000 | non-informative (uia+off floored) |
| 400/0.3 | 0.369 [0.349,0.408] (12) | 0.249 [0.227,0.314] (12) | 0.287 [0.257,0.409] (12) | 0.356 [0.35,0.367] (12) | 0.675 | 0.699 | **FAIL** |
| 400/0.5 | 0.579 [0.352,0.595] (12) | 0.471 [0.357,0.52] (12) | 0.356 [0.175,0.501] (12) | 0.657 [0.643,0.657] (12) | 0.813 | 0.717 | **FAIL** |

n per cell-arm is 11–12 (one uia drop at 150/0.5, reason recorded: `[Tool:describe] Failed
to parse uiautomator dump output`). **Interleaving is ROUND-LEVEL, not per-cell round-robin
(3K1-M6).** From `fling-interleave-evidence.json`: each round runs the arms in
**24-swipe blocks** with the group order rotated per round (round 0 uia/scrcpy/off,
round 1 scrcpy/off/uia, round 2 off/uia/scrcpy), and drift/legacy alternate **per swipe**
inside the scrcpy block. So each arm's 12 samples for a cell are spread across rounds 0,1,2
over the full ~27-min window (uia 400/0.3 [28.8s..1374.6s], scrcpy 400/0.3
[181.8s..1620.4s], off 400/0.3 [421.5s..1240.9s]) — much better than 3k's single 7-min
block — but uia and off still occupy contiguous ~2–4 min blocks, so the `scrcpy/off`
comparison that drives the gate remains block-structured. Also **drift is always sampled
before legacy** in all 72 pairs, so any within-pair order effect maps onto the arm
(randomize the pair order next time).

### Paired legacy→drift permutation p per cell (20 000 draws) + scrcpy/off
| cell | Δ(drift−legacy) | paired legacy→drift p | scrcpy(drift)/off p |
|---|---|---|---|
| 150/0.3 | −0.020 | 1.00 | **0.010** |
| 250/0.3 | −0.053 | 0.63 | 0.43 |
| 250/0.5 | −0.266 | 0.13 | 1.00 |
| 400/0.3 | −0.038 | 0.31 | **0.001** |
| 400/0.5 | +0.115 | 0.33 | **0.000** |
**No cell shows a distinguishable legacy→drift effect (all p ≥ 0.13)** — drift is neutral,
even on a run where the deficit reproduced. The scrcpy under-scroll vs proprietary is real
and significant at 150/0.3, 400/0.3 and 400/0.5.

### Gate verdict string
`FAIL (per-cell ±0.15 on scrcpy/uia AND scrcpy/off, NO whitelist, over 4 informative
cell(s); 2 of 6 non-informative at the metric floor)` — offenders 150/0.3 (0.644/0.515),
400/0.3 (0.675/0.699), 400/0.5 (0.813/0.717); 250/0.3 passes (0.910/0.899).

### Device pacing evidence (3K-H3) — dumpsys input MotionEvent cadence, N per arm
Device suite **19 passed** (17 enforced + 2 measurement-only). The wire gesture is **8
frames** (26 requested steps → 8 wire frames; the host trace reads `frames=8`, not
"26-frame" — 3K1-M8). Source = `dumpsys input RecentQueue age=…ms`, **10 recent-input
timestamps** the trailing ~8 of which sum to the gesture; the parser now filters to
MotionEvent entries where the image labels them (else it says "event class NOT filtered").
**N = 1 swipe per arm** (measurement-only, RecentQueue):
- uia: dumpsys deltas sum to **417 ms**, final MOVE→UP gap **17 ms**; tail cadence
  ≈ 15/19/13/17 ms.
- scrcpy drift: **452 ms**, final gap **46 ms**; tail cadence ≈ 14/14/22/46 ms.
- scrcpy legacy: **439 ms**, final gap **35 ms**; tail cadence ≈ 21/8/19/35 ms.
So on the single device sample per arm **both scrcpy arms delivered a stretched tail** for
a 416 ms request, exactly where the velocity fit lives — this is the live open lead, not
host pacing. The dumpsys RecentQueue holds global recent events, so the raw age span can
overstate the gesture; the dense-tail deltas are the intra-swipe MOVE cadence (event class
now filtered where labelled, N = 1 per arm).

**Host trace covers only the `drift` arm (3K1-H2).** `pacing-trace.txt` holds **72 lines,
every one `mode=drift`** (12 samples × 6 cells); the `legacy`/default path is **not
traced** by construction. On the drift arm the host dispatch span equals the requested
duration — but the honest statistic is the distribution, not one line: median worst-frame
drift **2.1 ms**, p90 4.4 ms, **max 7.9 ms** (`maxDispatchDrift < 1 ms` is true of only
16 of the 72 lines). So the correct reading is "the host dispatches on time on the drift
arm; the default path is untraced; and the device saw a stretched tail on both scrcpy arms
anyway" — the deficit is between the host socket and the MotionEvent the OS sees, cause
open. It is **not** an 8-frame-schedule effect: the uia arm sends the identical 8 frames
and reads `uia/off` **1.037** at 400/0.3 (uia 0.369 vs off 0.356), while the proprietary
OFF arm sends one frame per 16 ms (26 frames at 400 ms) — the frame count is held constant
across the two ON arms and the deficit is not (3K1-H1).

**Disclosure (3K1-M7): three ON-side `uiautomator dump` parse failures this run** — one per
ON block on `tap+describe(settle:false)` (so those latency cells are n = 19 and the
first-attempt landing denominators are 59, not 60) and one fling sample dropped with its
reason recorded; same error class, **0 fast-inject fallbacks**.

### Screen-graph — recomputed from THIS run (34813849446), not copied from D.4.1
7 configs × 20 tasks × 5 reps, n = 155 non-launch steps per config, o200k_base, seed
`0x5eedc0de`. Every number recomputed from `bench-sg-…json` / `sg-matrix.log` of this run
(3K1-M10); the D.4.1 whitelist wording is **not** copied.

**Success (Wilson 95%, n = 100):** B1 100/100 [96,100] · B2 100/100 · O1 100/100 ·
O2 100/100 · O3 100/100 · O4 100/100 · O5 100/100 — **parity across all seven configs; the
differentiator is tokens, not success** (34801849653, same code, reads O2 99/100 and
100/100 elsewhere).

**Tokens/step, o200k p50:** B1 657 · B2 651 · O1 179 · **O2 54** · O3 627 · O4 21 · O5 21
(the D.4.1 whitelist said O2 68 — inside the 54–68 same-code spread, but republished here,
not copied). **RTT count/step p50:** 2/2/2/2/2/1/1. **H1** O1/B2 = 179/651 = **0.275×**
(≤ 0.5×, PASS, identical to 34801849653). **H2** all-steps B2−O2 = 0 (FAIL, structural);
same-screen p50 1 (PASS), means B2 2.00 vs O2 **1.20** (34801849653: 1.22). **H3**
O4/O3 = 21/627 = **0.033×** (PASS). **H4** every open config +0 [0,0] vs B1 and B2 —
trivially non-inferior because every arm is 100/100 here (the informative version is
34801849653, O2 −1 [−3,0]).

**Store invariants OK**, `skippedNoIdHash` 0 (`sg-matrix.log:197`): three stores —
`com.android.settings` **10 nodes / 9 edges, max out-degree 8, mean 0.9** (34801849653
built **11/10**, so the store shape is not run-stable), `com.android.chrome` 1/1,
`com.google.android.settings.intelligence` 2/1. **O5 routing (n = 60 known-target taps):**
**60/60 one-step routed, 0 diverged, 0 fallbacks** (34801849653: 59/60 with one
hash-mismatch divergence); measured RPCs per routed tap min 7 / p50 7 / max 7 (a lower
bound).

**The post-action-wait "symmetric settle" row does NOT reproduce on this run and is NOT
carried here (3K1-M10).** `actionRttMs + settleMs` p50 spreads **2246 (B1) … 2644 (O5) =
17.7 %, with B1 the cheapest** — the opposite shape of 34801849653's 5.2 %. Symmetry is
cited only from run 34801849653 (with that run id), never as a property of 34813849446.

### Not done / open
- Scoreboard updated separately (Part 2) to carry only review-accepted rows with
  34813849446 as the single reference; `open/main` **not** fast-forwarded.
- Fling deficit stays **OPEN**: gate RED and paired legacy→drift not significant. Host
  pacing is not the cause (drift ≈ legacy; drift dispatches on time). The **mechanism is
  unresolved**: the device saw a stretched scrcpy tail on both pacing arms (final MOVE→UP
  gap 46/35 ms vs uia 17 ms), so the residual is between the host socket and the
  MotionEvent the OS reads (scrcpy read-time stamping / arrival jitter on the last
  frames), N = 1 per arm. The **8-frame-schedule explanation is ruled out** — the uia arm
  sends the identical 8 frames and reaches `uia/off` 1.037 at 400/0.3, so the frame count
  is not the sole cause; do not chase a VelocityTracker frame-count hypothesis without an
  arm that varies the frame count. Next: an arm that varies the frame count, or the
  device-side timeline (3k 2(b)), not more host-pacing work.
- The CI **workflow file could not be updated** (push token lacks the `workflow` OAuth
  scope); the interleave is driven from `run-fling.js` instead. If a future run wants the
  cleaner single-INTERLEAVE workflow step, a token with `workflow` scope is needed.
