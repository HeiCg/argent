# @argent/ios-device-server

Argent's open-source **XCUITest on-device automation server for iOS**, on the
same contract as `@argent/android-device-server`: NDJSON **JSON-RPC 2.0** over a
loopback TCP socket. Simulator first (iOS-1); the physical-iPhone path is
compiled but exercised manually, not in hosted CI.

- `ArgentRunner/` — the Xcode project. The server lives in the
  `ArgentRunnerUITests` bundle; `ArgentRunner` is a minimal host app XCUITest
  requires (it never participates in automation).
- Sources adapted from the upstream `feat/ios-physical-devices` runner
  (`packages/ios-device-runner`, Software Mansion): the `app.snapshot()`
  one-XPC-round-trip tree, the `drag` duration→velocity + `settle`, the hardware
  `button`, the main-thread watchdog and NSException guard are carried over. The
  HTTP/1.1-per-command transport is replaced by the NDJSON JSON-RPC TCP server.

See `PROTOCOL.md` for the wire contract and the method table.

## Build & launch (CI, macOS)

```
xcodebuild build-for-testing -project ArgentRunner/ArgentRunner.xcodeproj \
  -scheme ArgentRunner -destination 'platform=iOS Simulator,id=<udid>'
xcodebuild test-without-building -xctestrun <…>.xctestrun \
  -only-testing:ArgentRunnerUITests/ArgentRunnerSession/testServeCommands \
  -destination 'platform=iOS Simulator,id=<udid>'
```

The runner parks in a 24h `XCTWaiter` and serves commands until `shutdown`.
Simulator needs no signing; the physical path keeps upstream's
`ARGENT_IOS_TEAM_ID` auto-signing and the `iphoneos` xctestrun.

## Device-free unit tests

`RunnerSerializerTests` covers the JSON-RPC framing, the reply serializer, the
version hash and the method table without driving the UI:

```
xcodebuild test -only-testing:ArgentRunnerUITests/RunnerSerializerTests \
  -destination 'platform=iOS Simulator,id=<udid>'
```
