# Spec: @device-stream/dsl confirmed-bug batch

Date: 2026-09-02. Repo: /Users/heicg/Desktop/projects/device-farm, branch
`fix/ci-failures` (clean tree). Package: `device-stream/packages/dsl/`.
Run tests from `device-stream/` root: `npx vitest run packages/dsl`
(per-package `npm test` is broken — config rootDir mismatch; see B7).

All findings verified at HEAD by a read-only audit; file:line refs below.

## B1 (URGENT) `clear()` is destructive on Android
`src/session.ts:195-200` — taps the element then fires `pressKey('back')`
50×. Android maps `back` → keycode 4 (BACK) in `src/drivers/android.ts:21-29`,
so this dismisses the IME and walks back out of the app. On iOS `pressKey`
throws and is swallowed → no-op.

Fix:
- Android: select-all + delete via the RPC layer. Preferred: android-server
  `typeText`/`key` path — send `KEYCODE_MOVE_END` then `KEYCODE_DEL` repeated
  `text.length` times based on the element's current `.text` (read from the
  hierarchy before clearing), or if android-server exposes a `clearText`/
  `setText('')` method in `native-servers/android-device-server/.../JsonRpcHandler.kt`,
  use that. Check the Kotlin handler first; add a `clearText` RPC there (UiObject2
  `.clear()` / setText("")) if missing — that is the cleanest and cheapest.
- iOS: WDA `POST /session/:id/element/:id/clear` on the active element (tap
  first, then `element/active` → `/clear`). Add `del` key support is NOT
  required.
- Add `'delete'`/`'moveEnd'` to the Android key map only if the RPC route is
  chosen over `clearText`.
- Tests: Android driver mock asserts no `key: back` is ever sent by clear();
  iOS asserts the `/clear` endpoint is called.

## B2 `changeTo` scans root forest only
`src/session.ts:244` — `tree.some(el => …)` over roots; everywhere else uses
`flattenTree` (`src/selectors/matcher.ts:53-67`). Use flattened traversal so
in-place mutation of nested elements is detected. Test with a nested element.

## B3 iOS `waitForIdle` is a fixed ≤350ms sleep
`src/drivers/ios.ts:141-145`. WDA has no idle endpoint, but it has
`/session/:id/source` — implement idle as "two consecutive `/source` reads
are identical (hash) within `timeoutMs`, polling every 150ms", falling back
to the sleep cap only if the first read fails. Honour the caller's
`timeoutMs` (today `scrollUntilVisible`'s `settleTimeoutMs: 2000` at
`src/session.ts:126` is silently truncated to 350ms).

## B4 WDA transport has no retry/timeout
`src/drivers/ios.ts:66-70` `wdaFetch` is a bare `fetch`; `ensureSession`
`:51-64` too. Mirror the Android RPC client's robustness
(`src/drivers/android-rpc.ts:103-158`): per-request timeout (AbortController,
default 30s, configurable), 3 retries with backoff on network errors / 5xx /
"invalid session id" (re-create session then retry once). Do not retry 4xx
element-not-found. Tests with a mocked fetch.

## B5 Android `hierarchy()` silent truncation
`src/drivers/android.ts:100` `maxElements: 200`. Make it configurable via
session options (default 200 → raise default to 500), and when the server
returns exactly the cap, attach `truncated: true` to the hierarchy result and
include a hint in `ElementNotFoundError` diagnostics ("tree truncated at N
elements; raise maxElements"). Check whether the Kotlin server reports
truncation; if not, add a `truncated` boolean to its response.

## B6 `screenshot({scale})` ignored on iOS
`src/drivers/ios.ts:177-181`. WDA returns full-res PNG; apply scale host-side
(use `sharp` only if already a dependency in the monorepo — check; otherwise
use the same downscale utility the MCP screenshot path uses, or skip with a
documented warning). Must keep the 1MiB cap behaviour consistent with Android.

## B7 per-package `npm test` broken
`device-stream/packages/dsl/package.json:14` runs
`vitest run --config ../../vitest.config.ts`; the include globs in
`device-stream/vitest.config.ts` are root-relative so from the package dir no
files match. Fix so `npm test` inside the package works (e.g. `--root ../..`
plus a filter on `packages/dsl`, or a package-local config extending root).
Apply the same fix to sibling packages only if they use the identical script.

## Also (cheap, same files)
- `grantPermissions('*')` on Android swallows every failure
  (`src/drivers/android.ts:147`): collect failures and throw an aggregated
  error listing them after attempting all grants.
- Document in `README.md` (dsl) that `setLocation` on Android is
  emulator-only (`adb emu geo fix`).

## Acceptance
- `npx vitest run packages/dsl` from `device-stream/` green incl. new tests.
- `npm run lint` (device-stream root tsc) clean for dsl (+ android-server if
  Kotlin/TS client touched — TS side only; Kotlin changes must compile with
  `npm run build:android-server` if the SDK is available, else note skipped).
- No commit; report per-item status + counts.
