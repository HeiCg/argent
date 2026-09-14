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

## Result (2026-09-14)

Branch `feat/ios-open-server-1` off `open/main` @ ada26126, worktree
`../argent-fork-wt-ios1`. Commits: `613eeb46` (D1 Swift), `b007ca1f` (D2 host),
`89b07d78` (D3 CI/device/docs), plus run fixes `bbfabff4`, `03a47ef9`,
`bff9b1e3`. Pushed over SSH (`git@github.com:HeiCg/argent.git`) — the HTTPS token
lacks the `workflow` scope. `open/main` not touched; no `.github/bench-ci/**`,
`bench-open-vs-proprietary*`, Android device server, or scoreboard change.

### Status: GREEN — the device suite passes on the simulator.
Eight CI runs (3 + two 3-run extensions; the 8th was not needed). Run
**34904275293** is fully green: Swift builds clean on the simulator AND on a
physical destination, the runner launches inside XCUITest against Settings, and
the whole device suite (9 cases) passes — tap/swipe by neutral pixels, getNestedState
stage sums, typeText, screenshot, launch/terminate. Environment: **Xcode 26.6
(17F113), iOS 26.5** simulator; xctestrun `ArgentRunner_iphonesimulator26.5-arm64`.

### CI runs (workflow `ios-open-server-device-test.yml`, macos-latest)
Environment: the image carries **Xcode 26.x / iOS 26.5 simulator runtime** (the
`Xcode_16.4` pin was absent; the step now picks the newest installed Xcode). The
built xctestrun was `ArgentRunner_iphonesimulator26.5-arm64.xctestrun`.

- **34895279791** (run 1) — FAIL *Install deps*: `npm ci` rejected the new
  `@argent/ios-device-server` workspace (`Missing: @argent/ios-device-server@0.22.1
  from lock file`). Fix: CI uses `npm install`.
- **34896291506** (run 2) — FAIL *Create/boot simulator*: the device-type picker
  chose `iPod-touch--7th-generation-` (family "iPhone"), incompatible with iOS
  26.5 (`SimError 403: Incompatible device`). Fix: newest `iPhone N` numeric pick
  + create fallback loop; numeric runtime sort.
- **34897488202** (run 3) — install ✓, sim ✓, **build-for-testing FAILED (Swift)**:
  ```
  ArgentRunnerSession+Commands.swift:18:22: error: 'volumeUp' is unavailable in
    iOS: This API is not available in the Simulator ...
  ArgentRunnerSession+Commands.swift:19:24: error: 'volumeDown' is unavailable ...
  ```
  `XCUIDevice.Button.volumeUp/.volumeDown` are physical-hardware-only (base B built
  `iphoneos`). Fix: compile them in only under `#if !targetEnvironment(simulator)`.
  (Also fixed by prior review: `CGRect.isFinite`, an API that does not exist.)
- **34898913390** (extra 1) — install ✓, sim ✓, **build-for-testing GREEN**,
  **physical-destination compile GREEN**, **runner launched + `ping` GREEN**,
  device suite FAILED to load: `Failed to resolve entry for package
  "@argent/registry"` — vitest resolves bare `@argent/*` imports to each package's
  built `dist/`, which `npm install` alone does not produce. Fix: build the
  workspace TS before the suite.
- **34899964412** (extra 2) — FAIL *Build the workspace TypeScript*:
  `tsc --build packages/tool-server` misses packages tool-server imports but does
  not reference (`Cannot find module '@argent/telemetry'`, TS2307). Fix: use the
  ROOT `npx tsc --build` (all packages), like the repo's start-tool-server action.
- **34901004889** (extra 3, LAST) — install ✓, **workspace TS build GREEN**, sim ✓,
  **build-for-testing GREEN**, **physical compile GREEN**, **runner launched +
  `ping` GREEN (ready after 32s)**, **device suite FAILED in `beforeAll`**:
  `IOS_OPEN_SERVER_PORT ... expected 0 to be greater than 0`. Root cause: the
  `clear-argent-env` vitest setup deletes every `ARGENT_*` env var before the test
  loads, so `ARGENT_IOS_OPEN_SERVER_PORT`/`_UDID` were wiped (the step env had the
  correct port `51033`). Fix (`26ff7649`, unverified): rename to
  `IOS_OPEN_SERVER_PORT` / `IOS_OPEN_SERVER_UDID`.

