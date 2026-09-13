# Ticket: phase 3h — scrcpy fast-inject tap does not land; make the bench effect-checked

Repo: ARGENT FORK. Worktree: create
`/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-p3h`
on branch `feat/android-open-server-p3h` from `feat/android-open-server-p3g`
(d13cbec7; contains 3f backend + 3g). Never edit other worktrees. NO local
emulator/adb (host memory-exhausted; ZF524RZBHD off-limits). Verify on CI
only: merge `feat/bench-ci` CI files into your branch (`feat/bench-ci-3h`)
and run `bench-open-vs-proprietary.yml -f suite=latency`.

## Evidence (CI run 33736918373, adversarial review)
- Device test "fast-inject tap navigates (scrcpy DOWN/UP + flushInput)":
  `pngDiffRatio == 0` (byte-identical screenshots), and "tap→describe sees
  destination": 0/20. Kotlin-path tap in the same session: PASS. Swipe and
  pinch via scrcpy at the same absolute coordinates DO land.
- So a static DOWN → 50 ms hold → UP with no MOVE is what fails.
- The step was `continue-on-error: true`, so the run was green and the
  bench timed no-op injections (tap 51/52 "win" retracted).

## Hypotheses to test in order (scrcpy 3.3.1 control protocol, @yume-chan/scrcpy 2.3.x)
1. `buttons`/`actionButton`: scrcpy's `Controller.injectTouch` on server
   3.x expects `actionButton`/`buttons` to carry `AMOTION_EVENT_BUTTON_PRIMARY`
   (=1) for a touch DOWN when `pointerId == -1` (mouse) — for a finger
   (`pointerId >= 0` or `-2`) buttons should be 0. Check what the backend
   sends for tap vs swipe (`scrcpy-inject-backend.ts`): if tap uses a
   different `pointerId`/`buttons` combination than swipe, align it.
2. `pressure`: DOWN pressure must be > 0 (scrcpy maps `pressure` u16 → float;
   0 on DOWN can be treated as no contact); UP pressure 0 is fine. Compare
   with swipe frames.
3. Coalescing: DOWN and UP with identical coordinates and ~50 ms apart may
   be delivered but the app needs an `ACTION_MOVE` or a `>= ViewConfiguration.getTapTimeout()`
   window; scrcpy's own client sends DOWN…UP fine for clicks, so unlikely —
   but verify the backend waits the hold with real time (not `tMs` slots
   both at 0).
4. `videoWidth/videoHeight` = 0 on tap only? (3f review: with video:false
   dims are ignored — confirm the same for the tap path; a 0×0 size might
   be rejected by `PositionMapper` only when displayData is set — should be
   null in control-only).
5. Device-side: check `scrcpy` server logcat lines for `Ignore positional
   event` / `Could not inject` during the failed tap in the run's emulator
   log (artifact `logs/emulator.log` or the device test output).
Fix the real cause; add a unit test that the tap message sequence matches
scrcpy's own click sequence (DOWN pressure 1, buttons per pointer type, UP
pressure 0, same pointerId).

## Lead from the stopped attempt (2026-09-03)
The agent was inspecting how `@yume-chan/scrcpy`'s `ScrcpyControlMessageWriter`
buffers/flushes `injectTouch` messages when it was stopped. Hypothesis 0
(check FIRST): the tap's DOWN and UP are written back-to-back into the
same writer without an awaited flush between them, or the writer batches
both into one write that the server's reader consumes as a single frame —
whereas swipe/pinch interleave many MOVEs with real-clock waits so their
DOWN is flushed long before UP. Test: await the writer/stream flush after
DOWN, hold 50 ms on the real clock, then UP; or send one no-op MOVE at the
same point between them. Also verify DOWN and UP carry the same
`pointerId` and that `videoWidth/videoHeight` are non-zero if the server
build validates them for DOWN (control-only 3.3.1 ignores them per the 3f
review, but confirm for this event type).

## Bench hardening (required regardless of the fix)
- `gesture-tap` and `tap+describe` in `bench-open-vs-proprietary.ts`: assert
  effect per iteration — read `getState().hash` (open) / describe text hash
  (OFF) before and after the tap on a navigating target; count `effect=0`
  iterations per block and FAIL the block if > 0 (report the count).
- Device-test step in the workflow: remove `continue-on-error`; the job must
  fail on any device-test failure.
- Print the scrcpy server start line, `scid`, and `fastInjectFallbacks`
  per block in the log (not only console.debug capture).
- Gesture-parity: run `assertIdenticalGestureParams` even under `BENCH_ONLY`
  (per block against the constant is meaningless — instead record the
  actual injected timeline (frame count, tMs, holdMs) from each backend
  into the block JSON and compare in merge).
- Fling A/B: gate ±15 % on informative cells; exclude clamped cells
  (median == floor/ceiling); print the verdict.

## Output
CI run green with device tests enforced; 4 blocks with per-block
effect-check counts = 0; append "v9 / phase 3h" to
`/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-02-open-vs-proprietary-results-v4.md`
with the root cause, the fixed tap numbers (p50/p95 all 4 blocks), effect
counts, parity evidence, fling gate. Commit + push your branches. Report.
