# Adversarial review — phase 3n run 1 (CI 34853156073)

Kotlin injection strategies (`uia-sync` / `uia-async` / `input-manager`) vs scrcpy vs
the proprietary driver. Read-only review; nothing in the branch or the worktree was
modified.

## Reviewed + evidence

- Subject: `feat/open-server-3n-kotlin-injector` @ `a61c47d5` (`ac2e6a57`…`a61c47d5`,
  incl. merge `cb3f32ee` of `open/main` @ `8315e396`), worktree
  `/Users/heicg/Desktop/projects/argent-fork-wt-3n`.
- Ticket + `## Result`:
  `docs/open-server/2026-09-14-open-server-phase3n-kotlin-injector-replaces-scrcpy.md`
  (worktree copy).
- Artifacts: the worktree `.bench-results/` was **empty**, so both run artifacts were
  downloaded fresh: `bench-latency` (artifact id 10356142970, 38 entries, created
  2026-09-14T15:39:46Z) and `bench-screen-graph` (10355753802). Run metadata:
  `run_attempt` **1**, head `46fb3f79`, created 14:03:49Z, conclusion `failure`.
- Recompute: every latency p50/p95 below was recomputed from
  `.bench-results/bench-block-*.json`; every fling median/IQR/n and every ratio was
  recomputed from `.bench-results/fling-block-*.json` samples; p-values are two-sided
  permutation tests on the medians (B = 20 000, seed 7).
- Local checks run in the worktree: `node --test .github/bench-ci/gates.test.js`
  (22/22 pass), `npx vitest run --maxWorkers=2
  packages/tool-server/test/open-server-inject-strategy.test.ts` (7/7 pass).
- Reference context: `docs/open-server/2026-09-03-scoreboard.md:35-56,116-133`,
  `2026-09-14-review-3k1-findings.md`, `2026-09-14-decision-fling-next-phase.md`,
  `2026-09-14-open-server-phase3m-fingerprints-opt-in.md:103,128,217,252-275`.

### Numbers that reproduce exactly

Every p50/p95 in the Result's verb table reproduces from the block JSON, and every
number in the Result's reference column reproduces from `2026-09-03-scoreboard.md:35-46`.
The Result's `input-manager` fling ratios (1.54 / 1.048, 0.959 / 0.844, 1.132 / 0.796)
reproduce exactly from the cell medians. The screen-graph section reproduces exactly
from `screen-graph/results-ci.md`. The device table reproduces exactly from
`logs/device-test.log:90-95`. The step-16-only failure is confirmed independently: jobs
API shows `Screen-graph matrix` **success**, `Latency bench` **failure** with exactly one
failed step, `16 Fling A/B`.

## VERDICT

**The measurement run is sound and the Result's numbers are honest and reproducible —
but its central conclusion is wrong, because the pre-registered gates measure the wrong
thing.** Every gate in section A grades the Kotlin arms against **scrcpy**, and scrcpy is
the arm the phase exists to delete. Graded against the **proprietary** driver — the
owner's actual goal — this run says the opposite of "no strategy passes":
`input-manager` is **at parity with proprietary on tap** (55 vs 53/53, floor ±2), **beats
proprietary on swipe** (268 vs 307/300, floor ±7) and **on pinch** (323 vs 351/356, floor
±5), is **faster than proprietary on the like-for-like headline** `tap+describe`
(400 vs 445/548, OFF self-drift 103 ms), lands **60/60** with **0 fallbacks**, and
**resolved the hidden `InputManager.injectInputEvent` pipe on-device with no
`hidden_api_policy` change**. Two of the four "FAIL" rows in the Result's gate table are
artefacts: gate 4's `±2 ms` floor is a **hard-coded default**, not a measured floor
(`scoreboard.js:174-176` — the OFF blocks never emit a `settle:false` row), and gate 1's
floor is a 2 ms synthetic minimum over a **0 ms** measured drift.

The fling section is where the Result is too generous to itself in the other direction.
The run does **not** support "input-manager under-scrolls like scrcpy while the
UiAutomation arms scroll correctly". Recomputed, the **UiAutomation reference arm itself
under-scrolls the proprietary driver** on two of three informative cells (0.680,
p = 0.0009; 0.703, p = 0.007), and at 250/0.3 `input-manager` is the **only** arm at
parity with proprietary (1.048, p = 0.43) while uia (0.680) and scrcpy (0.662) both
collapse. There is no pipe-sorted signal in this run. Underneath that, the fling metric
itself is unfit for a ±0.15 ratio gate: it is censored and quantized (127 of 355 samples
are exactly the 0.175 floor, 36 are exactly 0.657, 5 are the hard-clamp `return 1`).

Code review is clean: the reflection is correct and defensively guarded, the DEFAULT
path is behaviourally and wire-level unchanged, and `uia-async`'s drain genuinely uses
the same slot and the same synchronous `ACTION_CANCEL` as scrcpy's `flushInput`. The
biggest process gap is that **run 1 carries no `ON-uiautomation` latency block**, so the
run cannot demonstrate that the default path is unchanged and every strategy delta is
anchored only to scrcpy and OFF.

Overall: **accept the run, reject the Result's promotion verdict, re-grade against
proprietary, and do not let any fling number from this run reach the scoreboard.**

## HIGH

