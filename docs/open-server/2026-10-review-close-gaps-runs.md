# 2026-10-08 — runs of plan close-gaps-2026-10 (step measure-deferred)

Plan: `docs/plans/2026-10-08-close-gaps.md`. Previous scoreboard and review:
`2026-10-scoreboard-vs-0.27.0.md`, `2026-10-review-final-runs.md`.

| run         | workflow                      | commit   | validity                                                                                           |
| ----------- | ----------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| 37824312091 | Android ABBA latency          | 7296b63c | 8/8 blocks valid; job red only from device test 3d (fling D1, known)                               |
| 37824322706 | screen-graph MULTIHOP + CHURN | 7296b63c | MULTIHOP and CHURN valid; job red only from E1-G5 "not measured" (needs MATRIX in the same run)    |
| 37824355475 | AndroidWorld AW-2             | 7296b63c | 15/15 episodes terminal                                                                            |
| 37824317476 | iOS                           | 7296b63c | cancelled at the 120 min job limit; reruns 37840591012 (ON-siminput INVALID) and 37856050947 below |
| 37855208770 | Android ABBA (APK v31)        | a37482c2 | 8/8 valid                                                                                          |
| 37856050947 | iOS (runner start retry)      | 8db728f9 | 3/4 valid (OFF-2 INVALID)                                                                          |

Emulator pinned to 15004761 on every Android run (default since b0689edc).

## Android ABBA 37824312091 (N=20, 3 OFF vs 3 ON blocks)

1. Describe is now a win. ON describe p50 41.0-44.3 ms vs OFF 52.0-55.0. The
   JIT warm-up (40 discarded reads, 1197.6 ms per start, measured apart and
   excluded from ON cold start) removes the cold first calls that made ON
   describe 54 ms in run 37694540212.
2. Tap: P2 Δ +2.1 ms, CI [0.5, 3.7], NOT PASSED. The tap-stage table: the `getScreenSize` read before each tap costs 1.3-1.6 ms
   (median per ON block), the tap RPC round trip 52.3-53.2 ms, device inject
   overhead 0.5-1.3 ms, device parse 0.2 ms. The instrumentation costs −0.1 to
   +1.1 ms (p50 with minus without timing, n=9-10 each). In this run the screen-size read is most of the gap. The fix that
   removed it (APK v31) did not close the gap in the follow-up run below.
3. Settle on the action meets its target. `tap(settle)+describe` on ON-im: 30/30
   correct at first read, time-to-correct p50 884.5 ms vs 1503.5 ms for
   `tap+await-idle+describe` on the same arm (MET). Against OFF's
   `tap+await-idle+describe` (2584.7 ms) it is 2.9× faster to the correct screen.
4. The stream causality arm is valid this time. ON-im-bg (our stack plus the
   proprietary `simulator-server` spawned idle) vs ON-im-1, within-block
   bootstrap, 1 block each: tap → first frame +242.5 ms [196, 264]; tap →
   transition finished +717 ms [602, 782.5]; time-to-correct +1130 ms
   [962, 1438]. With the idle proprietary process, our transition time
   (1156.5 ms) comes close to OFF's (1301 ms). One block per arm; this supports
   the attribution of run 37609765062 Part A to the proprietary
   `simulator-server` (its screen stream is the leading candidate), not to our
   driver.
5. Gates: P3 INCONCLUSIVE (swipe+describe Δ −100, CI [−208, 8]; gesture alone
   −32.8, CI [−49.9, −15.6], win). P4 PASS (pinch+describe −587.6; gesture alone
   −37.7). P5 PASS (time-to-correct −1085.6, CI [−1844, −327]; first read 60/60
   both arms). P11 PASS. P6 N/A (no ON-uia block).
6. P5 decomposition (sums close): OFF 2584.7 = 1301 transition + 497.9 await
   floor + 53 describe + 732.8 rest; ON 1499.1 = 580 + 312.5 + 43.1 + 563.5.

## Screen graph 37824322706

1. MULTIHOP: launch-node fix confirmed. Paired success 100/100 both arms
   (was 97/100 for graph), non-inferior in the strict form (Δ 0.0 pp, bootstrap
   0.0-0.0). Cost with the target supplied: observation tokens 0.370× (CI
   0.295-0.472), device RPCs 0.491×, wall 0.778×, tool calls 2 vs 6. One task
   still excluded by its warm-up (`mh-battery-saver-schedule`, hop 3 label
   "Set a schedule" not found on API 34).
