# Open server phase 3k — scrcpy fling pacing + bench-gate hardening (CI results)

Repo: **HeiCg/argent** fork. Branch `feat/open-server-3k` off `open/main` @ `690e66bc`.
Reported run: **34800933407** (`feat/open-server-3k` @ `1408e233`), workflow
`bench-open-vs-proprietary.yml`, `-f suite=latency -f blocks="OFF-1,ON-uiautomation,
ON-scrcpy,OFF-2" -f n=20`. Runner: **ubuntu-latest, x86_64, KVM-accelerated emulator**,
`system-images;android-34;google_apis;x86_64`, Android 14 / SDK 34, 1080x2400 @ 420dpi.
**N = 20 per verb per block; fling A/B N = 12 per cell per backend.** Not comparable to a
local arm64/HVF host. The fling A/B carries the pre-3k `ON-scrcpy-legacy` (await-per-frame)
and the `ON-scrcpy` drift-corrected arm in the SAME run — the phase-3k before/after.

First 3k run **34795811096** is superseded: it enabled `InputDispatcher/InputReader
VERBOSE` during the latency+fling steps (added for F7), which perturbed the ON path's
synced UiAutomation inject and pushed the uia fling arm to the floor. VERBOSE was removed
from those steps; run 34800933407 is the clean measurement. Do not blend the two.

Read with `2026-09-03-review-final-findings.md` (F2, F4–F7, F9–F16, F19) and
`2026-09-03-open-vs-proprietary-results-final-ci.md` (run 7 = 33975063607, the before
baseline). **No scoreboard rows until adversarial review.**

## What changed (code)

- **scrcpy host pacing (A).** `scrcpy-inject-backend.ts injectTimeline` gains a
  drift-corrected, socket-decoupled pacing mode (`drift`, default/after): it dispatches
  each MOVE frame at its wall-clock slot (`anchor + tMs`, recomputed against the real
  clock) and INITIATES the `injectTouch` write there **without awaiting its consume**. The
  WHATWG `WritableStream` under `injectTouch` queues the writes in order, so a slow socket
  write no longer stretches the DOWN→UP span and starves the OS VelocityTracker. The pre-3k
  await-per-frame loop is kept as `legacy` (before), selected per process by
  `ARGENT_SCRCPY_PACING`. **No velocity tuning** (A.2(c) dropped per the addendum).
- **Measurement (option i).** Per-swipe host pacing trace (`pacing mode=… intendedDurMs=…
  downUpDispatchMs=… writeSpanMs=… maxDispatchDriftMs=…`); a local unit test
  (`open-server-fast-inject-pacing.test.ts`) proves drift decouples the write span from the
  dispatch span while legacy couples them. Device-test `3k pacing` reads the delivered
  MotionEvent DOWN→UP span from logcat for all three arms.
- **Gate (A.3 / F4 / F9).** `merge-fling.js`: the value-bounded whitelist is **removed**;
  the gate is per-cell `scrcpy(drift)/uia ±0.15`, blocking, **no whitelist**; the
  both-arms floor-pinned exclusion is **kept**; transparency rows `scrcpy/off` and
  `uia/off` and the `legacy→drift` before/after are printed.
- **Part B honesty.** F7 (no-effect tap identity logged + recorded; logcat across bench
  blocks), F6 (dump short-circuit is a logged/gated event), F12 (per-block ready gate
  BLOCKING), F13 (an executable proprietary OFF baseline that fails now fails the run),
  F19 (all-zero `destinationVisible` staleness probe removed). Gate unit tests
  `.github/bench-ci/gates.test.js` (17 cases) wired into `unit-tests.yml`.

## Result

Reported run **34800933407**. **RED on one gate only — the fling parity gate (cell
150 ms/0.3).** Everything else is green: device suite **19/19** (the pre-existing
`getScreenSize<50ms` timing test passed this run), latency merge passed every gate
(redir on both ON blocks; first-attempt landing 40/40, 60/60, **60/60 scrcpy**, 40/40;
oracle self-test pass ×4; clean two-frame DOWN→UP tap timeline; **0 fast-inject
fallbacks**; OFF baseline present so F13 satisfied).

