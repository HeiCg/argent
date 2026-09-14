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
9. **No latency numbers exist anywhere in A** — `benchmarks/token-bench` is a token-payload bench driven by the *closed* argent server and states it is "not a latency benchmark".
10. Capture is fine for a bench (`sim-capture-avcc`, `sim-capture-private`, WDA MJPEG on device), but `tools/sim-capture` referenced by `capture-service.ts` **does not exist** in the tree.

---

## Findings — researcher 1 (base A: device-stream)

Read-only. Repo root is `/Users/heicg/Desktop/projects/device-farm` (device-stream is a subdir, not its own repo). Both iOS paths landed in the root commit `50e8b15` "Initial commit — Device Farm v3.0" (2026-05-17) and `git log -- native-servers/ios-xctest-server` / `-- tools/sim-input` show **no commit since**.

### 1. RPC coverage matrix — A vs the Android Kotlin server

Android method table: `/Users/heicg/Desktop/projects/argent-fork/packages/android-device-server/src/main/java/com/argent/devicecontrol/JsonRpcHandler.kt:124-156`.
Host contract: `/Users/heicg/Desktop/projects/argent-fork/packages/tool-server/src/blueprints/android-open-server.ts:300-520`.
A's method table: `/Users/heicg/Desktop/projects/device-farm/device-stream/native-servers/ios-xctest-server/XCTestServer/JsonRpcHandler.swift:90-123`.

| RPC (Android/host name) | Android | A (`ios-xctest-server`) | A (`sim-input` CLI) |
|---|---|---|---|
| `ping` | ✓ `JsonRpcHandler.kt:153` | missing | n/a |
| `getInfo` | ✓ `JsonRpcHandler.kt:145` (`InfoHandler`) | missing (only `getCurrentApp`, a stub) | n/a |
| `getScreenSize` | ✓ `JsonRpcHandler.kt:146`, ~1 ms via `DisplayReader` | partial — `ScreenInfo.swift:7-14` takes a **full screenshot** to read `image.size`; no rotation field | n/a |
| `getAccessibilityTree` (flat) | ✓ `JsonRpcHandler.kt:144` | partial `JsonRpcHandler.swift:103-104` → `TreeWalker.swift:13-27`; flat only, no `truncated`, no `waitTimeoutMs`, no `flush` | missing |
| `getAccessibilityTree {nested:true}` | ✓ via `nested` param, `android-open-server.ts:959-965` (`maxElements` 3000) | **missing** — no nested/multi-window shape | missing |
| `getState` | ✓ `JsonRpcHandler.kt:147` (`StateHandler`, 17 KB: waitForIdle + tree + info + optional screenshot + `sinceVersion`/`unchanged`) | partial `JsonRpcHandler.swift:20-37` — screenshot+tree+app+keyboardVisible+`captureMs`; **no** waitForIdle, no info, no version/fingerprints | missing |
| `getNestedState` (host) | ✓ `android-open-server.ts:966-1000`, backs `open-server-describe.ts:56-68` | **missing** | missing |
| `query` (server-side selector) | ✓ `JsonRpcHandler.kt:148` | **missing** | missing |
| `diff(sinceVersion)` | ✓ `JsonRpcHandler.kt:149` | **missing** | missing |
| `awaitChange` | ✓ `JsonRpcHandler.kt:150` (`fromVersion`/`until`/`settle`/`quietMs`) | **missing** | missing |
| `waitForIdle` | ✓ `JsonRpcHandler.kt:151` | partial — `wait` is a bare `Thread.sleep`, `Actions/WaitAction.swift:9` | missing |
| `tap` | ✓ `JsonRpcHandler.kt:124` + multi-tap timeline (`clickCount`/`holdMs`/`gapMs`, `open-server-input.ts:28-30`), `dropped` flag, `inject` strategy | partial `Actions/TapAction.swift:14` — `point.tap()`, no clickCount/hold/gap, no drop reporting | partial `main.swift:103-108` — single tap, `duration: 0` |
| `longPress` | ✓ `JsonRpcHandler.kt:136` | ✓ `Actions/LongPressAction.swift:17` (`press(forDuration:)`, default 1000 ms) | missing (no wire verb) |
| `swipe` | ✓ `JsonRpcHandler.kt:137` — `steps`, `holdEndMs` (fling suppression), `inject` | partial `Actions/SwipeAction.swift:22` — fixed 0.05 s press, `.default` velocity, `thenHoldForDuration` = the requested duration (semantics differ from Android) | partial `main.swift:110-121` → 10 steps, `stepMs` derived, no hold/no fling control |
| `gesture` (multi-pointer timeline) | ✓ `JsonRpcHandler.kt:138`, `handlers/GestureHandler.kt:14-20` (`pointers[].points[].tMs`) | **missing** | **missing on the wire** (`touch2` exists in Swift at `IndigoHIDInput.swift:175-183` but no CLI verb) |
| `flushInput` | ✓ `JsonRpcHandler.kt:139` | **missing** | **missing** |
| `typeText` | ✓ `JsonRpcHandler.kt:140` (`sendStringSync` + shell fallback, full unicode) | partial `Actions/TypeAction.swift:14-30` — focused-element lookup then fallbacks | partial `main.swift:148-163` — **ASCII only**, `Support.swift:87-111` |
| `setClipboard` | ✓ `JsonRpcHandler.kt:141` | **missing** | **missing** |
| `key` | ✓ `JsonRpcHandler.kt:142` | partial `Actions/PressKeyAction.swift:13-33` — 8 named keys, rest typed as text | partial `main.swift:123-147` — HID usage page 7; `release` is an **acked no-op** |
| `screenshot` | ✓ `JsonRpcHandler.kt:143` (png/jpeg/webp, quality, scale) | ✓ `Actions/ScreenshotAction.swift:9-27` (jpeg only, quality+scale) | n/a |
| `launchApp` | ✓ `JsonRpcHandler.kt:152` | ✓ `Actions/LaunchAppAction.swift:11-12` | n/a |
| terminate app | missing on Android | ✓ `Actions/TerminateAppAction.swift:11-12` (A-only) | n/a |
| `batch` | ✓ `JsonRpcHandler.kt:154` | ✓ `JsonRpcHandler.swift:40-74` | n/a |
| `shutdown` | ✓ `JsonRpcHandler.kt:155` | missing (runner blocks on a semaphore, `XCTestServerRunner.swift:18-19`) | EOF on stdin, `main.swift:179` |
| outcome variants / `timings` / `version` / `hash`/`stateHash`/`idHash` | ✓ `TreeStore.kt:98-108,246`, `handlers/StateHandler.kt:93,295` | **all missing** | n/a |

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
- **Multi-pointer**: `IOHIDDigitizerDispatch.send` takes a single `identifier`; `IndigoHIDInput.touch2` (`:175-183`) deliberately stays on the *legacy* `IndigoHIDMessageForMouseNSEvent` path and its comment says the digitizer recipe "doesn't model" coincident fingers yet. `twoFingerPath` exists (`:323-345`) but is not on the CLI wire. **Practical answer: no working multi-touch on the fast path today.**
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
- A's *other* describe path bypasses XCUITest entirely: `packages/ios-simulator/src/describe-ui.ts:67-79` fetches WDA `/session/{id}/source` XML and converts it to an `AXNode` (role/label/value/identifier/title/help/frame/enabled/focused/hidden/children). Its header comment says "Phase D will swap the implementation for direct AXPTranslator dispatch (the baguette recipe)" — that swap has not happened. `packages/dsl/src/drivers/ios.ts` and `selectors/wda-xml.ts` are also WDA-based.

