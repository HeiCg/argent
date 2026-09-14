# Decision doc — fling under-scroll: what to do next (owner decision, 2026-09-14)

## What is established (run 34813849446, consolidated base, reviewed)
- scrcpy fast-inject swipes under-scroll vs proprietary at 150/0.3, 400/0.3, 400/0.5
  (scrcpy/off 0.515 / 0.699 / 0.717, N = 12 per cell-arm, permutation p = 0.009 / 0.001
  / 0.001). Same in the byte-equal pre-3k `legacy` path. Host-side drift-corrected
  pacing changes nothing (paired p >= 0.13 every cell).
- UiAutomation (Kotlin server) sends the SAME 8-frame schedule and scrolls correctly
  (uia/off 1.037 at 400/0.3). The proprietary path sends 26 frames.
- Device-side arrival timing differs: for a 416 ms request the device sees 452 / 439 ms
  (scrcpy drift / legacy) vs 417 ms (uia), with a final inter-event gap of 46 / 35 ms vs
  17 ms (dumpsys input RecentQueue, N = 10, measurement-only). scrcpy-server stamps each
  MotionEvent with its arrival time (`SystemClock.uptimeMillis()` at socket receipt), so
  socket jitter lands in `eventTime` and the OS VelocityTracker reads a slower release.
  UiAutomation injects with times chosen on-device. This is the open lead, not a proven
  cause.
- Latency: scrcpy swipe RPC 259 ms vs uia 292 vs proprietary 296–300 (p50). A swipe that
  under-scrolls 30 % is not a like-for-like win; the scoreboard carries it as a win only
  on RPC time with the fling row OPEN next to it.

## Options
A. **Hybrid default (recommended now).** Route multi-frame gestures (swipe, momentum
   swipe) through the Kotlin UiAutomation path; keep scrcpy fast-inject for tap and
   pinch (both reviewed wins/parity, both land). Effect: swipe verdict becomes PARITY
   (292 vs 296–300), scroll fidelity restored (uia/off ≈ 1.0 on informative cells),
   fling gate expected green on the pre-registered rule. Cost: gives up ~35 ms on
   swipe RPC. Scope: one dispatch decision in `open-server-input.ts` + tests + one
   run. No velocity tuning.
B. **Device-stamped timeline through scrcpy.** Fork the scrcpy-server jar (Apache-2.0)
   so the control channel carries the host's intended `eventTime` offsets and the
   server injects with those times (or pre-buffers the whole timeline and replays it
   on-device). Keeps the scrcpy latency win if it works. Scope: Java change in a
   vendored server, build + ship the jar, protocol version guard, tests; two or three
   runs. Risk: the fork diverges from upstream 3.3.x.
C. **Do nothing, publish the loss.** Keep scrcpy swipe as is, scoreboard says
   "swipe RPC faster, scroll fidelity worse (OPEN)". Not recommended: the owner's goal
   is like-for-like wins.

## Recommendation
A now (one ticket, one run, closes the only red gate honestly), B as a research ticket
after the release, only if the swipe RPC delta matters to a user story. Whichever is
chosen, the measurement rule stays: pre-registered gate, both arms, interleaved,
adversarial review before the scoreboard.

## Also open on the consolidated base (separate ticket, investigation running)
`tap+describe(settle:false)` ON 505/529 vs OFF 354/297 (+150–230 ms, floor 57, n = 19):
new loss vs run 7's parity; root-cause doc `2026-09-14-tap-describe-loss-root-cause.md`.

## Decision taken (owner, 2026-09-14): option D — our Kotlin injector replaces scrcpy
Neither A nor B. The Kotlin server already injects device-timestamped timelines
(`MotionInjector`); the gap to scrcpy is ~25–35 ms of RPC latency, not fidelity. Ticket
`2026-09-14-open-server-phase3n-kotlin-injector-replaces-scrcpy.md`: strategies
`uia-sync | uia-async | input-manager`, pre-registered gates, scrcpy removed if one
passes. "Port scrcpy to Rust" answered: the device half must stay Java/Kotlin; we own
that process already.
