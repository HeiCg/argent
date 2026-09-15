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
- Reach: simulator = host `127.0.0.1:<port>` (shared loopback); physical device =
  usbmux forward onto the device loopback.

## Coordinates and geometry

All input coordinates are **screen points** (the same space as
`XCUIElementSnapshot.frame`). The host converts from its normalized 0–1 points
against the screen size from `getInfo` / `getScreenSize`. `getInfo` reads the
screen size in points and the scale from `UIScreen.main` — never from a
screenshot. Node `bounds` are `{x1,y1,x2,y2}` in screen points.

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
