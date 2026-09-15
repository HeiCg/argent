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

_status: PENDING CI — filled from the run artifacts. The tables below are emitted
verbatim by `scoreboard-ios.js` from the merged JSON; the gate verdicts are from
`merge-blocks-ios.js`._

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

_(subsequent run ids appended as the runs progress.)_

### Scoreboard

_(scoreboard-ios.md pasted here after the green run: verb table per block, G2 Δ/CI/
verdicts, landing rates, optical scroll offsets, G4 tokens, G3 stage sums.)_

### Minutes used

_(from the run.)_

### Could not verify

_(anything the run did not establish.)_