### 4. Capture

- `packages/ios-simulator/src/capture-service.ts` manages two binaries: legacy MJPEG `sim-capture` (ScreenCaptureKit) and `sim-capture-avcc` (H.264 AVCC + JPEG seed), framing = 4-byte BE length + 1-byte tag + payload, tags 0x01 avcC / 0x02 keyframe / 0x03 delta / 0x04 jpeg-seed (`:1-12,47-48,55-60`). **Gap: `tools/sim-capture` does not exist in the tree** (only `sim-cam`, `sim-capture-avcc`, `sim-input`), so `DEFAULT_MJPEG_BINARY_PATH` (`:47`) is dead; `bin/sim-capture` is a symlink to `sim-capture-private`.
- `tools/sim-capture-avcc/Package.swift` links VideoToolbox/CoreVideo/CoreMedia/CoreGraphics/ImageIO/IOSurface with `-F <Xcode>/Library/PrivateFrameworks`, macOS 15+.
- `native-servers/sim-capture-private/README.md:1-11` — IOSurface → CVPixelBuffer → H.264 over a Unix socket, replacing the TCC-prompting ScreenCaptureKit path. **Status line says "scaffolding only (Phase 32 in progress); the daemon is a stub"**, though `Sources/{Bridge,DyldSymbols,H264Encoder,IpcServer,ScreenAttach,TouchInject,Probe}.mm` are all present and `bin/sim-capture-private` is built (129 KB). Note `Sources/TouchInject.mm` is a *second*, independent HID injection port (from kittyfarm, `IndigoHIDMessageForMouseNSEvent`) — redundant with `sim-input` and on the older mouse-event recipe that `IOHIDDigitizerDispatch.swift:8-14` says iOS 26 broke. Build needs XcodeGen + full Xcode + `xcodebuild`; binary runs **unsigned** (README "Signing" section).
- `packages/ios-device` (physical): WDA MJPEG at :9100 with a `qvh` QuickTime fallback, go-ios for pairing/forwarding (`docs/ios-device.md:3-49,183-189`; `src/mjpeg-client.ts`, `src/quicktime-capture.ts`). Requires `brew install go-ios`, a **signed** WebDriverAgent on the device, env `WDA_PORT=8100`, `MJPEG_PORT=9100`.
- Role in a bench: `sim-capture-avcc`/`sim-capture-private` give a continuous host-side frame stream independent of the driver under test — usable as the **effect oracle / fling metric source** without asking either server for screenshots (so the measurement is not censored by the driver's own capture path). `ScreenCaptureKit` would need a Screen Recording TCC grant on first run (`docs/ios-simulator.md:216`), which is a problem on a fresh CI runner; `sim-capture-private` exists specifically to avoid that.

### 5. Build, launch, signing, ports

- **`ios-xctest-server`: there is no build system.** The directory contains only 18 `.swift` + 2 `Info.plist` files — **no `.xcodeproj`, no `project.yml`, no `Package.swift`, no README, no build script**, and nothing in `package.json`, `scripts/`, `README.md` or `docs/` references it (grep across the tree finds it only in its own files). `App/AppDelegate.swift:3-4` says the host app is "minimal host app required for XCTest UI testing"; `XCTestServer/Info.plist` is `CFBundlePackageType BNDL`, `App/Info.plist` is `APPL`. Launch model is the standard UI-test one: `XCTestServerRunner.testStartServer` starts the TCP listener and blocks on a semaphore forever (`XCTestServerRunner.swift:8-20`), so it would be run via `xcodebuild test`/`test-without-building` with the test never completing. **Port 45679 hardcoded**, `allowLocalEndpointReuse = true` (`TCPServer.swift:21-23`). Simulator needs no signing; physical would need a team id and a host app — untested, and `XCUIApplication()` with no bundle id binds to the *target application* of the test, which in this scheme is the empty host app (`AppDelegate.swift:13-16`) — so every action and the whole tree are scoped to that empty app unless the xctestrun is rewired. This is the single largest unknown in base A.
- **`sim-input`**: SwiftPM, `swift-tools-version: 6.0`, `.macOS(.v15)`, no private frameworks linked at build time (`Package.swift:1-21`); built by `scripts/build-sim-input.sh` with `DEVELOPER_DIR` pinned; consumed at `tools/sim-input/.build/release/sim-input` (`input-service.ts:55-58`) or `bin/sim-input`. No signing needed; no port — stdin/stdout only.
- **CI**: `device-stream/.github/workflows/{ci,publish}.yml` are **ubuntu-latest only**. There is no macOS job, no Xcode pin, no simulator runtime setup anywhere in A. Everything iOS in A has only ever been run on the owner's machine.

### 6. Gaps vs the Android contract, and maturity

Gaps (beyond the matrix): no `version` clock / AX event listener, so no `awaitChange`, no `diff`, no `sinceVersion`/`unchanged`, no settle semantics; no `hash`/`stateHash`/`idHash`; no per-stage `timings` (`OpenServerTimings`); no `wireBytes`/`hostParseMs` instrumentation; no injection-strategy selection or `dropped` reporting (`OpenInjectReport`); no `flushInput`; no `gesture`; no `setClipboard`; no nested multi-window tree; no `getInfo` (package/activity/rotation/keyboard as one object); no outcome-capable action variants; no host-side device mutex equivalent.

Maturity, honestly:
- `ios-xctest-server` — **prototype, effectively abandoned.** ~700 LOC, zero tests, zero build config, zero callers, unchanged since the root commit (2026-05-17, ~4 months). `ScreenInfo.getCurrentApp()` returns a hardcoded empty `bundleId` (`ScreenInfo.swift:29-32`); `getScreenSize` screenshots the screen to read a size; `TypeAction`'s `hasFocus == true` predicate over `descendants(matching: .any)` is a full-tree query per call. Treat it as a design sketch of the RPC surface, not as code to build on.
- `tools/sim-input` — **the mature asset.** Dense, commented, verbatim-ported with a provenance banner, wired to a tested host client (`packages/ios-simulator/tests/input-service.spec.ts`, 173 lines; `simulator-manager-input.spec.ts`, 65 lines) and documented (`docs/ios-simulator.md:267-307`). But: no Swift-level tests, no CI, all behaviour depends on undocumented byte offsets in a private framework at a **specific Xcode/iOS pair (26 / 26.4)**, and the CLI wire exposes a strict subset of what the Swift class can do.
- `packages/ios-simulator` / `packages/ios-device` — TypeScript is well tested (16 spec files under `ios-simulator/tests`), but the iOS describe path is WDA-based and explicitly marked "interim" (`describe-ui.ts:1-5`).

Open in my slice: (a) whether XCUITest in this host-app configuration can even see a third-party app's tree without rewiring the xctestrun — unresolved, would need a build I am not allowed to run; (b) actual per-action latency for both paths — no data exists in A, must be measured; (c) whether `IndigoHIDInput.touch2`/`twoFingerPath` still work on iOS 26.4 (their own comments say they are on the recipe that regressed).