### Fling A/B — the pacing fix (per-cell, N=12, median normalized scroll + IQR)

before = `ON-scrcpy-legacy` (await-per-frame), after = `ON-scrcpy` (drift), same run.

| cell | uia (IQR) | scrcpy drift (IQR) | scrcpy legacy (IQR) | off (IQR) | scrcpy/uia legacy→drift | scrcpy/off legacy→drift | gate |
|---|---|---|---|---|---|---|---|
| 150 / 0.3 | 0.232 [0.175,0.461] | 0.320 [0.175,0.464] | 0.464 [0.458,0.464] | 0.443 [0.175,0.464] | 2.000 → **1.379** | 1.048 → 0.722 | **FAIL** |
| 150 / 0.5 | 0.175 [floor] | 0.175 [floor] | 0.175 [floor] | 0.175 [floor] | 1.000 → 1.000 | 1.000 → 1.000 | excluded (floor) |
| 250 / 0.3 | 0.473 [0.452,0.483] | 0.459 [0.426,0.468] | 0.442 [0.433,0.471] | 0.467 [0.45,0.482] | 0.934 → 0.970 | 0.947 → 0.983 | OK |
| 250 / 0.5 | 0.175 [floor] | 0.175 [0.175,0.464] | 0.175 [floor] | 0.320 [0.175,0.464] | 1.000 → 1.000 | 0.547 → 0.547 | excluded (uia+scrcpy floor) |
| 400 / 0.3 | 0.313 [0.29,0.318] | 0.319 [0.296,0.324] | 0.324 [0.32,0.344] | 0.360 [0.351,0.367] | 1.035 → **1.019** | 0.900 → 0.886 | OK |
| 400 / 0.5 | 0.585 [0.573,0.648] | 0.635 [0.589,0.643] | 0.581 [0.56,0.595] | 0.657 [0.657,0.657] | 0.993 → **1.085** | 0.884 → 0.967 | OK |

**Verdict:** `FAIL (1 informative cell outside ±0.15: 150ms/0.3=1.379)`.

**The reproducible long-duration under-scroll the ticket targeted is RESOLVED.** Against
run 7 (legacy pacing) the 400 ms cells read scrcpy/uia 0.717 and 0.710 (scrcpy/off 0.642,
0.580); this run they read **1.019 and 1.085** vs uia and **0.886 and 0.967** vs
proprietary — parity. 250/0.3 is likewise at parity (0.970 / 0.983).

**The sole gate red (150/0.3 = 1.379) is a short-duration reference artifact, not a scrcpy
defect.** Every arm is bimodal there (IQRs straddle the 0.175 floor: uia [0.175,0.461],
scrcpy [0.175,0.464], off [0.175,0.464]) — a 150 ms swipe either catches a fling or floors.
This run the **uia reference under-scrolled** (median 0.232, uia/off **0.524**), while
scrcpy/off = **0.722** is *closer* to proprietary than uia is; the drift fix even lowered
scrcpy here toward uia (legacy 0.464 → drift 0.320, ratio 2.0 → 1.379). This is the
"UiAutomation is the unstable arm" phenomenon of review F2, now tripping the no-whitelist
scrcpy/uia gate at short duration. See "Open items" — a gate-design question for the planner.

### Delivered swipe duration (device logcat, `3k pacing`, 26-frame ≈416 ms swipe)

| arm | delivered DOWN→UP | requested |
|---|---|---|
| UiAutomation | 405 ms | 416 ms |
| scrcpy drift | 416 ms | 416 ms |
| scrcpy legacy | 417 ms | 416 ms |

The DOWN→UP endpoints span ≈ requested for all three (the 2-event logcat parse sees only
the endpoints); drift vs legacy differ in the *intermediate MOVE cadence*, which is what
the scroll-distance A/B measures. The local unit test confirms the mechanism: under a slow
socket, drift keeps `downUpDispatchMs ≈ requested` while `writeSpanMs` lags (decoupled),
whereas legacy couples them.

### Latency verbs vs run 7 (p50/p95 ms; "unchanged verbs within drift floors")

