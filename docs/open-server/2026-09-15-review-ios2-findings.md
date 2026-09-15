# Adversarial review — iOS-2 simulator bench (run 34926722346)

Review of the iOS-2 like-for-like bench before any iOS row enters the shared scoreboard
(`2026-09-03-scoreboard.md`). Read-only: nothing in the branch, the worktree or the
artifact was modified; the only write is this file.

## Reviewed + evidence

- Subject: `feat/ios-open-server-2-bench` @ `1fcf112c` (now merged into `open/main` as
  `19890038`), worktree `/Users/heicg/Desktop/projects/argent-fork-wt-ios2`. Commits
  `91137053`…`1fcf112c`. **The published run was built from `ab05ce6a`**
  (`.bench-results/RUN_ID.txt`: `run_id=34926722346 attempt=1 sha=ab05ce6aa8a2…`);
  `1fcf112c` only removed the temporary push trigger and wrote the `## Result`.
- Results: `docs/open-server/2026-09-14-ios-bench-results-ci.md`;
  `## Result` + `### Outcome` on `docs/open-server/2026-09-14-ios-phase2-bench.md:86-150`
  (worktree copy). Context: `2026-09-14-ios-open-driver-spec.md`,
  `2026-09-14-ios-open-driver-research.md`, `2026-09-14-ios-phase1-runner-on-contract.md`,
  rules of evidence in `README.md:100-116`, `2026-09-14-review-3n1-findings.md`,
  `2026-09-14-review-3k1-findings.md`.
- Harness read in full: `packages/tool-server/scripts/bench-ios-open-vs-proprietary.ts`
  (1338 lines), `.github/bench-ci/merge-blocks-ios.js`, `.github/bench-ci/scoreboard-ios.js`,
  `.github/workflows/bench-ios-open-vs-proprietary.yml`,
  `packages/tool-server/src/utils/ios-sim-input-service.ts`,
  `packages/ios-sim-input/Sources/sim-input/{main,IndigoHIDInput,IOHIDDigitizerDispatch}.swift`,
  `packages/ios-device-server/ArgentRunner/ArgentRunnerUITests/ArgentRunnerSession+{Gestures,Snapshot,Commands}.swift`.
- GitHub calls (budget respected): **one** `gh run view 34926722346 --json jobs` and
  **one** `gh run download 34926722346 -n bench-ios-open-vs-proprietary`. The worktree has
  no `.bench-results/`.
- Recompute: every p50/p95 in both tables recomputed from the four
  `bench-block-*.json` `latencySamples`; every floor and every bootstrap CI recomputed
  independently in Python (20 000 draws, percentile, own seed 7); the Jaccard recomputed
  from the two `fidelitySet` arrays; the landing denominators recomputed from
  `effectCheckedTotal`/`firstTapNoEffectTotal`.
- Local check: `npx vitest run --maxWorkers=2
packages/tool-server/test/utils/ios-sim-input-service.test.ts` → **9/9 pass**.

### Numbers that reproduce exactly

Every cell of both published tables reproduces from the block JSONs, and both tables are
byte-identical to `.bench-results/scoreboard-ios.md` in the artifact — the "emitted
verbatim by `scoreboard-ios.js`" claim holds. Verb p50/p95 reproduce (describe
283/185/132/235, tap 66/1038/168/61, tap+describe 2649/2641/5694/4689, swipe
712/1613/1295/873, idle 573/728/803/747, await-ui-element 236/139/205/306). The six floors
reproduce (48 / 5 / 2040 / 161 / 174 / 70). Landing reproduces (20/20, 20/20, 10/20,
19/20). Jaccard reproduces exactly: |A∩B| = 31, |A∪B| = 36 → **0.861**; the difference is
`id:Toolbar`+`text:Toolbar` (ax-service only) vs `id:AdditionalDimmingOverlay`,
`id:Settings`, `id:chevron.forward` (XCUITest only) — i.e. the two backends see the same
**labels**; the 30-vs-54 element gap is structural nodes carrying no new identity. G4
tokens reproduce and are **byte-identical across both blocks of each backend** (2744 B /
1126 tok @ 30 el for ax-service in OFF-1 _and_ OFF-2; 4226 B / 1775 tok @ 54 el for
XCUITest in both ON blocks), so the token comparison is stable even though the samples are
42 minutes apart.

## VERDICT

**Report-only ACCEPT of a narrow subset; REJECT as a like-for-like latency comparison.**
The run is honestly reported at the level of "what the harness measured" — the gate
failure was not hidden, the tables are verbatim, and the numbers reproduce. But the
harness is **not like-for-like** on the axis that matters: the OFF arms are driven through
`registry.invokeTool` while both ON arms are driven **directly over the runner socket with
bench-local logic**, bypassing the tool layer the Android bench keeps identical on both
sides (IOS2-H1). On top of that, the two ON blocks run _identical code_ for describe and
await-\* yet differ by more than the OFF↔OFF drift floor, which by itself voids the two
published "win" verdicts (IOS2-H2). The three arms did not tap the same target (IOS2-H3),
the landing/oracle threshold is an order of magnitude below a real navigation, which made
G0 pass on a block whose tap almost certainly never navigated (IOS2-H4), and the optical
scroll metric is censored by construction and reported in the wrong unit (IOS2-H5).

