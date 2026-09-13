# Spec: physical-device mock location (Android now, iOS pending research)

Date: 2026-09-01 · Fork: HeiCg/argent · Depends on: feat/android-open-server (9eceb91)

## Context

`set-location` (P2, branch feat/android-system-verbs) covers Android **emulator**
(`adb emu geo fix`) and iOS **simulator** (`simctl location`). Physical devices are
uncovered. This spec adds physical Android mock location via the open-source
on-device server (feat/android-open-server), and gates iOS physical on research.

## Part A — Android physical mock location (implement now)

Branch: `feat/android-mock-location` off `main` in a fresh fork clone
(`git clone git@github.com:HeiCg/argent.git .../scratchpad/argent-mock-loc`). This
depends on the android-device-server package, so merge `feat/android-open-server`
(9eceb91) into this branch first (real merge), then build on top. Conventional
commits, push, no PR.

Mechanism (real system mock location, not emulator console injection):
1. **On-device server (Kotlin)**: new JSON-RPC method `setMockLocation({latitude,
   longitude, altitude?, accuracy?})` and `clearMockLocation()`. Implement with
   `LocationManager.addTestProvider` + `setTestProviderEnabled` +
   `setTestProviderLocation` for both `gps` and `network` providers (the standard
   Android test-provider API). The instrumentation process already runs with a
   UiAutomation context; test providers require the app to be selected as the mock
   location app (see step 2). Handle `SecurityException` with a clear error telling
   the caller the appops grant is missing.
2. **Host side**: the app must be the selected mock-location app —
   `adb shell appops set <serverPkg> android:mock_location allow`. Do this in the
   open-server blueprint's install/ensure path (or a dedicated ensure step invoked
   by the location tool), idempotently, alongside the existing install gate. The
   server package is `com.argent.devicecontrol` (from P3).
3. **Tool wiring**: extend the existing `set-location` tool (do NOT add a new tool
   id — keeps catalog count stable and is the honest UX: same verb, more platforms)
   so Android physical routes to the open server's `setMockLocation` when the
   `open-device-server` flag is on and the device kind is `device`. Emulator keeps
   `adb emu geo fix`. Add an optional `clear` path if the schema allows it cheaply;
   otherwise a separate follow-up. Update capability to include `android:{ device:
   true }` for the server-backed path; document the flag requirement in the
   description (mind SpiderShield headroom).
4. Failure codes: `ANDROID_MOCK_LOCATION_FAILED` (+ the appops-missing case mapped
   to a recovery-guidance message). Register in failure-codes.ts.

Tests:
- Kotlin (if JVM-side test setup allows, as P3 established): method parses args,
  builds Location, provider fallback. Otherwise document the gap.
- TS: tool routes emulator vs physical correctly by device kind + flag; appops
  ensure is called; SecurityException → the guidance error.
- Live smoke on emulator-5554 is NOT sufficient (emulator uses geo fix). If a
  physical Android is available the implementor may smoke it, but the attached
  device `ZF524RZBHD` must **NOT** be used without explicit user opt-in — treat it
  as off-limits; report physical smoke as "not run (no authorized physical device)"
  otherwise. Prove the Kotlin path compiles + unit-passes instead.

Gates: full argent suite green (tsc, typecheck:tests, tool-server+mcp, knip,
catalog count unchanged since no new tool id), docs row/skill updated. Push branch.

## Part B — iOS physical location (research first, no implementation)

Dispatch a researcher (separate, parallel) — do NOT implement yet. Question: what
is the cheapest correct way to set location on a physical iOS device that fits
argent's stack, NOT device-stream's go-ios?
- iOS <17: `com.apple.dt.simulatelocation` DT service over DeveloperDiskImage.
- iOS 17+: `DVTLocationSimulation` via RemoteXPC / CoreDevice tunnel.
- Map against argent's unmerged `origin/feat/ios-physical-devices` branch
  (XCUITest + usbmux, packages/tool-server/src/utils/ios-device/*): does its
  usbmux/devicectl layer already expose or could cheaply expose a location
  service? Is there a `devicectl` location command? Does XCUITest have any
  location API usable from the runner?
- Deliverable: viability verdict (feasible on their stack / needs their branch to
  land first / not feasible without go-ios), the specific service/API, and a
  rough implementation sketch IF feasible. No code.

Also note: device-stream itself (packages/dsl iOS device path) could get
`setLocation` for physical via go-ios `ios setlocation` as a straightforward
addition — separate from argent, owner's call; out of scope here unless requested.

## Reporting

Part A implementor: branch SHA, files, mechanism confirmation, gate outputs, smoke
status. Part B researcher: viability verdict + sketch.
