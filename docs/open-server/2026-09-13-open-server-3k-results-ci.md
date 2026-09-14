# Open server phase 3k — scrcpy fling pacing + bench-gate hardening (CI results)

Repo: **HeiCg/argent** fork. Branch `feat/open-server-3k` off `open/main` @ `690e66bc`.
Workflow `bench-open-vs-proprietary.yml`, `-f suite=latency`. Runner: **ubuntu-latest,
x86_64, KVM-accelerated emulator**, `system-images;android-34;google_apis;x86_64`,
Android 14 / SDK 34, 1080x2400 @ 420dpi. **N = 20 per verb per block; fling A/B N = 12
per cell per backend.** Not comparable to a local arm64/HVF host. This run is the phase-3k
before/after: the fling A/B carries the pre-3k `ON-scrcpy-legacy` (await-per-frame) arm
and the `ON-scrcpy` drift-corrected arm in the SAME run.

Read with `2026-09-03-review-final-findings.md` (F2, F4–F7, F9–F16, F19) and
`2026-09-03-open-vs-proprietary-results-final-ci.md` (run 7 = 33975063607, the before
baseline). **No scoreboard rows until adversarial review.**

## What changed (code)

- **scrcpy host pacing (A).** `scrcpy-inject-backend.ts injectTimeline` gains a
  drift-corrected, socket-decoupled pacing mode (`drift`, the default/after) that
  dispatches each MOVE frame at its wall-clock slot and INITIATES the `injectTouch`
  write there **without awaiting its consume** — the WHATWG `WritableStream` queues the
  writes in order, so a slow socket write no longer stretches the DOWN→UP span and
  starves the OS VelocityTracker. The pre-3k await-per-frame loop is kept as `legacy`
  (before), selected per process by `ARGENT_SCRCPY_PACING`. **No velocity tuning** (A.2(c)
  dropped per the addendum).
- **Measurement (option i).** A per-swipe host pacing trace (`pacing mode=… frames=…
  intendedDurMs=… downUpDispatchMs=… writeSpanMs=… maxDispatchDriftMs=…`) is emitted for
  every swipe; per-arm logcat is captured around the fling A/B step so the delivered
  MotionEvent span can be read for all three arms + the proprietary reference. Two
  device-test measurements (`3k pacing` uia / scrcpy drift-vs-legacy) log delivered-vs-
  requested from logcat.
- **Gate (A.3 / F4 / F9).** `merge-fling.js`: the value-bounded whitelist is **removed**;
  the gate is per-cell `scrcpy(drift)/uia ±0.15`, blocking, **no whitelist**; the
  floor-pinned exclusion is **kept**; transparency rows `scrcpy/off` and `uia/off` and the
  `legacy→drift` before/after are printed.
- **Part B honesty.** F7 (no-effect tap identity logged + recorded; logcat across bench
  blocks), F6 (dump short-circuit is a logged/gated event), F12 (per-block ready gate
  BLOCKING), F13 (an executable proprietary OFF baseline that fails now fails the run),
  F19 (the all-zero `destinationVisible` staleness probe removed). F3 (tap "at parity")
  and F4/F9 value-bound + landing-rate gate already landed on `open/main`.
- **Gate unit tests.** `.github/bench-ci/gates.test.js` (17 cases) wired into
  `unit-tests.yml`.

## Before baseline (run 7 = 33975063607, legacy pacing) — fling A/B, scrcpy/uia and scrcpy/off

| cell | uia | scrcpy | off | scrcpy/uia | scrcpy/off | prior status |
|---|---|---|---|---|---|---|
| 150 / 0.3 | 0.449 | 0.466 | 0.464 | 1.038 | 1.004 | pass |
| 150 / 0.5 | 0.175 | 0.175 | 0.175 | 1.000 | 1.000 | floor (no signal) |
| 250 / 0.3 | 0.357 | 0.324 | 0.455 | 0.908 | 0.712 | pass |
| 250 / 0.5 | 0.175 | 0.265 | 0.175 | 1.514 | 1.514 | out, was whitelisted |
| 400 / 0.3 | 0.321 | 0.230 | 0.358 | 0.717 | 0.642 | FAIL (only red) |
| 400 / 0.5 | 0.507 | 0.360 | 0.621 | 0.710 | 0.580 | out, was whitelisted |

Reproducible scrcpy 400 ms under-scroll ~35–42 % vs proprietary across runs 5 and 7.

<!-- AFTER-NUMBERS AND VERDICT FILLED FROM THE 3k RUN BELOW. -->

## Result

_(pending run 34795811096 — filled once the run completes)_