**3N-H1 — Gate 4 is graded against a floor that does not exist; against proprietary every
ON arm wins that row.** `scoreboard.js:173-176` computes `driftFloor(verb) =
max(2, |OFF-1 − OFF-2|)` and falls back to `2` when the verb is absent from the OFF
blocks. `tap+describe(settle:false)` is **only** emitted for `config === "ON"`
(`bench-open-vs-proprietary.ts:2164-2171`), so its "floor ±2" in `scoreboard.md` and in
the Result's gate table is the hard-coded default, not a measurement. The established
like-for-like comparator (scoreboard:41, 3m gate G6 at
`2026-09-14-open-server-phase3m-fingerprints-opt-in.md:217`) is OFF `tap+describe`, whose
self-drift **in this run is |445 − 548| = 103 ms**. Against that:

| arm | p50 | Δ vs OFF-1 445 | Δ vs OFF-2 548 | G6 ratio (OFF-1 / pooled 496 / OFF-2) |
|---|---|---|---|---|
| ON-uia-sync | 437 | −8 | −111 | 0.98 / 0.88 / 0.80 — PASS |
| ON-uia-async | 422 | −23 | −126 | 0.95 / 0.85 / 0.77 — PASS |
| **ON-input-manager** | **400** | **−45** | **−148** | **0.90 / 0.81 / 0.73 — PASS** |
| ON-scrcpy | 340 | −105 | −208 | 0.76 / 0.69 / 0.62 — PASS |

All four arms clear 3m's pre-registered G6 (`≤ 1.15`) on every denominator. On run
34840929610 the same gate **failed** for uia (band 1.23–1.41) and sat on the knife edge
for scrcpy. This is the single largest "vs proprietary" result in the run and the Result
does not mention it. Caveat that must travel with it: the OFF denominator also moved
(364/418 on 34840929610 → 445/548 here), so part of the ratio improvement is a slower
proprietary baseline; the 103 ms OFF↔OFF drift on this row makes it a one-run signal, not
a scoreboard row.

**3N-H2 — The fling mechanism claim is not supported; the UiAutomation reference arm is
itself out vs proprietary.** Recomputed per cell (n = 11–12 per arm-cell, two-sided
permutation p on the medians):

| cell | OFF med (n) | uia/off (p) | scrcpy[drift]/off (p) | im/off (p) | im/uia (p) |
|---|---|---|---|---|---|
| 250/0.3 | 0.441 (12) | **0.680 (0.0009) OUT** | **0.662 (0.0021) OUT** | 1.048 (0.43) OK | **1.540 (0.0066) OUT** |
| 400/0.3 | 0.360 (11) | 0.881 (0.011) OK (dev 0.119) | 0.958 (0.42) OK | **0.844 (0.0009) OUT** | 0.959 (0.49) OK |
| 400/0.5 | 0.657 (11) | **0.703 (0.0072) OUT** | **0.802 (0.0078) OUT** | **0.796 (0.0079) OUT** | 1.132 (0.68) OK |