The sim-input G1 failure is **real and not a fudge** — but it is also **not yet
characterised**: "50 %" is an upper bound on the true navigation rate, and the strongest
single datum in the artifact (this block's own self-test `navDiff = 0.0554` vs
0.1759–0.2376 everywhere else) says the arm did not navigate even on the iteration the
gate counted as a pass. Stopping at the 4-run budget with the exact error was the right
call. Do **not** spend another macOS run on the current harness.

## Gate status (recomputed)

| gate           | published               | this review                              | why                                                                                                                                          |
| -------------- | ----------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| G0 control     | GREEN                   | **AMBER — false pass on ON-siminput**    | threshold `navDiff ≥ 0.02` vs 0.176/0.176/0.238 on the healthy blocks; ON-siminput passed at **0.0554**, ≈ one table-row highlight (IOS2-H4) |
| G1 landing     | RED (ON-siminput 10/20) | **RED, and not comparable across arms**  | OFF and ON locate different targets (IOS2-H3); "landed" = ≥ 2 % pixels (IOS2-H4); `runnerCrashes` can never be non-zero (IOS2-M9)            |
| G2 report-only | reported                | **reported, 2 of 2 "win" verdicts void** | identical-code ON blocks drift more than the floor (IOS2-H2); ON bypasses the tool layer (IOS2-H1)                                           |
| G3 stage sums  | GREEN (0.002/0.003 ms)  | **vacuous**                              | `captureMs` encloses the three stages by construction (IOS2-M1)                                                                              |
| G4 tokens      | reported                | **usable, with caveats**                 | stable and reproducible; the "equal cap 400" never binds (IOS2-M5)                                                                           |
| G5 process     | present                 | **present, one number wrong**            | run 4 is 74.1 min wall, not ≈ 82; minutes are estimates, not billed data; the tested sha is absent from the results file (IOS2-M8)           |

## HIGH

### IOS2-H1 — the ON arms bypass the tool-server; the OFF arms do not. Every ON latency row is biased low and none of them measures the shipped path

`OffArm` drives everything through `createRegistry()` + `invokeTool`
(`bench-ios-open-vs-proprietary.ts:383-396,412-414,445-457`): zod parse, device
resolution, capability check, the tool body. Both ON arms talk to the runner socket
directly (`:612-613,681-683`, `IosOpenServerClient.request`) and, for describe, format the
tree **in the bench** (`:531-541`). The Android bench — the reviewed methodology this
ticket was told to mirror — drives _both_ arms through `reg.invokeTool` and flips
`open-device-server` underneath (`bench-open-vs-proprietary.ts:52-53,344,920,951`).

The iOS tool layer already has an open path behind the flag
(`tools/describe/platforms/ios/index.ts:142`, `tools/gesture-tap/index.ts:142`,
`utils/ios-open-server-input.ts:22-35`), so this was a choice, not a constraint. Two
consequences: (a) the ON−OFF Δ on describe (−71 / −124 ms) and await-ui-element
(−142 / −76 ms) contains an unmeasured, unbounded amount of tool-server overhead that only
the OFF side pays; (b) the numbers **do not describe what a user gets** — the shipped path
adds `openDeviceServerMutex.withDeviceLock` + `resolveService` + a `getScreenSize` per call
(`ios-open-server-input.ts:31-35`). The results file lists only the OFF-side caveats
(ack = acceptance, host-paced gestures — `2026-09-14-ios-bench-results-ci.md:19-22`) and
never states this one.

### IOS2-H2 — the two ON blocks run identical code and differ by more than the drift floor; both published "win" verdicts are block drift

`describe`, `await-screen-idle`, `await-ui-element` and the G3 stages are the **same
methods** on the same class for both ON arms (`OpenTree.describe/awaitIdle/awaitElement`,
`:531-596`, reached via `:615-617,653-658` and `:685-687,738-743`). The input arm cannot
affect them. Recomputed bootstrap CIs on the p50 difference (20 000 draws, seed 7):

| verb              | OFF-1 − OFF-2 (published floor) | CI95(OFF-1 − OFF-2) | ON-xcuitest − ON-siminput (identical code) | CI95           |
| ----------------- | ------------------------------- | ------------------- | ------------------------------------------ | -------------- |
| describe          | 48                              | (−21, 81)           | **+53**                                    | **(40, 91)**   |
| await-screen-idle | 174                             | (−213, −103)        | −75                                        | (−181, 45)     |
| await-ui-element  | 70                              | (−104, −18)         | **−66**                                    | **(−84, −54)** |

