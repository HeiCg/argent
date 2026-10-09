# Scoreboard: open stack vs @swmansion/argent 0.27.0 (2026-10-08)

## Update after plan close-gaps-2026-10

Runs 37824312091, 37855208770 (Android ABBA), 37824322706 (screen graph
MULTIHOP + CHURN), 37824355475 (AndroidWorld), 37856050947 (iOS). Review:
`2026-10-review-close-gaps-runs.md`.

- **Android: faster on describe, pinch, paste and on reaching the correct
  screen; swipe inconclusive; tap slower.**
  - Describe is now a win in both runs (ON 41-46 ms vs OFF 52-63). The server
    warms its code with 40 discarded reads at start.
  - With `settle:true` on the tap, the agent reaches the correct screen in
    884 ms with 30/30 correct first reads, against 2585 ms for the official
    tap → await → describe in run 37824312091 (2.6-2.9× faster across the two
    runs).
  - Pinch+describe −566 to −588 ms (P4 PASS). Paste about 2× faster (no gate).
  - Swipe+describe P3 INCONCLUSIVE in both runs; swipe alone −32.8 ms in
    37824312091 and −3.6 ms, CI crossing 0, in 37855208770.
  - Tap is 2-5 ms slower (P2 NOT PASSED, then FAIL). In 37824312091 the
    screen-size read before each tap (1.3-1.6 ms) was most of the gap; the fix
    that removed it did not close the gap in 37855208770, a slower runner on a
    new APK. Hypothesis for the rest: the official tap may return on a local
    ack plus a 50 ms host sleep without waiting for the emulator (OFF tap stayed
    at 53 ms while OFF describe moved 52 → 62 ms); not established.
  - In one valid diagnostic block, the idle proprietary `simulator-server`
    raises the median screen transition by 717 ms (CI [602, 782]).
- **iOS: tap and describe within a few ms of the official stack; swipe no longer flings.** One block per
  arm (OFF-2 invalid). Tap 70 vs 68 ms, describe 246 vs 242 ms. Swipe 408 vs
  605 ms, but the gestures still differ (ON scrolls 301.7 pt, OFF 344.7 pt; the
  offset gate is missed), so the swipe times are not a like-for-like win.
  Before the fix ON scrolled 567 pt.
- **Screen graph: 100/100 success**, observation tokens 0.37×, RPCs 0.49×,
  wall 0.78× per 3-hop navigation when the target is known. Template search in
  long lists 4.4 s (was 8.7 s), 0 swipes with a gap (was 38-42 %).
  AndroidWorld still inconclusive (shallow tasks).

The sections below are the 2026-10-08 morning scoreboard, kept for reference.

Every number below was read by an independent reviewer with the raw artifacts.
Review: `2026-10-review-final-runs.md`. Plan: `docs/plans/2026-10-07-beat-official.md`.
Scope: GitHub-hosted runners only. Android latency and MULTIHOP = x86_64 KVM,
4 vCPU, swiftshader, emulator 36.4.10 (build 15004761) pinned. AndroidWorld
AW-2 ran on an unpinned emulator (37.2.12). iOS = macOS runner, Xcode 26.6,
iPhone 17 simulator. Not comparable to local arm64 / HVF numbers.

## Answer: better and faster than the official argent?

- **Android: faster end to end on swipe, pinch, paste and on reaching the right
  screen after a tap; two small losses.** Tap is 1.5 ms slower (CI [1.1, 2.0]) and describe is
  2.1 ms slower in this run (N=20, every block cold). Most of the after-tap gain
  comes from the stack: one diagnostic block (n=1, INVALID for an untimed
  connection drop) shows that the proprietary `simulator-server`, idle, slows
  the guest's screen transitions about 2× on its own. The driver code itself
  wins clearly only on pinch+describe; paste is mixed and first-read
  correctness with `describe settle:true` is stack plus the 500 ms cap.
- **iOS: parity, not yet better.** Tap and describe match the official stack
  through the product tools (sim-input input, open runner tree with more
  elements). Swipe is not yet comparable. XCUITest input is unusable.
- **Screen graph: cheaper navigation once the target is known**, not yet a
  proven agent-level win.

## Android (run 37694540212; ABBA, N=20, 3 OFF vs 3 ON blocks)