| verb | OFF-1 | ON-uia | ON-scrcpy | OFF-2 | vs run 7 |
|---|---|---|---|---|---|
| describe (idle) | 52/53 | 33/57 | 35/55 | 52/53 | unchanged (ON ≤ OFF; direction only, F1) |
| await-screen-idle | 496/537 | 287/292 | 287/289 | 495/502 | unchanged direction (ON win) |
| await-ui-element | 73/76 | 37/40 | 34/41 | 72/80 | unchanged |
| paste | 507/1223 | 290/476 | 286/442 | 521/1094 | unchanged (directional; 110 ms floor, F16) |
| gesture-pinch | 347/358 | 345/378 | 308/315 | 350/375 | unchanged |
| gesture-tap | 52/53 | **723/828** | **721/881** | 53/54 | **base regression, see below** |
| gesture-swipe | 293/306 | **1152/1238** | **1100/1149** | 290/317 | **base regression, see below** |
| tap+describe | 401/842 | — | — | 274/1016 | OFF comparable |
| tap+describe(settle:false) | — | 736/914 | 777/884 | — | inflated by the same base regression |

OFF (proprietary) and the ON describe / await / paste / pinch verbs reproduce run 7 within
their drift floors. **ON `gesture-tap`, `gesture-swipe`, `tap+describe` are inflated ~10x
vs run 7 (tap 77→~722, swipe 257→~1100) on this base.** This affects **ON-uiautomation,
which uses no scrcpy at all**, and OFF/describe/pinch are normal — so it is a property of
the current `open/main` (post `feat/screen-graph-d` merge) on-device UiAutomation
tap/swipe inject (`WAIT_FOR_FINISH`), **not the 3k pacing change** (reproduced identically
in both 3k runs, legacy and drift arms alike). Flagged in "Open items".

### F5 / F6 / F7 / transport (per block)

| block | locateVia dump/describe | first-attempt no-effect | transport | oracle |
|---|---|---|---|---|
| OFF-1 | 0 / 40 | 0 | n/a (proprietary) | pass |
| ON-uiautomation | 0 / 60 | 0 | redir | pass |
| ON-scrcpy | 0 / 60 | 0 | redir | pass |
| OFF-2 | 0 / 40 | 0 | n/a (proprietary) | pass |

`locateVia = describe 100%` in every block (the backend-independent `uiautomator dump`
returned nothing; the F6 short-circuit fired and logged — locate is per-backend, only the
`mResumedActivity` fingerprint is backend-independent, F5). No first-attempt no-effect taps
this run (scrcpy landed 60/60), so no F7 identities to print.

## Open items (for the planner)

1. **Fling gate design at short duration.** The no-whitelist `scrcpy/uia ±0.15` gate is
   fragile when the uia REFERENCE is bimodal/floored at short durations (150 ms). Options:
   (a) extend the floor-pinned exclusion to a cell whose uia reference IQR straddles the
   floor (denominator uninformative); (b) gate scrcpy against the proprietary OFF reference
   (`scrcpy/off`) rather than uia at cells where uia is unstable; (c) accept the red as a
   uia-noise artifact given `scrcpy/off = 0.722` is closer to proprietary than uia there.
   Not changed here — the addendum fixed the gate as scrcpy/uia ±0.15 + both-arms floor
   exclusion, and altering the acceptance metric is a planning decision.
2. **Base ON tap/swipe latency regression.** `open/main` @ 690e66bc shows ON
   `gesture-tap`/`gesture-swipe` inject ~10x run 7 (independent of the 3k change and of
   the backend). Worth bisecting the `feat/screen-graph-d` merge before trusting ON tap/
   swipe latency numbers.
3. **Device-side timeline 2(b).** Drift resolved the long-duration deficit, so 2(b) is not
   needed for the 400 ms cells. If the planner wants 150 ms parity too, 2(b) (device-side
   timestamps) would remove the residual short-duration reference noise.
4. **Host pacing trace in CI.** The per-swipe host trace is emitted but the fling harness
   swallows the backend's log-callback/stdout; the mechanism is proven by the local unit
   test and corroborated by the device delivered-duration + the scroll A/B. Surfacing it in
   the fling-log is a follow-up (route through the fling harness's own logger).