So for `describe` the ON↔ON drift on _identical code_ is 53 ms with a CI that excludes
zero — larger than the 48 ms OFF↔OFF floor the gate uses. The published table then reports
ON-xcuitest describe as **parity** (Δ −71, CI [−108, −24]) and ON-siminput describe as a
**win** (Δ −124, CI [−155, −102]) — two different verdicts for the same tree backend read
by the same code. The results file states the rule "describe is scored per TREE backend,
never per input arm" (`ios-bench-results-ci.md:29-31,180-182`) and then publishes two
describe rows per input arm with different verdicts; the G2 table contradicts the file's
own rule. The same applies to `await-ui-element`: identical code, **win** on one ON block
and **parity** on the other.

Neither "win" survives. The correct floor for an ON claim is `max(OFF↔OFF, ON↔ON)`, and
with an ON↔ON floor of 53 ms the describe CI [−108, −24] and [−155, −102] straddle or sit
close to it.

### IOS2-H3 — the three arms did not tap the same target; G1 landing is not comparable across arms

Two different locate implementations:

- OFF: `OffArm.locate` → `locateInDescribeText` (`:427-430,762-769`) — the **first**
  describe line containing `"General"` that carries a trailing `(x, y, w, h)` frame.
- ON: `OpenTree.locate` → `findTappableByLabel` (`:556-563,492-512`) — the **topmost**
  match with `hittable && onScreen`.

The artifact records coordinates only for _no-effect_ taps (`:919`), and those show the
two arms aiming at different places: every ON-siminput miss is `tap@(0.628,0.847)`, while
OFF-2's single miss is `tap@(0.500,0.096)` — top-centre of the screen, ~0.75 of a screen
height away from the ON target. Worse, `hittable` on the ON side is not XCUITest
hit-testing: the runner sets `hittable: snapshot.isEnabled && hasArea`
(`ArgentRunnerSession+Snapshot.swift:180`, comment at `:162` says "a heuristic"). So the
results file's refutation of the run-2 hypothesis — "that IS a valid, hittable, on-screen
General" (`ios-bench-results-ci.md:141-144`) — rests on a flag that means "enabled and
non-empty", not "hit-testable".

Consequences: G1 ("landing ≥ 95 % on every block") grades four blocks on **different
gestures against different targets**; the OFF 20/20 and 19/20 are not a baseline for the
ON 20/20 and 10/20. This violates the "symmetric gates / per-iteration untimed locate"
rule in `README.md:111-112`. It is also unverifiable after the fact: the per-iteration
coordinate is not persisted for landed taps, and the describe text is not persisted at all
(only `fidelitySet` + counts, `:1050,1136`), so the real frame of "General" in either
backend cannot be recovered from the artifact.

### IOS2-H4 — the effect threshold is an order of magnitude too low; G0 false-passed on ON-siminput and "50 % landing" is an upper bound

`landed` is `neutralPixelDiffRatio ≥ 0.02` (`:906`), and the G0 self-test passes on
`navDiff ≥ 0.02 && rootDiff < navDiff` (`:1093`). The artifact's own measurements of a
_real_ Settings→pane navigation are **0.1763 (OFF-1), 0.1759 (ON-xcuitest), 0.2376
(OFF-2)**. ON-siminput's self-test passed at **navDiff = 0.0554** — 3.2× smaller than any
other block, and almost exactly one table row of a 160-px raster (a row is ≈ 7 % of the
screen). `rootDiff` is exactly `0` on both ON arms, so the instrument is sensitive enough
to distinguish "nothing happened" — 0.0554 is a _real but sub-navigation_ change.

So (a) G0 GREEN on ON-siminput is a false pass: the gate certified an oracle on an
iteration that, on the evidence, produced a touch highlight and not a navigation; and
(b) the same 0.02 threshold defines the landing verdict, so the 10 "landed" taps may
include highlight-only events. **50 % is an upper bound on the sim-input navigation rate;
the true rate may be near zero.** The harness records only the boolean, never the ratio, so
this cannot be settled from the artifact — which is exactly the datum iOS-2.1 must persist.

### IOS2-H5 — the optical scroll metric is censored by construction, reported in the wrong unit, and its published explanations are unsupported

1. **Censored.** The dy search runs over `−maxShift … +maxShift` with
   `maxShift = (ry2 − ry1) / 2` (`:290`). With the region rows and the 160-px longest-side
   raster (`toBmp`, `:219`) that is ≈ 52 rows. A swipe that travels further than half the
   region has its true offset outside the search window, the best match is junk, the
   confidence test refuses it (`:320-322`) and it is dropped. That is the mechanism that
   fits the OFF pattern (18/20 and 19/20 refusals, with the _accepted_ values 58, 38, 41
   sitting just under the ceiling). The ticket pre-registered this metric as "no clamp"
   (`2026-09-14-ios-phase2-bench.md:36-40`); a half-region search window is a clamp.
2. **Wrong unit.** `dyPx` is rows of the **downscaled 160-px BMP**, not device pixels or
   points. The results file says the OFF swipes "moved the list ~38–41 px"
   (`ios-bench-results-ci.md:221-222`); in screen terms 38/160 of the height is ≈ 24 % of
   the screen ≈ 200 pt ≈ 600 device px. Off by a factor of ~5 (points) to ~15 (pixels).
