# 2026-10-08 — plan: close the gaps the final runs found

Source: `docs/open-server/2026-10-review-final-runs.md` and
`docs/open-server/2026-10-scoreboard-vs-0.27.0.md`. Goal unchanged: beat
@swmansion/argent 0.27.0 on our bench, multi-device from one session, screen
graph navigation that an agent actually uses.

## Steps, by value per effort

1. **sg-launch-node** (screen graph, product). The recorder creates the source
   node of a recorded action when it is missing (from the before-fingerprint the
   tap already reads), so the launch screen enters the graph without a prior
   `describe`. Test: launch, tap, flush, no describe → edge kept, `navigate-to`
   from the launch screen plans. Bench: MULTIHOP rep 0 no longer fails. Also fix
   the non-inferiority test to the pre-registered strict form (`lo > -5`).
2. **sg-summary-reach** (screen graph, product). The `summary` lists the
   targets the agent most likely wants, not only the nearest: up to 8 lines, at
   most 4 at the smallest depth, the rest filled from deeper screens ordered by
   visits. A depth-3 target of a warmed route then appears from the root. The AW
   agent guideline teaches `navigate_to` by the hash8 shown in the summary and
   says the hops count is informative. Test: 6-route Settings graph, every
   depth-3 target listed from the root.
3. **ios-momentum-free** (iOS, product). Amendment 2026-10-08 (review round
   1): the ease-out has a fixed length in ms (not a share of the duration) so
   it holds from 150 ms to 300 ms swipes; the promotion gate is the bench
   optical offset of ON-siminput within 10 % of OFF's median (344.7 pt in run
   37699809946), IQR ≤ 15 % of the median; the official stack scrolls less than
   the finger path (slop and deceleration), so "equal to the finger path" is not
   the target. The simulator measurement happens in `measure-deferred`.
   Original text: The sim-input momentum-free swipe must
   stop where the finger lifts. Measure first on a simulator (optical offset
   vs finger path) with a slower end (ease-out over the last 30 % plus the end
   hold), then route `momentum:false` to sim-input by default only when the
   optical offset matches the finger path within 10 %. Bench: ON-siminput swipe
   offset equals OFF's (344.7 pt) within IQR.
4. **android-describe-fallback** (Android, product). When the open server holds
   UiAutomation, never fall back to `uiautomator dump`; retry the open-server
   read once and return a clear error. The dump path detects empty output.
   `gesture-custom` never falls back to the proprietary simulator-server on
   Linux; it returns the open-server error.
5. **fling-d1-ci** (Android, product). The held-swipe release with device
   evidence: device test 3d green and `releaseVelocityLsqPxPerS` below the fling
   threshold in CI.
6. **tap-latency** (Android, driver). Find the 1.5 ms on tap (ON 54.4 vs OFF
   52.8): profile the tap RPC path host and device side; warm the open server
   JIT at start (`cmd package compile -m speed`), which also removes the cold
   describe cost.
7. **bench-ios-runner** (harness). One resident XCUITest runner warmed outside
   the clock, ABBA order with 2 blocks per arm, timeout 600 s with one retry.
8. **aw-deep-tasks** (bench). An AndroidWorld subset with routes of 3 or more
   screens, 3 seeds, so AW-2 can measure what the graph is for.

9. **measure-deferred** (bench, carried from plan beat-official-2026-10). Two
   acceptance checks of that plan were not run and move here:
   - `settle-on-action`: the ABBA run must include `tap(settle)+describe`
     (merged in 6e3f1362, after run 37694540212). Target: correct at first
     read ≥ 90 % and time-to-correct ≤ the `tap+await-idle+describe` variant.
   - `swipe-scroll-accessibility`: the screen-graph churn bench
     (`blocks=CHURN`). Targets: template search p50 ≤ 4 s, swipes with a gap
     ≤ 5 %, success 37/37 kept.

Then rerun the CI benches with the emulator pinned (Android ABBA, iOS,
screen-graph MULTIHOP and CHURN, AndroidWorld) and update the scoreboard.