Readings the Result does not make: (a) the **default UiAutomation path fails the
"vs proprietary" side of the 3k.1 rule on 2 of 3 informative cells** — the same arm that
read `uia/off 1.037` at 400/0.3 on run 34813849446 reads **0.881** here; (b) at 400/0.5
uia (0.703) is the **worst** arm, below both scrcpy (0.802) and input-manager (0.796);
(c) at 250/0.3 input-manager is the **only** arm at parity with proprietary. Both
candidate mechanisms ("the InputManager pipe under-scrolls", "the UiAutomation pipe is
correct") are contradicted by at least one cell. The Result's own wording — "input-manager
under-scrolls vs off at 400 ms, similar to scrcpy" — is true only against the *legacy*
scrcpy arm (0.800 at 400/0.3); the gate arm (drift) reads 0.958 there.

**3N-H3 — The fling metric is censored and quantized; a ±0.15 ratio-of-medians gate on it
is not a valid test.** `bench-fling-fidelity.ts:132-165`: the score is the median
downward displacement of labels surviving in **both** describes, filtered to `d > 0.02`,
and `if (disps.length === 0) return 1` — a fling hard enough to push every labelled row
off screen scores exactly **1.0**. Across all 355 samples in this run there are only 132
distinct values, and **127 are exactly 0.175**, **36 are exactly 0.657**, **5 are exactly
1.0** — 47 % of all samples sit on three atoms produced by the Settings list's row pitch
and by the clamp. A harder fling therefore *loses* survivors and can score *lower*, and
the median snaps between row-pitch multiples. This explains both the 250/0.3 "uia anomaly"
the Result attributes to emulator noise and the non-reproducibility of `uia/off` between
34813849446 (1.037) and this run (0.881). No fling ratio from this run should be treated
as an estimate of scroll fidelity.

**3N-H4 — Run 1 has no `ON-uiautomation` latency block, so it cannot show the default path
is unchanged.** The six blocks are `OFF-1, ON-uia-sync, ON-uia-async, ON-input-manager,
ON-scrcpy, OFF-2` (`scoreboard.md` "Blocks run"); the default arm was dropped to make room.
Consequences: (a) the code-level "DEFAULT is byte-for-byte unchanged" claim (verified
below) has **no measured confirmation** on this run, even though the base also carries the
3m/3m.1 merge; (b) every strategy delta is anchored only to scrcpy and OFF; (c) the
Result's "default UiAutomation tap was 78 in 34813849446" comparison **crosses runs** —
the honest within-run statement is that this run has no default arm. Note the internal
check that *is* available: for `count = 1`, `finalUpSyncFor(UIA_ASYNC, false) ==
finalUpSyncFor(DEFAULT, false) == false` (`MotionInjector.kt:462-468`), so `uia-async`'s
tap row **is** the DEFAULT tap row under another name — 86 ms here.

**3N-H5 — Gates decided at ±1–3 ms have no confidence interval, because the verbs carry no
per-sample arrays.** Each verb entry in `bench-block-*.json` holds only
`{n, p50, p95, max, min, mean}` (per-sample arrays exist for the *describe* stage split,
not for gesture verbs). No bootstrap or rank test on any verb delta is possible from the
artifact. The Result then decides gate 1 by **1 ms** and gate 2 by **3 ms**, on a row
whose measured OFF↔OFF drift is **0 ms** only because the harness rounds two 20-sample
p50s that happened to land on the same integer (tap p95 drift on the same blocks is
61 vs 68). Any promotion decision at this resolution needs per-sample latency arrays and a
stated interval.

**3N-H6 — The pre-registered gate set answers the wrong question.** Gates A1–A4 are all
"within/not worse than **ON-scrcpy**". Combined with 3N-H1, this produces a verdict ("no
strategy meets the full promotion gate") that is an artefact of the comparator, while the
same run's data show `input-manager` at parity with or beating **proprietary** on every
gesture verb. The ticket's own goal statement is "a Kotlin injection strategy at or below
scrcpy's RPC latency **with correct scroll fidelity, then scrcpy removed**" — but the
scoreboard's goal row and every prior review grade the open stack against the proprietary
driver. Run 2 must carry proprietary-referenced gates (text in *Promotion recommendation*
below).

## MEDIUM

**3N-M1 — `injectStrategyReported` is one post-hoc probe tap, not per-block-per-RPC
evidence.** `bench-open-vs-proprietary.ts:2442-2465`: the echo is read from **one extra
`tap` issued after the measured loop**, and **only** when `config === "ON" && injectStrategy
=== "input-manager"`. The `uia-sync` / `uia-async` blocks carry `injectStrategy` but **no**
`injectStrategyReported` (verified: the field is absent from both block JSONs), and the
fling job has no availability check at all. The inference that input-manager ran as itself
throughout the block is still sound — `InputManagerInjector.probe()` caches the resolution
for the process lifetime under a lock and only ever transitions unprobed→resolved
(`InputManagerInjector.kt:56-71`), and `resolveEffective` consults that same cache
(`MotionInjector.kt:441-457`) — but it is an inference from process lifetime, not a
measurement, and it does not cover the fling arm. The only direct per-strategy on-device
confirmation in the whole run is the device test (`ranAs=<strategy>` for all three,
`logs/device-test.log:90-95`).

**3N-M2 — The one available internal consistency check on the tap row comes out inverted.**
`uia-sync` forces a blocking final UP (`WAIT_FOR_FINISH`), `uia-async` does not, so
`uia-sync` tap must be ≥ `uia-async` tap. Measured: **uia-sync 84, uia-async 86**. The
ordering is backwards, i.e. the 2 ms differences on that row are noise — which is the same
magnitude as the gate-1 "FAIL by 1 ms". (The swipe row is consistent with the mechanism:
uia-sync 311 vs uia-async 291, Δ 20 ms = the final-UP dispatch wait.)

**3N-M3 — "cleaner reliability than scrcpy" is not a distinguishable difference.** 60/60 vs
58/60 is Fisher two-sided **p = 0.4958**. Both scrcpy misses are on
`tap+describe(settle:true)` (`scoreboard.md`, F7 identities, i=7 and i=9), a verb no
promotion gate covers, and scrcpy's 96.7 % still clears the ≥95 % gate. The claim should
read "no arm missed the landing gate".

**3N-M4 — The input-manager fling grading is not in any artifact.** `merge-fling.js:251-319`
prints the input-manager section to **stdout only**; `fling-ab-1789400383810.json` contains
**zero** occurrences of `input-manager`/`inputManager` and its `grid` cells carry only
`uiautomation / scrcpy / scrcpyLegacy / off`. The Result's input-manager fling table is
therefore not reproducible from the artifact (it *is* arithmetically correct — I
recomputed it from `fling-block-ON-input-manager.json`). `merge-fling.js` should write the
input-manager grid + verdict into the JSON.

**3N-M5 — The three strategy arms have no per-block log in the artifact.** The zip contains
`bench-log-OFF-1.txt`, `bench-log-OFF-2.txt`, `bench-log-ON-scrcpy.txt` and nothing for
`ON-uia-sync` / `ON-uia-async` / `ON-input-manager` — the self-orchestrated children
(`run-bench.js:38-58`, `stdio: "inherit"`) write to the job log, which the workflow's
per-block redirection does not capture. Any warning those arms emitted is unreviewable
from the artifact.

**3N-M6 — The residual-gate estimator was changed after the gate failed.** `46fb3f79`
changes both residual loops from `i < 5` to `i < 20` and the test budget 180 s → 300 s,
explicitly because run 34840929610 "failed it by 1 ms on a 5-sample median". The threshold
(10 ms) is unchanged and the change was committed **before** the run and documented in the
addenda — process-honest — but the estimator is no longer independent of the data that
failed it. It was not outcome-determinative here (measured 0 ms idle / 5 ms after-tap,
`logs/device-test.log:99`). The six 3n device cases themselves were committed in `2d6d7c00`
and untouched by `46fb3f79`: **no post-hoc loosening of the 3n cases.**

**3N-M7 — "Interleaved" is round-granular for the strategy arms.** From
`fling-interleave-evidence.json` (360 events, 5 not-ok): within each of the 3 rounds an
arm runs **24 consecutive samples** (6 cells × 4) before the next arm starts; only
`ON-scrcpy` / `ON-scrcpy-legacy` alternate 1:1. Arm order does rotate across rounds
(uia→im→scrcpy→off, im→scrcpy→off→uia, scrcpy→off→uia→im), which balances slow drift at
round scale, but within-round drift stays confounded with arm.

**3N-M8 — Screen-graph is green but not at the reference, and the Result states the numbers
without the comparison.** This run: B1 100 · B2 97 · O1 99 · O2 100 · O3 99 · O4 98 · O5 98;
`skippedNoIdHash` **2**; O5 one-step routed **58/60** with **2 hash-mismatch** divergences;
store `com.android.settings` 11 nodes / 10 edges; invariants OK (`sg-matrix.log:200`).
Reference 34813849446 (`2026-09-03-scoreboard.md:120,128,129`): **100/100 on all seven
configs**, `skippedNoIdHash` **0**, O5 **60/60**, settings store 10/9. So O4 98 / O5 98 are
**not** "within run-spread" of the reference on success — the reference had zero failures
everywhere; they *are* within the spread of the 3m run (O4 98, O5 97) and inside every H4
non-inferiority interval on this run (O4 Δ −2 pp [−5, 0] vs B1, O5 Δ −2 pp [−6, 0]).
Tokens are within spread (O1 138 is inside the documented 138–179 band; O2 54, O3 627,
O4 21, O5 22 all match). I could **not** establish 34840929610's `skippedNoIdHash` — the
3m.1 Result records "invariants GREEN / no EMPTY_TREE_HASH node"
(`2026-09-14-open-server-phase3m-fingerprints-opt-in.md:185`) but never quotes the counter,
and that run's artifact is out of scope here. Attribution: the screen-graph job runs with
no `ARGENT_OPEN_INJECT_STRATEGY`, so 3n's code is inert on it; nothing here is attributable
to 3n. Whether it is attributable to 3m.1 cannot be decided without 34840929610's counter.

**3N-M9 — The non-informative filter hides input-manager's largest deviation.** At 150/0.3
`q25(uia) = 0.175` makes the cell non-informative under the 3k.1 rule — correctly applied
(I verified all six exclusions match the rule) — but `q25(off) = 0.415`, i.e. the
**proprietary** reference is clean there, and `input-manager` reads **0.175 vs off 0.464 =
0.377** (only 4 of 12 samples above the floor). The rule's "keyed on the reference arms"
wording lets a bimodal *uia* arm suppress a cell where *proprietary* is a perfectly good
reference. Run 2's rule should be: a cell is informative when **either** reference arm is
above the floor, graded against that reference only.

**3N-M10 — The cadence claim is n = 1.** "input-manager delivered the cleanest ~16 ms MOVE
cadence" rests on one 8-frame gesture per strategy (7 intervals):
input-manager `[16,16,16,16,17,18,21]` vs uia-async `[17,15,16,17,15,19,19]` — not
distinguishable at n = 1. The uia-sync trace `[23,9,17,15,16,16,26]` is the visibly
jittery one. Worth repeating at n ≥ 10 gestures per strategy in run 2; the cadence
histogram is the cheapest lead on the fling mechanism (see below).

**3N-M11 — input-manager availability is proven on exactly one image.** The reflective pipe
resolved with **no** `hidden_api_policy` write and **no** `-e disable-hidden-api-checks`
anywhere in the tree (grep over the whole repo returns only doc/comment mentions), on
`system-images;android-34;google_apis;x86_64` (`ci-runner-env.json`). `google_apis`
(non-Play) images are userdebug; a Play image or a user-build device may enforce hiddenapi
and drop the arm to `uia-async`. The fallback path exists and is correct, but "input-manager
is available" is a claim about this emulator image, not about devices.

## LOW

**3N-L1 — The 3n device cases are saturated and cannot discriminate strategies.** All three
report the identical `tap +2/-40 labels`, identical fling `1168 px`, identical pinch
`2.9 % of pixels` (`logs/device-test.log:90-95`); only the momentum-free control varies
(540 / 631 / 566). 1168 px is almost certainly the list's end-of-scroll clamp. They prove
"each strategy works", which is what they were for, but they carry no comparative signal.

**3N-L2 — `InputManagerInjector.injectAsync` reports a post-probe failure as a dispatcher
drop, not as a fallback.** `InputManagerInjector.kt:78-86` catches `Throwable` and returns
`false`; `MotionInjector.dispatchEvent` maps that to `dropped = true`. A SecurityException
thrown per-call *after* a successful `probe()` would surface as "the dispatcher rejected
the event", never as `strategy:"unavailable"`. It did not bite (errors 0 and fallbacks 0 on
every verb of every block), but the fallback accounting has this blind spot.

**3N-L3 — The ≤33 reflection branch was never exercised.** `resolveInstance`
(`InputManagerInjector.kt:113-129`) tries `InputManagerGlobal` then `InputManager`; the CI
image is API 34, so only the first branch ran. `INJECT_INPUT_EVENT_MODE_ASYNC = 0` matches
AOSP; `getMethod("injectInputEvent", InputEvent, int)` on the instance's own class is
correct for both holders; the probe is cached under a lock and never throws; `describe()`
unwraps `InvocationTargetException`. The reflection is correct and defensively guarded as
claimed.

**3N-L4 — One host call site is not literally unchanged on the DEFAULT path.**
`openServerSwipeWithOutcome` (`open-server-input.ts`) previously passed `undefined` when
`idleTimeoutMs` was unset and now always passes an object (`{...injectOpt()}` = `{}`).
Behaviourally inert — the blueprint spreads `inject` only when defined
(`android-open-server.ts` tap/swipe/gesture/`*WithOutcome` builders all use
`...(x !== undefined ? {x} : {})`), so the **wire is byte-for-byte unchanged** — but it is
the one place where "the DEFAULT path is untouched" is true only after reading the
blueprint.

**3N-L5 — The availability probe injects an unaccounted extra tap** at screen centre after
every `input-manager` block (`bench-open-vs-proprietary.ts:2449-2452`), outside any verb's
accounting and after the effect oracle has been torn down.

**3N-L6 — A fourth graph store appears.** `com.google.android.permissioncontroller` (1 node
/ 1 edge) is present this run; the reference documented three stores. Consistent with the
scoreboard's own "the store shape is not run-stable" note; no invariant violated.

### Verified as claimed (no finding)

- **DEFAULT path unchanged.** `git diff 998d8954..a61c47d5 -- MotionInjector.kt`: for
  `DEFAULT`, `resolveEffective` does not probe, `finalUpSyncFor(DEFAULT, true/false)`
  reproduces the old `sync = true` on a gesture's final UP and `sync = false` on a tap's,
  `dispatchEvent(..., DEFAULT, ...)` is literally `uiAutomation.injectInputEvent(event,
  sync)`, and the `asyncUp.clear()` / `markOutstanding()` bookkeeping is unchanged.
  Multi-tap is unchanged too: the new `isFinalUp = k == count - 1` gate resolves to
  `doSync = false` for every tap under DEFAULT, as before.
- **`uia-async` ≡ scrcpy's `flushInput` semantics.** Both fold the drain into the next
  read, both inject **one synchronous `ACTION_CANCEL` with pressure/size 0** through
  `uiAutomation.injectInputEvent(ev, true)` (`MotionInjector.kt:356-392`), and both are
  invoked in the **same slot** — step 0 of `StateHandler.execute`
  (`StateHandler.kt:122-128`) and of `HierarchyHandler` (`HierarchyHandler.kt:49-54`),
  inside the measured capture, `flush:true` selecting `flushInput` and the default
  selecting `drainAsyncUp`. The accounting is like-for-like; the row is comparable.
- **Fling arm "identical by construction" for uia-sync/uia-async — pre-lift only.** In
  `MotionInjector.inject` the only strategy-dependent branch before the final UP is the
  pipe selection in `dispatchEvent`, which for `DEFAULT`/`UIA_SYNC`/`UIA_ASYNC` is the
  same `uiAutomation.injectInputEvent(ev, false)` call, so **the injected pre-lift timeline
  is byte-identical** and the final-UP mode cannot change the velocity the fling reads.
  Post-lift it is *not* identical (the UP is queued, the drain moves into the next read),
  but the harness sleeps 1300 ms and then calls `await-screen-idle` before measuring
  (`bench-fling-fidelity.ts:147-150`), which swamps that difference. **However: no
  `uia-sync` / `uia-async` fling arm was run, so this is a code argument with zero run
  evidence** — the fling job produced only `OFF`, `ON-uiautomation`, `ON-scrcpy`,
  `ON-scrcpy-legacy`, `ON-input-manager`.
- **Device tests, as pre-registered.** All six 3n cases PASS with `ranAs` equal to the
  requested strategy, and the 20-sample residual gate passes at 0 ms idle / 5 ms after-tap
  (`logs/device-test.log:90-99`). dumpsys cadence per strategy: N = 8 delivered for an
  8-frame wire gesture, source `dumpsys input` RecentQueue (MotionEvent-filtered),
  deliveredSpan 122 / 118 / 120 ms. What it shows: the injected frame count survives
  delivery and the inter-arrival spacing. What it does **not** show: the `eventTime` stamps
  the app actually saw, any velocity, any comparison against the proprietary driver's own
  cadence (never captured), and anything at n > 1.
- **No `hidden_api_policy` manipulation** anywhere in the tree.
- **No run blending.** Every number in the Result traces to run 34853156073's artifact or
  is explicitly labelled as run 34813849446. `run_attempt` is 1; there is no second
  attempt to blend with.

## Fling mechanism candidates

Ranked. The run gives **no** pipe-sorted signal (3N-H2), so the ranking starts with the
instrument, not the mechanism. Items marked *(AOSP inference)* come from framework
knowledge, not from code in this repo.

1. **The metric, not the injection path.** Censored + quantized + clamped
   (`bench-fling-fidelity.ts:132-165`; 47 % of samples on three atoms), and the same
   `ON-uiautomation` arm reads `uia/off` 1.037 on 34813849446 and 0.881 here with identical
   default-path code. Until the instrument is shown to reproduce itself, no mechanism
   question is answerable. **Discriminator: run the same arm twice in one run
   (`ON-uia-A` / `ON-uia-B`, interleaved per sample) and require `|A/B − 1| ≤ 0.15` on every
   informative cell before any arm comparison is graded.**
2. **`waitForAnimations` / `syncInputTransactions` on the UiAutomation pipe** *(AOSP
   inference)*. The 2-arg `UiAutomation.injectInputEvent(ev, sync)` implies
   `waitForAnimations = true`, and `UiAutomationConnection.injectInputEvent` issues a
   blocking `WindowManager.syncInputTransactions()` **before every injected event**, then
   calls the same `InputManagerGlobal.injectInputEvent` that `input-manager` calls
   directly. That predicts exactly what this run measures: ~30 ms/tap of extra cost on the
   uia arms (84/86 vs 55) and a jittery MOVE cadence (uia-sync `[23,9,17,15,16,16,26]` vs
   input-manager `[16,16,16,16,17,18,21]`), and irregular MOVE spacing changes the
   least-squares fit VelocityTracker runs. **Discriminator: a `uia-async-nowait` arm using
   the 3-arg `injectInputEvent(ev, false, false)`; if its cadence tightens to
   input-manager's, this is the uia arms' mechanism.**
3. **MOVE cadence / resampling, not velocity stamping.** `MotionInjector` stamps
   `eventTime = SystemClock.uptimeMillis()` at dispatch (`MotionInjector.kt:128`, `:253`) —
   the true arrival time — and neither ASYNC injection nor `InputDispatcher` re-stamps it,
   so all three open arms hand the framework honest times. What differs from a real
   touchscreen is *spacing*: none of the arms pace to vsync, and `ViewRootImpl`'s batched
   resampling interpolates at the vsync from event times, so an 8–26 ms jittered stream
   resamples differently than a 16.67 ms one. **Discriminator: capture the `dumpsys input`
   MotionEvent inter-arrival histogram for the PROPRIETARY driver's own swipe (never yet
   measured) and compare it against each arm at n ≥ 10 gestures.**
