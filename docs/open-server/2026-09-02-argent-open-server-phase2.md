# Spec: argent feat/android-open-server — phase 2 (route the remaining verbs)

Date: 2026-09-02. Checkout:
/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-p3
Branch `feat/android-open-server`. FIRST: `git pull --ff-only origin feat/android-open-server`
(remote is 1 commit ahead: cacb3832 bundles manifest+APK). Commit locally in
conventional style (`feat(android-open-server): …`); do NOT push.

Context: phase 1 added blueprint `packages/tool-server/src/blueprints/android-open-server.ts`
(client API at :52-73: ping/getInfo/getAccessibilityTree/tap/longPress/swipe/
typeText/key/waitForIdle/launchApp), NDJSON JSON-RPC client
`utils/android-open-server-client.ts`, per-device lock `utils/device-mutex.ts`,
flag `open-device-server` (`packages/configuration-core/src/flags.ts:72-75`,
default off). Only 3 tools route through it: `describe`
(`tools/describe/platforms/android/index.ts:56-82`), `gesture-tap`
(`tools/gesture-tap/index.ts:111,128`), `gesture-swipe`
(`tools/gesture-swipe/index.ts:124,133`). Every path try/catches and falls
back to the legacy (proprietary) chain. The Kotlin server
(`packages/android-device-server/src/main/java/com/argent/devicecontrol/JsonRpcHandler.kt:69-84`)
already implements: tap, longPress, swipe, typeText, key, screenshot,
getAccessibilityTree, getInfo, getState, waitForIdle, launchApp, batch, shutdown.

Goal: when the flag is on, every Android verb that the open server can serve
uses it, so an Android session never needs the proprietary simulator-server
for touch/screen. Same pattern as phase 1: `shouldUseOpenServer(...)` guard,
try open server, on error log + fall back to legacy.

## T1 `screenshot` → open server
`tools/screenshot/index.ts:191` resolves `simulatorServerRef` inline. Add the
open-server branch for Android: call `screenshot` RPC (add to the client API
in the blueprint; confirm request/response shape from the Kotlin
ScreenshotHandler — likely `{quality, scale}` → base64 PNG/JPEG). Preserve
the tool's output contract (format, dimensions metadata). Fallback to SS.

## T2 `screenshot-diff` live capture → open server
`tools/screenshot-diff/index.ts:121` — reuse T1's capture helper (extract a
shared `captureAndroidScreenshot(device, services)` util so T1/T2 don't
duplicate the branch).

## T3 `gesture-custom` / `gesture-pinch` / `gesture-rotate`
`tools/gesture-custom/index.ts:88`, `gesture-pinch/index.ts:89`,
`gesture-rotate/index.ts:97`. These need multi-pointer paths. Check whether the
Kotlin server's `swipe`/gesture support accepts multi-pointer input; if not,
ADD a `gesture` RPC to the Kotlin server (UiAutomation
`injectInputEvent` with multiple pointers over a timeline: input = array of
pointer paths `[{id, points:[{x,y,tMs}]}]`) and route the three tools to it.
If Kotlin work is not feasible in this ticket (no Android SDK on the machine),
implement the TS side against the proposed RPC shape, leave the Kotlin handler
with a clear TODO + throw `-32601` unimplemented, and document in the report —
the fallback keeps behaviour intact.

## T4 `paste` (android) → open server
`tools/paste/platforms/android.ts:33` uses SS. Route to `typeText` RPC (or a
dedicated `paste` RPC if the server should set clipboard + paste; check the
Kotlin handler; `typeText` is acceptable for phase 2).

## T5 `longPress` exposure
Client API already has `longPress`; verify whether any tool exposes a long
press (`gesture-tap` with duration? `gesture-custom`?). Route it if a tool
maps to it; otherwise no-op and note it.

## T6 flow tree adapter
`flows/flow-android-tree.ts:205` still resolves `androidDevtoolsRef` directly.
Route through the same describe source selection used by
`tools/describe/platforms/android/index.ts` so flows honour the flag.

## T7 swipe semantics parity
`tools/gesture-swipe/index.ts:133-156` — open path is one RPC with
server-side interpolation; `momentum: false` and mid-gesture abort semantics
of the SS per-frame loop are lost. Either: (a) add `momentum`/`holdEndMs`
params to the Kotlin `swipe` handler (hold the last pointer position N ms
before UP to kill fling) and pass them through, or (b) when `momentum ===
false` and open server lacks support, fall back to SS for that call. Prefer
(a) if Kotlin is editable; document the choice.

## T8 `getState` / `batch` usage (latency win)
`await-screen-idle` / `await-ui-element` poll `describe`
(`utils/poll-describe-tree.ts`). When the open server is active, use
`waitForIdle` RPC before the first describe read, and use `getState` (idle +
tree + info in one RTT) where the poll loop currently does describe+info
separately. Keep output identical.

## Tests
Follow existing phase-1 test style (find tests for gesture-tap/describe open
branches under `packages/tool-server/test/`). For each routed tool: flag on →
open client called with expected args; open client throws → legacy path used
and a warning logged; flag off → open client never touched.

## Acceptance
- `packages/tool-server` vitest green; `tsc --noEmit` clean; repo `npm run lint`
  if fast enough.
- Kotlin: `npm run build:android-device-server` if Android SDK + Java 17
  present; otherwise state skipped explicitly.
- Local commits only. Report: per-ticket status, which verbs now route through
  the open server vs still on SS, and any Kotlin RPCs added/proposed.