3. **n = 1 and n = 2.** OFF-1's median/IQR rests on **two** accepted samples (58, 38) and
   OFF-2's median and "IQR 0" on **one** (41). Publishing an IQR over n = 2 and a median
   over n = 1 is below the bar the Android reviews set.
4. **Unsupported explanations.** "the closed server redraws chrome/status content that
   defeats the strip match" — the strip is the middle third of the columns over the region
   rows only (`:287-289`), and no evidence for chrome redraw exists in the artifact.
   "the root fits, or the momentum swipe under-travelled" for the 0-px ON result is
   **contradicted by the artifact**: both `fidelitySet`s contain
   `text:Vertical scroll bar, 2 pages`, i.e. both backends report the Settings root as
   scrollable, two pages long.
5. **Unverifiable.** No screenshots are in the artifact — `rmShot` deletes every PNG
   (`:197-206`) and the upload lists only `.bench-results` + three logs
   (`bench-ios-open-vs-proprietary.yml:247-251`). The swipe `from`/`to` and the per-arm
   `scrollRegion` are **not persisted** either (`ScrollResult`, `:946-955`), and the two
   arms compute the region from different sources (OFF from describe-text frames
   `:770-780`; ON from the tree's scroll container `:564-569`, **unclamped** — if a Table
   reports a content-sized frame, `y2/screenHeight` can exceed 1 and the swipe's start
   point lands off-screen). A degenerate or off-screen ON swipe is fully consistent with
   "0 px, 0 refusals, no error, non-trivial latency" and cannot be excluded from the
   artifact.

**The metric is not usable on iOS as configured.** No swipe/scroll row may be published,
and "the ON swipe does not scroll the Settings root" is not an established finding.

### IOS2-H6 — `tap+describe(settle:false)` is mislabelled on iOS and measures animation settling, not describe

`settle` is documented as **"Android open-server only"**
(`tools/describe/index.ts:65-72`). No arm passes it: `OffArm.describe()` calls
`describeText()` with no argument, and the parameter is dropped
(`:391-397,398-407`); the ON arms have no settle concept at all. The verb name is copied
from the Android bench and is false on iOS for all four blocks — in the block JSON, the
scoreboard, both published tables and the merge's `VERBS` list
(`merge-blocks-ios.js:21`).

What the timed window actually contains (`:1169-1181`; the `ensureRoot` setup is untimed):
`locate` + `tap` + `describe`. For OFF that is **two full describe round-trips** plus the
tap (`locate` is itself an `invokeTool("describe")`, `:427-430`); for ON, two
`getNestedState` calls plus the tap (which adds a third RPC, IOS2-M2). Subtracting the
measured per-verb p50s leaves ≈ 1.4 s of post-tap describe on ON-xcuitest and ≈ 5.4 s on
ON-siminput (arithmetic on p50s of different distributions — an inference, not a
per-iteration decomposition; the harness records no sub-timings). The mechanism is that
`app.snapshot()` waits for app quiescence (`snapshotRoot`, `Snapshot.swift:24-40`) and each
arm's tap returns at a different point of the transition: XCUITest's `coordinate.tap()`
blocks through the quiescence wait (`Gestures.swift:25-32`), so its snapshot starts after
the animation; sim-input returns in 168 ms and its snapshot lands _inside_ it. The row
therefore ranks arms by _where in the animation their tap returned_, not by describe cost.

### IOS2-H7 — `await-screen-idle` measures a drifted screen and fires blind taps, contradicting the harness's own stated rule

`timeTapEffect` states the rule: "A locate that fails EXCLUDES the iteration (never a
blind tap)" (`:865-866`). Two other verbs break it with `?? { x: 0.5, y: 0.3 }`:
`tap+describe` (`:1173`) and `await-screen-idle` (`:1195`). Worse, the `await-screen-idle`
loop calls `ensureRoot()` **once before the loop** (`:1188`) and never again, while its
per-iteration setup taps the target (`:1194-1197`). After iteration 1 navigates away, the
arm stays off-root for the remaining 19 iterations, `locate("General")` fails on the new
screen, and every subsequent setup is a blind tap at (0.5, 0.3) on whatever screen the arm
drifted to — a different drift path per arm, since the first tap target already differs
(IOS2-H3). The merge's degraded-arm check only looks for saturated latencies
(`:1200-1202,1210-1212`; `merge-blocks-ios.js:118-121`) and cannot see this.

## MEDIUM

### IOS2-M1 — G3 is a tautology

`captureStart` is taken immediately before `snapStart` and `captureMs` immediately after
`encodeMs`, with only assignments in between (`Snapshot.swift:56-71`). `Σ(stages) −
captureMs` can only ever be the few microseconds of bookkeeping, which is exactly what was
measured (0.002/0.003 ms). The gate verifies arithmetic, not instrumentation: it would stay
green if the stages were unrelated to the host-observed 132–185 ms describe. A meaningful
G3 compares Σstages to the **host-side RPC latency** (transport + serialize-to-wire
included).