2. CHURN (`swipe-scroll-accessibility` deferred check): template search p50
   4367 ms (target ≤ 4000: NOT MET, was 8700), attempts with gaps 0/40 (target
   ≤ 5 %: MET, was 38-42 %), success 36/36 present-only and 40/40 raw (kept).
   The comparator without store or template is 4689 ms with 0/40 gaps: both arms
   now use the accessibility scroll, so the template's own benefit is 7 %.
   Store growth, bytes and invariants (E1-G1, G2, G4) PASS.

## AndroidWorld 37824355475

Still inconclusive, as planned: steps warm/cold 1.0×, API input tokens 1.098×,
success warm 5/5 vs cold 4/5, `navigate_to` called 2 times in 15 episodes. The
tasks route over 1-2 screens; step `aw-deep-tasks` is the test that fits the
graph.

## Verdict

See the end of this document: the follow-up runs change the tap reading.

## Follow-up runs

### Android ABBA 37855208770 (APK v31, normalized gesture coordinates)

The `getScreenSize` read is gone (screen-size stage 0 ms in every ON block),
but the tap RPC round trip rose from 52.3-53.2 to 56.9-60.6 ms and P2 is a FAIL
(Δ +5.2 ms, CI [2.0, 8.4]). This runner was slower than the previous ones: OFF
describe, 52.0-55.0 ms in the earlier runs, is 61.4-63.4 ms here, while OFF
tap stays at 52.7-53.5 ms in both runs. Hypothesis: the proprietary
`gesture-tap` sends Down, sleeps 50 ms on the host and sends Up, waiting each
time for an ack from the local simulator-server (`gesture-tap/index.ts:619-638`);
if that ack does not wait for the emulator, the OFF tap is a host timer and
does not follow guest speed, while the open server replies after the device
injected the Up. The ack timing is documented only for the iOS simulator-server
(~0.06 ms, `simulator-client.ts:64`); the Android ack is inside the closed
binary. The RTT rise also coincides with the APK v30 → v31 change. About
3-5 ms of the ON round trip beyond hold, inject and parse is not explained.
Next check: v30 against v31 on one runner, and the Android ack timing. Describe
stays a win (ON 40.7-46.1 vs OFF 61.4-63.4), pinch+describe a win (P4 PASS).

### iOS 37856050947 (runner start retry, ease-out momentum-free swipe)

ON-siminput VALID; OFF-1 valid; OFF-2 INVALID (the runner did not start on
either attempt), so this is 1 block per arm.

| verb (p50 ms) | OFF-1 | ON-siminput | reading                        |
| ------------- | ----- | ----------- | ------------------------------ |
| describe      | 242   | 246         | within a few ms (1 block each) |
| gesture-tap   | 68    | 70          | within a few ms (1 block each) |
| tap+describe  | 1783  | 1974        | inconclusive (1 block each)    |
| gesture-swipe | 605   | 408         | ON faster by 197 ms            |

The ease-out stops the fling: ON-siminput scrolls a median 301.7 pt (IQR
301.7-364.0) against OFF 344.7 pt (IQR 0), down from 567.3 pt before. The
pre-registered promotion gate (within 10 % of OFF's median, IQR ≤ 15 %) is
missed by a small margin: −12.5 % and IQR 21 %. `momentum:false` stays behind
`ARGENT_SIM_INPUT_MOMENTUM_FREE` until a run meets the gate.

## Verdict (all runs of the plan)

- Android: describe, pinch+describe, paste (no gate) and time to the correct screen
  (P5; with `settle` on the tap, 2.6-2.9× faster than the official tap →
  await → describe) are wins. Swipe is inconclusive. Tap is 2-5 ms slower and
  its cause is not established.
- iOS: tap and describe within a few ms of OFF (1 block per arm, no CI); the momentum-free swipe no longer flings but
  still scrolls 12.5 % less than the official one; 1 block per arm.
- Screen graph: 100/100, 0.37× tokens per navigation with a known target;
  template search 4.4 s with no gaps (target 4 s missed).
- CHURN success is 40/40 raw. The "present-only" figure counts 36/36 because
  the presence sweeps missed 4 targets (Story 36-39) that the search still
  found; the 4 deliberately absent targets (Story 60-63) are a separate give-up
  test, all swept. The plan's 37/37 is the target the plan wrote; the present-only denominator
  depends on what the sweeps observe.
- AndroidWorld: inconclusive; the compact arm also hit one `describe` HTTP 500
  (uiautomator dump parse failure, defect 4 of the close-gaps plan).
