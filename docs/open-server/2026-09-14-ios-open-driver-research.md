# Ticket: iOS-0 — research for the open iOS driver (owner approved 2026-09-14)

Goal: decide the base for an open iOS driver that mirrors the Android one (device-side
server + host fast path + the platform-agnostic screen-graph/tokens layer), with
like-for-like numbers against the closed `simulator-server` on the iOS Simulator and,
where the closed driver has no answer, physical iPhone support as an open-only capability.
Read-only research; no code, no builds, no CI. Output: one Markdown report.

## Three candidate bases (all already on disk)

A. **Owner's `device-stream`** (`/Users/heicg/Desktop/projects/device-farm/device-stream`,
read-only): `native-servers/ios-xctest-server` (Swift XCUITest bundle: `TCPServer`,
`JsonRpcHandler`, `Actions/{Tap,Swipe,LongPress,Type,PressKey,Screenshot,LaunchApp,
   TerminateApp,Wait}`, `Accessibility/{TreeWalker,TreeCompressor,ElementSerializer}`,
`Util/ScreenInfo`), `tools/sim-input` (host Swift CLI injecting simulator HID through
IndigoHID / SimulatorKit / IOHIDDigitizer), `tools/sim-capture-avcc`, `sim-cam`,
`native-servers/sim-capture-private`, `packages/ios-simulator` (ScreenCaptureKit
capture), `packages/ios-device` (WebDriverAgent MJPEG + go-ios), `docs/ios-*.md`,
`benchmarks/token-bench`. Initial commit 2026-05-17.
B. **Upstream `origin/feat/ios-physical-devices`** (Software Mansion, 2026-08-31, not
merged): `packages/ios-device-runner/ArgentRunner` (Swift XCUITest runner:
`ArgentRunnerSession+{Commands,Gestures,Screenshot,Snapshot,TextEntry}`,
`ArgentExceptionGuard.m`, `RunnerHostApp.swift`, `PROTOCOL.md`, `README.md`), host
side in `packages/tool-server/src` (usbmuxd port forward, `devicectl` launch,
auto-signing via `ARGENT_IOS_TEAM_ID`, Swift sources shipped in the npm package),
`scripts/e2e-ios-physical-device.mjs`, docs pages. Siblings: `feat/physical-ios-via-
   simserver` (CoreDevice through the closed server) and `feat/physical-ios-device-support`
(CoreDevice sidecar + pymobiledevice3 tunnel).
C. **Closed `simulator-server`** on iOS (what we must beat): `packages/tool-server/src/
   utils/{simulator-client,ios-host,sim-remote,simctl-backend}.ts` and the blueprint
`blueprints/simulator-server.ts` show its API surface; mechanism inferred from the
host side only (binary is closed; do not reverse-engineer it, its LICENSE forbids).

## Questions (answer each with file:line evidence)

1. **Protocol and coverage matrix.** For A, B and our Android Kotlin server
   (`packages/android-device-server/src/main/java/com/argent/devicecontrol/handlers/`):
   which RPCs exist (describe/tree, query/diff/awaitChange, tap, swipe with timeline,
   multi-pointer gesture, long press, type/paste, key, screenshot, launch/terminate,
   flushInput, stage timings, version/fingerprints). Table with ✓ / partial / missing.
   Which base is closer to the Android RPC contract the host `open-server-input.ts`,
   `open-server-describe.ts` and the screen-graph wiring already speak?