4. **Event identity: `deviceId` / `flags` / `displayId`** *(partly AOSP inference)*. Every
   arm builds events with `InputDevice.SOURCE_TOUCHSCREEN`, `deviceId = 0`, `flags = 0`,
   no explicit display (`MotionEvent.obtain(...)` 14-arg, `MotionInjector.kt:131-146`), i.e.
   a virtual device with no `InputDevice` behind it and no `FLAG_IS_GENERATED_GESTURE`.
   The proprietary driver may inject with a real touchscreen `deviceId` and/or generated-
   gesture flags, which can change how views classify the stream. **Discriminator: one arm
   that sets `deviceId` to a live touchscreen id from `InputDevice.getDeviceIds()` and sets
   `FLAG_IS_GENERATED_GESTURE`, everything else held constant.**
5. **Injection mode (ASYNC vs WAIT_FOR_RESULT/FINISH) causing MOVE coalescing.** ASYNC gives
   no back-pressure, so a burst can be batched into one delivery with only the last
   `eventTime`, suppressing VelocityTracker samples. Ranked low because the 3n cadence row
   already shows **N = 8 delivered for 8 wire frames** on all three strategies — no loss on
   that gesture. **Discriminator: injected-vs-delivered MOVE count on the 400 ms / 0.5
   fling gesture specifically (26 wire frames), not the 8-frame probe.**
