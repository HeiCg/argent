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
