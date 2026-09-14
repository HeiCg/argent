# Ticket: iOS-1 — the open iOS server on our contract, simulator first (owner approved 2026-09-14)

Spec: `2026-09-14-ios-open-driver-spec.md` (read in full). Research with file:line evidence:
`2026-09-14-ios-open-driver-research.md` (both `## Findings` sections — the B section
tells you exactly where things are on the upstream branch). Android reference contract:
`packages/android-device-server/src/main/java/com/argent/devicecontrol/JsonRpcHandler.kt`
(method table), `TCPServer.kt`, `handlers/{StateHandler,HierarchyHandler,TapHandler,
SwipeHandler,InfoHandler}.kt`, host `packages/tool-server/src/blueprints/
android-open-server.ts`, `utils/{open-server-transport,open-server-input,
open-server-describe,android-open-server-client}.ts`, `tools/describe/platforms/android/
open-server-tree.ts`. No numbers are published by this phase.

## Deliverable 1 — `packages/ios-device-server/` (Swift XCUITest runner on the Android contract)
Source: copy `packages/ios-device-runner/` from `origin/feat/ios-physical-devices` @
b547b735 (`git show`/`git checkout <commit> -- <path>` into the new directory; keep the
upstream authorship in the commit message). Keep: the Xcode project and scheme,
`RunnerHostApp.swift`, `ArgentExceptionGuard.m`, `MainThreadGate.swift`,
`ArgentRunnerSession+{Snapshot,Gestures,Screenshot,TextEntry,Commands}.swift` logic
(`app.snapshot()` one-XPC-round-trip tree, `drag` duration→velocity + `settle`, `button`).
Replace: the HTTP/1.1-per-command `RunnerProtocol` with an NDJSON JSON-RPC 2.0 TCP server
(port from `TEST_RUNNER_ARGENT_RUNNER_PORT`, `0` = OS-assigned and printed; `allowLocalEndpointReuse`)
mirroring `TCPServer.kt`; one serial dispatch queue in front of XCUITest (no concurrent
XCTest calls). Method table (names, params and reply shapes as the Android server;
unknown method → JSON-RPC error):
- `ping`, `getInfo` (bundleId of the target app, orientation, keyboardVisible, screen size
  in points and scale from `XCUIScreen.main` — never from a screenshot), `getScreenSize`.
- `getState` / `getNestedState` (`includeScreenshot`, `maxElements` default 1500 as B,
  `truncated`, `version` = monotonic hash-change counter of the snapshot, `timings`
  `{snapshotMs, serializeMs, encodeMs, captureMs}` with Σ ≈ captureMs asserted by the
  device test). Nested shape = the Android nested shape (`children` arrays) so
  `openServerNestedToDescribeNode` applies; element fields: type, label, identifier,
  value, bounds in **screen points** (not app-frame offsets), enabled/hittable/selected/
  focused. Coordinates on every input RPC: screen points (host converts from normalized).
