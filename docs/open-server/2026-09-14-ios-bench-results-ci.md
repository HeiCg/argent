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

_(run ids + per-run errors fixed verbatim recorded here as the run progresses.)_

### Scoreboard

_(scoreboard-ios.md pasted here after the green run: verb table per block, G2 Δ/CI/
verdicts, landing rates, optical scroll offsets, G4 tokens, G3 stage sums.)_

### Minutes used

_(from the run.)_

### Could not verify

_(anything the run did not establish.)_
