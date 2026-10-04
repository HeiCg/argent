# iOS bench: harness repair (2026-10-04)

Branch `fix/ios-bench-harness`, stacked on #12 (bench emulator diagnostics), #11 (simslim)
and #10 (re-baseline 0.27). Workflow `bench-ios-open-vs-proprietary.yml`.

## Runs

| Run         | Sha        | Harness                                   | Conclusion | Gate violations |
| ----------- | ---------- | ----------------------------------------- | ---------- | --------------- |
| 34914794345 | `489596c1` | iOS-2 bring-up                            | failure    | —               |
| 34920382022 | `2ceb94d9` | iOS-2 bring-up                            | cancelled  | —               |
| 34926722346 | `ab05ce6a` | previous harness (published figures)      | failure    | 1               |
| 37213144359 | `2eb893cf` | like-for-like rewrite `3f3ecdea`, 1st run | failure    | 32              |

No run of this workflow has concluded `success`. 34926722346 failed one gate:
`G1: landing 50.0% < 95% on ON-siminput (10/20)`. Commit `3f3ecdea` (2026-09-15) rewrote
the harness and first ran in CI on 2026-10-04 (37213144359).

## Defects in run 37213144359

1. **No target app on the runner.** G0 failed in all four blocks, the proprietary OFF-1
   included: `self-test threw: no target app set; call launchApp first (e.g.
com.apple.Preferences)` (raised by `ArgentRunnerSession+Commands.swift:44`). The oracle
   called `getNestedState()` with no bundle id, every arm's `ensureRoot` was a simctl
   relaunch, and nothing called `launchApp`. The ON describe hit the same error inside
   the tool layer: `[describe-ios] open ios-device-server failed, falling back to
ax-service: no target app set`. The product `launch-app` tool launches through simctl
   and does not set the runner's target either.
2. **Two XCUITest runners on one simulator.** The workflow started a resident runner
   (port 50727) for the oracle; with the flag on, `describe` made the tool layer start a
   second one (port 64039) from the same project and bundle id. Resident runner log:
   `Restarting after unexpected exit, crash, or test timeout`, `Executed 0 tests`, then
   `** TEST EXECUTE FAILED **` at 16:01:46. Bench log: `connect ECONNREFUSED
127.0.0.1:64039` on every later describe, `connect ECONNREFUSED 127.0.0.1:50727` in
   the G0 notes of ON-xcuitest, ON-siminput and OFF-2. Simulator after it: `Process
spawn via launchd failed because device is not booted` / `Bad or unknown session`
   (16:11:32, 16:21:36).
3. **Fallbacks counted as open-driver numbers.** ON-xcuitest reported
   `describeTokens=1126@30el` under `backend=xcuitest` with `describe.source=ax-service`
   (the backend label was fixed per arm). All 20 gesture-swipe samples logged
   `[gesture-swipe] ios open-device-server failed, falling back to simulator-server` and
   were recorded as n=20 open-driver latencies (p50 654 ms). Only a block note flagged the
   describe; no gate saw the swipe.
4. **"crashes" were connection errors.** `crashes=66` (ON-xcuitest) and `88`
   (ON-siminput) counted `isConnectionError` hits, not app crashes.
5. **Blank swipe "before" frames.** Settings was still rendering after the fixed 900 ms
   relaunch settle: 6 of the 9 kept `swipe-*-before.png` (OFF-1 3/3, ON-xcuitest 2/3,
   ON-siminput 1/3) show only the status bar on an empty background, 72-74 KB against
   364-479 KB for rendered frames.

## What changed

- **One runner per simulator.** The job starts no resident runner. The oracle reads the
  tree through the tool layer's own runner, resolved from the block's registry
  (`scripts/bench-ios-harness.ts` `toolLayerRunner`), so with the flag on it is the
  instance `describe` / `gesture-*` use. With the flag off the measured tools stay on
  simulator-server + ax-service and the runner serves only the oracle: the same
  instrument in all four blocks. No product code changed. A warm step builds and starts
  that runner once before the blocks and shuts it down; the step checks between blocks
  that no `xcodebuild test-without-building` / `ArgentRunnerUITests-Runner` process
  survived (`build/runner-processes.log`), and kills a survivor with a warning.
- **Target app.** Every block calls the product `launch-app` tool, then `launchApp`
  (Settings) on the runner, before any tree read. Oracle reads pass `bundleId`, so a
  simctl relaunch never leaves them without a target.
- **Serving path per sample.** Every measured describe / gesture sample records `servedBy`:
  the describe `source`; for gestures the injector, from the tool layer's fallback note
  (`simulator-server` when one was logged during the call). ON-siminput records
  `sim-input`.
- **Fail-closed validity** (`.github/bench-ci/ios-validity.js`). A block is INVALID when
  a sample crossed to the other arm's path, a measured sample has no recorded path, the
  oracle self-test failed, `connectionErrors > 0`, or simulator-server was not ready (OFF).
  The block's backend label is derived from the observed sources. INVALID blocks render
  as `INVALID (<reasons>)` with no latency, landing or scroll numbers and stay out of
  G2, G4 and fidelity; the merge writes its artifacts, then exits non-zero.
- **`connectionErrors`** replaces `runnerCrashes` in the block JSON and the scoreboard
  (the old key is still read); the first message is quoted. A tool-layer runner that
  restarts or terminates mid-block counts as one.
- **Swipe settle.** Before each "before" frame: one oracle tree read, then simctl frames
  every 250 ms until two consecutive ones are byte-identical, at most 5 s. Untimed;
  `settleMs` / `settleStable` per swipe, totals in `scroll.settle`.
- **Job timeout** 90 → 120 min (37213144359 took 79 min with every block failing fast).

Unchanged: measured verbs, N, statistics, thresholds, simslim input and behaviour,
proprietary provenance recording, triggers.

## Expectations for the next run (pre-registered)

Stock (`slim=false`), default blocks and N:

1. G0 oracle self-test passes in all four blocks.
2. Zero samples on the proprietary path in ON-xcuitest and ON-siminput; zero samples on
   the open path in OFF-1 and OFF-2.
3. `connectionErrors = 0` in every block; one runner start per block; no runner process
   survives a block.
4. simulator-server ready in both OFF blocks.

Not verifiable before a macOS run: runner start time per block, the settle wait
distribution, total job time against the 120 min timeout.

## Result

TODO(run-id)
