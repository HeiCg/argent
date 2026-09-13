# Runbook/spec: on-device validation of argent open-server phase 2

Date: 2026-09-02. Checkout:
/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-p3
Branch `feat/android-open-server` @ 349fa427 (pushed). Goal: prove the new
Kotlin injection paths work on a real emulator, fix what doesn't, commit
fixes locally (conventional style), do NOT push.

## Environment (known facts)
- AVD `bench-api35` (Pixel 7, API 35, arm64 google_apis). SDK at
  `/opt/homebrew/share/android-commandlinetools` (emulator/platform-tools
  there; check `ANDROID_HOME`/`ANDROID_SDK_ROOT`, set if unset). Boot headless:
  `emulator -avd bench-api35 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`
  in background; wait for `adb wait-for-device` + `sys.boot_completed=1`.
- UiAutomation channel is exclusive: make sure `com.devicestream.server`
  (device-farm's own server) is NOT running on the AVD
  (`adb shell am force-stop com.devicestream.server`; also kill any
  `am instrument` sessions) before starting argent's open server.
- Argent private binaries are probably absent → the proprietary fallback path
  will error. That is fine and useful: with flag `open-device-server` ON, an
  error surfacing from the fallback means the open path threw first. Read
  the warning logs to tell them apart.
- The device-farm benchmark harness already drives argent programmatically:
  `/Users/heicg/Desktop/projects/device-farm/device-stream/benchmarks/token-bench/adapters.ts`
  — read it to learn how a tool-server/tool call is invoked from a script
  (registry setup, device object shape, flags). Reuse that invocation style
  in a throwaway validation script under the argent-p3 checkout
  (e.g. `packages/tool-server/scripts/validate-open-server.ts`, or a vitest
  file tagged as manual/integration that is skipped without an env var —
  prefer the latter so it can be kept: `OPEN_SERVER_DEVICE_TESTS=1`).
- Target app: a system app is enough for gestures (Settings:
  `com.android.settings`, or Chrome/Maps if present for pinch). For text:
  Settings search box, or the Android `Contacts`/`Messages` app for a real
  EditText. Check what's installed (`adb shell pm list packages`).

## Steps
1. Build + install: `npm run build:android-device-server` in argent-p3, then
   install the APK(s) the blueprint expects (see
   `packages/tool-server/src/blueprints/android-open-server.ts` for how it
   installs/starts — reuse its code path rather than manual adb where
   possible). Confirm `ping` RPC responds via the NDJSON client.
2. Enable flag `open-device-server` for the run (how flags are read: see
   `packages/configuration-core/src/flags.ts` and how tests toggle it).
3. Exercise, capturing the JSON result + the open/fallback warning log for
   each:
   a. `describe` → non-empty tree, `source: "open-device-server"`.
   b. `screenshot` → PNG bytes, valid header, dimensions match `getInfo`.
   c. `gesture-tap` on a Settings row → screen changes (describe diff).
   d. `gesture-swipe` momentum default vs `momentum:false` (holdEndMs 120):
      on a long list, momentum:false must scroll noticeably LESS than default
      (compare first visible row before/after; assert the difference).
   e. flow `long-press` step (via gesture-custom Down…Up delayed ~800ms) on a
      home-screen icon or a list row that has a long-press action → context
      menu / selection appears in describe.
   f. `gesture-pinch` and `gesture-rotate` on a zoomable surface (Maps if
      present; else Chrome on a page; else the Photos viewer). At minimum:
      no exception from `MotionInjector`, and both pointers reach the
      screen (validate via `adb shell getevent` sampling or by visible
      zoom change in screenshot diff).
   g. `paste` → text lands in an EditText (read back via describe).
   h. `await-ui-element` / `await-screen-idle` → resolves via `getState`
      path (log shows open path, no fallback), reasonable latency (<1s idle).
4. Record results in the report: per verb PASS/FAIL, evidence (describe
   snippet / screenshot size / latency ms), and fallback triggered? (must be
   NO for all).
5. Fix any Kotlin/TS defect found (MotionInjector pointer ids/timing, held
   swipe, getState includeScreenshot, PNG format, etc.), rebuild, re-run the
   failing step, commit `fix(android-open-server): …`.
6. Tear down: stop the open server, `adb emu kill`.

## Acceptance
- All steps 3a–3h PASS on device with zero fallbacks, or explicit FAIL with
  root cause + fix commit + re-run PASS.
- The kept integration test (if created) is skipped by default and
  documented in its header.
- `npm run test -w @argent/tool-server` still green; APK still builds.
- Report: table of results, commits, anything left unresolved and why.
