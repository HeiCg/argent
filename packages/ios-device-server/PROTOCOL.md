# Argent iOS open server — wire protocol

The open iOS server speaks the **same contract as the open Android server**
(`@argent/android-device-server`): newline-delimited **JSON-RPC 2.0** over a
loopback **TCP** socket. One request object per line; one `\n`-terminated reply
line per request. The server processes requests serially on one dispatch queue,
so no two XCUITest interactions ever overlap.

The runner is an XCUITest bundle. It targets **another app by bundle id**
(`launchApp`), never its own empty host app — this is how it drives Settings
(`com.apple.Preferences`).

- Transport: `RunnerLineServer` (NWListener, loopback, `allowLocalEndpointReuse`).
- Port: `TEST_RUNNER_ARGENT_RUNNER_PORT` (xcodebuild strips it to
  `ARGENT_RUNNER_PORT`). `0` = OS-assigned; the bound port is printed as
  `ARGENT_RUNNER_LISTENING port=<n>`.
- Reach: simulator = host `127.0.0.1:<port>` (shared loopback). Simulators only;
  physical iPhones use the upstream runner.

## Coordinates and geometry

All input coordinates are **screen points** (the same space as
`XCUIElementSnapshot.frame`). The host converts from its normalized 0–1 points
against the screen size from `getInfo` / `getScreenSize`. Node `bounds` are
`{x1,y1,x2,y2}` in screen points.

Geometry fields (`getInfo`, `getScreenSize`, `getState`/`getNestedState`
`info`):

- `screenWidth`, `screenHeight`: the point size of the screen as the target app
  sees it: the target app's frame when it is in the foreground (on the state
  methods, the snapshot root's frame), else SpringBoard's. 402×874 on an
  iPhone 17 in portrait. `orientation` is `portrait` when width ≤ height.
- `scale`: framebuffer pixels per point, rounded to 0.01: the panel's long side
  in pixels over the long side in points. The panel size comes from one
  `XCUIScreen` screenshot per session. 3 on an iPhone 17; `screenHeight × scale`
  is the height of a `simctl io screenshot`.

The runner does not use its own `UIScreen.main`: the test code runs in the
XCTest runner app, which Xcode generates without a launch screen, so iOS runs it
in compatibility mode. There `bounds` is a 320×480-class size and `nativeBounds`
follows the same mode (1440 px tall on an iPhone 17, not 2622).

`getScreenSize` answers from a per-session cache keyed by the target app and the
device orientation, so the call the host makes before every gesture reads no
accessibility state. `launchApp` and `terminateApp` clear the cached point size;
`getInfo`, `getState` and `getNestedState` read it fresh and refresh the cache.

## Methods (iOS-1)

| method           | params                                                                | result                                                                                |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ping`           | —                                                                     | `{status:"ok"}`                                                                       |
| `getInfo`        | —                                                                     | `{bundleId, orientation, keyboardVisible, screenWidth, screenHeight, scale, version}` |
| `getScreenSize`  | —                                                                     | `{screenWidth, screenHeight, scale}`                                                  |
| `getState`       | `includeScreenshot?`, `maxElements?` (1500)                           | `{tree, truncated, info, version, timings, screenshot?}`                              |
| `getNestedState` | `maxElements?`                                                        | as `getState`, never a screenshot                                                     |
| `tap`            | `x, y, clickCount?, holdMs?, gapMs?`                                  | `{success, dropped:false, dropReporting:"unsupported"}`                               |
| `longPress`      | `x, y, durationMs?`                                                   | `{success}`                                                                           |
| `swipe`          | `startX, startY, endX, endY, steps?, holdEndMs?, durationMs?`         | `{success}`                                                                           |
| `typeText`       | `text`                                                                | `{success, charsTyped}`                                                               |
| `key`            | `key` (return/delete/escape or home/volumeUp/volumeDown/actionButton) | `{success}`                                                                           |
| `screenshot`     | `format?` (png/jpeg), `quality?`, `scale?`                            | `{data, mimeType, width, height}`                                                     |
| `launchApp`      | `bundleId`                                                            | `{success, bundleId}`                                                                 |
| `terminateApp`   | `bundleId?`                                                           | `{success, bundleId}`                                                                 |
| `flushInput`     | —                                                                     | `{success}` (ack no-op)                                                               |
| `batch`          | `actions:[{method,params}]`                                           | `{results:[…]}`                                                                       |
| `shutdown`       | —                                                                     | `{status:"ok"}`, then the session ends                                                |

`swipe` `durationMs` sets the drag velocity: `distance / (durationMs / 1000)`
points per second, clamped to [60, 5000]. Without it XCUITest's default velocity
applies. A zero-length swipe with `durationMs` is a press of that length. `steps`
is accepted and ignored (XCUITest interpolates its own drag).

App-scoped methods (`getState`, `getNestedState`, `tap`, `longPress`, `swipe`,
`typeText`, keyboard `key`s) also take an optional `bundleId` that overrides the
`launchApp` target for that call.

`tree` is the **nested** shape: each node is
`{type, label?, identifier?, value?, bounds{x1,y1,x2,y2}, enabled, hittable,
selected, focused, children:[…]}`. `version` is a monotonic counter that advances
only when the canonical snapshot hash changes. `timings` is
`{snapshotMs, serializeMs, encodeMs, captureMs}` with
`snapshotMs + serializeMs + encodeMs ≈ captureMs`.

## Deferred to iOS-2/3/4 (answered `-32004` "unsupported")

`query`, `diff`, `awaitChange`, `gesture` (multi-pointer), `setClipboard`,
`getAccessibilityTree`, `waitForIdle`, and the screen fingerprints
(`hash`/`stateHash`/`idHash`).

An unknown method returns `-32601` "Method not found".