6. **UiAutomation injecting on the accessibility input-filter path.** Effectively refuted:
   `UiAutomation.injectInputEvent` is not the input-filter path (that is
   `AccessibilityService.dispatchGesture`); it terminates in the same
   `InputManager(.Global).injectInputEvent` as candidates 2 and 4. Keep it only as a
   negative control.

**The one device test that discriminates most, if only one can be run:** a single
interleaved fling run carrying **six arms** — `uia-A`, `uia-B` (duplicate, the noise
control), `uia-nowait` (3-arg `waitForAnimations=false`), `input-manager`, `scrcpy`, `off`
— each cell also recording the `dumpsys input` MotionEvent inter-arrival histogram for the
gesture that produced it. `uia-A` vs `uia-B` bounds the instrument (candidate 1);
`uia-nowait` vs `uia-A` isolates candidate 2; the histograms against `off`'s own histogram
settle candidate 3; and if all four open arms track each other while `off` stands apart,
the mechanism is not the pipe at all.

## Promotion recommendation

### (a) Is a Kotlin-only default justified by THIS run against proprietary, with scrcpy
removed?

**Yes for latency and reliability; no for fling — and the owner's proposed split is not
supported.** Recomputed against the proprietary blocks at this run's measured drift floors:

| verb | floor | ON-uia-sync | ON-uia-async | **ON-input-manager** | ON-scrcpy |
|---|---|---|---|---|---|
| gesture-tap (OFF 53/53) | ±2 | +31/+31 **loss** | +33/+33 **loss** | **+2/+2 parity** | −1/−1 parity |
| gesture-swipe (OFF 307/300) | ±7 | +4/+11 parity/loss | −16/−9 **win** | **−39/−32 win** | −49/−42 win |
| gesture-pinch (OFF 351/356) | ±5 | −4/−9 parity/win | −11/−16 **win** | **−28/−33 win** | −44/−49 win |
| tap+describe settle:false (OFF 445/548) | ±103 | −8/−111 parity/win | −23/−126 parity/win | **−45/−148 parity/win** | −105/−208 win |
| landing | — | 60/60 | 60/60 | **60/60** | 58/60 |
| fallbacks | — | 0 | 0 | **0** | 0 |
| fling vs off (informative cells) | ±0.15 | = uia: 2 of 3 OUT | = uia: 2 of 3 OUT | **2 of 3 OUT** | 2 of 3 OUT |