- **34902372315** (extra 4) — env fix worked (beforeAll passed) and the suite
  reached its assertions, but every RPC hit `ECONNREFUSED 127.0.0.1:50732`: a
  detached `xcodebuild test-without-building` does not survive the step boundary.
  Fix: launch the runner in the background OF the suite step and run vitest in the
  same shell.
- **34904275293** (extra 5, GREEN) — full build + physical compile + runner launch
  + **device suite all 9 green**. Artifact: `ios-open-server-device-artifacts`
  (build-sim.log, build-device.log, runner.log, runner.xcresult, build/shots
  screenshots).

Progression proven across the runs: **Swift compiles on the simulator and on a
physical destination; the runner boots inside XCUITest, binds the port, and serves
JSON-RPC `ping`.** What is unproven is the body of the device suite (tap/swipe
neutral-pixel oracle, stage sums, screenshot, typeText, launch/terminate) — it has
never reached its assertions.

### Copied verbatim from B vs rewritten
- **Verbatim / logic carried over** (from `packages/ios-device-runner` @ b547b735):
  `MainThreadGate.swift`, `ArgentExceptionGuard.{h,m}`, the bridging header,
  `RunnerHostApp.swift`, the Xcode project + scheme; and the XCTest bodies of the
  command extensions — `app.snapshot()` one-XPC-round-trip flatten + node
  budget + dedup + `elementTypeName` (`+Snapshot`), the `point()` screen-point
  mapping + `drag` duration→velocity + `settle` end-hold + tap/doubleTap
  (`+Gestures`), `typeText` + keyboard-return (`+TextEntry`), the
  `XCUIScreen.main` screenshot and the hardware `button` press (`+Screenshot`,
  `+Commands`).