| verb (p50 ms)                                        | official | ours  | Δ                   | gate                           | attribution                                        |
| ---------------------------------------------------- | -------- | ----- | ------------------- | ------------------------------ | -------------------------------------------------- |
| describe                                             | 52.1     | 54.2  | +2.1                | none                           | driver (cold JIT on the first ~20 calls; see note) |
| tap                                                  | 52.9     | 54.4  | +1.5, CI [1.1, 2.0] | P2 NOT PASSED                  | driver                                             |
| swipe, gesture only                                  | 300      | 268   | −31                 | P3 part, win                   | stack                                              |
| swipe + describe                                     | 1285     | 1215  | −70, CI [−125, −15] | P3 INCONCLUSIVE (OFF variance) | stack                                              |
| pinch, gesture only                                  | 353      | 317   | −36                 | P4 part, win                   | driver + stack                                     |
| pinch + describe                                     | 1134     | 559   | −575                | P4 PASS                        | driver (~85 % survives the idle stream)            |
| paste                                                | 587      | 233   | −354                | none                           | mixed                                              |
| tap → await → describe, time to correct screen       | 2547     | 1480  | −1067               | P5 PASS                        | stack ~82 %, await algorithm 15-18 %, driver ~0    |
| first read correct after tap, `describe settle:true` | 0/30     | 28/30 | —                   | report only                    | stack + 500 ms cap                                 |
| wrong reads, await variant and plain describe        | 0/120    | 0/120 | —                   | P11 PASS                       | —                                                  |

Note on describe: in the reference run 37609765062 (N=40) ON describe reached
37 ms once warm (last 20 calls) against a flat 52.1 ms on OFF. That warm number
is from the other run, not from this one.

Not measured: `settle` on the action (`gesture-tap {settle:true}`), merged
after this run; the plan's target (≥ 90 % correct at first read on
`tap(settle)+describe`) is still open. The screen-graph churn bench (template
search p50 ≤ 4 s, swipes with a gap ≤ 5 % for `swipe-scroll-accessibility`)
was not run. Both checks move to step `measure-deferred` of
`docs/plans/2026-10-08-close-gaps.md` (amendment in the plan above).

## iOS (run 37699809946; 4/4 blocks valid, N=20)

| verb (p50 ms)  | official OFF-1 / OFF-2 | ours, sim-input | ours, XCUITest | reading                                                               |
| -------------- | ---------------------- | --------------- | -------------- | --------------------------------------------------------------------- |
| describe       | 198 / 372              | 199             | 203            | parity; ours returns 54-55 elements vs 30                             |
| tap            | 62 / 67                | 70              | 1002           | sim-input parity (Δ +6, CI [−2, 21])                                  |
| tap + describe | 1591 / 1741            | 1876            | 2015           | inconclusive within drift (Δ +250, CI [44, 410]; OFF drift floor 150) |
| swipe          | 655 / 479              | 347             | 1857           | not comparable: ours still flings (567 pt vs 345 pt)                  |

## Screen graph (run 37695643290, MULTIHOP, 5 Settings routes of 3 hops, 97 pairs)

| metric             | navigate-to (graph) | hop by hop | ratio                                                                               |
| ------------------ | ------------------- | ---------- | ----------------------------------------------------------------------------------- |
| tool calls         | 2                   | 6          | 0.33 (by construction)                                                              |
| observation tokens | 1403                | 3766       | 0.37 (CI 0.30-0.47)                                                                 |
| device RPCs        | 11.7                | 24.0       | 0.49                                                                                |
| wall ms            | 3696                | 4772       | 0.77                                                                                |
| success            | 97/100              | 100/100    | −3 pp; non-inferiority NOT met in the pre-registered strict form (lower bound −5.0) |

The target was supplied by the harness. It appears in the root summary in
2/100 samples (summary cap of 8). AndroidWorld AW-2 (5 shallow tasks, 1 seed):
inconclusive; `navigate_to` used once in 15 episodes and refused as ambiguous.

## Multi-device from one Claude session (delivered, unit-tested)

- `use-device {udid}` sets a per-session default; device ids become optional
  and are filled in; the last explicit id, `boot-device` or `use-device` wins;
  stopping the default clears it.
- `run-on-devices {udids[2..8], steps}` runs one sequence on several devices in
  parallel, serialised per device, with per-device results.
- Not yet exercised on several real devices in CI.

## Open defects that block a stronger claim

1. Screen graph: the launch screen is not recorded without a `describe` first,
   so the first hop is lost.
2. Screen graph: the summary cap hides depth ≥ 3 targets from the root; the AW
   agent prompt does not teach the hash8 address.
3. iOS sim-input: momentum-free swipe still flings on the simulator.
4. Android describe fallback returns HTTP 500 when the helper APK is absent and
   the open server holds UiAutomation.
5. Android `gesture-custom` falls back to the proprietary simulator-server on
   Linux (HTTP 500).
6. Fling defect D1 on the Android motion swipe (device test 3d still red).
7. Tap +1.5 ms on Android.
