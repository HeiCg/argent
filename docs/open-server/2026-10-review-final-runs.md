# 2026-10-08 — adversarial review of the final runs of plan beat-official-2026-10

Plan: `docs/plans/2026-10-07-beat-official.md`. Runs read here, each reviewed by
an independent reader with the raw artifacts and the source:

| run         | workflow                | commit   | emulator / Xcode          | validity                            |
| ----------- | ----------------------- | -------- | ------------------------- | ----------------------------------- |
| 37694540212 | Android ABBA latency    | 61b439c1 | pinned 15004761 (36.4.10) | 7/8 blocks valid (ON-im-bg INVALID) |
| 37695643290 | screen-graph MULTIHOP   | b0689edc | pinned 15004761           | valid, 1 task excluded by warm-up   |
| 37686064074 | AndroidWorld AW-2       | 61b439c1 | emulator latest (AW job)  | 15/15 episodes terminal             |
| 37699809946 | iOS open vs proprietary | b0689edc | Xcode 26.6                | 4/4 blocks valid                    |
| 37686041333 | iOS (first attempt)     | 61b439c1 | Xcode 26.6                | 2/4 valid (runner did not start)    |

Two runs died with qemu RSS at 14 GB (37686036860, 37686158727). Cause: the
dispatch left `emulator_build` empty and sdkmanager installed 37.2.12, which
leaks host memory at about 400 MB/min while the screen renders. The pinned
36.4.10 stayed between 5.9 and 6.8 GB for the whole ABBA run. Since b0689edc the
three Android workflows pin 15004761 by default; the latency and screen-graph
jobs fail an unpinned run, AndroidWorld only warns.

## Android ABBA 37694540212

Two premises were wrong and are corrected here. The run measured 61b439c1, not
the latest open/main, so `settle` on the action is not in it. The reference run
37609765062 ran N=40; this one ran N=20.

1. NOTE — no describe regression. ON describe p50 rose from 41-44 to 54 ms
   because N fell from 40 to 20. The open server is cold at the start of every
   block: in the reference run 37609765062 (N=40) ON-im-2 goes from 82 to 35 ms over 40 calls, all of it in `encodeMs`
   (`StateHandler.kt:287-299`). On the first 20 samples of the reference run ON
   describe was 52-54 ms, the same as now. Warm (reference run, last 20 calls), ON describe is 37 ms against a
   flat 52.1 ms on OFF (SD 0 in every block of both runs).
2. MAJOR (attribution) — the idle proprietary `simulator-server` alone makes the
   guest as slow as OFF. ON-im-bg (our stack plus that process spawned and never
   called): tap → transition finished 1235 ms (ON-im 573, OFF 1222),
   time-to-correct 2869 ms (ON-im 1480, OFF 2547), still-screen verbs unchanged
   (describe 54.2, await floor 314). qemu vCPU 84-91 % → 123 % while the server
   itself uses 0.6-1 %. The block is INVALID (a TCP abort in its untimed setup,
   41 s before the first timed marker; 0 timed fallbacks), so this is report
   only, n=1. It is consistent with run 37609765062 Part A.
3. P5 decomposition (sums close): OFF 2546.8 = 1222.5 transition + 500.4 await
   floor + 52.1 describe + 771.8 rest; ON 1479.5 = 573.2 + 311.3 + 54.2 + 540.8.
   Δ −1067: transition 61 %, await floor 18 %, rest 22 %, describe ~0.
   ON-hostawait (our stack, the host await algorithm) adds +157 ms
   time-to-correct and +176 ms floor: the algorithm is 15-18 % of Δ. The rest
   follows the stack (point 2).
4. P3 INCONCLUSIVE is variance, not effect. ON swipe+describe 1214.8 (was
   1216.8). OFF blocks 1295.7 / 1256.6 / 1302.5 (SD 24.8) with 3 vs 3 blocks at
   N=20 give CI [−125.5, −14.7]. Gesture alone −31.2 ms (was −31.3). In ON-im-bg
   the gesture alone is 299.8 ms, at OFF level: the swipe win is the stack's.
5. NOTE — ordering. Every ON-im block follows an OFF block; OFF-1, first after
   the probe, is the slowest OFF block in both runs. OFF tap+await SD 210 ms
   (was 63).
6. Open: the TCP abort in ON-im-bg; +40 ms on ON pinch+describe vs the previous
   run; +9 ms on the ON await floor; describe settle:true in ON-im-bg at 339 ms.

## Screen graph MULTIHOP 37695643290

1. MAJOR (product) — the launch screen is not a graph node unless the agent
   calls `describe` before its first tap. The recorder creates only the
   destination node (`screen-graph/recorder.ts:72-99`); only `describe` creates
   the current one (`describe/platforms/android/tiered.ts:97-98`); the store
   integrity check drops edges whose source is not a node
   (`screen-graph/store.ts:631-635`). So the warm-up never recorded hop 1. All 3
   graph failures are rep 0 with `no known path`, 0 hops, ~70 ms; the nograph arm
   warmed the root for every later rep. An agent that launches an app and taps
   without a describe first loses its first hop the same way.
