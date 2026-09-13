# Ticket: open-server phase 3e — last latency residuals (tap +8 ms, transitional describe +148 ms)

Repo: ARGENT FORK checkout
`/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-p3`,
branch `feat/android-open-server` @ 19597050 (pushed). Commit locally; do
not push. AVD `bench-api35` (`-grpc 8554 -grpc-use-token`); never
`ZF524RZBHD`. The screen-graph Phase C agent owns the AVD right now — do all
code + unit tests first, then poll `adb devices` every 60 s (≤ 60 min) until
`emulator-5554` is gone before booting your own.

Scoreboard after 3d (p50 ms, OFF/ON): pinch 362/341, swipe 301/281,
await-idle 524/526, await-ui 80/82, describe 87/89 (tokens identical), paste
100/110, tap 54/62, tap+describe settle:false 138/286 (OFF stale 75–85%),
settle:true —/684 (fresh 100%). Two residuals remain.

## R1 gesture-tap +8 ms
Measured on-device: DOWN inject p50 14 ms, sync UP p50 10 ms, hold 50 ms.
OFF is 54 = 50 hold + ~2 transport + ~2 inject. Ours: 50 + 14 + 10 ≈ 62+.
- Make the final UP `sync=false` for `tap` too (keep 50 ms hold; UP is
  queued before the RPC returns; ordering vs a following describe is
  preserved by the input dispatcher + describe's own tree read — verify
  with the existing "tap then describe sees navigation" device test and the
  A.1 outcome test). If a following `getNestedState` could observe the
  pre-UP state, add a cheap `uiAutomation.waitForIdle(0, 50)`-free
  guarantee: have `StateHandler` first drain pending injected events by
  injecting a no-op `sync=true` only when an async UP is outstanding
  (track a volatile flag in `MotionInjector`).
- DOWN 14 ms p50 (occasional 400 ms stall): investigate whether the first
  event after idle pays a wake-up cost; if `injectInputEvent(sync=false)`
  for DOWN is safe (it is — ordering is preserved), make DOWN async as well
  and only sync when the caller asks for an outcome.
Target: gesture-tap ON ≤ OFF + 2 ms; A.1/3b device tests still green.

## R2 tap+describe settle:false 286 vs 138
`captureMs` ~179 vs proprietary `getHierarchy` ~76 during the transition;
idle screen capture is 12–15 ms. During a navigation there are 2+ windows
(outgoing activity, incoming, possibly a transient overlay); we serialize
ALL windows nested (phase-3 token-parity decision, needed for the IME
window on the search screen).
- Serialize the active window fully; for non-active windows serialize only
  if they are `TYPE_INPUT_METHOD` or `TYPE_SYSTEM`/dialog-like
  (`AccessibilityWindowInfo.type`), skipping other `TYPE_APPLICATION`
  windows that are not active (the outgoing activity during a transition).
  Keep the golden tests (Settings root, search+IME, dialog) byte-identical;
  add a golden for "two application windows, one inactive" asserting the
  inactive one is dropped.
- Measure `captureMs` split per window (log in the report) to confirm the
  outgoing window was the cost; if the residual is the active window's own
  size mid-animation, report the number and stop (no importance pruning in
  this ticket).
Target: tap+describe settle:false ON ≤ 1.3× OFF; tokens identical; goldens
green.

## R3 paste +10 ms
The clipboard attempt (fails on API 35 from instrumentation) costs one RPC
before the type fallback. Cache the "clipboard unsupported" result per
server session after the first failure so subsequent pastes go straight to
typing. Target: paste ON ≤ OFF + 3 ms.

## Bench + report
Re-run the like-for-like bench (N=20, OFF-1/ON/OFF-2, all verbs incl.
tap+describe settle:false/true) and append a "v6 / phase 3e" section to
`/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-02-open-vs-proprietary-results-v4.md`
with the final scoreboard and a one-paragraph verdict in PR-ready wording
(claims only what the numbers support). Tear the emulator down.