`input-manager` is the only arm that is at-or-better than proprietary on **every** verb,
and it is strictly better than the current default (`uia`) on every gesture verb. The
`uia-*` arms lose the tap row to proprietary by ~31 ms.

The owner's proposed split — `input-manager` for tap/pinch, `uia-async`/`uia-sync` for
swipe/momentum — **has no support in this run**: `input-manager` is the *fastest* Kotlin
swipe arm (268 vs 291/311) and at 250/0.3 the *only* arm at fling parity with proprietary,
while `uia` is the *worst* arm at 400/0.5 (0.703 vs 0.796). Recommend instead:

- **Default `input-manager` for tap, swipe, pinch and multi-pointer gesture**, with the
  existing automatic `uia-async` fallback on a hiddenapi block (already correct and
  reported).
- **Do not remove scrcpy in the same commit as the default flip.** Not because scrcpy is
  better — it failed its own blocking fling gate and loses landing — but because
  `input-manager` availability is proven on exactly one emulator image (3N-M11) and the
  fallback has never been exercised on a blocked device. Flip the default in run 2; remove
  `@yume-chan/*`, the scrcpy backend/timeline and the fetch/pump steps in the run **after**
  run 2 is green, or in the same PR with a single-commit revert documented.
- **Make no fling claim either way.** Ship the fling status as OPEN, unchanged.