### IOS2-M2 — an extra live RPC sits inside both ON arms' timed tap/swipe windows

`XcuitestArm.tap` and `SimInputArm.tap` call `tree.screenSize()` → `getScreenSize`, a real
socket round-trip (`ios-open-server-client.ts:154-156`), inside the timed window
(`:621-628,705-708,709-722`) — the OFF path passes normalized coords straight to the tool
(`:412-414`). The value was already available from the `locate` in the same iteration
(`st.info.screenWidth`, `:556-563`). For ON-siminput (p50 168 ms) this is a non-trivial
share. It mirrors the shipped path (`ios-open-server-input.ts:33-34`), so the right fix is
to publish _both_ — a cached-size row and a product-path row — not to leave it unstated.

### IOS2-M3 — the OFF baseline drifts significantly within the run; the pooled OFF p50 is a mixture and the floor carries no uncertainty

Blocks run strictly sequentially in one step, OFF-1 at 04:06:14Z → OFF-2 at 04:48:50Z
(`env.startedAt` per block; `bench-ios-open-vs-proprietary.yml:183-196`). OFF-2 is
uniformly worse (describe p95 590 vs 427, await-screen-idle p95 2674 vs 738, tap+describe
p50 4689 vs 2649). Recomputed CI95(OFF-1 − OFF-2) excludes zero on **three of six verbs**
(tap+describe (−2345, −1376), await-screen-idle (−213, −103), await-ui-element (−104,
−18)) — the "noise floor" is a real, signed degradation over 42 minutes, treated as noise.
Pooling then produces a bimodal baseline: the tap+describe pooled p50 3496 is neither
block's value, and the 2040 ms floor swallows every ON difference (both ON arms read
"parity" at Δ −855 and +2198). Separately, the floor is a bare `|p50₁ − p50₂|`
(`merge-blocks-ios.js:150`) with no CI of its own: the tap floor of **5 ms** sits inside an
OFF-drift CI of (−5, 22).

### IOS2-M4 — the merge has no gate on errors, short samples or notes

`merge-blocks-ios.js` gates G0/G1/G3 + gesture-param drift and nothing else. A verb that
errors 20/20 yields `latencySamples: []`, `p50: NaN`, and the merge happily reports it —
which is precisely what happened in run 1 (OFF `gesture-swipe` and `await-ui-element`
errored 20/20, `ios-bench-results-ci.md:97-100`) and was caught only by a human reading
the log. Add: `errors === 0`, `latencySamples.length === N`, `notes.length === 0`,
`locateFailedTotal === 0` per block per verb.

### IOS2-M5 — G4's "equal element cap" never binds and the per-element framing is inverted

`DESCRIBE_CAP = 400` (`:64`) against 30 and 54 elements — the cap is decorative; the
comparison is uncapped, with denominators differing 1.8×. The runner's own budget is 1500
(`Snapshot.swift:19,51`), so nothing truncated on either side. Per element the XCUITest
tree is **cheaper** (1775/54 = 32.9 tok/el vs 1126/30 = 37.5), the opposite of the
impression left by "The XCUITest tree is richer (more elements → more tokens)"
(`ios-bench-results-ci.md:231-232`). Also, `merge-blocks-ios.js:169-185` keeps the **first**
block per backend and silently drops the second sample; here they happened to be
byte-identical, so nothing was lost this run, but the merge never checks that.

### IOS2-M6 — `ensureRoot` is asymmetric, on exactly the variable the sim-input arm is sensitive to

OFF: `simctl terminate` + `simctl launch` + `sleep(900)` **plus an untimed
`await-screen-idle(2500)`** (`:435-438,791-804`). ON: `XCUIApplication.launch()` (which
resets state and waits for foreground, `Commands.swift:96-104`) + a bare `sleep(900)`
(`:644-647,729-732`). So only the OFF arm gets an idle check before the timed window, and
only the ON arms can start a gesture on a non-settled screen. The 300 ms render settle
added in run 4 (`:885-887`) is not equivalent — and note the sim-input landing went _down_
(70 % → 50 %) across that change.

### IOS2-M7 — the ON `await-*` rows measure bench code, not a product path

`OpenTree.awaitIdle` (version-counter poll, 120 ms granularity, 500 ms quiet window,
`:571-587`) and `OpenTree.awaitElement` (poll `getNestedState` until the label appears,
`:588-596`) are implemented **in the bench script**. The OFF side calls the real
`await-screen-idle` / `await-ui-element` tools (`:445-457`). The ON await-ui-element figure
is therefore "one tree read plus poll granularity" — which is why it tracks the describe
row — and the published "await-ui-element ON is faster (open host-poll vs the closed tool)"
(`ios-bench-results-ci.md:205-206`) compares a tool to a 15-line loop with no product
behind it.

### IOS2-M8 — cost accounting is estimated, one figure is wrong, and the tested sha is not in the results file

