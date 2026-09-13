# Spec: open-device-server phase 3 — beat the proprietary backend

Date: 2026-09-02. Checkout: argent-p3
(/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-p3),
branch `feat/android-open-server` @ d808d87e (pushed). Commit locally in
conventional style; do NOT push. Physical device `ZF524RZBHD` may be attached:
never target it. AVD `bench-api35`; boot with `-grpc 8554 -grpc-use-token`
(the proprietary controller needs it) as the bench script does.

## Baseline (bench script `packages/tool-server/scripts/bench-open-vs-proprietary.ts`,
report in device-farm `docs/specs/2026-09-02-open-vs-proprietary-results.md`)

| verb p50 ms | proprietary (OFF) | open (ON) |
|---|---|---|
| gesture-tap | 53 | 146 |
| gesture-swipe | 298 | 650 |
| gesture-pinch | 348 | 846 |
| paste | 78 | 57 |
| describe / await-* | ≈ equal |
| describe tokens (Settings root, chars/4) | 473 (14 el) | 1077 (59 el) |
Fidelity: text labels 17/17 identical; OFF ids ⊂ ON ids.

## WIN CONDITION (acceptance — all must hold, measured with the same bench,
N=20, OFF-1 → ON → OFF-2)
1. gesture-tap ON p50 ≤ OFF p50 (target ≤ 50 ms).
2. gesture-swipe ON p50 ≤ OFF p50 for the SAME requested duration; fling
   distance for default momentum must remain within ±15% of OFF's (measure
   anchor delta as the bench does), and `momentum:false` must still scroll less.
3. gesture-pinch ON p50 ≤ OFF p50 with visible zoom (screenshot diff ≥ 2%).
4. describe ON tokens ≤ OFF tokens on Settings root AND on Settings search
   results screen, with text-label set identical to OFF and resource-ids of
   OFF still ⊆ ON.
5. describe/await/paste ON p50 not worse than baseline ON by >10%.
6. 0 errors / 0 fallbacks over the run; tool-server suite green; device test
   (`OPEN_SERVER_DEVICE_TESTS=1`) green; APK builds.
7. Updated results report written to
   `/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-02-open-vs-proprietary-results-v2.md`
   (same format, plus a "what changed" section with per-fix attribution).
Iterate profile → fix → re-bench until 1–4 hold. If after a serious attempt a
condition cannot be met, report the floor you reached and the exact reason
(e.g. a UiAutomation cost that cannot be avoided), with evidence.

## Where the time goes — investigate first, then fix (hypotheses, verify each
with timestamps: TS side `performance.now()` around client call; Kotlin side
`SystemClock.elapsedRealtimeNanos()` logged per phase)

A. Transport/RTT: NDJSON over `adb forward` TCP. Measure `ping` p50 — that is
   the floor. If ping > 5 ms, look at: Nagle (`setNoDelay(true)` on the TS
   socket; `tcpNoDelay` on the Kotlin `ServerSocket`/accepted socket), line
   buffering/flush on the Kotlin writer, JSON encode of large responses.
B. `tap`/`gesture` handler: check whether the handler calls `waitForIdle` /
   `UiDevice.waitForIdle()` / `UiAutomation.waitForIdle` implicitly after
   injecting (UiAutomator's `UiDevice.click` does — if the handler uses
   `UiDevice.click` or `UiObject2.click`, switch to raw
   `UiAutomation.injectInputEvent` DOWN/UP with `sync=false` or `true` as
   needed, no idle wait). Idle wait is the caller's job (`await-*` tools).
C. `MotionInjector` pacing: it sleeps to wall-clock between frames. For a tap
   there should be exactly DOWN + UP (≤ 10–20 ms apart). For swipes, frame
   count vs duration: match the proprietary path's requested duration (find
   what duration `gesture-swipe` passes on OFF: look at the tool's default and
   the SS `cmd: touch` payload) — if OFF completes a "300 ms" swipe in 298 ms
   wall, ON must too: total wall ≈ requested duration + ~10 ms, not 2×. Check
   for double-sleeping (TS side awaiting + Kotlin sleeping), an extra
   `holdEndMs` applied when momentum is default, or `injectInputEvent(sync=true)`
   blocking per frame (use `sync=false` for intermediate MOVEs, `sync=true`
   only for the final UP, or all `false` + one final `waitForIdle`-free flush).
D. Instrumentation thread: if the RPC dispatch runs on a single thread that
   also does `Looper` work, or if each request spawns/joins a thread, measure
   and fix (dedicated executor, keep the UiAutomation calls on one thread).
E. TS routing overhead: `gesture-tap` open path — does it call `getInfo`/
   `getState`/`describe` before tapping (to resolve coordinates or check the
   flag)? Cache `getInfo` per session; the flag check must be in-memory.
   Per-device lock acquisition should be µs.
F. Pinch: 2 pointers × N frames; same pacing analysis as C. Also verify the
   TS side does not run pinch as two sequential gestures.

## describe token parity (condition 4)
Study what OFF renders (14 elements from ADT for Settings root) vs ON (59):
- Port the pruning rules from device-farm's DSL
  `/Users/heicg/Desktop/projects/device-farm/device-stream/packages/dsl/src/selectors/describe.ts`
  (visible-only, drop anonymous containers without text/id/actionability,
  collapse single-child wrappers, merge a row's text children into the row)
  into the open describe path — preferably server-side in `TreeCompressor`
  behind a request param (`compact: true`) so bytes over the wire drop too,
  with the TS `describe` tool passing it. Keep the full tree available
  (`compact:false`) for `flow-android-tree` (`maxElements: 12000` path).
- Do NOT drop: any node with text, content-desc, resource-id that OFF keeps,
  or any clickable/scrollable/editable node. Row text must match OFF's
  rendering (OFF concatenates row texts into one label — do the same so the
  agent sees "Network & internet / Mobile, Wi-Fi, hotspot" style rows if that
  is what OFF emits; verify by diffing the two outputs).
- Re-check `await-ui-element` selectors still resolve on the compact tree
  (ids preserved), and the phase-1/2 unit tests.

## Report
Per hypothesis A–F: measured before/after numbers and what was changed.
Final table OFF-1/ON/OFF-2 for every verb, describe tokens on both screens,
fidelity check, commits list. Tear the emulator down.
