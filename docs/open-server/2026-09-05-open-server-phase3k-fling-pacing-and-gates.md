# Ticket: phase 3k — scrcpy fling pacing (long-duration momentum deficit) + bench gate hardening

Repo: ARGENT FORK. Code branch from `feat/android-open-server-final` (head after the
consolidation), CI branch from `feat/bench-ci-final`. Worktrees `argent-final` /
`argent-final-ci`. NO local emulator/adb; CI only; one `gh run view` per 10 minutes in
the foreground (`sleep 540` in the same Bash call), never a background monitor.
Read first: `2026-09-03-review-final-findings.md` (F2, F4–F7, F9–F16, F19) and
`2026-09-03-open-vs-proprietary-results-final-ci.md`.

## A. The real loss: scrcpy under-scrolls at long durations
Evidence (runs 33963464784 and 33975063607, scroll-distance ratio vs proprietary):
400 ms/0.3 → 0.66 / 0.64; 400 ms/0.5 → 0.57 / 0.58; 150 ms cells at parity;
deficit monotone in duration. Inferred mechanism (verify first): `gesture-swipe`
builds `round(duration/16)` frames (gesture-swipe/index.ts:177); the scrcpy backend
paces them HOST-side, awaiting one `injectTouch` write per frame over the socket
(scrcpy-inject-backend.ts:306-326, `MOMENTUM_STEP_MS` 16 in scrcpy-inject-timeline.ts:109),
so 26 frames at 400 ms stretch the gesture and lower the release velocity;
UiAutomation and the proprietary path hand the whole gesture to the device in one call.
1. Measure before changing: log per frame the intended `tMs` vs the actual wall-clock
   write time and the total gesture wall time for 150/250/400 ms swipes (host side),
   plus `MotionEvent` eventTime deltas from logcat (InputDispatcher verbose, device
   test step) — prove the stretch.
2. Fix candidates, in order: (a) schedule frame writes on a drift-corrected timer and
   do not await the socket per frame (write all frames whose `tMs` has elapsed, keep
   the DOWN→UP total equal to `duration`), verifying the server injects in order;
   (b) if the socket/adb hop still stretches, send the whole timeline to the device
   and inject it there with device-side timestamps (a small on-device "timeline"
   message in the Kotlin server used by the scrcpy backend for MOVE frames, or fall
   back to the Kotlin swipe for durations ≥ 250 ms and say so); (c) tune release
   velocity only if (a)/(b) leave a residual and only symmetrically.
3. Acceptance: all six informative cells within ±0.15 of the proprietary reference in
   one run, no whitelist; the gate's whitelist (merge-fling.js:57-60) removed.

## B. Bench honesty items queued by the final review (no numbers change)
- F7: log the no-effect iteration's identity (block, verb, iteration, before/after
  fingerprints, timings) and capture logcat during bench blocks, so a 59/60 can be
  diagnosed.
- F4/F9: fling gate — whitelist gets value bounds or is removed (see A.3); cells
  with either arm pinned at the 0.175 metric floor are excluded, not counted as parity.
- F5/F6: `locateVia` printed per block in the scoreboard; the dump short-circuit is a
  logged, gated event; state that locate is per-backend and the fingerprint is not.
- F12/F13: per-block ready gate blocking (no `|| true`); a missing OFF baseline fails
  the run instead of a warning.
- F19: `destinationVisible` probe locates fresh per iteration or is removed; an
  all-zero oracle-adjacent probe must fail loudly.
- Gates never observed to fire: unit tests in `.github/bench-ci/` for tap-timeline
  parity, oracle self-test, vacuous-arm, degraded-arm, redir, zero-fallback and the
  device-test enforcement step (a forced failure in a throwaway run is acceptable
  evidence for the last one).
- F3: scoreboard.js prints "at parity" when a difference does not clear the OFF-1/OFF-2
  drift floor for that verb.

## Output
One CI latency run; results appended as "v12 / phase 3k" to
`2026-09-02-open-vs-proprietary-results-v4.md` (working tree; no device-farm commits):
the per-frame pacing measurement before/after, the six fling cells before/after with
IQR, and the unchanged verbs vs run 33975063607 within their drift floors. Push; report.
