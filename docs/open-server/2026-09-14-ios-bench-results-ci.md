# iOS-2 like-for-like bench — results (CI)

Ticket: `2026-09-14-ios-phase2-bench.md`. Branch `feat/ios-open-server-2-bench` off
`open/main` @ 881fc69b, worktree `../argent-fork-wt-ios2`. Workflow
`.github/workflows/bench-ios-open-vs-proprietary.yml` (`macos-latest`,
`timeout-minutes: 90`; **macOS bills at 10× Linux minutes**). Bench script
`packages/tool-server/scripts/bench-ios-open-vs-proprietary.ts`; merge/gates
`.github/bench-ci/merge-blocks-ios.js`; scoreboard `.github/bench-ci/scoreboard-ios.js`.

Every number below names the **statistic / block / N / run id**. No number is
published to the shared scoreboard (`2026-09-03-scoreboard.md`) — the planner adds
the iOS section there after adversarial review (ticket Deliverables).

## Arms (three iOS drivers behind one `Arm` interface)

- **OFF-1 / OFF-2** — the closed `simulator-server ios` + `ax-service`, driven
  through the tool-server registry (`createRegistry()` + `invokeTool`, flag
  `open-ios-device-server` OFF). Fetched at run time by the workflow
  (`download-simulator-server.sh` + `download-native-binaries.sh`), never
  committed (LICENSE forbids redistribution). Its ack is acceptance not effect and
  its gesture timelines are host-paced — the same like-for-like caveats as
  Android's proprietary path. Tree backend = **ax-service**.
- **ON-xcuitest** — the iOS-1 open XCUITest runner reached directly over its NDJSON
  socket (`IosOpenServerClient`, port from `IOS_OPEN_SERVER_PORT`): tree from
  `app.snapshot()` AND input via XCUITest. Tree backend = **XCUITest snapshot**.
- **ON-siminput** — the SAME runner tree (XCUITest snapshot), input via the
  `sim-input` HID digitizer (`packages/ios-sim-input/`, built with `swift build
  -c release` and a pinned `DEVELOPER_DIR`) driven by the host driver
  `IosSimInputService`. Input and tree are independent on iOS: **describe is scored
  per TREE backend (ax-service vs XCUITest snapshot), never per input arm** — every
  table says so, and ON-xcuitest / ON-siminput share the one XCUITest describe row.

## Verbs (N = 20 per verb per block, p50/p95, per-sample arrays persisted)

describe (idle; two TREE-backend rows), gesture-tap (effect-checked),
tap+describe(settle:false), gesture-swipe (250 ms), await-screen-idle,
await-ui-element. `paste` and `gesture-pinch` have no ON counterpart yet → printed
as **`N/A (iOS-4)`**. Effect oracle for tap = neutral pixels via `xcrun simctl io
<udid> screenshot` before/after, polled OUTSIDE the timed window, plus the nav
title / version from the open tree; first-attempt verdict; landing rate per block
with denominators. Scroll metric for swipe = **optical** strip cross-correlation
between the pre/post-swipe simctl screenshots (pixel offset of the list region),
never tree survivorship, no clamp; raw offset distribution per arm with IQR and a
confidence-refusal count (no ratio gate this phase — the fling gate is 3o/iOS-3).

## Pre-registered gates (written BEFORE the run; every gate vs the proprietary blocks, floors from OFF-1↔OFF-2, bootstrap 95 % CI on the p50 Δ)

- **G0 control** — both OFF blocks and both ON arms present; the tap effect oracle
  self-test passed per block (one detected+restored navigation before the timed
  loop: navDiff ≥ 0.02 AND BACK restores the root, rootDiff < navDiff). FATAL.
- **G1 landing** — first-attempt landing ≥ 95 % on every block; 0 runner crashes;
  0 `sim-input` acks timed out. FATAL.
- **G2 report-only** — tap / swipe / await-* / describe Δ vs pooled OFF with a
  bootstrap 95 % CI on the p50 Δ and a verdict at the OFF-1↔OFF-2 drift floor
  (win = CI entirely below −floor; loss = entirely above +floor; else parity). NO
  promotion decision here — reported, not gated.
- **G3 stage sums** — `Σ(stages) ≈ captureMs` for the open tree (`snapshotMs +
  serializeMs + encodeMs` vs `captureMs`), ≤ 10 ms on 20 samples per ON block.
  FATAL on the ON (XCUITest) blocks; N/A on the ax-service blocks (no stages).
- **G4 tokens** — describe payload o200k tokens per TREE backend at an equal
  element cap (default 400): the cap AND the per-backend element count
  (denominator) are stated. Reported, not gated.
- **G5 process** — run id, `xcodebuild -version`, runtime, device type, minutes
  used in the artifact and this file's header; each artifact file stamped with the
  run id (`RUN_ID.txt`; JSON carries `env.runId`; md/txt get a `run_id` banner).