- `tap` (`clickCount`, `holdMs`, `gapMs`; report `dropped:false`; XCUITest cannot report
  a drop — say so in the reply as `dropReporting:"unsupported"`), `longPress`, `swipe`
  (`steps`, `holdEndMs` → B's `settle`), `typeText` (unicode via `typeText`), `key`
  (return/delete/escape + B's hardware `button`), `screenshot` (png/jpeg, `quality`,
  `scale` via CoreGraphics resample), `launchApp` (bundleId; `XCUIApplication(bundleIdentifier:)`
  — this is how the runner targets Settings, not the empty host app), `terminateApp`,
  `flushInput` (ack no-op), `batch`, `shutdown`.
- Not in this phase (return JSON-RPC "unsupported"): `query`, `diff`, `awaitChange`,
  `gesture` multi-pointer, `setClipboard`, hashes (iOS-3/iOS-4).
Swift unit tests where XCTest allows without a device (serializer, JSON-RPC framing,
method table), plus the device suite below.

## Deliverable 2 — host side
- `packages/tool-server/src/blueprints/ios-open-server.ts` + `utils/ios-open-server-client.ts`
  reusing `open-server-transport.ts` (loopback on the simulator; on a physical device
  keep B's usbmux forward from `src/utils/ios-device/usbmux*.ts` behind the same
  `request()` — copy those two files and their tests from B; do NOT copy B's HTTP client).
- Runner lifecycle: `utils/ios-open-server-runner.ts` = B's `runner-build.ts` /
  `runner-launch` logic adapted: `xcodebuild build-for-testing` once per Xcode version
  (cache key includes `xcodebuild -version`), `test-without-building -xctestrun … -destination
  'platform=iOS Simulator,id=<udid>'` detached; readiness = `ping` within 120 s. Simulator:
  no team id, `iphonesimulator` xctestrun; physical: B's `ARGENT_IOS_TEAM_ID` signing and
  `iphoneos` xctestrun kept intact.
- `shouldUseOpenServer(device)` covers iOS behind a new flag `open-ios-device-server`
  (off by default; document in `packages/docs/docs/reference/` config keys and a short
  `features/` note that it is experimental, simulator + physical). Describe path:
  `tools/describe/platforms/ios/open-server-tree.ts` = the Android adapter shape; tap/
  swipe/long-press/type/key/screenshot tools route through the blueprint when the flag
  is on; screenshot fallback to `xcrun simctl io screenshot` if the runner is not ready.
- Unit tests: transport framing over a fake socket, the method-name parity test (host
  method list == server method list, both derived from one source), describe adapter
  lockstep test (B has one: `tools/describe/platforms/ios-device*` on the branch — port it).

## Deliverable 3 — CI: `.github/workflows/ios-open-server-device-test.yml` (`workflow_dispatch`)
`macos-latest`; pin Xcode with `sudo xcode-select -s /Applications/Xcode_<ver>.app` and
print `xcodebuild -version` (the version is part of the build cache key); pick the
newest available iOS simulator runtime with `xcrun simctl list runtimes -j`, create + boot
an iPhone device, `xcrun simctl bootstatus -b`; build-for-testing; launch the runner
against `com.apple.Preferences`; device test in `packages/tool-server/test/blueprints/
ios-open-server.device.test.ts` (`OPEN_IOS_SERVER_DEVICE_TESTS=1`): ping; getInfo
without screenshot; getNestedState stages sum; tap on "General" navigates — effect
oracle = neutral pixels (`xcrun simctl io <udid> screenshot` before/after, diff ratio
≥ 2 %, plus the nested tree's navigation title changes); swipe scrolls (screenshot diff
in the list region); typeText into the Settings search field; screenshot png + jpeg
scale 0.5; launchApp/terminateApp; shutdown. Upload logs + xcresult + screenshots as an
artifact. Note the minutes multiplier (macOS = 10×) in the workflow header. Physical
device path: compiled by the same build (both destinations) but NOT run in CI; document
the manual one-off on the owner's iPhone as a follow-up step in the Result, not done here.

## Constraints
Worktree `../argent-fork-wt-ios1` on branch `feat/ios-open-server-1` off `open/main`
(never /tmp; root `node_modules` symlinked; no npm install / gradle / Xcode builds
locally — Swift compiles only in CI on macOS, so read every Swift edit twice and keep the
diff close to B's proven code; vitest `--maxWorkers=2`). No simulator locally. CI budget:
up to THREE runs of the new workflow (Swift compile errors are expected on the first
try; each run is short, ~15–25 min). Polling: one `gh run view` per 10 min as a single
`run_in_background` Bash call `sleep 540; gh run view <id> --json status,conclusion,jobs`;
never loop; one `gh run download` per artifact. Workflow YAML push over SSH if the HTTPS
token lacks the `workflow` scope. Do not touch the Android bench, the scoreboard, or
`open/main`. Docs: `packages/docs` pages for the flag; `npx docusaurus build` and
`npm run format` only in the main checkout after merge (say so).

## Acceptance
Runner builds on `macos-latest` from our package; NDJSON contract with the method table
above; device suite green on the simulator (tap effect by neutral pixels, stages sum,
screenshot, type, launch); host tools route iOS through the blueprint behind the flag;
method-parity and describe-lockstep tests green; docs pages added; `## Result` here with
run ids, the xcodebuild/simulator versions, per-RPC device timings as informal
observations (NOT scoreboard numbers), what was copied from B verbatim vs changed, and
what is deferred to iOS-2/3/4.