`gh run view 34926722346 --json jobs`: job `ios-bench` ran **2026-09-15T03:53:56Z →
05:08:04Z = 74.1 min** wall (bench step 04:05:04 → 05:07:34 = 62.5 min), not the "run 4
≈ 82 min" in `ios-bench-results-ci.md:246`. The billed figure for run 4 is 75 × 10 =
**750 minutes**. The totals for runs 1–3 ("≈ 90 / 85 / 90+", total "≈ 3450 billed") are
estimates from memory, not from the API, and are labelled as if measured — G5 asks for
"minutes used". Also: the results file names the branch base (`881fc69b`) but never the sha
the run was built from (`ab05ce6a`, in `RUN_ID.txt`).

### IOS2-M9 — "0 runner crashes on every block" is a constant, not an observation

`crashCount` is declared in both ON arms and **never incremented**
(`:610,663,679,748` — no assignment anywhere in the file). The G1 sub-gate
`runnerCrashes > 0` (`merge-blocks-ios.js:112`) can never fire, and the published claim
"0 runner crashes" (`ios-bench-results-ci.md:209-210`) carries no information. (The ack
counter is real: `ackTimeoutCount` increments at `:695`, and a process exit would reject
the pending promise and surface as a verb error — errors were 0, so the process did stay
alive.)

## LOW

- **IOS2-L1** — the results file says the tap oracle uses "neutral pixels … plus the nav
  title / version from the open tree" (`ios-bench-results-ci.md:38-41`, ticket line 34).
  `timeTapEffect` uses the pixel diff only (`:901-907`); no tree or version read happens in
  the effect check.
- **IOS2-L2** — `scoreboard-ios.js:149` labels identity-token counts as elements
  ("OFF elements 33, ON elements 34") two rows below the real element counts (30 / 54).
- **IOS2-L3** — `scoreboard-ios.js:138` emits `| block | samples | max |Σ−capture| (ms) |`
  with unescaped pipes: the G3 table has 5 header cells against a 3-cell separator and does
  not render in the job summary.
- **IOS2-L4** — the describe payload text is never persisted (only `fidelitySet` + counts,
  `:1050,1136`), so G4, the Jaccard and every locate coordinate are unauditable from the
  artifact.
- **IOS2-L5** — `p95` at N = 20 is the 19th order statistic (`pct`, `:86-90`), i.e. the
  second largest sample. Fine, but it should be labelled as such next to a p95 of 10376 ms.
- **IOS2-L6** — `WARMUP` was cut 3 → 1 between runs 2 and 4 (`ios-bench-results-ci.md:120-121`).
  Only run 4 is published so the run is internally consistent, but the parameter belongs in
  the published header (it is in `env.WARMUP`, not in the results file).
- **IOS2-L7** — `originLost` is computed, always 0, and published; the code says so
  (`:922-925`). Drop the field rather than publish a structural zero.

## sim-input landing diagnosis

**It is a genuine sim-input HID delivery/recognition failure, not a coordinate, scale or
normalisation bug — but the reported "50 %" is a harness artefact on top of it, and the
true navigation rate is probably far below 50 %.**

Ruled out (coordinate space / points vs pixels / screen scale): both ON arms normalise the
located centre by `st.info.screenWidth/Height` (`:556-563`) and denormalise with
`getScreenSize` (`:621-624,705-708`) — the same numbers from the same runner, in **points**
(`Snapshot.swift:80-88`, `getInfo` comment `:61-62`). `sim-input` divides by the supplied
`screenWidth/screenHeight` and clamps to 0..1 (`main.swift:85-89,107`,
`IndigoHIDInput.swift:117-118`), so any scale factor cancels identically; `info.scale` is
never read by either arm. Both arms therefore issue the same normalised point, and the
XCUITest arm navigates from it (self-test `navDiff = 0.1759`). _Caveat:_ "ON-xcuitest taps
that exact coordinate and lands 20/20" (`ios-bench-results-ci.md:141-144`) is an
**inference**, not artifact evidence — coordinates are recorded only for no-effect taps
(`:919`), so the 20 landed ON-xcuitest coordinates are not in the JSON.

Ruled out (wire / process): 20/20 taps returned `{ok:true}` with `errors = 0` and
`ackTimeouts = 0`. `IOHIDDigitizerDispatch.tap` returns false on any symbol-resolution or
event-build failure (`:84-89,134-151`), which would have surfaced as `ackErr` → a verb
error. So all 20 HID messages were built, patched and posted.

Causes, ranked:

1. **Touch delivered, tap not recognised (HID event timing/shape on iOS 26.5).** Best
   supported. The block's own self-test produced `navDiff = 0.0554` where every other block
   produced 0.176–0.238, with `rootDiff = 0` proving the instrument is sensitive — i.e. the
   HID touch perturbed roughly one table row's worth of pixels (a selection highlight)
   without completing a tap. Consistent with it, the post-tap `app.snapshot()` on this arm
   took ≈ 5.4 s p50 against ≈ 1.4 s on ON-xcuitest (IOS2-H6): XCUITest's quiescence wait
   was stalled by _something_ the touch started. Specific suspects inside the verbatim
   recipe, which the package README pins to **iOS 26.4** while the runner is **26.5 /
   Xcode 26.6**: the 50 ms hold (`max(0.02, holdSeconds)` with `holdSeconds = 0.05`,
   `IOHIDDigitizerDispatch.swift:86`, `IndigoHIDInput.swift:121`, `main.swift:107` passes
   `duration: 0`); the down and up events each taking a **fresh** `mach_absolute_time()` at
   build time (`IOHIDDigitizerDispatch.swift:172`) so the 50 ms separation may not be
   visible to the recogniser as hold time; and no range/hover-only event before the down
   (`.down` already carries Range|Touch|Position, `:66-72`).
