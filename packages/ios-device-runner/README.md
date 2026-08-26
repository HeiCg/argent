# @argent/ios-device-runner

Argent's on-device automation runner for **physical iOS devices**: an XCUITest
bundle that, instead of running a scripted test, starts an HTTP command server
and parks in an `XCTWaiter` wait for 24 hours. XCUITest is the only
Apple-supported process allowed to drive arbitrary apps on real hardware, so
Argent hosts its automation server inside one.

## Layout

```
ArgentRunner/
  ArgentRunner.xcodeproj      Two targets: ArgentRunner (placeholder host app)
                              and ArgentRunnerUITests (the runner itself).
  ArgentRunner/               Host app: a single black "Argent Runner" screen.
  ArgentRunnerUITests/
    ArgentRunnerSession.swift            Entry test + dispatch, coalescing, busy gate
    ArgentRunnerSession+Commands.swift   Target resolution, exception guard,
                                         recorded-failure detection
    ArgentRunnerSession+Gestures.swift   tap / longPress / drag / viewport
    ArgentRunnerSession+TextEntry.swift  type / keyboardReturn
    ArgentRunnerSession+Snapshot.swift   one-shot AX tree capture + flattening
    ArgentRunnerSession+Screenshot.swift inline base64 PNG
    RunnerProtocol.swift                 wire models (see PROTOCOL.md)
    RunnerHTTPServer.swift               NWListener HTTP/1.1 framing
    CommandJournal.swift                 send-once bookkeeping for lost replies
    MainThreadGate.swift                 watchdog + busy/wedged reporting
    ArgentExceptionGuard.{h,m}           @try/@catch shim for XCTest NSExceptions
```

The TypeScript side (build orchestration, transport, command client) lives in
`packages/tool-server/src/utils/ios-device/`.

## How it runs

1. The tool-server builds this project lazily with `xcodebuild
build-for-testing` (signed with the user's team; see the environment
   variables below) and caches the artifact under
   `~/.argent/ios-device-runner/derived/` keyed by sources + Xcode + signing.
2. Per session it clones the `.xctestrun` with `ARGENT_RUNNER_PORT` injected
   and launches `xcodebuild test-without-building` detached; testmanagerd
   installs and starts the runner on the device.
3. Commands travel as one HTTP POST per command over usbmux (USB cable
   only). `PROTOCOL.md` documents the contract.

## Build-time configuration

The project intentionally hardcodes no team and only placeholder bundle ids;
the tool-server injects real values on the `xcodebuild` command line:

- `ARGENT_RUNNER_APP_BUNDLE_ID` / `ARGENT_RUNNER_TEST_BUNDLE_ID`: bundle ids
  (from the `ARGENT_IOS_RUNNER_BUNDLE_ID` env var, default
  `com.swmansion.argent.runner`).
- `DEVELOPMENT_TEAM`: from `ARGENT_IOS_TEAM_ID`.
- `CODE_SIGN_IDENTITY` / `PROVISIONING_PROFILE_SPECIFIER`: from
  `ARGENT_IOS_SIGNING_IDENTITY` / `ARGENT_IOS_PROVISIONING_PROFILE`, when set.
  Either of them also switches `CODE_SIGN_STYLE` to `Manual`: xcodebuild
  refuses a manually specified profile on an automatically signed target.

`ARGENT_IOS_RUNNER_PROJECT` tells the tool-server where this project is (the
absolute path to `ArgentRunner.xcodeproj`). In a checkout it is found by
walking up from the tool-server sources, so the variable is only for unusual
layouts. An npm install of `@swmansion/argent` is one of them: the package
ships the bundled tool-server and not these Xcode sources, so physical-device
runs from an installed Argent require `ARGENT_IOS_RUNNER_PROJECT` pointing at a
checkout of this repository.

## Reliability model

- **Issue suppression**: `record(_:)` mutes two benign "Failed to get
  matching snapshot" accessibility issue shapes that would otherwise tear the
  long-lived test down; hung-query timeouts still record.
- **Watchdog**: command work runs on the main thread under a hard budget;
  overruns are abandoned (XCTest work cannot be cancelled) and the runner
  answers `RUNNER_BUSY`, escalating to `RUNNER_WEDGED` when stuck.
- **Send-once**: mutating commands are journaled by `commandId`; a client
  that lost a reply asks `status` for the command's fate instead of replaying
  it. Duplicate in-flight sends coalesce onto the single execution.
- **Explicit targeting**: app commands require `appBundleId`; the runner
  never redirects them to its own host app.