## Result

_status: DONE (4 runs) — G0/G3/G5 green, G2/G4 reported; **G1 red on ON-siminput
(50 % landing)**, a genuine sim-input HID reliability limit on iOS 26.5 / Xcode
26.6 (recipe verified on 26.4). Final run **34926722346**. Stopped at the 4-run
budget per the ticket. The tables below are emitted verbatim by `scoreboard-ios.js`
from the merged JSON; gate verdicts from `merge-blocks-ios.js`._

### CI runs

Environment (all runs): **Xcode 26.6 (Build 17F113), iOS 26.5 simulator,
iPhone 17** (`com.apple.CoreSimulator.SimDeviceType.iPhone-17`). Tokenizer
`js-tiktoken o200k_base`. macOS bills at 10× minutes.

- **34907978510** (run 1) — harness shakedown; all four blocks completed and
  merged (Set up → build sim-input → runner build all GREEN; the closed
  simulator-server + ax-service downloaded fine), but the merge failed 2
  pre-registered gates and surfaced four bugs, fixed together:
  1. `G0`: `OFF-1 (self-test threw: Command failed: xcrun simctl io <udid>
     screenshot ...)` — a transient `simctl io` blip on the first shot. Fix:
     retry `simctlScreenshot` up to 3×.
  2. `G0`: `ON-xcuitest (navDiff=0.1689 rootDiff=0.1689 ...)` and
     `ON-siminput (navDiff=0.0511 rootDiff=0.0521 ...)` — `navDiff==rootDiff`
     means `goBack()` (a tap at the top-left chevron) did NOT navigate back on
     iOS. Fix: `goBack()` relaunches Settings (the only reliable iOS root
     restore); drop the redundant per-iteration trailing restore.
  3. `G1`: `landing 60.0% < 95% on ON-siminput (12/20)` — cascaded from the
     broken back (iterations were measured, but the short effect-poll window
     also under-counted slow sim-input navigations). Fix: goBack→relaunch and
     widen the effect poll to 3×800 ms.
  4. `gesture-swipe` errored 20/20 on OFF (`n=0, err=20`) — the tool takes
     `fromX/fromY/toX/toY`, not `startX/endX`. `await-ui-element` errored 20/20
     on OFF — the tool takes `{condition, selector:{text}}`, not `{label}`.
     Fixes applied verbatim. Also: OFF-1's G4 describe sample was 0 elements
     (ax-service cold before injection; OFF-2 recovered 29) → warm up describe
     until non-empty before the G4 sample. Also cut the tap effect poll from
     ~15 screenshots/iteration to ≤3 and shrank the diff raster (160 px) so the
     bench fits the 90-min cap comfortably (run 1's bench step took ~70 min).
  G3 was GREEN in run 1 (Σstages−captureMs max 0.008/0.009 ms over 20 samples);
  G4/G2/scoreboard all rendered with real numbers.

- **34914794345** (run 2) — all four blocks completed and merged. **G0 GREEN**
  (every block's oracle self-test passed — the goBack→relaunch fix worked;
  rootDiff 0 on ON arms), **G3 GREEN** (ON stageMaxDelta 0.003 ms/20 samples),
  OFF-1 warmed to 20/20 and its ax-service describe recovered, OFF gesture-swipe
  + await-ui-element no longer error. **Only remaining failure: G1 landing 70 %
  on ON-siminput (14/20).** Root cause found in the block JSON: all 6 no-effect
  taps were the SAME coordinate `(0.628, 0.847)` — the bottom of the screen.
  `findByLabel` returned the DFS-first "General", which is sometimes an
  offscreen / non-hittable table cell (XCUITest reports below-the-fold cells with
  bottom bounds). XCUITest's own coordinate tap still changed the screen there
  (so ON-xcuitest read 20/20, masking it), but the sim-input HID tap on a
  non-hittable spot did nothing → no-effect. Fix: `findTappableByLabel` prefers a
  `hittable`, on-screen, topmost match; WARMUP trimmed 3→1 for runtime margin
  (run 2's bench step finished at ~72 min, under the 90-min cap).

- **34920382022** (run 3, locate fix) — the bench step **completed failure** (the
  merge threw on a gate), but the job then **hung in the "Stop the runner and
  simulator" post-step** on a bare `xcrun simctl shutdown` (the XCUITest runner
  still held the sim). Because the `if: always()` Upload step ran AFTER Stop, no
  artifact uploaded and the run had to be cancelled — its merge.log/scoreboard
  were lost (a cancelled run's step logs come back empty). Fixes for run 4:
  guard every teardown command with `timeout` and **upload the artifact BEFORE
  teardown**; the bench now deletes each screenshot right after its diff
  (`rmShot`) so `build/shots` no longer accumulates thousands of files (which
  also slowed the upload); a brief render settle before each HID tap. So run 4 is
  guaranteed to produce a readable artifact whatever the gate outcome.

- **34926722346** (run 4, FINAL) — all four blocks completed, merged, and the
  artifact uploaded cleanly (the teardown-hang + upload-order fix worked).
  **G0 GREEN** (every block's oracle self-test passed), **G3 GREEN**
  (Σstages−captureMs max **0.002 / 0.003 ms** over 20 samples), OFF-1 20/20,
  OFF-2 19/20, ON-xcuitest 20/20. **The one remaining failure is G1: ON-siminput
  first-attempt landing 50 % (10/20).** Characterization from the block JSON:
  every no-effect tap is the SAME located coordinate `(0.628, 0.847)` — and that
  IS a valid, hittable, on-screen "General" (ON-xcuitest, using the identical
  locate + tree, taps that exact coordinate and lands **20/20**). So the miss is
  NOT a coordinate/locate bug (the run-2 "offscreen cell" hypothesis was wrong —
  `findTappableByLabel` returns the same element, which XCUITest taps fine). It is
  the **sim-input HID digitizer tap itself failing to register ~half the time** on
  this **iOS 26.5 / Xcode 26.6** simulator. The `sim-input` provenance banner
  states the recipe was verified on **iOS 26.4 / Xcode 26** — a plausible timing
  drift on the newer runtime. This is a genuine ON-siminput input-arm limitation,
  not a fudgeable number; it is exactly the sim-input-depth work scoped to iOS-4.

**Budget exhausted (4 of 4 runs). STOPPING with the exact error, per the ticket:**

```
PRE-REGISTERED GATE FAILURES (G0/G1/G3 + drift):
  ✗ G1: landing 50.0% < 95% on ON-siminput (10/20)
Error: iOS bench gates failed: 1 violation(s)
```

### Scoreboard (run 34926722346, Xcode 26.6 / iOS 26.5 / iPhone 17, N = 20)

Emitted verbatim by `scoreboard-ios.js` from the merged JSON. Gate verdicts from
`merge-blocks-ios.js`: **G0 GREEN · G1 RED (ON-siminput 50 %) · G2 reported ·
G3 GREEN · G4 reported · G5 present.** Not entered into the shared scoreboard —
the planner adds the iOS section after adversarial review, and G1 is red.

**Verb latency per block (p50 / p95 ms; describe scored per TREE backend):**

| verb | OFF-1 (ax-service) | ON-xcuitest (xcuitest) | ON-siminput (xcuitest) | OFF-2 (ax-service) |
|---|---|---|---|---|
| describe | 283/427 | 185/252 | 132/154 | 235/590 |
| gesture-tap | 66/114 | 1038/1632 | 168/200 | 61/138 |
| tap+describe(settle:false) | 2649/4821 | 2641/3085 | 5694/6670 | 4689/10376 |
| gesture-swipe | 712/1094 | 1613/1771 | 1295/1475 | 873/1922 |
| await-screen-idle | 573/738 | 728/863 | 803/1105 | 747/2674 |
| await-ui-element | 236/395 | 139/197 | 205/281 | 306/478 |
| paste | N/A (iOS-4) | N/A (iOS-4) | N/A (iOS-4) | N/A (iOS-4) |
| gesture-pinch | N/A (iOS-4) | N/A (iOS-4) | N/A (iOS-4) | N/A (iOS-4) |

describe has TWO tree-backend rows: ax-service (OFF) vs XCUITest snapshot (both
ON arms share it — ON-siminput is NOT a separate describe row).

**G2 (report-only) — Δ vs pooled OFF per verb, drift floor, bootstrap 95 % CI on the p50 Δ, verdict:**

| verb | OFF p50 (OFF-1/OFF-2) | floor | arm | ON p50 | Δ | CI95 | verdict |
|---|---|---|---|---|---|---|---|
| describe | 256 (283/235) | 48 | ON-xcuitest | 185 | −71 | [−108, −24] | parity |
|  |  |  | ON-siminput | 132 | −124 | [−155, −102] | **win** |
| gesture-tap | 63 (66/61) | 5 | ON-xcuitest | 1038 | +975 | [815, 1067] | **loss** |
|  |  |  | ON-siminput | 168 | +105 | [73, 124] | **loss** |
| tap+describe(settle:false) | 3496 (2649/4689) | 2040 | ON-xcuitest | 2641 | −855 | [−2103, −198] | parity |
|  |  |  | ON-siminput | 5694 | +2198 | [1055, 2863] | parity |
| gesture-swipe | 783 (712/873) | 161 | ON-xcuitest | 1613 | +830 | [703, 946] | **loss** |
|  |  |  | ON-siminput | 1295 | +512 | [365, 602] | **loss** |
| await-screen-idle | 698 (573/747) | 174 | ON-xcuitest | 728 | +30 | [−71, 159] | parity |
|  |  |  | ON-siminput | 803 | +105 | [55, 184] | parity |
| await-ui-element | 281 (236/306) | 70 | ON-xcuitest | 139 | −142 | [−173, −125] | **win** |
|  |  |  | ON-siminput | 205 | −76 | [−105, −55] | parity |

_G2 is report-only (no promotion). The floors are wide on some verbs (OFF-1↔OFF-2
drift is large for the closed server — tap+describe floor 2040 ms), which is why
several ON differences read parity despite large Δ. Notable like-for-like: the
closed server's tap is fastest (host-paced ack, 63 ms); the XCUITest tap is slow
(1038 ms, XCUITest gesture overhead); the sim-input HID tap is fast (168 ms) but
lands only 50 % (G1). ON describe is faster than ax-service; await-ui-element ON
is faster (open host-poll vs the closed tool)._

**G1 first-attempt landing (denominators):** OFF-1 20/20 (100 %) · ON-xcuitest
20/20 (100 %) · **ON-siminput 10/20 (50 %) — RED** · OFF-2 19/20 (95 %). 0 runner
crashes, 0 sim-input ack timeouts on every block.

**Optical scroll offset per arm (strip cross-correlation, px, no clamp):**

| block | median dyPx | IQR (q1–q3) | confidence refusals | n accepted |
|---|---|---|---|---|
| OFF-1 | 38 | 38–58 (IQR 20) | 18 | 2 |
| ON-xcuitest | 0 | 0–0 (IQR 0) | 0 | 20 |
| ON-siminput | 0 | 0–0 (IQR 0) | 0 | 20 |
| OFF-2 | 41 | 41–41 (IQR 0) | 19 | 1 |

_The closed-server (OFF) swipes moved the list ~38–41 px but the cross-correlation
was ambiguous on 18–19 of 20 (the closed server redraws chrome/status content that
defeats the strip match) — only 1–2 accepted. Both ON arms register 0 px with 0
refusals: the XCUITest / sim-input swipe on the Settings root did not scroll the
list (the root fits, or the momentum swipe under-travelled). Report-only, no ratio
gate this phase (the fling gate is 3o/iOS-3); the 0-offset ON result is itself the
finding to carry into iOS-3._

**G4 tokens per TREE backend at the equal element cap (cap = 400):** ax-service
1126 tokens @ 30 elements (denominator); XCUITest snapshot 1775 tokens @ 54
elements. o200k. The XCUITest tree is richer (more elements → more tokens) at the
idle Settings root.

**G3 stage sums (Σstages ≈ captureMs on the open tree):** ON-xcuitest max |Σ−capture|
= **0.003 ms** / 20 samples; ON-siminput **0.002 ms** / 20 samples. Well within
the ≤ 10 ms floor.

**Fidelity — OFF-1 (ax-service) vs ON-xcuitest (XCUITest) describe identity:**
Jaccard **0.861** (ax-service 33 vs XCUITest 34 id/text tokens) — the two tree
backends see nearly the same Settings-root elements.

### Minutes used

macOS runner, billed at **10× minutes**. Four runs, each `timeout-minutes: 90`:
run 1 ≈ 90 min (bench step ~70 min then gate fail), run 2 ≈ 85 min, run 3
cancelled after the teardown hang (~90+ min of runner wall clock), run 4 ≈ 82 min.
Total ≈ **345 wall-clock runner minutes ≈ 3450 billed minutes** across the four
runs. The screenshot-heavy neutral-pixel oracle + per-iteration relaunch dominate;
`build/shots` cleanup (run 4) fixed disk/upload, not wall clock.

### Outcome

Acceptance is **NOT fully met**: G0/G3/G5 green and G2/G4 reported with CIs/floors
and optical scroll offsets, but **G1 is red on ON-siminput (50 % landing)**. The
open XCUITest arm (ON-xcuitest) is fully green (20/20 landing, oracle, stages) and
is a valid like-for-like arm; the sim-input HID input arm is not yet reliable on
iOS 26.5 / Xcode 26.6. No iOS row enters the shared scoreboard (that awaits
adversarial review and, for the sim-input arm, a landing fix).

### Could not verify

- **G1 for ON-siminput** — sim-input HID taps land only 50 % first-attempt on this
  runtime (the recipe is verified on iOS 26.4 / Xcode 26). The exact HID-timing
  cause is not isolatable without a local simulator (unavailable per resource
  policy); it is the sim-input-depth work scoped to **iOS-4**.
- **A green four-block run** — not achieved within the 4-run budget; the blocker is
  the sim-input landing, above, not the harness (which is otherwise green).
- **Physical-device arms** — out of scope (hosted runners have no iPhone; iOS-4).