2. **Measurement: the 0.02 landing threshold (IOS2-H4).** Certain as a defect, and it caps
   what can be concluded: "landed" includes highlight-class events, so 10/20 is an upper
   bound.
3. **Settle asymmetry (IOS2-M6).** sim-input is the only arm that can tap a non-idle
   screen. Contributing, not sufficient — the 300 ms settle added in run 4 coincided with
   the rate falling 70 % → 50 %.
4. **Contention with the resident XCUITest runner**, alive and holding the simulator's
   automation session across all four blocks (`bench-ios-open-vs-proprietary.yml:149-157`).
   Untested.

**The one discriminating test for iOS-4** (one short macOS job, ON-siminput only, no OFF
arms, no describe/swipe loops — ≈ 15 min wall / ≈ 150 billed minutes): locate the target
**once**, freeze the coordinate, then run 3 cells × 20 taps with
`holdSeconds ∈ {0.05, 0.15, 0.35}`, recording per tap the **maximum neutral-pixel diff
ratio** (a number, not a boolean), the coordinate, and the poll index — and keep the
before/after PNG pair for the highest- and lowest-ratio tap of each cell. Decision rule:
if the ratio distribution becomes bimodal at ≈ 0.18 and the landing rate rises with hold,
it is recogniser timing → fix the hold and the event timestamps; if ratios stay clustered
at 0.02–0.06 at every hold, the touch is delivered but never consumed as a tap → the event
recipe needs a 26.5 revision, which is the sim-input-depth work. Add one control cell of
20 XCUITest taps at the same frozen coordinate in the same job to anchor the
navigation-ratio scale.

## Scoreboard rows allowed

An **"iOS (simulator) — first like-for-like run, report-only"** section may be added to
`2026-09-03-scoreboard.md` with the rows below and no others. Every row must carry the
run id, N, block and statistic, and the section must open with the caveat block.

Required section preamble (verbatim):

> **iOS (simulator) — first like-for-like run, report-only.** Run **34926722346**
> (sha `ab05ce6a`), `macos-latest`, Xcode 26.6 (Build 17F113), iOS 26.5 simulator,
> iPhone 17, N = 20 per verb per block, blocks OFF-1 → ON-xcuitest → ON-siminput → OFF-2
> in one job. **Not a capability comparison:** the OFF arms are driven through the
> tool-server (`invokeTool`), both ON arms directly over the runner socket with
> bench-local logic, so every ON latency excludes the host tool layer. The three arms
> also acknowledge differently (closed server = acceptance; XCUITest = dispatched and
> quiescent; sim-input = HID message posted) and did not tap the same located target.
> No win/loss verdict from this run enters the scoreboard. Adversarial review:
> `2026-09-15-review-ios2-findings.md`.

Allowed rows:

1. **describe payload per TREE backend (G4).** ax-service **1126 o200k tokens @ 30
   elements**; XCUITest snapshot **1775 @ 54**; identical in both blocks of each backend;
   element cap 400 (never binding); per element 37.5 vs 32.9 tok/el. Idle Settings root.
2. **describe fidelity.** Jaccard **0.861** on id/text identity tokens, OFF-1 (ax-service,
   33 tokens) vs ON-xcuitest (XCUITest, 34); 31 shared, 2 OFF-only (`Toolbar`), 3 ON-only
   (`AdditionalDimmingOverlay`, `Settings`, `chevron.forward`). The backends see the same
   labels; the element gap is structural nodes.
3. **tap latency per arm, ack semantics stated, no verdict.** closed server 66 / 61 ms p50
   (OFF-1 / OFF-2, ack = acceptance) · open XCUITest **1038 ms p50** (blocks until
   dispatched _and_ the app is quiescent) · sim-input HID **168 ms p50** (ack = HID message
   posted; includes a mandatory 50 ms hold). Report the three numbers side by side with the
   three definitions; do **not** report the Δ or the "loss" verdicts.
4. **landing, ON-xcuitest and OFF only.** OFF-1 20/20, ON-xcuitest 20/20, OFF-2 19/20,
   first-attempt, effect = ≥ 2 % neutral-pixel change within 2.4 s of the tap, oracle
   polled outside the timed window — with the note that the OFF and ON arms located the
   target with different code, so the rates are per-arm, not a comparison.
5. **process (G5).** run id, sha, Xcode 26.6 (17F113), iOS 26.5,
   `SimDeviceType.iPhone-17`, N = 20, WARMUP = 1, tokenizer `js-tiktoken o200k_base`,
   **74.1 min wall / ≈ 750 billed minutes for this run** (runs 1–3 are estimates and are
   marked as such).