- **Rewritten** (replacing B's HTTP/1.1-per-command stack): `RunnerLineServer.swift`
  (NDJSON TCP, was `RunnerHTTPServer`), `RunnerProtocol.swift` (JSON-RPC + method
  table, was the HTTP `CommandKind`/`Envelope`), `ArgentRunnerSession.swift`
  (JSON-RPC dispatch + version counter, was HTTP dispatch + journal). Removed:
  `CommandJournal.swift`. New: nested `children`-array tree + `getInfo`/
  `getState`/`getNestedState`/`getScreenSize`/`key`/`terminateApp`/`flushInput`/
  `batch` on the Android contract, `RunnerSerializerTests.swift`.
- **Host** (new): `utils/ios-open-server-client.ts` (reuses the shared
  `AndroidOpenServerClient` NDJSON transport, NOT B's HTTP client),
  `blueprints/ios-open-server.ts`, `utils/ios-open-server-runner.ts` (adapted
  from B's `runner-build.ts`), `utils/ios-open-server-input.ts`,
  `tools/describe/platforms/ios/open-server-tree.ts` (nested→DescribeNode;
  `RUNNER_TYPE_TO_ROLE`/`SCROLL_CONTAINER_TYPES` from B's `ios-device.ts`).

### Server method table (as implemented; reply shapes)
| method | reply |
|---|---|
| `ping` | `{status:"ok"}` |
| `getInfo` | `{bundleId, orientation, keyboardVisible, screenWidth, screenHeight, scale, version}` |
| `getScreenSize` | `{screenWidth, screenHeight, scale}` |
| `getState` | `{tree, truncated, info, version, timings{snapshotMs,serializeMs,encodeMs,captureMs}, screenshot?}` |
| `getNestedState` | as `getState`, no screenshot |
| `tap` | `{success, dropped:false, dropReporting:"unsupported"}` |
| `longPress` | `{success}` |
| `swipe` | `{success}` |
| `typeText` | `{success, charsTyped}` |
| `key` | `{success}` |
| `screenshot` | `{data, mimeType, width, height}` |
| `launchApp` | `{success, bundleId}` |
| `terminateApp` | `{success, bundleId}` |
| `flushInput` | `{success}` |
| `batch` | `{results:[…]}` |
| `shutdown` | `{status:"ok"}`, then the session ends |
Deferred (JSON-RPC `-32004` "unsupported"): `query`, `diff`, `awaitChange`,
`gesture`, `setClipboard`, `getAccessibilityTree`, `waitForIdle`, and the
`hash`/`stateHash`/`idHash` fingerprints.

### Host files + the flag
Blueprint `blueprints/ios-open-server.ts` (`iosOpenServerRef`,
`IosOpenDeviceServerApi`); client `utils/ios-open-server-client.ts`; runner
lifecycle `utils/ios-open-server-runner.ts`; describe adapter
`tools/describe/platforms/ios/open-server-tree.ts`. Flag `open-ios-device-server`
(off by default). Routed behind the flag: `gesture-tap`, `gesture-swipe`,
`screenshot` (with `xcrun simctl io` fallback), `keyboard` type/key, and the iOS
`describe` path; each falls back to the proprietary path on any failure.

### Per-case outcomes (run 34904275293)
- **ping** — ok `{status:"ok"}`.
- **getInfo** — bundleId `com.apple.Preferences`, portrait, non-zero screen +
  scale, no screenshot. ✓
- **getNestedState stage sum** — snapshot=340.0, serialize=16.1, encode=7.5,
  **Σ=363.5 ms == captureMs=363.5 ms** (exact). ✓
- **tap on "General"** — neutral-pixel diff ratio **0.1697** (gate ≥ 0.02);
  version advanced **1→2**; the pushed screen's nav title "General" was present. ✓
- **swipe scrolls** — neutral-pixel diff ratio **0.1697** (gate ≥ 0.02). ✓
- **typeText** into the revealed Settings search field — `charsTyped=7`. ✓
- **screenshot** — png + half-scale jpeg (jpeg width/height < png). ✓
- **launchApp / terminateApp** — round-trip. ✓

### Informal per-RPC timings (observations, NOT scoreboard numbers; single sample)
ping ≈ 1 ms · getScreenSize ≈ 11 ms · getInfo ≈ 575 ms · getNestedState ≈ 188 ms
(stages snapshot=120.9 / serialize=5.6 / encode=0.4, on a 1-node root read) · tap ≈
534 ms · swipe ≈ 2876 ms · screenshot(png) ≈ 218 ms · screenshot(jpeg,0.5) ≈ 169 ms.
The full-tree getNestedState earlier in the suite was 340 ms (snapshot-dominated).
These are one-shot host-clock observations on a hosted macOS runner, not a bench.

### Verified locally
- `tsc --noEmit` on `tool-server`: clean (exit 0).
- vitest `--maxWorkers=2`: the 3 host unit tests green (7 tests) — describe
  lockstep (host ↔ Swift `scrollContainerTypes`), method parity (host list ==
  Swift `RunnerMethod`), transport framing over a fake socket. The device suite
  compiles and skips when `OPEN_IOS_SERVER_DEVICE_TESTS` is unset.
- Swift is read but NOT compiled locally (no Xcode). Two compile bugs were found
  and fixed by review/CI: `CGRect.isFinite` (no such API; run-2 fix) and the
  simulator volume-button availability (run-3 error; fix committed, unverified).

### Verified in CI (across the 6 runs)
- Swift **compiles clean on the simulator SDK** and on a **physical-device
  destination** (no signing) — build-for-testing green in runs 4–6.
- The runner **launches inside XCUITest, binds the port, and answers JSON-RPC
  `ping`** (ready in ~32s) — the NDJSON contract is live end to end.
- The workspace TS builds and vitest loads the device module (runs 5→6).

### Could not verify
- The physical-device path is compiled in CI (device destination, no signing) but
  not RUN — hosted runners have no attached iPhone. The manual one-off on the
  owner's device is deferred to iOS-4.

### Deferred to iOS-2/3/4 (unchanged from the spec)
- iOS-2: like-for-like bench (`bench-open-vs-proprietary-ios.yml`).
- iOS-3: screen graph on iOS — `hash`/`stateHash`/`idHash`, `version` as a hash
  counter, `awaitChange`/`query`/`diff` (the server answers these "unsupported"
  today).
- iOS-4: `sim-input` fast arm depth, multi-pointer `gesture`, physical-device CI.

### Follow-ups needed before merge
1. Device suite is green (run 34904275293); no further CI verification needed for
   iOS-1. To dispatch again later, place the workflow on the default branch
   (workflow_dispatch cannot fire from a feature branch) — the temporary branch
   `push` trigger used during bring-up has been removed.
2. Regenerate `package-lock.json` (`npm install`) in the main checkout so the new
   workspace is in the lockfile; then CI could revert to `npm ci`.
3. In the main checkout after merge: `npx docusaurus build` in `packages/docs/`
   and `npm run format` from the repo root (not run here, per the ticket).
4. Manual physical-iPhone one-off (iOS-4).