### (b) Pre-registered gates for run 2 — verbatim, referenced to proprietary

> **Phase 3n run 2 — pre-registered acceptance. Base: `open/main` @ <sha>. Blocks:
> `OFF-1, ON-uiautomation, ON-input-manager, ON-scrcpy, OFF-2`. N = 20 per verb per block.
> Every gate below is graded against the PROPRIETARY blocks, never against ON-scrcpy.
> Every verb emits its per-sample latency array; every Δ is reported with a 10 000-sample
> bootstrap 95 % CI on the p50 difference.**
>
> **P0 — control arm present.** `ON-uiautomation` (the current default, no
> `ARGENT_OPEN_INJECT_STRATEGY`) runs as a latency block. If it is absent the run is void.
>
> **P1 — drift floor is measured, never defaulted.** For every gated verb the floor is
> `|OFF-1 p50 − OFF-2 p50|` on the SAME verb name in the OFF blocks. A verb with no OFF
> counterpart is gated on the OFF verb the scoreboard already declares its comparator
> (`tap+describe(settle:false)` → OFF `tap+describe`). `scoreboard.js` must NOT substitute
> a constant; a missing comparator makes the gate `N/A`, never `±2`.
>
> **P2 — tap RPC vs proprietary.** `ON-input-manager` `gesture-tap` p50 ≤ `max(OFF-1,
> OFF-2)` + floor.
>
> **P3 — swipe RPC vs proprietary.** `ON-input-manager` `gesture-swipe` p50 ≤ `min(OFF-1,
> OFF-2)` + floor.
>
> **P4 — pinch RPC vs proprietary.** `ON-input-manager` `gesture-pinch` p50 ≤ `min(OFF-1,
> OFF-2)` + floor.
>
> **P5 — headline, vs proprietary (restates 3m G6).** `ON-input-manager`
> `tap+describe(settle:false)` p50 ÷ same-run OFF `tap+describe` p50 ≤ **1.15** against
> **each** of OFF-1, OFF-2 and their pooled p50.
>
> **P6 — no regression of the default.** `ON-input-manager` is not slower than
> `ON-uiautomation` by more than the floor on any of the four gated verbs.
>
> **P7 — landing and fallbacks.** First-attempt landing ≥ 95 % with the effect oracle on
> every block, oracle self-test passed, and **0** `input-manager` fallbacks; the
> `strategy` echo is recorded on **every** measured tap/swipe/gesture reply and the block
> reports `injectStrategyReported` as a count (`input-manager: n/n`), not a single probe.
>
> **P8 — fling instrument first, arms second.** The fling job runs `ON-uia-A` and
> `ON-uia-B` as two independent same-code arms, interleaved per sample. If
> `|A/B − 1| > 0.15` on any informative cell, the fling section is reported as
> **INSTRUMENT-UNRESOLVED** and no arm verdict — PASS or FAIL — is issued for any arm.
> Only if the A/B control holds are the arms graded under the 3k.1 rule, two-sided on
> `arm/off` (proprietary) with `arm/uia` reported for information only, informative =
> `q25(off) > 0.175 + eps` **or** `q25(uia) > 0.175 + eps`, graded against whichever
> reference is above the floor, n ≥ 10 per arm-cell. Fling is **not** a promotion blocker
> for run 2: the current default fails it too (run 34853156073: uia/off 0.680, 0.881,
> 0.703), so it cannot select between arms.
>
> **P9 — availability and portability.** `input-manager` resolves on the CI image with no
> `hidden_api_policy` write, AND the `uia-async` fallback is exercised at least once by a
> test that forces `InputManagerInjector.probe()` to fail, asserting
> `strategy == "unavailable"`, `fellBackTo == "uia-async"` and an unchanged outcome.
>
> **P10 — screen-graph.** Job green, store invariants OK, `skippedNoIdHash` reported
> alongside 34813849446 (0) and 34840929610, per-config success and tokens reported with
> the H4 paired-cluster intervals. A drop below the reference's 100/100 is reported, not
> called "undisturbed".
>
> **Promotion is P0–P7 + P9 + P10 all green.** P8 is reported, never gating. If P2–P6 are
> green the default becomes `input-manager` and scrcpy removal ships in the following PR.

