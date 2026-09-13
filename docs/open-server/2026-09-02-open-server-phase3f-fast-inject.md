# Ticket: open-server phase 3f — fast-inject backend (scrcpy control channel), UiAutomation stays for reads

Repo: ARGENT FORK checkout
`/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-p3`,
branch `feat/android-open-server` (HEAD = phase 3e commit once landed; if
3e is still unmerged, base on it: `git log` will show `2f37b132` or later).
Commit locally; do not push. AVD `bench-api35` (`-grpc 8554
-grpc-use-token`); never `ZF524RZBHD`. Poll `adb devices` before booting;
other agents (screen-graph Phase C, phase 3e) may hold the AVD.

## Why
Argent's proprietary Android path injects via (a) emulator gRPC
`EmulatorController.sendTouch` on emulators and (b) Android Studio's
Apache-2.0 `screen-sharing-agent` (shell-uid `app_process` →
`IInputManager.injectInputEvent`) on physical devices. Both skip the
UiAutomation instrumentation hop (2 binder round-trips + sync). Our
residual: tap DOWN ~14 ms + sync UP ~10 ms vs their ~2 ms, plus occasional
400 ms DOWN stalls. Everything we need is public: scrcpy (Apache-2.0) is the
same technique and its server 3.3.1 is already fetched by device-farm's
`@device-stream/android` postinstall; `@yume-chan/adb-scrcpy` exposes
`client.controller.injectTouch` with true multi-pointer (`pointerId`
bigint). LICENSE constraint: never copy anything from Argent's
`bin/simulator-server` or their `resources/android/*` tarball contents; get
scrcpy-server from the scrcpy release (`fetch-scrcpy-server 3.3.1`) or from
device-farm's node_modules.

## Step 0 — go/no-go spike (≤ 2 h, on device)
In a throwaway script under the fork (`packages/tool-server/scripts/spike-scrcpy-control.ts`,
keep it, opt-in): connect with `@yume-chan/adb` (TangoADB) to
`emulator-5554`, push/start scrcpy-server 3.3.1 via `AdbScrcpyClient.start`
with `{ video: false, audio: false, control: true }` (use
`AdbScrcpyOptionsLatest`), obtain `controller`, and:
1. `injectTouch` DOWN/UP at the centre of a Settings row with `videoWidth/
   videoHeight` = real display size (from `wm size`), `pointerId: 0n`; verify
   navigation happened (adb `dumpsys activity` top activity changes).
2. Two-pointer pinch: interleave `injectTouch` for `pointerId 0n/1n` with
   ACTION_DOWN, ACTION_POINTER_DOWN, MOVEs, POINTER_UP, UP at 16 ms cadence
   on Chrome example.com; screenshot diff ≥ 2 %.
3. Measure per-`injectTouch` wall time (p50/p95 over 200 events) and
   DOWN→visible-ripple latency if cheap; compare to UiAutomation numbers
   (DOWN 14 / UP 10 / MOVE 1 ms).
4. Check coexistence: scrcpy-server (shell uid, `app_process`) running at
   the same time as our instrumentation server; both must work; note any
   `INJECT_EVENTS`/SELinux denials in logcat on API 35.
If 1 or 2 fails on API 35, STOP, report exactly what failed, and propose
option (a) emulator-gRPC as the fallback design — do not implement it in
this ticket.

## Step 1 — backend behind the blueprint seam
`packages/tool-server/src/blueprints/android-open-server.ts` factory option
`fastInject: 'off' | 'scrcpy'` (default `'off'`; flag
`open-device-server-fast-inject`, default off). When `'scrcpy'`:
- New `utils/scrcpy-inject-backend.ts`: lifecycle (start server via
  `AdbScrcpyClient` control-only, reconnect on drop, dispose kills it),
  `tap(x,y,{holdMs, clickCount, gapMs})`, `swipe(points…)`, `gesture(pointers)`
  implemented with `injectTouch` using the SAME timelines the Kotlin
  `MotionInjector` uses (real-clock pacing, 16 ms cadence, hold 50 ms,
  multi-tap gap 100 ms, momentum tail) so fling fidelity is unchanged.
  Coordinates: pass real display size as `videoWidth/videoHeight`; re-read
  on rotation via the existing rotation-keyed screen cache.
- Replace only the `tap`/`swipe`/`gesture` closures in the `api` object with
  the backend when enabled; everything else (describe, state, screenshot,
  typeText, key, awaitChange, outcomes) stays on the NDJSON Kotlin client.
- Ordering guarantee (critical): after any fast-inject action, call a new
  Kotlin RPC `flushInput` (`MotionInjector`-side: inject one synchronous
  no-op event, e.g. a zero-duration `ACTION_CANCEL`-free approach — prefer
  `uiAutomation.injectInputEvent(sync=true)` of a harmless KEYCODE_UNKNOWN
  key or a `syncInputTransactions()` call if available on API 35) so a
  following `getNestedState` cannot observe pre-UP state. Outcomes
  (`tapWithOutcome` etc.) must still work: run before/after capture around
  the fast-inject + flush.
- Multi-device: scrcpy server per serial; port/tunnel allocation must not
  collide with the NDJSON forward; dispose both.

## Step 2 — tests
- Unit: backend timelines equal MotionInjector's for tap/multi-tap/swipe
  (momentum + holdEndMs)/pinch (frame count, tMs, pointer ids); flag off →
  closures untouched; dispose stops the server.
- Device test additions (`android-open-server.device.test.ts`): with fast
  inject on — tap navigates, tap→describe sees destination (100/100 over 20
  runs with `settle:true`, and no pre-UP reads with `settle:false`), pinch
  zooms, swipe momentum:false < default, coexistence with instrumentation.

## Step 3 — bench + report
Like-for-like bench (N=20, OFF-1 / ON(uiautomation) / ON(scrcpy) / OFF-2),
all verbs. Append "v7 / phase 3f" to
`/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-02-open-vs-proprietary-results-v4.md`
with per-event inject cost (scrcpy vs UiAutomation vs proprietary inferred),
tap p50/p95/max (the 400 ms DOWN-stall tail must disappear), fling grid
reliable cells within ±15 %, and a verdict paragraph.
Targets: gesture-tap ON(scrcpy) ≤ OFF p50 and p95 ≤ OFF p95 + 10 ms; swipe/
pinch not worse than ON(uiautomation); 0 fallbacks; tokens unchanged.
Tear the emulator down.
