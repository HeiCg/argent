# 2026-10-07 — iOS-4 plan: sim-input as the open product input path

Source: first VALID iOS simulator bench run 37572773799 (N=20, Xcode 26.6,
iOS 26.5, iPhone 17), researcher decomposition of `packages/ios-sim-input`,
`bench-ios-*.ts`, `ios-open-server-input.ts`. Tags: [art] artifact,
[code] verified in code, [est] estimate.

## Measured (p50 ms, OFF = proprietary simulator-server + ax-service)

| verb          | OFF-1 / OFF-2            | ON-xcuitest        | ON-siminput  |
| ------------- | ------------------------ | ------------------ | ------------ |
| describe      | 284 / 280                | 245                | 329          |
| gesture-tap   | 71 / 72                  | 4107               | 185 (min 72) |
| tap+describe  | 5051 / 4230              | 6963               | 5038         |
| gesture-swipe | 584 / 542                | 2719               | 1480         |
| await-\*      | 4252 / 2919, 4013 / 2708 | N/A (bench choice) | N/A          |

All four blocks VALID; landing 20/20 on sim-input; G1 red only by one
sim-input ack timeout outside timed samples and one n=19 verb.

Two instruments are broken [art]: (1) both ON arms' describe returned 3
elements / 551 bytes (Settings, Search) vs 30 on ax-service — the bench's
describe passes no bundleId (`bench-ios-open-vs-proprietary.ts:474-476`)
and the runner's target goes stale after each `simctl` relaunch; the
245 ms "win" is NOT like-for-like. (2) The optical scroll metric reads
±0.02 pt on every arm while the saved shots show a half-screen scroll.

## Where sim-input's time goes

- One long-lived Swift process per simulator, JSON lines on stdin, private
  SimulatorKit HID client called on the main thread
  (`IndigoHIDInput.swift:580-612`, `IOHIDDigitizerDispatch.swift:134-150`).
  No spawn per gesture (cached, `ios-sim-input-service.ts:156-162`). Ack =
  one stdout line after Up; the 5 s timeout lives only in the bench. [code]
- Tap hold is 50 ms on both sides (`IndigoHIDInput.swift:121`,
  `gesture-tap/index.ts:207,521`). 185 − 50 = ~135 ms over 2 HID messages,
  ~67 ms per message; JSON/pipe < 1 ms. Hypothesis: the send blocks the main
  thread until the simulator drains it. [est]
- Swipe: 10 linear moves at ~20 ms + 20 ms tail = 220 ms of sleep over 12
  messages, samples 1068-1986 ms, ~105 ms per message. Proprietary: 17
  frames at 16 ms, ease-out when `momentum:false`, ~18 ms per message. The
  sim-input arm never passes `momentum` (no wire field), so the two arms do
  different gestures. [code]
- Describe ON-siminput vs ON-xcuitest: same code path; runner capture is
  faster on the siminput arm (108 vs 125 ms); the +84 ms is host-side and
  not split by the artifact. [art]

## Tickets (dependency order)

1. Instrument sim-input: per-message receive / send-start / send-end / ack
   timestamps on the ack line; service and bench record host write→ack.
   Evidence: one CI run with per-sample breakdown.
2. Repair the instruments: bench describe passes the bundleId (or re-targets
   after relaunch); fix the optical scroll metric to match the saved shots.
   Evidence: ON describe ~30 elements; nonzero scroll offset on every arm.
3. If (1) confirms blocking sends: dedicated send queue with completion,
   clock-paced frames, ack on Up. Estimated tap 60-75 ms, swipe 260-300 ms.
4. Gesture parity on the wire: `holdMs`, `steps`, `momentumFree` (ease-out),
   trailing Move before Up, `clickCount` gap; fix `release`. Evidence: same
   scroll offset as OFF within IQR.
5. `ios-sim-input` registry service per simulator: start, crash-restart,
   per-call timeout that drops the pending entry, stop with the device,
   prebuilt binary. Unit tests with a fake spawn.
6. Route product tools under the flag: tap, swipe, keyboard ASCII text to
   sim-input, fallback to runner then simulator-server (visible, as #16).
   Physical devices stay excluded; index-targeted taps stay on the runner.
   Evidence: bench ON-siminput `inputIsProductTool=true`, 0 fallbacks.
7. Pinch over the wire via the existing two-finger helpers.
8. Bench measures ON await-\* through the real tools (needs 2); the open
   await path already routes to the open server via `describeIos`.

## Risks

- 10/20 → 20/20 landing came from the harness repair and a different tap
  point, not from a sim-input change (sources unchanged since import). [est]
- Private API + hard-coded byte offsets (0x6c/0x10c): any Xcode update can
  break it. Headless works (plain `simctl boot`, no Simulator.app). No TCC.