Must wait (no row):

- **The whole ON-siminput arm** — G1 red, and the failure is not yet characterised
  (IOS2-H4). Not even the fast tap latency belongs in a row of its own until the landing
  metric is repaired.
- **Every G2 Δ / CI / verdict**, including both "wins" (IOS2-H1, IOS2-H2).
- **describe latency** (185/132 vs 283/235) — identical-code ON drift exceeds the floor.
- **swipe latency and the optical scroll offsets** — censored metric, wrong unit, n = 1–2
  on OFF, unexplained 0 px on ON, no screenshots (IOS2-H5).
- **await-screen-idle and await-ui-element** — bench-local implementations on the ON side
  (IOS2-M7) and a drifted screen (IOS2-H7).
- **tap+describe** — mislabelled and measuring animation settling (IOS2-H6).
- **G3** — tautological (IOS2-M1). It may be mentioned as "stage instrumentation is
  internally consistent by construction", never as a green gate.

## iOS-2.1 change list (harness fixes; all of it before any further macOS run)

Ordered by what the next run's validity depends on. Items 1–6 are blocking.

1. **Same host layer on both sides (IOS2-H1).** Drive the ON arms through
   `setFlag("open-ios-device-server")` + `registry.invokeTool` for `describe`,
   `gesture-tap` and `screenshot`, as the Android bench does. Keep the direct socket only
   where no tool path exists, and label those rows "bench-local, no product path".
2. **Symmetric target (IOS2-H3).** One locate implementation for all arms. Compute the
   coordinate once per iteration from the ON tree, hand the same normalised point to every
   arm, and fail the block if the per-arm coordinates ever differ by more than a tolerance.
   Stop relying on the runner's `hittable` heuristic; if hit-testability matters, add a real
   `isHittable` field to the runner reply.
3. **Calibrated effect threshold (IOS2-H4).** Record the **ratio** per tap, not a boolean.
   Derive the landing threshold per block from the G0 self-test (`landed = ratio ≥ 0.5 ×
navDiff`), and raise G0 to require `navDiff ≥ 0.10` — the three healthy blocks were
   0.176–0.238; 0.0554 must fail.
4. **Persist per-iteration records.** Per tap: coordinate, ratio, poll index, latency,
   landed. Per swipe: `from`, `to`, the computed `scrollRegion`, the raw dy and the
   confidence. Keep 2–4 before/after PNG pairs per block in the artifact (the rest still
   deleted by `rmShot`). Persist the describe text used for G4/fidelity.
5. **Repair or drop the optical metric (IOS2-H5).** `maxShift = ry2 − ry1` (full region,
   no half-window), raster longest side ≥ 320, report the offset **in screen points** with
   the raster scale stated, clamp `scrollRegion` to [0, 1] and assert the swipe endpoints
   are on-screen. If it still refuses most samples, drop the row rather than publish n = 1.
6. **Fix the verbs (IOS2-H6, IOS2-H7).** Rename `tap+describe(settle:false)` →
   `tap+describe` (or thread a real iOS settle); record locate/tap/describe sub-timings
   inside the window; `ensureRoot()` per iteration in `await-screen-idle`; delete both
   `?? {x:0.5,y:0.3}` blind-tap fallbacks and count a locate failure as an excluded
   iteration everywhere.
7. **Floors and gates.** Compute an **ON↔ON drift floor** for every verb the two ON arms
   share, and grade G2 at `max(OFF↔OFF, ON↔ON)`; publish both. Bootstrap a CI on the floor
   itself rather than using a bare point estimate. Add merge gates for `errors === 0`,
   `latencySamples.length === N`, `notes.length === 0`, `locateFailedTotal === 0`.
8. **Symmetric settle (IOS2-M6).** The same pre-window settle on every arm — an idle check
   on both, or a fixed sleep on both, not one each.
9. **Timed-window hygiene (IOS2-M2).** Cache `getScreenSize` per block so the tap window is
   the tap; add a separate "product path" measurement if the shipped per-call
   `getScreenSize` is to be represented.
10. **G3 (IOS2-M1).** Compare Σstages against the **host-observed** RPC latency, or drop
    the gate.
11. **Real crash detection (IOS2-M9).** Watch the runner process / socket and increment
    `crashCount`, or delete the field and the gate clause.
12. **Reporting (IOS2-M8, IOS2-L1…L7).** Put the tested sha and `WARMUP` in the results
    header; take minutes from `gh run view --json jobs` and label estimates as estimates;
    fix the two `scoreboard-ios.js` caption/escaping defects; drop the nav-title claim from
    the oracle description; drop `originLost`.
13. **Cost discipline.** Land 1–12, then validate with a **single-block** dry run
    (`BENCH_ONLY=ON-xcuitest`, `BENCH_N=5`) before spending a four-block run. The iOS-4
    sim-input discriminating test above is a separate, short job and should not be bundled
    into the bench run.