### (c) Scoreboard rows allowed from this run

**May enter now (run 34853156073, head `46fb3f79`, x86_64/KVM GitHub runner):**

| row | statistic | N |
|---|---|---|
| Latency verb table, six blocks `OFF-1 / ON-uia-sync / ON-uia-async / ON-input-manager / ON-scrcpy / OFF-2` | p50/p95 ms, with the measured OFF↔OFF drift floors stated per verb (tap 0, describe 0, swipe 7, pinch 5, await-ui-element 4, await-screen-idle 5, `tap+describe` **103**) | 20 per verb per block |
| `input-manager` availability | the reflective `InputManager.injectInputEvent` (`InputManagerGlobal.getInstance()`, `INJECT_INPUT_EVENT_MODE_ASYNC`) resolved and ran on `system-images;android-34;google_apis;x86_64` with **no** `hidden_api_policy` change; must name the image | 1 post-loop probe + 6 device cases |
| Device-test outcome row | all six 3n cases PASS, `ranAs` == requested for all three strategies; 20-sample residual gate 0 ms idle / 5 ms after-tap (≤10) | 6 cases / 20 samples |
| dumpsys MotionEvent cadence, measurement-only | 8-frame wire gesture, N = 8 delivered, deliveredSpan 122 / 118 / 120 ms, MOVE intervals per strategy — explicitly **n = 1 gesture per strategy** | 1 |
| First-attempt landing | uia-sync 60/60, uia-async 60/60, input-manager 60/60, scrcpy 58/60, OFF-1 40/40, OFF-2 40/40; oracle self-test passed on every block. **No "better than scrcpy" wording** (Fisher p = 0.4958) | 40–60 per block |
| Screen-graph row for this run | success B1 100 / B2 97 / O1 99 / O2 100 / O3 99 / O4 98 / O5 98; tokens 657/646/138/54/627/21/22; H1 0.214× PASS, H2 0 FAIL / same-screen 1 PASS, H3 0.033× PASS, H4 none inferior vs B1 and B2; invariants OK; `skippedNoIdHash` **2**; O5 one-step 58/60 — **stated side by side with 34813849446's 100/100 · 0 · 60/60** | n = 155 steps, 100 runs, 20 task clusters |
| Process row | run conclusion `failure`, `run_attempt` 1, single failed step `16 Fling A/B`; screen-graph job success; three strategy arms self-orchestrated by `run-bench.js` (no `workflow` OAuth scope) | — |

**Must wait for run 2:**

- Any "`input-manager` is the default" / "scrcpy removed" row — no code change has shipped.
- **Any fling ratio or verdict for any arm**, including the scrcpy control's FAIL. The
  instrument has not been shown to reproduce itself (3N-H3), the reference arm is out vs
  proprietary (3N-H2), and the input-manager grading is not in any artifact (3N-M4). The
  fling status row stays **OPEN** with no new numbers.
- Any "input-manager is more reliable than scrcpy" row (3N-M3).
- Any tap / swipe / pinch **win vs proprietary** as a durable property — single run, no
  per-sample arrays, no CI (3N-H5). The table above is allowed as *this run's* numbers,
  not as a capability claim.
- The `tap+describe` / G6 reversal (3N-H1) — it is the biggest result in the run, but the
  OFF denominator moved 364/418 → 445/548 between runs and its own within-run drift is
  103 ms. Needs replication with `ON-uiautomation` present.
- Any statement that the default path is unchanged by 3n/3m.1 — no default latency block
  was run (3N-H4).
- Any `skippedNoIdHash` trend line — 34840929610's value is not recorded anywhere I could
  read.

## Unresolved within this review's scope

- `skippedNoIdHash` for run **34840929610** is not quoted in any doc, and that run's
  artifact was out of scope, so "2 vs 34840929610" could not be evaluated. Only
  "2 vs the reference's 0" is established.
- The `merge-fling.js` input-manager verdict string exists only in the job step log, which
  I did not fetch (artifact-only budget). The per-cell numbers were recomputed instead and
  match the Result.
- The Result's step numbers (11 / 14 / 15 / 16) were verified only at the level of "exactly
  one step failed, and it is the Fling A/B step" via the jobs API; the individual step
  names 11/14/15 were not cross-checked.
- Whether `UiAutomationConnection.injectInputEvent` issues `syncInputTransactions` per
  event on this image is an AOSP inference, not a measurement — it is the basis of fling
  candidate 2 and is exactly what the `uia-nowait` arm would settle.