2. **Injection paths on iOS and their limits.** XCUITest (`XCUICoordinate`, `press`,
   `swipe`, `XCUIApplication.snapshot()`): latency order of magnitude per action from
   any numbers in A's `benchmarks/` or docs, what timing control exists (none for event
   timestamps?), multi-touch support, sim vs physical differences. `sim-input`
   (IndigoHID): what events it can send (touch timelines with timestamps? multi-pointer?
   keys?), which private frameworks, which Xcode/macOS versions it was built against,
   simulator-only. Physical device options for a fast path (none besides XCUITest /
   WebDriverAgent? note go-ios and WDA as in A's `packages/ios-device`).
3. **Accessibility tree and tokens.** How A's `TreeWalker`/`TreeCompressor` and B's
   `Snapshot` read the tree (XCUIElement snapshot vs AX API), depth/attribute limits,
   cost per read, whether a stable element identity (like Android's `idHash`) is
   derivable for the screen graph, and how the closed server's iOS `describe` output
   compares in shape (from `simulator-client.ts` / fixtures in `packages/tool-server/test`
   naming iOS) so the token bench can be like-for-like.
4. **Build, signing, distribution, CI.** For A and B: Xcode project vs SwiftPM, code
   signing needs for simulator (none) and physical (team id), how the bundle is built and
   launched (`xcodebuild test-without-building`, `xctestrun`), startup time, how the
   port is reached (simulator: localhost; physical: usbmuxd/go-ios), whether Swift
   sources can ship in npm (B does). What a GitHub `macos-latest` job needs to run the
   simulator bench (Xcode version, simulator runtime, minutes cost estimate vs the
   Android x86_64 job).
5. **Bench design sketch.** How to reproduce the Android bench (OFF = closed
   simulator-server, ON = open XCUITest server, ON-fast = sim-input HID) on
   `macos-latest`: which verbs are like-for-like, what the effect oracle would be on iOS
   (resumed view controller? AX focus?), what the fling/scroll metric could be that is
   not censored (learn from `2026-09-14-review-3n1-findings.md` 3N-H3), N and wall-time.
6. **Recommendation.** One base (or a merge of A's server + B's host plumbing, or B's
   runner + A's `sim-input`), the minimal phase list to reach a first like-for-like run
   (iOS-1 … iOS-n), the risks (private frameworks breaking on Xcode updates, signing,
   CI cost), and what the closed driver cannot do that we can (physical devices).

## Process

Fan-out allowed (max 2 agents machine-wide; check the host is not in swap before adding
the second): researcher 1 = A + question 2/3 (device-stream tree, read-only); researcher
2 = B + C + question 4/5 (the fork's branches; use `git show origin/feat/ios-physical-
devices:<path>` and `git diff main...origin/feat/ios-physical-devices --stat`, no
checkout, no worktree). No builds, no `npm install`, no Xcode, no simulator. Report to
`docs/open-server/2026-09-14-ios-open-driver-research.md` (append `## Findings` sections
by researcher), every claim with a path or a commit hash. The planner writes the spec
and tickets from it.

## Findings — researcher 1 (base A: device-stream)`.

## 10-line summary

1. Base A has **two unrelated halves**: an orphaned XCUITest JSON-RPC server (`native-servers/ios-xctest-server`, ~700 LOC, no build file, no client, no tests, untouched since root commit `50e8b15` 2026-05-17) and a live, wired HID fast path (`tools/sim-input` + `packages/ios-simulator/InputService`).
2. RPC coverage vs the Android contract: **11 of 24** methods present, all the screen-graph ones (`query`/`diff`/`awaitChange`/fingerprints/`version`/`timings`/`flushInput`/`gesture`/`setClipboard`/`getInfo`) **missing**.
3. XCUITest actions are synchronous-blocking, single-pointer, no event timestamps, no multi-touch, no velocity/timeline control; `swipe` is `press(forDuration:thenDragTo:)` with `.default` velocity.
4. `sim-input` is the real asset: SimulatorKit `IOHIDEventCreateDigitizerEvent` + trackpad wrapper + 4-byte patch, verified iOS 26.4 / Xcode 26, **simulator-only**, all private symbols `dlopen`'d at runtime.
5. `sim-input`'s CLI wire exposes only tap/swipe/press/release/text — the richer Swift surface (`touch1` streaming, `touch2`, buttons, edge gestures) is **not reachable over stdin**.
6. Timing: the digitizer API accepts a timestamp but the code hardcodes `mach_absolute_time()`; pacing is host `usleep` (10 steps, ≥8 ms). No caller-controlled timeline like Android's `gesture(pointers[].tMs)`.
7. `TreeWalker` never calls `XCUIApplication.snapshot()`: it walks lazily and touches ~15 XCUIElement properties per node, each a separate IPC — expensive, flat-only, default cap 50, no nesting/multi-window.
8. Stable element identity: `element.identifier` (accessibility id) is the only candidate; Android's `idHash` is a **screen**-level hash and has no A-side equivalent.
9. **No latency numbers exist anywhere in A** — `benchmarks/token-bench` is a token-payload bench driven by the _closed_ argent server and states it is "not a latency benchmark".
10. Capture is fine for a bench (`sim-capture-avcc`, `sim-capture-private`, WDA MJPEG on device), but `tools/sim-capture` referenced by `capture-service.ts` **does not exist** in the tree.

---

## Findings — researcher 1 (base A: device-stream)

Read-only. Repo root is `/Users/heicg/Desktop/projects/device-farm` (device-stream is a subdir, not its own repo). Both iOS paths landed in the root commit `50e8b15` "Initial commit — Device Farm v3.0" (2026-05-17) and `git log -- native-servers/ios-xctest-server` / `-- tools/sim-input` show **no commit since**.

### 1. RPC coverage matrix — A vs the Android Kotlin server

Android method table: `/Users/heicg/Desktop/projects/argent-fork/packages/android-device-server/src/main/java/com/argent/devicecontrol/JsonRpcHandler.kt:124-156`.
Host contract: `/Users/heicg/Desktop/projects/argent-fork/packages/tool-server/src/blueprints/android-open-server.ts:300-520`.
A's method table: `/Users/heicg/Desktop/projects/device-farm/device-stream/native-servers/ios-xctest-server/XCTestServer/JsonRpcHandler.swift:90-123`.

| RPC (Android/host name)                                                | Android                                                                                                                                         | A (`ios-xctest-server`)                                                                                                                                          | A (`sim-input` CLI)                                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ping`                                                                 | ✓ `JsonRpcHandler.kt:153`                                                                                                                       | missing                                                                                                                                                          | n/a                                                                                                  |
| `getInfo`                                                              | ✓ `JsonRpcHandler.kt:145` (`InfoHandler`)                                                                                                       | missing (only `getCurrentApp`, a stub)                                                                                                                           | n/a                                                                                                  |
| `getScreenSize`                                                        | ✓ `JsonRpcHandler.kt:146`, ~1 ms via `DisplayReader`                                                                                            | partial — `ScreenInfo.swift:7-14` takes a **full screenshot** to read `image.size`; no rotation field                                                            | n/a                                                                                                  |
| `getAccessibilityTree` (flat)                                          | ✓ `JsonRpcHandler.kt:144`                                                                                                                       | partial `JsonRpcHandler.swift:103-104` → `TreeWalker.swift:13-27`; flat only, no `truncated`, no `waitTimeoutMs`, no `flush`                                     | missing                                                                                              |
| `getAccessibilityTree {nested:true}`                                   | ✓ via `nested` param, `android-open-server.ts:959-965` (`maxElements` 3000)                                                                     | **missing** — no nested/multi-window shape                                                                                                                       | missing                                                                                              |
| `getState`                                                             | ✓ `JsonRpcHandler.kt:147` (`StateHandler`, 17 KB: waitForIdle + tree + info + optional screenshot + `sinceVersion`/`unchanged`)                 | partial `JsonRpcHandler.swift:20-37` — screenshot+tree+app+keyboardVisible+`captureMs`; **no** waitForIdle, no info, no version/fingerprints                     | missing                                                                                              |
| `getNestedState` (host)                                                | ✓ `android-open-server.ts:966-1000`, backs `open-server-describe.ts:56-68`                                                                      | **missing**                                                                                                                                                      | missing                                                                                              |
| `query` (server-side selector)                                         | ✓ `JsonRpcHandler.kt:148`                                                                                                                       | **missing**                                                                                                                                                      | missing                                                                                              |
| `diff(sinceVersion)`                                                   | ✓ `JsonRpcHandler.kt:149`                                                                                                                       | **missing**                                                                                                                                                      | missing                                                                                              |
| `awaitChange`                                                          | ✓ `JsonRpcHandler.kt:150` (`fromVersion`/`until`/`settle`/`quietMs`)                                                                            | **missing**                                                                                                                                                      | missing                                                                                              |
| `waitForIdle`                                                          | ✓ `JsonRpcHandler.kt:151`                                                                                                                       | partial — `wait` is a bare `Thread.sleep`, `Actions/WaitAction.swift:9`                                                                                          | missing                                                                                              |
| `tap`                                                                  | ✓ `JsonRpcHandler.kt:124` + multi-tap timeline (`clickCount`/`holdMs`/`gapMs`, `open-server-input.ts:28-30`), `dropped` flag, `inject` strategy | partial `Actions/TapAction.swift:14` — `point.tap()`, no clickCount/hold/gap, no drop reporting                                                                  | partial `main.swift:103-108` — single tap, `duration: 0`                                             |
| `longPress`                                                            | ✓ `JsonRpcHandler.kt:136`                                                                                                                       | ✓ `Actions/LongPressAction.swift:17` (`press(forDuration:)`, default 1000 ms)                                                                                    | missing (no wire verb)                                                                               |
| `swipe`                                                                | ✓ `JsonRpcHandler.kt:137` — `steps`, `holdEndMs` (fling suppression), `inject`                                                                  | partial `Actions/SwipeAction.swift:22` — fixed 0.05 s press, `.default` velocity, `thenHoldForDuration` = the requested duration (semantics differ from Android) | partial `main.swift:110-121` → 10 steps, `stepMs` derived, no hold/no fling control                  |
| `gesture` (multi-pointer timeline)                                     | ✓ `JsonRpcHandler.kt:138`, `handlers/GestureHandler.kt:14-20` (`pointers[].points[].tMs`)                                                       | **missing**                                                                                                                                                      | **missing on the wire** (`touch2` exists in Swift at `IndigoHIDInput.swift:175-183` but no CLI verb) |
| `flushInput`                                                           | ✓ `JsonRpcHandler.kt:139`                                                                                                                       | **missing**                                                                                                                                                      | **missing**                                                                                          |
| `typeText`                                                             | ✓ `JsonRpcHandler.kt:140` (`sendStringSync` + shell fallback, full unicode)                                                                     | partial `Actions/TypeAction.swift:14-30` — focused-element lookup then fallbacks                                                                                 | partial `main.swift:148-163` — **ASCII only**, `Support.swift:87-111`                                |
| `setClipboard`                                                         | ✓ `JsonRpcHandler.kt:141`                                                                                                                       | **missing**                                                                                                                                                      | **missing**                                                                                          |
| `key`                                                                  | ✓ `JsonRpcHandler.kt:142`                                                                                                                       | partial `Actions/PressKeyAction.swift:13-33` — 8 named keys, rest typed as text                                                                                  | partial `main.swift:123-147` — HID usage page 7; `release` is an **acked no-op**                     |
| `screenshot`                                                           | ✓ `JsonRpcHandler.kt:143` (png/jpeg/webp, quality, scale)                                                                                       | ✓ `Actions/ScreenshotAction.swift:9-27` (jpeg only, quality+scale)                                                                                               | n/a                                                                                                  |
| `launchApp`                                                            | ✓ `JsonRpcHandler.kt:152`                                                                                                                       | ✓ `Actions/LaunchAppAction.swift:11-12`                                                                                                                          | n/a                                                                                                  |
| terminate app                                                          | missing on Android                                                                                                                              | ✓ `Actions/TerminateAppAction.swift:11-12` (A-only)                                                                                                              | n/a                                                                                                  |
| `batch`                                                                | ✓ `JsonRpcHandler.kt:154`                                                                                                                       | ✓ `JsonRpcHandler.swift:40-74`                                                                                                                                   | n/a                                                                                                  |
| `shutdown`                                                             | ✓ `JsonRpcHandler.kt:155`                                                                                                                       | missing (runner blocks on a semaphore, `XCTestServerRunner.swift:18-19`)                                                                                         | EOF on stdin, `main.swift:179`                                                                       |
| outcome variants / `timings` / `version` / `hash`/`stateHash`/`idHash` | ✓ `TreeStore.kt:98-108,246`, `handlers/StateHandler.kt:93,295`                                                                                  | **all missing**                                                                                                                                                  | n/a                                                                                                  |

Transport parity: both are newline-delimited JSON-RPC 2.0 over TCP (`XCTestServer/TCPServer.swift:103-134`; Kotlin `TCPServer.kt`), so `open-server-transport.ts` would mostly work as-is. Two deltas: A's port is **hardcoded 45679** (`XCTestServerRunner.swift:9`) while Android binds an injectable port and supports `0` = OS-assigned (`TCPServer.kt:16,22`); and A's dispatch queue is `.concurrent` (`TCPServer.swift:12`) with **no mutex** around XCUITest calls, so two connections can drive XCTest concurrently (the Android side serializes host-side via `openDeviceServerMutex`, `open-server-describe.ts:58`).

Coordinate convention: Android open server takes **device pixels** (`android-open-server.ts:296-298`). A's XCUITest actions use `app.coordinate(withNormalizedOffset: .zero).withOffset(...)` — i.e. **points relative to the app frame origin**, not the screen (`TapAction.swift:12-13`, `SwipeAction.swift:18-20`, `LongPressAction.swift:15-16`). `sim-input` takes points and normalizes by a caller-supplied `screenWidth/Height`, defaulting to 1.0×1.0 = already-normalized (`main.swift:80-89`, `IndigoHIDInput.swift:117-118`).

### 2. Injection paths

**XCUITest (`ios-xctest-server`)** — every Action is synchronous and blocking; the RPC returns only after XCTest's own implicit idle wait completes (inference from XCUITest semantics; not measured anywhere in A).

- `TapAction.swift:14` `point.tap()` — no press duration, no click count.
- `LongPressAction.swift:11-17` `press(forDuration:)`, ms→s, default 1000.
- `SwipeAction.swift:22` `startPoint.press(forDuration: 0.05, thenDragTo: endPoint, withVelocity: .default, thenHoldForDuration: duration)` — **velocity is `.default`, not derived from `durationMs`**; `durationMs` becomes the end-hold. No intermediate points, no per-step timing, so no fling/velocity control and no way to express Android's `holdEndMs` momentum-free swipe.
- `TypeAction.swift:14-30`, `PressKeyAction.swift:13-33`, `ScreenshotAction.swift:9-27`, `WaitAction.swift:9`.
- **Multi-touch: none.** No `XCUIElement.pinch`, no `XCUICoordinate` multi-pointer, no `XCUIGestureRecognizer`. There is no analogue of `GestureHandler.kt`.
- **Event timestamps: none.** XCUITest offers no API to stamp synthetic events.
- `XCUIApplication.snapshot()` is **never called** anywhere in A (verified across all 20 files under `native-servers/ios-xctest-server/`).

**`tools/sim-input` (host Swift CLI, the fast path)**

- Wire (stdin JSONL / stdout acks): `main.swift:12-20` and `docs/ios-simulator.md:299-307`. Verbs: `tap`, `swipe`, `press`, `release`, `text`. `release` is acked as a no-op because `key()` brackets down+up (`main.swift:136-146`, mirrored host-side at `packages/ios-simulator/src/input-service.ts:101-106`).
- Mechanism: `IOHIDEventCreateDigitizerEvent` (parent) + `IOHIDEventCreateDigitizerFingerEvent` (child) + `IOHIDEventAppendEvent`, wrapped by SimulatorKit's `IndigoHIDMessageForTrackpadEventFromHIDEventRef`, then **two byte slots patched** (`0x6c`/`0x10c` ← target `0x32`; `0x3a/0x3b` + `0xda/0xdb` ← edge bitmask) and dispatched through `SimDeviceLegacyHIDClient` via `sendWithMessage:freeWhenDone:completionQueue:completion:` — `IOHIDDigitizerDispatch.swift:134-239`.
- **Event types**: phases down/move/up with `IOHIDDigitizerEventMask` 0x07/0x07/0x06 (`IOHIDDigitizerDispatch.swift:66-74`). Edge flags none/left/top/right/bottom (`:39-51`) drive home-indicator and status-bar recognizers.
- **Timestamps**: the private API takes a `ts` argument, but the code passes `mach_absolute_time()` at build time (`IOHIDDigitizerDispatch.swift:172`) — so the capability exists but is **not exposed**; pacing is host-side `usleep` between sends (`:105`, `:121`, `:124`). Contrast Android `MotionInjector.kt:98-132`, which carries an explicit `downTime` and paces against a `downTime + tMs` slot schedule.
- **Multi-pointer**: `IOHIDDigitizerDispatch.send` takes a single `identifier`; `IndigoHIDInput.touch2` (`:175-183`) deliberately stays on the _legacy_ `IndigoHIDMessageForMouseNSEvent` path and its comment says the digitizer recipe "doesn't model" coincident fingers yet. `twoFingerPath` exists (`:323-345`) but is not on the CLI wire. **Practical answer: no working multi-touch on the fast path today.**
- **Keys**: `IndigoHIDMessageForHIDArbitrary(target, page, usage, op)` with modifier bracketing (`IndigoHIDInput.swift:277-304`). Character decomposition is **ASCII-only** (`Support.swift:87-111`) — no accents, no emoji, no IME. Wire-code map at `Support.swift:113-145`.
- **Buttons / system gestures** (Swift-level only, not on the CLI): home, lock, power, volume, digital crown, side buttons, app switcher (double home press), swipe-to-home (12 steps × 16 ms), swipe-to-app-switcher (30 × 35 ms + 900 ms dwell), pull-down lock screen / notification center — `IndigoHIDInput.swift:197-275`, `Support.swift:45-54`.
- **Private frameworks / versions**: `SimulatorKit` `dlopen`'d from the active developer dir (`IndigoHIDInput.swift:615-641`, `IOHIDDigitizerDispatch.swift:280-299`); IOKit symbols via `RTLD_DEFAULT`. Developer dir resolved by `xcode-select -p` with a fallback scan of `/Applications/Xcode*.app` (`Support.swift:290-323`). `Package.swift:14` requires **macOS 15+**, swift-tools 6.0; deliberately **not linked** at build time (`Package.swift:5-11`). Recipe stated as verified against **iPhone 17 Pro Max / iOS 26.4 / Xcode 26** (`IOHIDDigitizerDispatch.swift:31-33`, `IndigoHIDInput.swift:10`). Ported verbatim from baguette (Apache-2.0) with a "DO NOT modify byte layouts, timing constants, or HID event ordering" banner (`:1-3`), echoed at `docs/ios-simulator.md:287,373`.
- **Simulator-only.** Nothing in `sim-input` can reach a physical device.
- **How invoked**: `InputService` spawns one long-lived child per UDID, `spawn(binary, ['--udid', udid])`, id-stamped envelopes with an id-match + FIFO ack queue (`packages/ios-simulator/src/input-service.ts:55-58,164,213-245`); wired into `IOSSimulatorManager.tap/swipe/pressKey/typeText` (`packages/ios-simulator/src/simulator-manager.ts:19,54-105`). Build: `scripts/build-sim-input.sh:11-17` (`swift build -c release` with `DEVELOPER_DIR` forced to `/Applications/Xcode.app/Contents/Developer`, staged to `bin/sim-input`), `npm run build:sim-input`.

**Physical device**: the only paths present are WebDriverAgent over go-ios. `packages/ios-device/src/go-ios-client.ts:185-248` runs `ios runwda --xctestconfig=WebDriverAgentRunner.xctest` and `ios forward 8100/9100`; `wda-client.ts` implements tap/typeText/pressButton/screenshot/swipe/scroll/longPress/`captureUIHierarchy`/launch/terminate/activate (`:151-554`). No HID fast path exists for physical hardware in A.

**Latency numbers: none.** Grepped `benchmarks/`, `docs/ios-*.md`, `CHANGELOG.md` — `benchmarks/token-bench` measures transcript tokens only and says so explicitly: "This is a mechanical payload measurement, not a task-success or latency benchmark" (`benchmarks/token-bench/results/SUMMARY.md:63`). Its iOS configs (`A1-ios`, `A4-ios`, `F2`, `FX-ios`) drive the **closed argent simulator-server**, not `ios-xctest-server` (`benchmarks/token-bench/results/RESULTS.md:39-61`, `adapters.ts:290-337`). Environment recorded: QA-iPhone17, iOS 26.4 sim, pt-BR, Xcode 26.4 (`RESULTS.md:16`). Describe payload for iOS configs: 2753 / 1136 (`RESULTS.md:92-94`). `scenario-ios.json` records that "iOS taps are fire-and-forget (argent issue #547) so every navigation tap is verified by re-describe" — a closed-server property, relevant to bench design.

### 3. Accessibility tree

- `TreeWalker.swift:37-69` does a manual DFS from `XCUIApplication()`. For every node it calls `children(matching: .any)`, `.count`, `.element(boundBy: i)`, `.exists`.
- `TreeCompressor.shouldKeep` (`TreeCompressor.swift:17-48`) reads `isEnabled`, `elementType`, `label`, `identifier`, `value`; `ElementSerializer.serialize` (`ElementSerializer.swift:7-27`) additionally reads `frame`, `accessibilityLabel`, `isHittable`, `hasFocus`, `isSelected`.
- **Cost**: ~15 XCUIElement property accesses per surviving node, each of which resolves the query against the app under test over XCTest's IPC (inference — XCUIElement is lazy and re-resolves on access; there is no caching in this code and no `snapshot()` call). With the default 50-element cap that is on the order of 10^2–10^3 IPC round-trips per `getAccessibilityTree`. Not measured anywhere in A.
- **Limits**: `maxElements` default **50** (`TreeWalker.swift:9`), overridable per call (`:14`). Depth is unbounded. Pure layout containers (`.group`/`.other`/`.layoutArea`) that fail `shouldKeep` are not recursed into (`:49-52`) — an aggressive prune that can drop content nested under an unlabeled group. No `truncated` flag is emitted (Android sets one, `handlers/HierarchyHandler.kt:123`).
- **Output shape**: flat 1-based-indexed array of `{index, className, resourceId, text, contentDesc, bounds{x1,y1,x2,y2}, clickable, scrollable, focused, enabled, selected}` (`ElementSerializer.swift:10-27`), deliberately mimicking Android's flat `IndexedElement`. Android's equivalent fields are at `accessibility/NodeSerializer.kt:204-228` and additionally carry `packageName`, `longClickable`, `checkable`, `checked`, `focusable`, `password`, and a `children` array for the nested form. So A matches the **legacy flat** Android shape, not the nested `getNestedState` shape the describe path and `openServerNestedToDescribeNode` actually consume today (`open-server-describe.ts:64-68`).
- **Stable element identity**: the only candidate is `element.identifier` (accessibility identifier), serialized as `resourceId` (`ElementSerializer.swift:13`). No index path, no persistent handle, no hash. Android's `idHash` is **not** an element id — it is a screen-identity fingerprint, `ScreenHash.identity(roots, pkg)` stored per snapshot (`TreeStore.kt:108,246`, `accessibility/ScreenHash.kt:189`), computed FNV-1a over a canonical DFS string with host-side parity in `packages/tool-server/src/utils/screen-hash.ts` (`ScreenHash.kt:14-18`). An iOS analogue is derivable in principle from the same `(className, identifier, quantized bounds, flags)` DFS recipe, since `ElementSerializer` already produces every input field — but it does **not exist** in A, and A has no `version` clock at all, so `query`/`diff`/`awaitChange` have no substrate.
- A's _other_ describe path bypasses XCUITest entirely: `packages/ios-simulator/src/describe-ui.ts:67-79` fetches WDA `/session/{id}/source` XML and converts it to an `AXNode` (role/label/value/identifier/title/help/frame/enabled/focused/hidden/children). Its header comment says "Phase D will swap the implementation for direct AXPTranslator dispatch (the baguette recipe)" — that swap has not happened. `packages/dsl/src/drivers/ios.ts` and `selectors/wda-xml.ts` are also WDA-based.

### 4. Capture

- `packages/ios-simulator/src/capture-service.ts` manages two binaries: legacy MJPEG `sim-capture` (ScreenCaptureKit) and `sim-capture-avcc` (H.264 AVCC + JPEG seed), framing = 4-byte BE length + 1-byte tag + payload, tags 0x01 avcC / 0x02 keyframe / 0x03 delta / 0x04 jpeg-seed (`:1-12,47-48,55-60`). **Gap: `tools/sim-capture` does not exist in the tree** (only `sim-cam`, `sim-capture-avcc`, `sim-input`), so `DEFAULT_MJPEG_BINARY_PATH` (`:47`) is dead; `bin/sim-capture` is a symlink to `sim-capture-private`.
- `tools/sim-capture-avcc/Package.swift` links VideoToolbox/CoreVideo/CoreMedia/CoreGraphics/ImageIO/IOSurface with `-F <Xcode>/Library/PrivateFrameworks`, macOS 15+.
- `native-servers/sim-capture-private/README.md:1-11` — IOSurface → CVPixelBuffer → H.264 over a Unix socket, replacing the TCC-prompting ScreenCaptureKit path. **Status line says "scaffolding only (Phase 32 in progress); the daemon is a stub"**, though `Sources/{Bridge,DyldSymbols,H264Encoder,IpcServer,ScreenAttach,TouchInject,Probe}.mm` are all present and `bin/sim-capture-private` is built (129 KB). Note `Sources/TouchInject.mm` is a _second_, independent HID injection port (from kittyfarm, `IndigoHIDMessageForMouseNSEvent`) — redundant with `sim-input` and on the older mouse-event recipe that `IOHIDDigitizerDispatch.swift:8-14` says iOS 26 broke. Build needs XcodeGen + full Xcode + `xcodebuild`; binary runs **unsigned** (README "Signing" section).
- `packages/ios-device` (physical): WDA MJPEG at :9100 with a `qvh` QuickTime fallback, go-ios for pairing/forwarding (`docs/ios-device.md:3-49,183-189`; `src/mjpeg-client.ts`, `src/quicktime-capture.ts`). Requires `brew install go-ios`, a **signed** WebDriverAgent on the device, env `WDA_PORT=8100`, `MJPEG_PORT=9100`.
- Role in a bench: `sim-capture-avcc`/`sim-capture-private` give a continuous host-side frame stream independent of the driver under test — usable as the **effect oracle / fling metric source** without asking either server for screenshots (so the measurement is not censored by the driver's own capture path). `ScreenCaptureKit` would need a Screen Recording TCC grant on first run (`docs/ios-simulator.md:216`), which is a problem on a fresh CI runner; `sim-capture-private` exists specifically to avoid that.

### 5. Build, launch, signing, ports

- **`ios-xctest-server`: there is no build system.** The directory contains only 18 `.swift` + 2 `Info.plist` files — **no `.xcodeproj`, no `project.yml`, no `Package.swift`, no README, no build script**, and nothing in `package.json`, `scripts/`, `README.md` or `docs/` references it (grep across the tree finds it only in its own files). `App/AppDelegate.swift:3-4` says the host app is "minimal host app required for XCTest UI testing"; `XCTestServer/Info.plist` is `CFBundlePackageType BNDL`, `App/Info.plist` is `APPL`. Launch model is the standard UI-test one: `XCTestServerRunner.testStartServer` starts the TCP listener and blocks on a semaphore forever (`XCTestServerRunner.swift:8-20`), so it would be run via `xcodebuild test`/`test-without-building` with the test never completing. **Port 45679 hardcoded**, `allowLocalEndpointReuse = true` (`TCPServer.swift:21-23`). Simulator needs no signing; physical would need a team id and a host app — untested, and `XCUIApplication()` with no bundle id binds to the _target application_ of the test, which in this scheme is the empty host app (`AppDelegate.swift:13-16`) — so every action and the whole tree are scoped to that empty app unless the xctestrun is rewired. This is the single largest unknown in base A.
- **`sim-input`**: SwiftPM, `swift-tools-version: 6.0`, `.macOS(.v15)`, no private frameworks linked at build time (`Package.swift:1-21`); built by `scripts/build-sim-input.sh` with `DEVELOPER_DIR` pinned; consumed at `tools/sim-input/.build/release/sim-input` (`input-service.ts:55-58`) or `bin/sim-input`. No signing needed; no port — stdin/stdout only.
- **CI**: `device-stream/.github/workflows/{ci,publish}.yml` are **ubuntu-latest only**. There is no macOS job, no Xcode pin, no simulator runtime setup anywhere in A. Everything iOS in A has only ever been run on the owner's machine.

### 6. Gaps vs the Android contract, and maturity

Gaps (beyond the matrix): no `version` clock / AX event listener, so no `awaitChange`, no `diff`, no `sinceVersion`/`unchanged`, no settle semantics; no `hash`/`stateHash`/`idHash`; no per-stage `timings` (`OpenServerTimings`); no `wireBytes`/`hostParseMs` instrumentation; no injection-strategy selection or `dropped` reporting (`OpenInjectReport`); no `flushInput`; no `gesture`; no `setClipboard`; no nested multi-window tree; no `getInfo` (package/activity/rotation/keyboard as one object); no outcome-capable action variants; no host-side device mutex equivalent.

Maturity, honestly:

- `ios-xctest-server` — **prototype, effectively abandoned.** ~700 LOC, zero tests, zero build config, zero callers, unchanged since the root commit (2026-05-17, ~4 months). `ScreenInfo.getCurrentApp()` returns a hardcoded empty `bundleId` (`ScreenInfo.swift:29-32`); `getScreenSize` screenshots the screen to read a size; `TypeAction`'s `hasFocus == true` predicate over `descendants(matching: .any)` is a full-tree query per call. Treat it as a design sketch of the RPC surface, not as code to build on.
- `tools/sim-input` — **the mature asset.** Dense, commented, verbatim-ported with a provenance banner, wired to a tested host client (`packages/ios-simulator/tests/input-service.spec.ts`, 173 lines; `simulator-manager-input.spec.ts`, 65 lines) and documented (`docs/ios-simulator.md:267-307`). But: no Swift-level tests, no CI, all behaviour depends on undocumented byte offsets in a private framework at a **specific Xcode/iOS pair (26 / 26.4)**, and the CLI wire exposes a strict subset of what the Swift class can do.
- `packages/ios-simulator` / `packages/ios-device` — TypeScript is well tested (16 spec files under `ios-simulator/tests`), but the iOS describe path is WDA-based and explicitly marked "interim" (`describe-ui.ts:1-5`).

Open in my slice: (a) whether XCUITest in this host-app configuration can even see a third-party app's tree without rewiring the xctestrun — unresolved, would need a build I am not allowed to run; (b) actual per-action latency for both paths — no data exists in A, must be measured; (c) whether `IndigoHIDInput.touch2`/`twoFingerPath` still work on iOS 26.4 (their own comments say they are on the recipe that regressed).

---

## Findings — researcher 2 (base B: upstream runner; base C: closed server; CI + bench)

Read-only, from `/Users/heicg/Desktop/projects/argent-fork` via `git show origin/<branch>:<path>`.
Branch tips: **B** `feat/ios-physical-devices` = `b547b735` (2026-08-31, Sebastian Flajszer,
"chore: review & comments"), 95 commits ahead of `main`, first branch commit 2026-08-25 —
i.e. the whole branch is **one 7-day push**, never merged. Siblings: `feat/physical-ios-via-
simserver` = `e6e8a8cf` (2026-08-24, Ignacy Łątka), `feat/physical-ios-device-support` =
`275e6e07` (2026-07-22, same author, tip is a merge of `main`).
`git diff main...origin/feat/ios-physical-devices --stat`: **146 files, +12998 / −196**.

### 1. B — RPC coverage vs the Android server (same rows as researcher 1)

B is **not** a JSON-RPC-over-TCP server. It is **one HTTP/1.1 POST per command**, `Connection:
close`, envelope `{ok,data}` / `{ok,false,error{code,message,hint}}`
(`packages/ios-device-runner/PROTOCOL.md:3-28` on B). Transport is **usbmux**
(`src/utils/ios-device/usbmux.ts:19-22` — raw `/var/run/usbmuxd` `ListDevices`+`Connect` pipe),
so `open-server-transport.ts` (adb-forward / emulator `redir`, NDJSON over TCP,
`packages/tool-server/src/utils/open-server-transport.ts:1-33` on `open/main`) does **not**
apply; B ships its own stack instead (`usbmux.ts` 400 L + `usbmux-protocol.ts` 413 L +
`runner-http.ts` 152 L).

| RPC (Android/host name)                             | Android                                           | B (`ArgentRunner` + `ios-device/*`)                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping`                                              | ✓                                                 | partial — `status` without `statusCommandId` returns `{uptimeMs,state,suppressedIssues,recordedFailures}` (`ArgentRunnerSession.swift:246-273`)                                                                                                                                                                   |
| `getInfo`                                           | ✓                                                 | **missing** (no package/rotation/keyboard object)                                                                                                                                                                                                                                                                 |
| `getScreenSize`                                     | ✓                                                 | partial — `viewport` → `XCUIApplication.frame` rect, app-scoped, not the screen (`ArgentRunnerSession+Gestures.swift:116-137`)                                                                                                                                                                                    |
| `getAccessibilityTree` (flat)                       | ✓                                                 | ✓ `snapshot` — flat emission-order list (`ArgentRunnerSession+Snapshot.swift:31-73`)                                                                                                                                                                                                                              |
| `getAccessibilityTree {nested}`                     | ✓                                                 | ✓ **in shape**: flat list + `parentIndex` links reconstruct the tree (`PROTOCOL.md:132-149`); the host rebuilds it in `src/tools/describe/platforms/ios-device.ts:12,132`                                                                                                                                         |
| `getState`                                          | ✓                                                 | **missing** (no combined tree+info+screenshot call)                                                                                                                                                                                                                                                               |
| `getNestedState` (host)                             | ✓                                                 | **missing** — but the _adapter_ exists, so the describe contract is already satisfied from `snapshot`                                                                                                                                                                                                             |
| `query` (server-side selector)                      | ✓                                                 | **missing**                                                                                                                                                                                                                                                                                                       |
| `diff(sinceVersion)`                                | ✓                                                 | **missing** (no version clock)                                                                                                                                                                                                                                                                                    |
| `awaitChange`                                       | ✓                                                 | **missing**                                                                                                                                                                                                                                                                                                       |
| `waitForIdle`                                       | ✓                                                 | **missing** on the wire — XCTest's own implicit pre-event idle wait is inlined in every gesture (budget note: "gestures must outlast XCTest's ~60s pre-event idle wait", `RunnerProtocol.swift:70-76`)                                                                                                            |
| `tap`                                               | ✓ (+ clickCount/holdMs/gapMs timeline, `dropped`) | partial — `tap` + `numberOfTaps`; 2 = native `doubleTap()`, >2 = on-device loop, **no hold/gap control, no drop report** (`+Gestures.swift:21-49`)                                                                                                                                                                |
| `longPress`                                         | ✓                                                 | ✓ `longPress` `durationMs`, floor 0.05 s, default 800 ms (`+Gestures.swift:52-63`)                                                                                                                                                                                                                                |
| `swipe`                                             | ✓ (`steps`, `holdEndMs`, `inject`)                | partial — `drag` maps `durationMs` to `XCUIGestureVelocity = distance/duration` clamped **[60, 5000] pt/s**, `settle:true` = 0.3 s end-hold (else 0.05) (`+Gestures.swift:67-112`). Closer to Android than A's `.default`, still no intermediate points                                                           |
| `gesture` (multi-pointer timeline)                  | ✓                                                 | **missing** — no multi-touch anywhere in the runner                                                                                                                                                                                                                                                               |
| `flushInput`                                        | ✓                                                 | **missing**                                                                                                                                                                                                                                                                                                       |
| `typeText`                                          | ✓                                                 | ✓ `type` → `app.typeText` into the first responder, `TEXT_INPUT_NOT_FOCUSED` on focus failure (`+TextEntry.swift:6-38`); plus `keyboardReturn` (`:41-60`), which Android has no twin for                                                                                                                          |
| `setClipboard`                                      | ✓                                                 | **missing**                                                                                                                                                                                                                                                                                                       |
| `key`                                               | ✓                                                 | **missing** (only `keyboardReturn`)                                                                                                                                                                                                                                                                               |
| `screenshot`                                        | ✓ (png/jpeg/webp, quality, scale)                 | partial — `XCUIScreen.main.screenshot()` PNG, **always inline base64, no scale/quality** (`+Screenshot.swift:5-20`)                                                                                                                                                                                               |
| `launchApp`                                         | ✓                                                 | **missing by design** — `foregroundTarget` refuses `.notRunning`; launching is `launch-app`'s job via `devicectl` (`+Commands.swift:196-248`)                                                                                                                                                                     |
| terminate app                                       | missing                                           | **missing**                                                                                                                                                                                                                                                                                                       |
| `batch`                                             | ✓                                                 | **missing**                                                                                                                                                                                                                                                                                                       |
| `shutdown`                                          | ✓                                                 | ✓ `shutdown` (reply flushed, then the XCTWaiter expectation is fulfilled, `ArgentRunnerSession.swift:150-159,218-221`)                                                                                                                                                                                            |
| `timings` / `version` / `hash`/`stateHash`/`idHash` | ✓                                                 | **all missing** — wire payloads are only `Message/Health/CommandStatus/Viewport/Screenshot/Snapshot(+Quality)` (`RunnerProtocol.swift:245-319`)                                                                                                                                                                   |
| **B-only**                                          | —                                                 | `button` (`home/volumeUp/volumeDown/actionButton` with `hasHardwareButton` pre-check, `+Commands.swift:168-194`); `status{statusCommandId}` journal recovery; `commandId` send-once + in-flight coalescing (`ArgentRunnerSession.swift:286-326`); `reactivated` / `warning` envelope stamps (`PROTOCOL.md:32-47`) |

Counting the same 24 rows researcher 1 used: **B ≈ 10 present (3 partial) vs A's 11** — but the
_overlap is different_: B has no `key`, no `launchApp`, no `batch`, no `getState`; A has no
`button`, no `keyboardReturn`, no send-once. Neither is close to the screen-graph half
(`query`/`diff`/`awaitChange`/`version`/`idHash`/`timings`/`flushInput`/`gesture`/`setClipboard`):
**both bases are 0/9 there.**

Two things B has that A does not, and that matter more than the row count:

- **`app.snapshot()` — one XPC round trip for the whole tree**, flattened in-process
  (`+Snapshot.swift:38-46`, comment: "One XPC round trip captures the whole tree. Flattening it
  in-process avoids per-element AX queries and their stalls"). A walks lazily at ~15 XCUIElement
  property reads per node (researcher 1, §3). This is the single biggest technical difference
  between the two Swift bases.
- **A real describe adapter already wired to our contract**: `src/tools/describe/platforms/
ios-device.ts` + the lockstep test `test/ios-device-swift-lockstep.test.ts:9-22`, which reads
  the Swift source from disk and pins `interactiveTypes`/`scrollContainerTypes` against the TS
  `RUNNER_TYPE_TO_ROLE`/`SCROLL_CONTAINER_TYPES`.

Snapshot limits: included = interactive types ∪ scroll containers ∪ anything with label/identifier/
value, viewport-intersecting, deduped by type+texts+geometry; **node cap 1500** → `quality.state:
"degraded"`, `reasonCode:"node_cap"`; raw walk depth cap 100, emission depth cap 60 (depth drops
do **not** mark degraded) — `+Snapshot.swift:5-28,94-108`, `PROTOCOL.md:152-166`. Coordinates are
**app-frame points** (`x,y` wire → `app.coordinate(withNormalizedOffset:.zero).withOffset(x −
origin.x, …)`, `+Gestures.swift:4-17`), host converts normalized 0-1 via `viewport`
(`src/utils/ios-device/runner-commands.ts:26-33,66`). Android open server takes device **pixels**.

Build / launch / signing / reach:

- **Build**: `xcodebuild build-for-testing -project …/ArgentRunner.xcodeproj -scheme ArgentRunner
-allowProvisioningUpdates -allowProvisioningDeviceRegistration CODE_SIGN_STYLE=Automatic
DEVELOPMENT_TEAM=<team> ARGENT_RUNNER_APP_BUNDLE_ID=… ONLY_ACTIVE_ARCH=YES
ENABLE_CODE_COVERAGE=NO` (`src/utils/ios-device/runner-build.ts:262-288`), destination
  `generic/platform=iOS` or `platform=iOS,id=<udid>` (`:395-402`), into
  `~/.argent/ios-device-runner/derived` with a **`.argent-cache-key` stamp** = sha256(source tree
  hash ⊕ `xcodebuild -version` ⊕ static args) (`:103-152,180,334-380`); stamp mismatch ⇒ `rm -rf`
  the derived dir and rebuild (`:373-379`). Build budget **15 min**, log cap 64 MB (`:257-259`).
- **Signing**: `ARGENT_IOS_TEAM_ID` is **required and unconditional** —
  `resolveRunnerSigningConfig` throws without it, bundle ids derived as
  `com.argent.runner.t<teamid>` (+`.uitests`) (`runner-build.ts:45-59`; README
  `packages/ios-device-runner/README.md:49-64`). The Xcode project hardcodes no team and
  placeholder bundle ids only.
- **Launch**: `xcodebuild test-without-building -only-testing ArgentRunnerUITests/
ArgentRunnerSession/testServeCommands -test-timeouts-enabled NO -collect-test-diagnostics never
-resultBundlePath …xcresult -xctestrun <base> -destination platform=iOS,id=<udid>`, **detached +
  unref'd**, `env: TEST_RUNNER_ARGENT_RUNNER_PORT=<port>` (xcodebuild strips the prefix into the
  test process) — `runner-build.ts:471-528`. The test parks in
  `XCTWaiter.wait(for:[done], timeout: 24*60*60)` (`ArgentRunnerSession.swift:104-136`).
  Port comes from `pickFreePort` on the host, read by `configuredPort()` (`:140-148`); `0` ⇒
  OS-assigned (Xcode-run sessions only). Readiness budget **120 s** polling `status`
  (`src/blueprints/ios-device-runner.ts:157,202`; `runner-client.ts:235-275`).
- **Reach**: usbmux only, **USB cable required** (`PROTOCOL.md:9-11`); the runner binds device
  loopback and usbmux terminates there.
- **Sim vs physical**: the Xcode project declares `SUPPORTED_PLATFORMS = "iphoneos
iphonesimulator"` (`ArgentRunner.xcodeproj/project.pbxproj:238,276`), but **every host path is
  physical-only**: the xctestrun finder filters on `iphoneos` (`runner-build.ts:185-201`),
  discovery filters devicectl to physical hardware (`ios-device/devicectl.ts:222`), and the
  transport is usbmux. A simulator arm needs: relax the team-id gate, an `iphonesimulator`
  destination, and a plain `127.0.0.1:<port>` socket instead of usbmux (**inference** — the sim
  shares the host loopback, so the HTTP layer itself is unchanged).
- **npm shipping**: the Swift sources ship inside the published package; the project is resolved
  next to the bundle, overridable with `ARGENT_IOS_RUNNER_PROJECT` (`runner-build.ts:68-82`;
  README `:66-72`; commit `ee20504a` "ship the runner's Swift sources inside the npm package").
- **Tests**: 39 test files changed/added, **+5261 lines under `packages/tool-server/test`** —
  `ios-device-runner-build.test.ts` (787), `usbmux-protocol` (482), `runner-client` (508),
  `blueprints/ios-device-runner` (510), `runner-http` (231), `runner-route` (167), the Swift
  lockstep (155), plus flow/describe/button/keyboard cases. A global vitest setup file
  `test/setup/enable-ios-physical-flag.ts` flips the opt-in flag
  (`packages/tool-server/vitest.config.ts` diff). **No Swift-side tests.** One manual e2e:
  `scripts/e2e-ios-physical-device.mjs` (list-devices → launch-app → describe → tap → describe →
  screenshot, `:5-7`).
- **Review state**: two tip commits are `chore: review & comments` / `chore: review code &
comments` (`b547b735`, `d19efe82`), and the log carries ~20 `fix(...)`/`docs(...)` commits
  answering review findings. Branch has been **quiet since 2026-08-31** and is not merged into
  `main`. Reliability model is unusually mature for a spike: XCTIssue suppression with the muted
  wording pinned as contract (`ArgentRunnerSession.swift:44-98`), main-thread watchdog with
  busy/wedged escalation (`MainThreadGate.swift`, thresholds documented `PROTOCOL.md:176-202`),
  NSException guard (`ArgentExceptionGuard.m:5-14`), recorded-failure demotion of ok mutations
  (`+Commands.swift:69-91`), and a 64-entry command journal with a 16 KB retained-response cap
  (`PROTOCOL.md:104-119`).

### 2. B's two siblings

**`feat/physical-ios-via-simserver` (`e6e8a8cf`, 2026-08-24, 88 files, +5284/−298).** Mechanism:
**no new process at all** — a physical iPhone becomes _another simulator-server subcommand_.
`subcommandForDevice` gains `ios_device` ("Apple CoreDevice over USB … so physical iOS is 'just
another sim-server subcommand' like the rest", `blueprints/simulator-server.ts:167-172` on that
branch), gated by an opt-in flag checked inside `simulatorServerRef` itself so a disable takes
effect immediately (`:39-56,135-165`). `describe` reads the **iOS-26+ axAudit** service through
the same binary and adapts it in `tools/describe/platforms/ios/ios-coredevice-ax-adapter.ts:5-23`.
Dependency on the closed server: **total** — input, screenshot, describe and the tree all come
out of the proprietary binary; the open side is adapters and gating only. Why it is superseded:
the adapter header states the fatal limit — "the inspector publishes no frame attribute, so the
payload carries no `screen` and no `rect` … Every frame below is therefore **synthesised from
list position**" (`ios-coredevice-ax-adapter.ts:9-17`), i.e. a tree with **no real geometry**, and
`describe` has to tell the agent to get positions from `screenshot`. Add the reverted two-finger
work (`7a1be554` then `319e7d4b` "Revert … enable two-finger gestures on a physical iPhone",
followed by `fd0bd3ac` "correct the multi-touch limitation to what ships") and the branch's
ceiling is visible: whatever Apple's remote-control services expose, nothing more, and no way to
fix a gap without the closed source.

**`feat/physical-ios-device-support` (`275e6e07`, 2026-07-22, 53 files, +3008/−124).** Mechanism:
a **host-side CoreDevice sidecar** — `blueprints/core-device.ts` (619 L) drives Apple's
RemoteXPC "remote control" services through the **`pymobiledevice3` CLI**, with
`blueprints/coredevice-agent.py` (297 L) as a persistent per-device agent replacing per-call CLI
spawns ("each ~0.8s, ~0.5s just the Python import"), holding the RSD tunnel, the touchscreen
media-stream session and the screenshot service open and speaking NDJSON on stdin
(`coredevice-agent.py:1-23`). Verbs: `screenshot` / `tap(x,y 0..1)` / `swipe(+durationMs,steps)`
/ `button(name)` / `axtree()` (`core-device.ts:34-50`). Dependency on the closed server: **none
for control** — this is the only one of the three that is genuinely open on the device side (it
imports `pymobiledevice3.remote.core_device.hid_service`, `IndigoHIDService`,
`ScreenCaptureService`, `SpringBoardServicesService`, `coredevice-agent.py:30-40`). Why
superseded: the requirements are brutal — **iOS 27+** ("Apple gates the touch/remote-control
services to 27.0+"), `pymobiledevice3` installed, and a **root** `sudo pymobiledevice3 remote
tunneld` running (`core-device.ts:62-71`); `b73616b2`/`3975f703` show the team fighting
`CoreDeviceError 9021` as an iOS-27 gate. Same geometry hole as the sibling
(`ios-coredevice-ax-adapter.ts` 123 L version here), and the tree is a VoiceOver caption string
that has to be re-parsed into label/value/traits. A root daemon + a Python dependency +
iOS-27-only is not shippable, which is presumably why the same author moved to the
sim-server route a month later and Flajszer then moved to XCUITest a week after that.

### 3. C — the closed `simulator-server`'s iOS surface, as seen from the host

Two **separate** closed binaries, both resolved from `@argent/native-devtools-ios`
(`packages/native-devtools-ios/src/index.ts:147,183,188`):

1. **`simulator-server ios --id <udid> [--device-set …]`** — spawned by
   `blueprints/simulator-server.ts:132-200`, announces itself on stdout as `api_ready <url>` and
   `stream_ready <url>` (`:182-199`). Surface:
   - **WebSocket `ws://<host>/ws`, one JSON command per message, ack `{"id","status":"ok"}`;
     errors come back with _no id_ and are matched positionally**
     (`utils/simulator-client.ts:82-93,130-191`). Commands: `touch{type:Down|Move|Up, x, y,
second_x, second_y}`, `button{direction,button}`, `rotate{direction}`, key
     (`SimulatorServerTransport`, `:37-54`, `routeViaTransport:518-545`). Coordinates are
     **normalized 0-1**.
   - **HTTP**: `POST /api/screenshot {rotation?,scale?}` → `{url,path}` (`:432-512`, default scale
     **0.25**, `:23-26`), `POST /api/pointer {show|trail}` (touch visualiser drawn _into the frame
     stream_, `:276-318`), `POST /api/clipboard/text` (device pasteboard; 404 on builds without
     it, `:320-372`).
   - **Frame stream**: the `stream_ready` URL is an **MJPEG** stream, consumed by
     `tools/screen-recording/capture.ts:295` (`openMjpegStream`) via
     `screen-recording-start.ts:114-141`. Remote sims swap the whole transport for **MoQ/
     WebTransport** (`createMoqTransport`, `simulator-client.ts:552-597`).
   - **What it measures/returns per action: nothing.** The ack is _acceptance_, not effect —
     `sendCommand` resolves on `status:"ok"` with a **5 s** ack timeout, and the comment records
     the measured cost of that round trip: "0.06ms p50 / 0.17ms max, measured over 200 sends
     against a booted iOS sim" (`:56-61`). There is no outcome, no timing, no hash, no
     `dropped`. Researcher 1's note (`scenario-ios.json`: "iOS taps are fire-and-forget (argent
     issue #547) so every navigation tap is verified by re-describe") is consistent with what the
     host code shows — and note the _pacing is host-side_: a tap is `touch Down` → host
     `sleep(TAP_HOLD_MS=50)` → `touch Up`, multi-tap gap 100 ms
     (`tools/gesture-tap/index.ts:74-75,168-186`); a swipe is `steps = round(duration/16)` host
     frames, `Down`/`Move`×n/`Up`, with an ease-out interpolation for `momentum:false`
     (`tools/gesture-swipe/index.ts:145-257`). So every iOS gesture's timeline is **Node's event
     loop over a WebSocket**, not a device-side schedule.
2. **`ax-service` (`axServiceBinaryPath{,Tcp}`)** — `xcrun simctl spawn <udid> <binary> --socket
… --timeout 3600` (`utils/ios-host.ts:388-413`), NDJSON RPC over a unix socket
   `/tmp/ax-<udid8>.sock` (`blueprints/ax-service.ts:73-76`). API: `describe()`, `alertCheck()`,
   `ping()`, plus a `degraded` flag meaning the sim was booted outside argent so the AX
   entitlement bypass never ran (`:65-71`).
   - **describe output shape**: `{alertVisible, screenFrame?{width,height}, elements:[{label?,
frame?{x,y,width,height}, tapPoint?, traits?[], value?, identifier?}]}`
     (`ax-service.ts:50-63`) — a **flat list, frames already normalized 0-1**, no hierarchy, no
     stable node id beyond `identifier`, no version/hash. The host adapter clamps to [0,1], drops
     zero-area nodes and hangs everything off a synthetic `AXGroup` root
     (`tools/describe/platforms/ios/ios-ax-adapter.ts:13-48`). Fixtures: `test/describe-ax-adapter.
test.ts:9-60` (trait→role cases, clamping); `alertVisible` also appears in
     `test/describe-tool.test.ts`, `test/await-ui-element.test.ts`, `test/await-screen-idle.test.ts`.
   - iOS `describe` = ax-service first, **native-devtools view hierarchy as fallback** when the AX
     read is empty (`tools/describe/platforms/ios/index.ts:129-200`).
     Notably **the tree does not come from simulator-server at all**, which is what makes an iOS
     like-for-like bench awkward: swapping the _input_ backend does not swap the _tree_ backend.
3. Neutral third channel that belongs to neither: **`xcrun simctl io <udid> screenshot`** + `sips`
   downscale, already implemented for tvOS (`tools/screenshot/index.ts:78-93`).

Android bench verbs vs an iOS counterpart (Android verb list:
`packages/tool-server/scripts/bench-open-vs-proprietary.ts:7-9`):

| Android bench verb  | iOS OFF (closed)            | iOS ON (B runner)                    | iOS ON-fast (A `sim-input`)              |
| ------------------- | --------------------------- | ------------------------------------ | ---------------------------------------- |
| `gesture-tap`       | ✓ ws Down/50 ms/Up          | ✓ `tap`                              | ✓ `tap`                                  |
| `gesture-swipe`     | ✓ ws Down/Move×(d/16)/Up    | ✓ `drag` (velocity-mapped, `settle`) | ✓ 10 steps                               |
| `describe`          | ✓ ax-service                | ✓ `snapshot`                         | ✗ (no tree)                              |
| `screenshot`        | ✓ `/api/screenshot`         | ✓ inline PNG                         | ✗ (use `simctl io` / `sim-capture-avcc`) |
| `await-ui-element`  | ✓ (host poll over describe) | ✓ (same host loop)                   | ✗                                        |
| `await-screen-idle` | ✓                           | ✓                                    | ✗                                        |
| `paste`             | ✓ `/api/clipboard/text`     | ✗ **no clipboard command**           | ✗                                        |
| `gesture-pinch`     | ✓ (`second_x/second_y`)     | ✗ **no multi-touch**                 | ✗ (not on the CLI wire)                  |

So **6 of 8 verbs are like-for-like OFF↔ON; 2 (paste, pinch) have no ON counterpart** and must be
declared out of scope rather than scored.

### 4. Question 4 — build, signing, distribution, CI for B

Repo evidence for a `macos-latest` job already exists: `.github/workflows/e2e-device-smoke.yml`
has three macOS jobs (`:63` ios-sim-macos, `:108`/`:157` chromium-macos), `timeout-minutes: 30`
(`:64`), `concurrency … cancel-in-progress: true` (`:55-58`) with the rationale "rapid pushes to a
PR would otherwise stack up the slow, billed macOS jobs", and the header states the trigger policy:
"Manual + on-change trigger only — the macOS jobs are slow and billed" (`:30`).

What a bench job needs, and what already exists:

- **Closed server on the runner: yes.** `bash scripts/download-simulator-server.sh` +
  `download-native-binaries.sh` with `GH_TOKEN` (`e2e-device-smoke.yml:78-83`); the release matrix
  includes `simulator-server-argent-macos:darwin` (`scripts/download-simulator-server.sh:20-25`),
  and the dylibs + **ax-service** come from the second script (the job comment says iOS needs both,
  `:71-77`). **The OFF arm is runnable on hosted macOS today.**
- **Simulator**: the existing job does **not** call `xcrun simctl boot` — it picks a UDID with
  `xcrun simctl list devices available --json` (`:85-89`) and lets the tool-server boot it through
  `scripts/e2e/drive-device.sh` (`:91-95`). A bench wants determinism, so boot explicitly
  (`simctl boot` + `simctl bootstatus -b`) and pin the device+runtime name (**not present in the
  repo today**).
- **Xcode pin: absent.** Grepping `.github/workflows/*.yml` for `xcode|DEVELOPER_DIR|simctl`
  returns exactly one hit (the `simctl list` line above). For B this is a real hazard, not
  cosmetics: `xcodebuild -version` is an **input to the runner artifact cache key**
  (`runner-build.ts:148-153,334-354`), so a `macos-latest` image bump silently invalidates the
  cache and pays the full build again (15 min ceiling, `:257`) — and can change XCUITest gesture
  behaviour under the bench. Pin the Xcode version explicitly.
- **Signing for a simulator arm: none needed by Apple, but B forces it anyway** —
  `resolveRunnerSigningConfig` throws without `ARGENT_IOS_TEAM_ID` (`runner-build.ts:45-59`).
  A simulator bench needs that gate relaxed (the pbxproj already supports `iphonesimulator`,
  `project.pbxproj:238,276`). Physical devices on hosted runners are **explicitly impossible**:
  "Physical devices: real iOS (CoreDevice HID) and real Android (adb-USB) have no attached
  hardware on hosted runners … Both would need self-hosted runners"
  (`e2e-device-smoke.yml:26-28`).
- **Fixed per-run costs** (from the code, not measured): `build-for-testing` ≤ 15 min budget
  (`runner-build.ts:257`), runner readiness ≤ 120 s (`blueprints/ios-device-runner.ts:157`),
  simulator boot + first-frame poll 6 s (`simulator-client.ts:34`).
- **Minutes**: the Android bench is `runs-on: ubuntu-latest, timeout-minutes: 120`
  (`bench-open-vs-proprietary.yml:51-52`) — the 1× tier. The repo carries **no multiplier number**;
  GitHub bills macOS standard runners at **10×** Linux for private-repo minutes (external
  knowledge, flagged as such — nothing in this repo states it). So an iOS bench of the same wall
  clock costs ~10× the Android one; the existing macOS jobs cap at 30 min for that reason.

### 5. Question 5 — bench design sketch for iOS

**Arms.** OFF = closed `simulator-server ios` (+ ax-service for the tree). ON = B's XCUITest
runner rebuilt for `iphonesimulator`, reached on `127.0.0.1:<ARGENT_RUNNER_PORT>` instead of
usbmux (inference; the HTTP layer is unchanged). ON-fast = A's `sim-input` HID child process
(input only — it has no tree and no screenshot).

**Like-for-like verbs**: `gesture-tap`, `gesture-swipe`, `screenshot`, `describe`,
`await-ui-element`, `await-screen-idle`. **Excluded with a stated reason**: `paste` (no ON
clipboard command), `gesture-pinch` (no ON multi-touch). Because the _tree_ backend is
independent of the _input_ backend on iOS (§3), the matrix must be declared as
`input ∈ {closed-ws, xcuitest, sim-input} × tree ∈ {ax-service, xcuitest-snapshot}` and the
describe row scored **per tree backend**, never attributed to the input arm.

**Effect oracle.** The Android oracle is `resumedActivityFingerprint()` — `adb shell dumpsys
activity activities | grep mResumedActivity|topResumedActivity`, chosen because it is
**backend-independent** (`bench-open-vs-proprietary.ts:1635-1653,2092-2097`), polled after the
timed call (`:542-640`). iOS candidates, in order of preference:

1. **Neutral pixels**: `xcrun simctl io <udid> screenshot` (already shelled in
   `tools/screenshot/index.ts:93`) → perceptual hash of a fixed region. Independent of all three
   arms and of both tree backends; works for in-app navigation, which the Android activity trick
   does not cover on iOS (a Settings row tap never changes the app). Cost is a `simctl` spawn per
   poll (**inference**: 10² ms), so poll interval, not latency, is the limit.
2. **ax-service `describe()` label-set hash** — a third binary, spawned via `simctl`
   (`ios-host.ts:388-413`), so independent of the _input_ path; but it is the OFF arm's own
   describe source, so it must not also be the oracle on the describe row.
3. `launchctl list` → `UIKitApplication:<bundle-id>` (parser already exists,
   `ios-host.ts:306-314`) — only proves _running_, not frontmost, and never changes on in-app
   navigation. Too weak on its own; useful only as a crash detector.
   Recommendation: **(1) as the oracle, (3) as a liveness guard**, and record per-iteration
   `effectChecked` / `effectZero` counters exactly as the Android bench does
   (`bench-open-vs-proprietary.ts:430-439`).

**A scroll/fling metric that is not censored.** 3N-H3 (`docs/open-server/2026-09-14-review-3n-
run1-findings.md:125-136`) diagnoses the Android metric: median downward displacement of labels
surviving in **both** describes, filtered `d > 0.02`, with `if (disps.length === 0) return 1` —
so a harder fling _loses survivors and can score lower_, 127 of 355 samples land on the single
value 0.175 (the Settings row pitch), and 47 % sit on three atoms. Two design rules follow:
(a) **never derive the metric from the accessibility tree** — survivorship is what censors it;
(b) **never clamp an unmeasurable case to a legal score**.
Proposal for iOS: measure displacement **optically** from a channel neither arm owns — a vertical
strip of two `simctl io` frames (or, better, A's continuous `sim-capture-avcc` / `sim-capture-
private` stream, researcher 1 §4, which avoids the per-frame spawn and the ScreenCaptureKit TCC
prompt), cross-correlated to a sub-pixel peak offset in normalized screen height. It is
continuous, has no survivorship filter, is defined when every labelled row leaves the screen, and
its only censoring is the physical one — travel ≥ strip height — which must be **reported as a
right-censored count, not folded into the median**. Report the full per-sample array, not
`{n,p50,p95,max,min,mean}` (3N-H5, same file `:150-160`: gate decisions at ±1–3 ms were made with
no interval because the artifact kept no per-sample arrays).

**N and wall time.** Mirror the Android knobs: `BENCH_N=20`, warmup 3, cold 3
(`bench-open-vs-proprietary.ts:45-46`), blocks `OFF-1, ON-xcuitest, ON-fast, OFF-2` (the trailing
OFF block is the drift detector, `:16-18`). That is 4 blocks × 6 verbs × 20 = **480 measured
actions** plus warmups. Fixed costs per run: simulator boot, `build-for-testing` (cached after the
first run; cold ≤ 15 min), 120 s runner readiness, first-frame 6 s. No iOS per-action latency
number exists anywhere (researcher 1 §2: none in A; none in this repo either), so wall time is an
**inference**: XCUITest's implicit idle wait dominates ON (its own budget comment sizes it at
"~60s" worst case, `RunnerProtocol.swift:70-76`), so I would budget `timeout-minutes: 90` on
`macos-latest` and expect 35–60 min, then re-tune from the first run. Fling grid: reuse the
Android shape (3 durations × 2 distances × N 12, `bench-fling-fidelity.ts:8-12,25-26`) and run
each arm in its **own process** (the touch backend is chosen once at factory time, `:37-40`).

### 6. B vs A — maturity and fit with our host contract

**B is the more mature engineering artifact by a wide margin, and A is the only one with a fast
path.** B is ~12 k lines written and reviewed in one week by the upstream team, with 39 host test
files, a written wire contract (`PROTOCOL.md`), a Swift↔TS lockstep test, a send-once/journal
recovery model, a watchdog, an exception guard and an issue-suppression contract — none of which
exist in A, whose `ios-xctest-server` has zero tests, **zero build files** and has not been
touched since its root commit (researcher 1 §6). Where B is genuinely better _technically_, not
just organisationally: `app.snapshot()` (one XPC hop vs A's ~15 property reads per node),
duration→velocity mapping and a `settle` end-hold on `drag` (vs A's `.default` velocity), and a
describe adapter already speaking our `DescribeNode` contract. Where B is worse: it is
**physical-only in every host path**, it speaks **HTTP-over-usbmux** rather than the NDJSON-over-TCP
that `open-server-transport.ts` / `android-open-server-client.ts` already implement, it has no
`key`/`launchApp`/`batch`/`setClipboard`, and — like A — it is **0/9 on the screen-graph half**
of the Android contract (`query`, `diff`, `awaitChange`, `version`, `idHash`, `timings`,
`flushInput`, `gesture`, multi-touch). Fit with the host contract is therefore a wash at the
_transport_ layer (both need new plumbing) and a clear win for B at the _describe_ layer (its
adapter + lockstep test already land in `tools/describe/platforms/`), while A's `sim-input`
remains the only artifact in any of the three bases that can inject with host-controlled timing
on a simulator — which is exactly the ON-fast arm the bench needs and neither B nor C can supply.

### Open in my slice

- Whether B's runner actually builds and serves on `iphonesimulator` — the pbxproj allows it, but
  no code path exercises it and I may not build.
- Per-action latency for any iOS arm: **no number exists** in this repo or (per researcher 1) in
  A. The `0.06 ms p50` in `simulator-client.ts:56-61` is the WebSocket ack round trip only, not an
  input-to-effect latency.
- Whether `ax-service` and `simulator-server ios` can run concurrently with an XCUITest runner on
  one booted simulator (XCTest's automation session may be exclusive) — untested, and it decides
  whether the oracle can be ax-service or must be pixels.
- Exact GitHub minutes multiplier and whether this fork bills macOS minutes at all: not stated
  anywhere in the repo.
