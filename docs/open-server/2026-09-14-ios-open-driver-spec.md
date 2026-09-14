# Spec — open iOS driver (planner, 2026-09-14; from ticket iOS-0 findings)

## Decision: base = upstream runner core on OUR contract, `sim-input` as the fast arm
- **Device-side server**: take `origin/feat/ios-physical-devices`'s `ArgentRunner`
  (XCUITest; `app.snapshot()` = one XPC round trip for the whole tree; `drag` with
  duration→velocity and a `settle` end-hold; describe adapter + Swift↔TS lockstep test)
  and re-transport it onto the Android contract: NDJSON JSON-RPC over TCP, injectable
  port (0 = OS-assigned), same method names and shapes as `JsonRpcHandler.kt`
  (`getState`/`getNestedState` with `timings`, `tap` with clickCount/hold/gap, `swipe`
  with `steps`/`holdEndMs`, `longPress`, `typeText`, `key`, `screenshot`, `launchApp`,
  `getInfo`, `ping`, `batch`, `flushInput` as a no-op ack). Simulator AND physical: on the
  simulator the socket is loopback (no usbmux, no team id); on a physical iPhone B's
  usbmux forward + `ARGENT_IOS_TEAM_ID` signing stay. Drop B's HTTP-per-command stack
  (965 lines) so `open-server-transport.ts`, `open-server-describe.ts` and the
  screen-graph wiring apply unchanged. A's `ios-xctest-server` is used only as a
  reference for the flat serializer; it is not built on (no build system, no tests,
  scoped to an empty host app).
- **Fast arm (simulator only)**: A's `tools/sim-input` (IndigoHID digitizer, verified iOS
  26.4 / Xcode 26, Apache-2.0 provenance) as `ON-siminput`, driven from the host like
  `input-manager` on Android. Phase iOS-4 extends its wire (timeline with timestamps,
  multi-pointer when the recipe allows). Never on physical devices.
- **OFF arm**: closed `simulator-server ios` + `ax-service` (already downloaded and run on
  `macos-latest` by `e2e-device-smoke.yml`). Its ack is acceptance, not effect, and its
  gesture timelines are host-paced Node sleeps — same class of like-for-like caveats as
  Android's proprietary path.
- **Tree vs input are independent on iOS**: describe is scored per tree backend
  (`ax-service` vs XCUITest snapshot), never per input arm.
- Siblings rejected: `physical-ios-via-simserver` (closed-binary subcommand, no geometry
  in the tree), `physical-ios-device-support` (iOS 27+, root tunneld, no rects).

## What the closed driver cannot do that we will: physical iPhone (B's plumbing), and the
screen-graph observation tier (tokens) on iOS.

## Phases
- **iOS-1 — runner on our contract, simulator first.** Package
  `packages/ios-device-server/` (copy of B's ArgentRunner sources + xcodeproj, adapted):
  NDJSON/TCP transport, method table above, `timings` per stage (snapshot, serialize,
  encode), `getInfo` (bundle id, orientation, keyboard, screen size without a
  screenshot). Host: `blueprints/ios-open-server.ts` + `utils/ios-open-server-client.ts`
  reusing `open-server-transport.ts`; `shouldUseOpenServer` gains iOS; describe path
  reuses `openServerNestedToDescribeNode`. CI: `macos-latest` job with a pinned Xcode
  (`xcode-select` + `xcodebuild -version` in the log, the version in the cache key),
  `xcrun simctl boot` of a pinned runtime, build via `xcodebuild build-for-testing`,
  launch via `test-without-building` with the xctestrun pointing at the target app
  (Settings), device test: tap navigates (effect oracle = neutral pixels from
  `xcrun simctl io screenshot`), swipe scrolls, type, screenshot, getState stages sum.
  No numbers published. Physical-device path compiled but not exercised in CI (hosted
  runners cannot attach iPhones); one manual run on the owner's iPhone documented.
- **iOS-2 — like-for-like bench.** `bench-open-vs-proprietary-ios.yml` on
  `macos-latest`: blocks `OFF-1, ON-xcuitest, ON-siminput, OFF-2`, N = 20, verbs
  describe / gesture-tap / tap+describe / gesture-swipe / await-screen-idle /
  await-ui-element (paste and pinch have no ON counterpart yet; say so). Effect oracle =
  neutral pixels; fling/scroll metric = optical strip cross-correlation on simctl
  screenshots (not tree survivorship; no clamp — 3N-H3 lesson). Drift floors from
  OFF-1↔OFF-2; per-sample arrays; bootstrap CIs; pre-registered gates vs proprietary;
  adversarial review; iOS section in the scoreboard. `timeout-minutes: 90` and the
  minutes multiplier stated.
- **iOS-3 — screen graph on iOS.** `hash`/`stateHash`/`idHash` from the snapshot DFS
  (same canonical recipe as `ScreenHash.kt` / `screen-hash.ts`); `version` = hash-change
  counter (XCUITest has no AX event stream), `awaitChange` = polled snapshot hash with
  quiet window; `query`/`diff` server-side on the last snapshot; then the screen-graph
  matrix (B1/B2/O1–O5) on iOS Settings with the existing harness; tokens/step vs
  `ax-service` describe. Review; scoreboard.
- **iOS-4 — fast arm depth + physical CI.** `sim-input` wire: timeline with timestamps,
  multi-pointer (pinch) when the iOS 26 recipe supports it, keys beyond ASCII; a
  self-hosted Mac mini runner story for physical iPhones; nightly device test.

## Rules carried over
One worktree per agent under this clone; max 2 agents; CI only for numbers; one
`gh run view` per 10 min; every number names statistic/block/N/run id; pre-registered
gates; adversarial review before the scoreboard; a same-run control arm beats a
cross-run comparison; fixtures verbatim or labelled hand-built.