2. MAJOR (gate) — non-inferiority is not met in the pre-registered form. The
   text says "stays above −5 pp"; the code tests `lo >= -5`
   (`screen-graph/bench/report.ts:344`); lo is exactly −5.0, a value that 5
   tasks produce by construction.
3. Cost claims stand with the target supplied by the harness: observation
   tokens 0.372× (task bootstrap 0.30-0.47), device RPCs 0.487×, wall 0.774×,
   tool calls 2 vs 6, n=97 pairs. `readsSkipped` 3 in 74/97 samples, 2 in 23/97.
   The nograph baseline does not pay the launch-screen read, so it is the
   conservative side.
4. Discovery claim: the target is in the root summary in 2/100 samples, both in
   rep 0 while the root still had 1-2 edges. In steady state 9 screens at 1-2
   hops fill the cap of 8 (`screen-graph/plan.ts:273`). `listedFromDepth` = 1 in
   the warm-up table is an artefact of point 1.

## AndroidWorld AW-2 37686064074

1. Inconclusive. Steps 0.857× and input tokens 0.847× come from one pair
   (SimpleCalendarDeleteOneEvent 6 vs 12 steps). Without it warm/cold is 1.04×
   steps and 1.23× tokens. The 5 tasks have complexity 1-1.2 and routes of 1-2
   screens, so ≤0.7× was out of reach by design.
2. `navigate_to` was called once in 15 episodes and was refused:
   `ambiguous target: 2 screens have the label "Stopwatch"`. The model took the
   label from the element list, not from the reachable list. The guideline
   (`bench/androidworld/tiered_agent.py:44-53`) does not teach the hash8 form.
3. MAJOR (product) — `describe` HTTP 500 "Failed to parse uiautomator dump
   output". Chain: open-server `getState` timed out at 10 s → the helper APK is
   not shipped in CI → fallback to `uiautomator dump`, which cannot connect
   while the open server holds UiAutomation (`describe/platforms/android/index.ts:163-169`)
   → the dump error check misses an empty output (`:383-399`) → the parser
   throws the generic message (`uiautomator-parser.ts:684-691`).
4. MINOR (product) — `gesture-custom` long press: when the open path fails it
   falls back to the proprietary simulator-server, which does not exist on Linux,
   and returns HTTP 500 (`gesture-custom/index.ts:296-313`).

## iOS 37699809946 (first run with 4/4 valid blocks)

p50 ms, OFF-1 / ON-xcuitest / ON-siminput / OFF-2:

| verb          | OFF-1 | ON-xcuitest | ON-siminput | OFF-2 | reading                                                               |
| ------------- | ----- | ----------- | ----------- | ----- | --------------------------------------------------------------------- |
| describe      | 198   | 203         | 199         | 372   | parity (OFF drifts 198 → 372)                                         |
| gesture-tap   | 62    | 1002        | 70          | 67    | sim-input parity (+6, CI [−2, 21]); XCUITest unusable                 |
| tap+describe  | 1591  | 2015        | 1876        | 1741  | inconclusive within drift (Δ +250, CI [44, 410]; OFF drift floor 150) |
| gesture-swipe | 655   | 1857        | 347         | 479   | NOT comparable (below)                                                |

1. MAJOR (product) — the momentum-free swipe on sim-input still flings. Both arms
   ask for `swipeMomentumFree`; OFF scrolls 344.7 pt with IQR 0; ON-siminput
   scrolls a median 567.3 pt with IQR 210 (finger path 437 pt). The end hold
   (`holdEndMs` 120, `ARGENT_SIM_INPUT_MOMENTUM_FREE=1`) does not stop inertia on
   the simulator. ON-xcuitest also scrolls 567.3 pt. Swipe latency is not a
   like-for-like comparison until the gestures match.
2. NOTE — describe compares two backends: ax-service (30 elements) vs the
   XCUITest runner (54-55 elements). Parity on latency with more elements.
3. Harness (fixed by this run, not by code): in 37686041333 the runner did not
   start within 300 s in 2/4 blocks (starts took 117-345 s; OFF-2 collided with
   a live xcodebuild of the previous block: `assert_no_runner` waits 30 s then
   `pkill` and `sleep 2`). This run started cleanly. Fix to keep it stable: one
   resident runner warmed outside the clock, or wait for the xcodebuild pid to
   exit plus `simctl bootstatus` before the next block, timeout 600 s with one
   retry.

## Verdict for the scoreboard

- Android: end-to-end faster than 0.27.0 on swipe, pinch, paste and tap →
  await → describe time-to-correct; first-read correctness with
  `describe settle:true` 28/30 vs 0/30. Two small losses: tap +1.5 ms (P2 NOT
  PASSED) and describe +2.1 ms (cold, N=20). Most of the transition and
  time-to-correct win follows the stack, not the driver code: one diagnostic
  block (n=1, INVALID for an untimed connection drop, report only) shows the
  idle proprietary screen stream slowing the guest's transitions about 2×.
- iOS: tap and describe at parity through product tools; swipe not comparable;
  XCUITest input unusable.
- Screen graph: one `navigate-to` costs 0.37× the observation tokens of
  hop-by-hop navigation when the target is known. Two product defects (launch
  screen, non-inferiority edge) and a discovery gap (summary cap) block a claim
  of agent-level benefit. AW-2 inconclusive.
