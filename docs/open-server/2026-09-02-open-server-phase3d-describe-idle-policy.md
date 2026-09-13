# Ticket: open-server phase 3d — describe idle policy parity (tap+describe)

Repo: ARGENT FORK checkout
`/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-p3`,
branch `feat/android-open-server` @ 9d0a9ccf (phase 3c, pushed). Commit
locally; do not push. AVD `bench-api35` (`-grpc 8554 -grpc-use-token`), never
`ZF524RZBHD`; boot only when `adb devices` shows no emulator.

## Finding (v4)
tap+describe: proprietary 145 ms p50, open 689 ms. `captureMs` 12 ms — the
residual is `waitedMs` 519 (`getNestedState waitTimeoutMs: 500` = quiescence
window). The proprietary ADT path reads the tree immediately after the tap
(no quiescence), so the two differ in *policy*, not speed. To be like-for-
like, the open describe must default to the same policy; the settled read is
the superior product feature and stays available explicitly.

## Changes
1. `tools/describe/platforms/android/index.ts` open branch: default
   `waitTimeoutMs: 0` (immediate read, matching ADT). Add describe param
   `settle?: boolean | number` (false/absent = immediate; true = 500 ms
   quiescence; number = custom cap) and thread it to `getNestedState`. Keep
   `waitedMs/captureMs` in metadata.
2. The proprietary comparator: verify what `android-devtools.ts:335`
   `waitForIdleMs: 500` actually does in the bench path (does ADT's
   `getHierarchy` honour it as a cap or a quiescence?). Measure: OFF
   tap+describe with `waitedMs`-equivalent unknown — instead, measure the
   OFF describe's *staleness*: after a navigating tap, does the OFF tree
   already contain the destination screen's title (count over 20 runs)?
   Do the same for ON at `settle:false` and `settle:true`. Report the
   three "destination already visible" rates.
3. Bench: tap+describe runs both `settle:false` (like-for-like) and
   `settle:true` (our policy) for ON; OFF as-is.
4. `await-ui-element`/`await-screen-idle` keep their current waits
   (unchanged).
5. Docs: the describe tool schema explains `settle` in one sentence; the
   open-server feature page (if any) states the default matches the
   proprietary path.

## Targets
- tap+describe ON(settle:false) ≤ 1.2× OFF p50.
- ON(settle:true) reported with its staleness benefit (destination-visible
  rate) — no latency target.
- No change to token parity, goldens, fallbacks; suite green; APK unchanged
  (TS-only change is expected — if Kotlin needs `waitTimeoutMs: 0` handling,
  verify `uiDevice.waitForIdle(0)` returns immediately, else skip the call).

## Output
Append a "v5 / phase 3d" section to
`/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-02-open-vs-proprietary-results-v4.md`
(same file, new section) with the tap+describe triple and staleness rates.
Tear the emulator down.
