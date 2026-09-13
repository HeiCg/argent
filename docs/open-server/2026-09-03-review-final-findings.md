# Final adversarial review — consolidated open-vs-proprietary run 7

Repo: `HeiCg/argent` fork. Read-only review. Run 7 = GitHub Actions
**33975063607**, `head_sha = f76f5d245a59269e7eb1fa4b196e0dc4d4736697`,
branch `feat/bench-ci-final`, conclusion **failure**, verified via
`gh api repos/HeiCg/argent/actions/runs/33975063607`. Code reviewed at that
exact sha in a detached worktree, so 3j finding 13 ("CI never ran on the
head") is RESOLVED.

Comparison runs: 6 = 33969204089, 5 = 33963464784 (artifacts downloaded).
Docs reviewed: `2026-09-03-open-server-consolidation-final-run.md`,
`2026-09-03-review-3h-findings.md`, `-3i-`, `-3j-`, and the implementor's
`2026-09-03-open-vs-proprietary-results-final-ci.md` (present, 12.4 K).

---

## Verdict: **ACCEPT-WITH-CAVEATS**

The run is the first in this effort that is methodologically sound end to
end: the effect oracle is genuinely backend-independent, the landing gate is
symmetric in code, the timed windows are identical across blocks, device
tests are enforced and passing 17/17, and the code under test is the run's
own head. Nothing here is a retraction of the kind that voided runs 1-4.

Three published conclusions must be weakened before they enter the
scoreboard, and one gate must be tightened:

1. **The describe speedup magnitude is not reproducible.** Run 6, same
   code, measured ON describe *equal to* OFF. The doc quotes run 5 and
   omits run 6. (F1.)
2. **The fling failure is explained as noise; its own data refutes that.**
   scrcpy's under-scroll at 400 ms is stable to within 0.02 against the
   proprietary reference across runs 5 and 7. (F2.)
3. **"ON-scrcpy beats OFF on tap: YES"** rests on a 1 ms difference at a
   0 ms noise floor. (F3.)
4. **The fling gate carries an unconditional two-cell whitelist** that
   excuses ratios of any magnitude. Two of the three out-of-tolerance cells
   in run 7 are exempted by it, and the doc's gate section does not mention
   it exists. (F4.)

No blended runs were found. Every latency number in the doc reproduces
exactly from run 7's block JSONs.

---

## Findings

Severity: **BLOCKING** (a published claim is wrong) / **HIGH** / **MEDIUM** /
**LOW** / **OK** (verified, no action).

### Claim (1) — timed windows, locate and settle symmetry

- **OK** — Timed window for `gesture-tap` is the tap RPC only; the untimed
  locate, the origin fingerprint, the effect poll and the BACK restore are
  all outside it (`bench-open-vs-proprietary.ts:586-598`; `t0` at :586,
  `dt` at :590, poll at :598). Identical code path for all four blocks.
- **OK** — `tap+describe` = tap RPC + describe RPC inside one timed window
  (`:2025-2031`); `timeTapEffect` wraps it through the same `timedTapAt`
  contract as the bare tap (`:2041`). No per-block special case.
- **OK** — The effect fingerprint is `mResumedActivity` from
  `dumpsys activity activities` (`:1508-1512`), which touches neither
  backend. OFF and ON have provably identical oracle sensitivity. This is
  consolidation item (a) done correctly, and it is what killed the phase-3h
  "MOVE frame" story (see F8).
- **HIGH (F5)** — **The untimed locate is NOT backend-independent.** The
  primary source, a `uiautomator dump` to a file (`:1419-1436`), returned
  nothing on this emulator, so every block fell through to its own backend's
  describe: `locateVia = {dump: 0, describe: 40/60/60/40}` in all four
  blocks (`bench-block-*.json`, `locateViaTotal`). Path: `locateTargetCoord`
  :1472 (dump) then :1482 (backend describe fallback). Consequence for the
  question asked: the last action before the timed tap is a describe costing
  ~52 ms on OFF and ~36-39 ms on ON, so **OFF gets more pre-tap settle time,
  not less**. The asymmetry biases *against* ON on the tap rows, so it does
  not manufacture the ON tap result. But the doc must stop calling the
  oracle "backend-independent" without qualifying that only the
  *fingerprint* is. Fix: report `locateVia` in the results doc, not only in
  the scoreboard notes.
- **MEDIUM (F6)** — `dumpUiTreeFile` short-circuits after 2 consecutive
  empty dumps per block (`:1420`, `uiDumpEmptyStreak >= 2`). This is a
  silent, per-block degradation of the primary locate source with no gate
  and no scoreboard line. Two blocks could differ in which source they used
  and nothing would fail. In run 7 all four degraded identically, so the run
  itself is unaffected.

### Claim (2) — landing rate and the 59/60

- **OK** — The landing gate is **symmetric in code**:
  `firstMiss(b) > Math.floor(c * 0.05)` applied to every present block, OFF
  and ON alike (`merge-blocks.js:102-118`; threshold :106, throw :114). For
  c=40 it permits 2 misses (95.0 %); for c=60 it permits 3 (95.0 %). The
  "landing rate >= 95 % per block, symmetric" label is accurate.
- **OK** — The miss's latency exclusion is consistent and lives in one place
  for all blocks: `if (changed) lat.push(dt); else effectZero++`
  (`bench-open-vs-proprietary.ts:603-604`). Visible in the data as
  ON-scrcpy `tap+describe(settle:false)` **n=19** against `effectChecked=20`.
- **The 59/60 is a REAL scrcpy injection drop, not an oracle miss.**
  The oracle is backend-independent and produced 0 misses in ON-uiautomation
  (60/60) and both OFF blocks (40/40) *in the same runs*; and the same 59/60
  recurs in run 6 (`dl6/bench-block-ON-scrcpy.json`:
  `firstTapNoEffectTotal = 1`, `effectCheckedTotal = 60`). Two runs, one
  block, same rate, only that backend. Aggregate first-attempt drop for
  scrcpy across runs 6+7: **2 / 120, about 1.7 %**.
- **MEDIUM (F7)** — **The miss is undiagnosable from the artifacts.**
  `bench-log-ON-scrcpy.txt:54` records only the aggregate
  `firstTapNoEffect=1/60`. The no-effect branch (`:604`) logs no iteration
  index, no origin or final fingerprint, no verb. Consolidation item (d) was
  implemented for *thrown* errors only (`:591-593`, `:458-461`), which is
  why `errors = 0` everywhere while a silent miss went unexplained. There is
  no logcat covering the bench blocks; the only logcat artifact,
  `logs/logcat-device-test.txt`, comes from the device-test step (yml:281).
  Fix: on `effectZero`, log `i`, verb, `originFp` and the last polled
  fingerprint.
- **OK (F8)** — The phase-3h "DOWN, MOVE, UP" mechanism is **gone and now
  forbidden**: every block records `frameCount: 2, hasMoveFrame: false`, and
  `merge-blocks.js:53-58` fails any block that is not a clean two-frame
  DOWN/UP. The 3h narrative ("scrcpy taps land because of the MOVE frame")
  is therefore **VOID**; the real cause was the effect oracle, as commit
  `ce0735c` states. Any surviving 3h wording must be retired.

### Claim (3) — fling

- **BLOCKING (F2)** — **The "measurement noise" explanation is refuted by
  the run's own data.** The results doc says the failing cell "MOVES run to
  run ... the median of 12 is still noisy". Against the OFF reference the
  400 ms deficit is stable:

  | cell | run 5 scrcpy/off | run 7 scrcpy/off |
  |---|---|---|
  | 400 ms / 0.3 | 0.244 / 0.370 = 0.66 | 0.230 / 0.358 = 0.64 |
  | 400 ms / 0.5 | 0.369 / 0.653 = 0.57 | 0.360 / 0.621 = 0.58 |

  Both distances, both runs, within 0.02. The scrcpy/uia ratio looks noisy
  only because **UiAutomation** is the unstable arm (400/0.3 uia 0.289 then
  0.321; 400/0.5 uia 0.567 then 0.507). Likewise the run-5 offender
  150/0.3 = 1.296 was a uia *under-scroll*: uia 0.358 against off 0.457,
  while scrcpy read 0.464 against off 0.457, i.e. scrcpy was the arm at
  parity with proprietary. Honest statement: **scrcpy under-scrolls at
  400 ms duration by roughly 35-42 % relative to the proprietary reference,
  reproducibly across runs 5 and 7, at both distances.** That is a real
  long-duration fling-momentum property of the scrcpy inject path, not
  noise.
- **INFERENCE, not confirmed by evidence** — a plausible mechanism:
  `steps = Math.max(1, Math.round(duration / 16))`
  (`tools/gesture-swipe/index.ts:177`), so 400 ms is 26 frames against 10
  at 150 ms. The scrcpy backend paces those frames **host-side**, awaiting
  one `injectTouch` per frame over the socket
  (`scrcpy-inject-backend.ts:306-326`, cadence `MOMENTUM_STEP_MS = 16` at
  `scrcpy-inject-timeline.ts:109`), while the UiAutomation path hands the
  whole gesture to the device in one RPC. More frames means more host
  round-trips, a stretched gesture and a lower release velocity, and the
  deficit is monotone in duration (150 gives 1.038, 250 gives 0.908, 400
  gives 0.717). I have no per-frame timing in the artifacts, so this is
  inference from code structure, not a measured mechanism.
- **HIGH (F4)** — **The gate whitelist is unconditional.**
  `merge-fling.js:57-60` exempts `250|0.5` and `400|0.5` **by key, with no
  value bound**, justified against a different run (33812265077, ratios
  1.577 and 0.614). In run 7 those cells read 1.514 and 0.710 and passed the
  gate silently. Three of six informative cells are outside the tolerance
  (1.514, 0.717, 0.710); the verdict names one. Any future regression in
  those two cells is invisible. Fix: pin the whitelist to a value band, or
  drop it and report the cells as failures with the explanation attached.
- **MEDIUM (F9)** — **`informative` does not exclude the observed floor.**
  `clamped()` rejects only a median of exactly 0 or 1
  (`merge-fling.js:61`). The scroll metric has a hard floor at **0.175**
  (`iqr [0.175, 0.175]` in several cells). So 150/0.5 scores a perfect
  `ratio = 1.000` because *both* arms are pinned at that floor, and that
  artificial 1.000 counts as a passing informative cell and is folded into
  the aggregate 0.954. At least one of six "passing" cells carries no
  signal.
- **LOW (F10)** — scrcpy `n = 11`, not 12, in three cells including the
  failing 400/0.3, while `N` is reported as 12. One sample was dropped per
  cell with no reason recorded.
- **LOW (F11)** — `merge-fling.js:34-35` claims scrcpy and UiAutomation
  "drive the IDENTICAL swipe timeline (buildSwipeTimeline)". That function
  is scrcpy-only (`scrcpy-inject-timeline.ts:201`, called from
  `scrcpy-inject-backend.ts:396`); the UiAutomation arm goes through the
  Kotlin `SwipeHandler`. The comment asserts the very parity the gate exists
  to test. Stale and misleading.

### Claim (4) — describe idle, cross-run

- **BLOCKING (F1)** — **Same-run ON vs OFF describe p50 is not stable across
  three runs of the same code:**

  | run | ON-uia | ON-scrcpy | OFF-1 | OFF-2 |
  |---|---|---|---|---|
  | 5 (33963464784) | 32 | 33 | 52 | 51 |
  | 6 (33969204089) | **53** | **50** | 52 | 52 |
  | 7 (33975063607) | 39 | 36 | 52 | 52 |

  OFF is rock stable, 51-52 in every block of every run, with OFF-1 to
  OFF-2 drift of 0 ms in runs 5 and 7. ON swings 32, 53, 39: a 21 ms range.
  The implementor's doc quotes run 5's ON figures and **omits run 6's**,
  which is the run that contradicts the headline. The only defensible claim
  is: **the open describe is never slower than proprietary and is sometimes
  13-19 ms faster; the magnitude does not reproduce.** The phase-3i target
  ("ON at most OFF + 10 ms") is met in all three runs. "Open describe is
  faster, 36/53 against 52/56" as a standalone headline is not
  scoreboard-grade. Noise floor: OFF path 0-1 ms within a run, ON path
  about 21 ms across runs.

### Claim (5) — consolidation items a-h, plus the 3j items

| item | status | evidence |
|---|---|---|
| a. effect check armed on OFF, backend-independent | **PARTIAL** | fingerprint independent (`bench:1508-1512`), armed on OFF (`effectCheckedTotal` 40/60/60/40); **locate is not** (F5). Loud disarm present: `merge-blocks.js:126-135`; scoreboard prints `zero/checked` (`bench-log-*.txt:54`). |
| b. degraded-arm detection | **DONE** | `bench:2301-2322` (`CAP_MS = 4000`, paste-field reason :2320); gate `merge-blocks.js:142-150`. All blocks `degradedReasons: []`. |
| c. flushInput asymmetry labelled | **DONE** | per-block note in all four blocks (scoreboard, "tap-RPC row ... carries the flushInput asymmetry"); `bench:2292-2297`; headline row named in the doc. |
| d. bare catches record and count | **DONE for throws** | `bench:591-593`, `:458-461`. Does not cover the silent no-effect iteration; see F7. |
| e. device-test assertions restored | **DONE** | `expect(quickHits).toBe(RUNS)` (`android-open-server.device.test.ts:1034`); 3k title back to `< 50ms` (device-test.log:136); pinch throws when not ready (`:549-553`, `:1092-1096`); swipe off-screen counted as "unmeasured" throw (`:427`, `:434`); `foregroundFocus` matches `mCurrentFocus` only (`:130-134`). |
| f. per-cell blocking fling gate | **DONE but weakened** | per-cell blocking (`merge-fling.js:83`, exit :156); undermined by the whitelist (F4) and the floor (F9). |
| g. pipefail plus `if: always()` enforce gate | **DONE, firing UNPROVEN** | `set -uo pipefail` with `PIPESTATUS` (yml:270, :291); enforce step yml:419-431. Item (g) asked for one observed firing; run 7's device tests passed, so the gate has still never been seen to fire, and there is no unit test. |
| h. redir by default on emulators | **DONE** | `transport: "redir"` on both ON blocks; no host env set (yml:304-308 deliberately does not set `ARGENT_OPEN_SERVER_BIND_ALL`); gate `merge-blocks.js:159-169`. |
| 3j, compact default off | **DONE** | `compact: stateOpts.compact ?? false` (`android-open-server.ts:741`, comment :736-740). |
| 3j, debug double gate on head | **DONE** | `-e benchDebug true` only under `ARGENT_OPEN_SERVER_BENCH_DEBUG=1` (`android-open-server.ts:377`); read at `DeviceControlInstrumentation.kt:74`; `_padTo` gated `JsonRpcHandler.kt:106`; `_benchLegacyEncode` gated `StateHandler.kt:87`. Present at the run's own sha. |
| 3j finding 14, splice race | **DONE** | per-call return, no shared `lastTreeJson` or `lastPadTo` (`JsonRpcHandler.kt:66`, `StateHandler.kt:46`). |
| 3j finding 13, CI on head | **DONE** | run 7 `head_sha = f76f5d245...` equals the reviewed tree. |

### Claim (6) — workflow gates, and whether each fires

The gate list with yml and js lines in the results doc is accurate; I
re-verified each line against the tree. Which have been *observed* to fire:

- **fling parity** (`merge-fling.js:156`) — **FIRES.** Run 7 step 16,
  "Fling A/B (uiautomation vs scrcpy)", is the run's only failing step
  (`gh api .../jobs`).
- **effect / landing** (`merge-blocks.js:114`) — **FIRES.** Run 6's merge
  threw on the then-strict `== 0` form; confirmed by the *absence* of any
  `bench-merged-*.json` in run 6's artifacts, while runs 5 and 7 both have
  one.
- tap-timeline parity (`:51`, `:54`), oracle self-test (`:88`), vacuous-arm
  (`:130`), degraded-arm (`:146`), redir (`:164`), zero-fallback (`:177`) —
  **never observed to fire, and no unit test exists for any of them.**
  `.github/bench-ci/` contains no test file and nothing under
  `packages/*/test` references `merge-blocks`. Their correctness rests on
  reading alone.
- device-test enforcement (yml:427-429) — never observed to fire (item g).

Hidden-failure sweep, remaining swallowed exits that matter:

- **MEDIUM (F12)** — **yml:321**: `ready-gate.sh ... | tee -a ... || true`.
  The per-block readiness gate cannot fail a block. The device-test one
  (yml:274) is likewise advisory because that step uses `set -uo pipefail`
  without `-e`. The gate the ticket required is present and logs, but it is
  not a gate.
- **MEDIUM (F13)** — **yml:327-333**: an OFF-1 failure becomes a
  `::warning::` and sets `OFF_OK=0`, which also skips OFF-2 (yml:338), and
  `merge-blocks.js:22-31` accepts a missing OFF. A run with **no
  proprietary baseline at all** would still go green and produce an ON-only
  scoreboard. Not triggered in run 7, where all four blocks are present,
  but it is a live path to a baseline-free "result".
- **LOW (F14)** — **yml:384-390**: scoreboard generation failure is caught
  and printed, never fails the step. Summary only.
- **LOW (F15)** — **yml:365-370**: an OFF fling failure is dropped with a
  warning, recorded as `offReferencePresent`. Acceptable, but it is the
  reference that F2 depends on.
- Every other `|| true` sits on a diagnostic `ls`, `cat`, `setprop` or
  `logcat -c` line and is harmless.
- No `continue-on-error` remains anywhere except the deliberate
  `id: devtest` one (yml:265), correctly re-enforced at yml:419.

### Claim (7) — OFF-1 vs OFF-2 drift as the noise floor

Run 7, p50 ms. Which ON-minus-OFF differences clear their own floor:

| verb | floor (OFF-1 to OFF-2) | ON-scrcpy vs OFF | ON-uia vs OFF | clears? |
|---|---|---|---|---|
| describe | 0 | -16 | -13 | yes (magnitude void cross-run, F1) |
| gesture-tap | 0 | **-1** | +25 | **scrcpy: NO** (F3); uia slower: yes |
| tap+describe (settle:false vs OFF) | 8 | -7 to -15 | +142 to +150 | **scrcpy: NO** (at floor); uia slower: yes |
| gesture-swipe | 4 | -33 to -37 | +2 to -6 | scrcpy yes; uia no |
| await-screen-idle | 1 | -36 to -37 | -34 to -35 | yes |
| await-ui-element | 1 | -41 to -42 | -40 to -41 | yes |
| paste | **110** | -174 to -284 | -136 to -246 | yes, but only just against the OFF-1 arm |
| gesture-pinch | 6 | -31 to -37 | -1 to -7 | scrcpy yes; uia no |

- **BLOCKING (F3)** — the scoreboard prints "**ON-scrcpy beats OFF on tap:
  YES**" for 51 ms against 52 ms at a 0 ms drift floor. That is not a
  result. The correct statement is **at parity**. The results doc's own
  prose ("as fast as the proprietary tap") is right; the generated
  scoreboard line that ships in the job summary is not.
- **MEDIUM (F16)** — the `paste` floor is 110 ms, an order of magnitude
  above every other verb. The doc notes it and says "every ON-OFF describe
  and tap difference above clears this floor", which is true but sidesteps
  that the paste *row itself* carries a 110 ms floor under a roughly 174 ms
  claimed gain. Report paste as directional only.

### Claim (8) — anything in the doc not derived from run 7's JSON

- **OK** — every latency, landing, transport, token, fidelity, cold-start,
  RSS, ping and fling number in the results doc reproduces exactly from
  `bench-block-*.json` and `fling-ab-1788626210430.json`. I re-derived the
  full verb table independently; no discrepancy.
- **HIGH (F17)** — **selective cross-run reporting.** The "Superseded runs"
  section quotes run 5's describe figures, which support the headline, and
  omits run 6's, which contradict it, while describing both as "same code"
  (`results-final-ci.md:198-217`). Fix: add run 6's describe row, or drop
  run 5's.
- **MEDIUM (F18)** — **the screen-graph deliverable is missing and
  unflagged.** Consolidation ticket item 4 required the screen-graph
  per-config table, Wilson intervals, O5-pure and O5-mixed, and H1-H4
  "from that single run id". The `Screen-graph matrix (x86_64 KVM)` job in
  run 7 was **skipped** (`gh api .../jobs`). The doc mentions only the yml
  checkout pin, and pins it to `feat/screen-graph-d` rather than the
  `feat/screen-graph-c4` head the ticket named. Nothing is misreported; the
  numbers are simply absent, and the doc should say so.
- **MEDIUM (F19)** — **a dead probe is silently dropped.**
  `destinationVisible` reads `visible: 0` of `n: 20` in **all four blocks**,
  including both OFF blocks whose taps land 40/40 (`bench-block-*.json`,
  `destinationVisible[*].rate = 0`, `markerCount: 11`). A probe that reads 0
  on the proprietary path is broken, not a finding: it taps the stale
  derived coordinate rather than a fresh locate (`bench:1625`) and matches
  marker labels captured once at derive time (`:1598`). No gate covers it
  and the scoreboard omits it, so it vanished. Given this effort's history
  with needle-matching retractions, an all-zero oracle-adjacent probe should
  fail loudly rather than disappear. The phase-3d staleness claim cannot be
  supported from run 7.

---

## Scoreboard-grade numbers

All from run **33975063607** ("run 7"), N = 20 per verb per block, p50/p95
in ms, x86_64 with KVM on a GitHub-hosted runner. **Not comparable to local
arm64/HVF numbers.** OFF = proprietary, ON = open server.

| verb | statistic | OFF-1 | ON-uiautomation | ON-scrcpy | OFF-2 | N | required label |
|---|---|---|---|---|---|---|---|
| describe (idle) | p50/p95 | 52/53 | 39/56 | 36/53 | 52/56 | 20 | direction only; ON p50 swings 32, 53, 39 across runs 5/6/7 on the same code (F1) |
| gesture-tap (tap RPC only) | p50/p95 | 52/54 | 77/91 | 51/52 | 52/53 | 20 | **not like-for-like**: scrcpy defers the input drain to the next read |
| tap+describe | p50/p95 | 305/817 | — | — | 313/958 | 20 | proprietary single policy |
| tap+describe(settle:false) | p50/p95 | — | 455/673 | 298/810 | — | 20 / **19** | **headline like-for-like tap row**; scrcpy n=19, the no-effect iteration excluded |
| tap+describe(settle:true) | p50/p95 | — | 788/1100 | 774/1039 | — | 20 | ON-only policy |
| gesture-swipe | p50/p95 | 290/308 | 296/359 | 257/262 | 294/303 | 20 | drift floor 4 ms |
| await-screen-idle | p50/p95 | 498/504 | 463/472 | 461/474 | 497/541 | 20 | drift floor 1 ms |
| await-ui-element | p50/p95 | 72/76 | 32/38 | 31/36 | 73/77 | 20 | drift floor 1 ms; strongest ON win |
| paste | p50/p95 | 463/1217 | 327/892 | 289/867 | 573/1104 | 20 | **drift floor 110 ms**; directional only |
| gesture-pinch | p50/p95 | 338/349 | 337/358 | 307/309 | 344/362 | 20 | drift floor 6 ms |
| cold-start describe | 3 samples | [1141,760,764] | [509,433,411] | [610,419,440] | [855,777,757] | 3 | n=3, no percentile |
| first-attempt landing | landed/checked | 40/40 | 60/60 | **59/60** | 40/40 | — | 98.3 % scrcpy; recurs in run 6, so a real ~1.7 % scrcpy drop |
| originLost / locateFailed / coordMoved | count | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | — | — |
| oracle self-test | pass/fail | pass | pass | pass | pass | — | fingerprint `mResumedActivity`, backend-independent |
| transport | — | n/a | redir | redir | n/a | — | decided on device, no host env |
| tap timeline | frames / MOVE | 2 / no | 2 / no | 2 / no | 2 / no | — | holdMs 50 identical; gated |
| describe tokens (o200k) | 1 sample | 657 | 657 | 657 | 657 | 1 | n=1 |
| fidelity Jaccard | id+text set | OFF-1 vs ON-uiautomation = **1.0**, 17 keys each | | | | 1 | single sample |
| ping (open RPC floor) | p50/p95 | n/a | 0.497/0.628 | 0.422/0.475 | n/a | 20 | ON only |
| host RSS (simulator-server) | kB | 92788 | none | none | 92528 | — | ON runs on-device via `am instrument` |
| device test suite | pass/total | **17/17, enforced** | | | | — | yml:419-431; `continue-on-error` re-enforced |

Fling A/B, run 7, N = 12 per cell per backend, median normalized scroll:

| cell | uia | scrcpy | off | scrcpy/uia | scrcpy/off | status |
|---|---|---|---|---|---|---|
| 150 / 0.3 | 0.449 | 0.466 | 0.464 | 1.038 | 1.004 | pass |
| 150 / 0.5 | 0.175 | 0.175 | 0.175 | 1.000 | 1.000 | **at the 0.175 floor, no signal (F9)** |
| 250 / 0.3 | 0.357 | 0.324 | 0.455 | 0.908 | 0.712 | pass |
| 250 / 0.5 | 0.175 | 0.265 | 0.175 | 1.514 | 1.514 | outside tolerance, **whitelisted (F4)** |
| 400 / 0.3 | 0.321 | 0.230 | 0.358 | **0.717** | 0.642 | **FAIL, the run's only red** |
| 400 / 0.5 | 0.507 | 0.360 | 0.621 | 0.710 | 0.580 | outside tolerance, **whitelisted (F4)** |

Cross-run stability of the 400 ms deficit, scrcpy against the OFF
reference: run 5 gives 0.66 and 0.57; run 7 gives 0.64 and 0.58.
**Reproducible.**

---

## Void list

1. **Phase 3h's stated tap mechanism**, "the scrcpy tap lands because the
   timeline became DOWN, MOVE, UP". VOID. Run 7 injects two frames with no
   MOVE in every block, and `merge-blocks.js:53-58` now *fails* any block
   that has a MOVE. The tap was fixed by fixing the effect oracle.
2. **"Open describe is faster than proprietary, 36/53 against 52/56"** as a
   magnitude. VOID as stated. Run 6, same code, measured ON 50-53 against
   OFF 52. Survives as: *ON is never slower than OFF and is 13-19 ms faster
   in 2 of 3 runs.*
3. **"ON-scrcpy beats OFF on tap: YES"** (scoreboard tap verdict). VOID.
   51 against 52 ms at a 0 ms drift floor is parity.
4. **"The fling failure is measurement noise on the multi-frame swipe."**
   VOID as an explanation. Against the proprietary reference the 400 ms
   deficit reproduces to within 0.02 across two runs at both distances.
5. **Fling cells 250/0.5 and 400/0.5 "explained".** Not void, but the
   whitelist that excuses them is value-free and was written against a
   different run's ratios; it cannot detect a regression in those cells.
6. **Fling cell 150/0.5 ratio 1.000.** VOID as evidence of parity: both
   arms sit at the 0.175 scroll floor.
7. **`destinationVisible` and phase-3d staleness rates from run 7.** VOID:
   0 of 20 in all four blocks including the proprietary ones, so the probe
   did not work.
8. **Screen-graph numbers "from run 7".** None exist; the job was skipped.
9. **`paste` ON-minus-OFF gain as a measured speedup.** Directional only;
   the OFF-1 to OFF-2 drift on that verb is 110 ms.

## Minimum to close

Doc edits only, no rerun required. The run's single red is a real and now
explained property.

1. Restate the describe claim as direction, and add run 6's describe row to
   the superseded-runs section (F1, F17).
2. Restate the 400 ms fling result as a reproducible scrcpy momentum deficit
   measured against the proprietary reference, not as noise (F2).
3. Change the tap verdict line to "at parity" (F3).
4. Disclose the fling whitelist and the 0.175 floor in the gates section
   (F4, F9), and value-bound or remove the whitelist.
5. Report `locateVia = describe 100 %` and stop calling the whole oracle
   backend-independent (F5).
6. State plainly that the screen-graph job was skipped in run 7 (F18) and
   that `destinationVisible` read 0 of 20 everywhere (F19).

Code changes worth queuing but not blocking this report: log the no-effect
iteration's identity (F7); make the per-block readiness gate blocking
(F12); fail rather than warn when the OFF baseline is absent (F13); add
unit tests for the six merge gates that have never been observed to fire.
