# Ticket: iOS-2 — like-for-like bench on the iOS Simulator (OFF closed server / ON-xcuitest / ON-siminput)

Spec: `2026-09-14-ios-open-driver-spec.md` (phase iOS-2). Base: `open/main` @ 7987d935
(iOS-1 merged: `packages/ios-device-server`, host blueprint behind
`open-ios-device-server`, workflow `ios-open-server-device-test.yml`, all green on run
34904275293 — read its `## Result` in `2026-09-14-ios-phase1-runner-on-contract.md`
for the CI recipe: Xcode 26.6 / iOS 26.5, newest `iPhone N` pick, root `tsc --build`,
runner + vitest in ONE step, env names without the `ARGENT_` prefix). Research with the
closed server's surface and the bench sketch: `2026-09-14-ios-open-driver-research.md`
(researcher 2 §C, §4, §5). Android bench to mirror: `packages/tool-server/scripts/
bench-open-vs-proprietary.ts`, `.github/bench-ci/{merge-blocks,scoreboard}.js`,
`.github/workflows/bench-open-vs-proprietary.yml`, rules in `README.md` and the 3k1/3n1
review findings (drift floors measured, per-sample arrays, bootstrap CIs, pre-registered
gates, same-run control, effect oracle outside the timed window, no censored metric).

## Arms
- **OFF-1 / OFF-2**: closed `simulator-server ios` + `ax-service` (the smoke workflow
  already downloads and runs them on `macos-latest` — reuse that recipe; the LICENSE
  forbids redistribution, so fetch at run time only).
- **ON-xcuitest**: iOS-1 runner (tree from `app.snapshot()`, input via XCUITest).
- **ON-siminput**: input via `tools/sim-input` from the owner's
  `/Users/heicg/Desktop/projects/device-farm/device-stream` (copy `tools/sim-input`
  verbatim into `packages/ios-sim-input/` with its Apache-2.0 provenance banner and
  `Package.swift`; build in CI with `swift build -c release` and `DEVELOPER_DIR` pinned as
  its `scripts/build-sim-input.sh` does; host driver = a port of
  `packages/ios-simulator/src/input-service.ts` (id-stamped JSONL over stdin/stdout)).
  Tree for this arm = the iOS-1 runner (input and tree are independent on iOS; describe
  is scored per TREE backend, never per input arm — say so in every table).

## Verbs (N = 20 per verb per block, p50/p95, per-sample arrays persisted)
describe (idle; tree backend `ax-service` vs XCUITest snapshot — two rows, not one),
gesture-tap (RPC), tap+describe(settle:false), gesture-swipe (250 ms), await-screen-idle,
await-ui-element. `paste` and `gesture-pinch`: no ON counterpart yet — print the row as
`N/A (iOS-4)`. Effect oracle for tap: neutral pixels via `xcrun simctl io <udid>
screenshot` before/after, polled OUTSIDE the timed window, plus the nav title from the
open tree; first-attempt verdict; landing rate per block with denominators. Scroll
metric for swipe: **optical** — strip cross-correlation between the pre- and post-swipe
simctl screenshots (pixel offset of the list region), never tree survivorship, no clamp;
report the raw offset distribution per arm with IQR (no ratio gate in this phase; the
fling gate is a 3o/iOS-3 concern).

## Pre-registered gates (write into `## Result` BEFORE the run; every gate vs the
proprietary blocks, measured floors from OFF-1↔OFF-2, bootstrap 95 % CI on the p50 Δ)
- G0 control: both OFF blocks and both ON arms present; oracle self-test passed per block.
- G1 landing ≥ 95 % first-attempt on every block; 0 runner crashes; 0 `sim-input` acks
  timed out.
- G2 report-only this phase: tap / swipe / await-* / describe Δ vs OFF with CIs and
  verdict at the floor (win / parity / loss); no promotion decision here.
- G3 `Σ(stages) ≈ captureMs` for the open tree (≤ 10 ms on 20 samples).
- G4 tokens: describe payload o200k tokens per tree backend at equal element cap
  (Android rule: state the cap and the denominator).
- G5 process: run id, `xcodebuild -version`, runtime, device type, minutes used, in the
  artifact and the results file header; each artifact file stamped with the run id.

## Deliverables
`packages/tool-server/scripts/bench-ios-open-vs-proprietary.ts` (mirror of the Android
script's block/verb/oracle/per-sample structure; iOS drivers behind one interface),
`.github/bench-ci/merge-blocks-ios.js` + scoreboard rows (or parametrise the Android
ones by platform — say which), `.github/workflows/bench-ios-open-vs-proprietary.yml`
(`workflow_dispatch`, `macos-latest`, `timeout-minutes: 90`, 10× minutes note, blocks
input default `OFF-1,ON-xcuitest,ON-siminput,OFF-2`), `packages/ios-sim-input/` +
host driver + unit tests (framing, ack queue), results file
`docs/open-server/2026-09-14-ios-bench-results-ci.md` with every number naming
statistic/block/N/run id, `## Result` on this ticket. Scoreboard untouched (planner
adds an iOS section after adversarial review).

## Constraints
Worktree `../argent-fork-wt-ios2` on branch `feat/ios-open-server-2-bench` off
`open/main` (never /tmp; root `node_modules` symlinked; no npm install / Xcode / swift
build / simulators locally — all in CI; vitest `--maxWorkers=2`). Budget: up to FOUR
CI runs (the first two will be harness shakedown; read the whole failing log between
runs and fix everything at once). Polling: one `gh run view` per 10 min as a single
`run_in_background` Bash call `sleep 540; gh run view <id> --json status,conclusion,jobs`;
never loop; one `gh run download` per artifact. Workflow dispatch from a feature branch
is not possible: use the temporary branch-scoped `push` trigger documented in the
iOS-1 Result and remove it in the last commit. Push over SSH. Do not touch the Android
bench files another agent (3n.3) is editing: `.github/bench-ci/merge-blocks.js`,
`scoreboard.js`, `bench-open-vs-proprietary.yml`, `bench-open-vs-proprietary.ts` — if
you parametrise by platform, do it in NEW files and leave the Android ones alone.

## Acceptance
One run with all four blocks complete, G0/G1/G3/G5 green, G2 and G4 reported with CIs
and floors, optical scroll offsets per arm, results file + Result written; adversarial
review before any iOS row enters the scoreboard.
