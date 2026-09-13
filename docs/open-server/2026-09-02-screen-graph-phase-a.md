# Ticket: Screen-graph Phase A — versioned tree, hashes, query/diff/awaitChange, action outcomes

Design: `docs/specs/2026-09-02-screen-graph-architecture.md` §2.1, §3, §7.
Repo: /Users/heicg/Desktop/projects/device-farm, branch `fix/ci-failures`
(clean). Targets:
- Kotlin: `device-stream/native-servers/android-device-server/src/androidTest/java/com/devicestream/server/` (JsonRpcHandler.kt, handlers/, accessibility/NodeSerializer.kt, TreeCompressor.kt, StateHandler.kt)
- TS: `device-stream/packages/dsl/src/drivers/android-rpc.ts`, `drivers/android.ts`, `drivers/types.ts`, `session.ts`, `types.ts`, `index.ts`
Build Kotlin with `npm run build:android-server` from `device-stream/` (Java 17 + SDK present). Tests: `npx vitest run packages/dsl` from `device-stream/`. Do not commit; do not edit .md except `packages/dsl/README.md` (document new verbs). Do not touch the argent checkouts.

## A1 Versioned tree + AX-event versioning (Kotlin)
- Add `TreeStore` singleton: `version: Long`, `lastTree: SerializedTree?`,
  `lastBuiltAtVersion`. Subscribe via
  `UiAutomation.setOnAccessibilityEventListener` to
  `TYPE_WINDOW_CONTENT_CHANGED`, `TYPE_WINDOW_STATE_CHANGED`,
  `TYPE_VIEW_SCROLLED`, `TYPE_VIEW_TEXT_CHANGED`; on each, `version++`
  (debounce not needed for the counter; it is just a monotonic clock).
- `getAccessibilityTree` / `getState`: if `lastBuiltAtVersion == version` return
  the cached serialization (no UiAutomation traversal). Expose
  `traversals: Long` and `version` in `getInfo` so tests can assert cache
  hits.
- Beware the existing UiAutomation flag setup; the listener must not break
  `waitForIdle`.

## A2 Structural and state hashes (Kotlin)
- `H` = 64-bit FNV-1a (or xxHash if available without new deps) over DFS
  sequence of `(className, resourceId, quantBounds, flags)` where
  `quantBounds` = bounds divided by (screenW/32, screenH/32) integer-floored,
  flags = clickable|scrollable|editable|checkable|enabled|focused bitmask.
  `H_text` = same plus `(text, contentDescription)`.
- Recycler/list handling: for nodes whose class is a known scrolling
  container (`RecyclerView`, `ListView`, `ScrollView`, `ViewPager*`,
  `HorizontalScrollView`, or `scrollable` flag), hash the container node
  itself plus the *class sequence of its first child only*, not all
  children — for `H`. `H_text` still includes all children.
- Include `hash`, `stateHash`, `version` in `getState`, `getAccessibilityTree`
  responses.

## A3 Query, diff, awaitChange RPCs (Kotlin)
- `query {selector, limit?, fields?}`: selector JSON = DSL selector shape
  (`id`, `text` as string | `{contains|regex|equals, caseInsensitive?}`,
  `class`, `containsDescendant` (nested selector), `index`, `visible`).
  Match against the current (cached-or-rebuilt) tree; return matching
  compact node records (`id,text,cd,class,bounds,flags,path`). `path` =
  child-index path from root (stable within a version).
- `diff {sinceVersion}`: keep the previous serialized tree; keyed diff on
  `(class, resourceId, indexInParent)` → `{version, hash, stateHash,
  added:[node+path], removed:[path], changed:[path+changedFields]}`. If
  `sinceVersion == version` → empty lists, no traversal. Keep only one
  previous snapshot (memory bound).
- `awaitChange {fromVersion, timeoutMs, until?}`: block on a condition
  variable notified by the AX listener; return as soon as `version >
  fromVersion` (and, if `until` selector given, when it matches — re-check
  on each event). Return `{version, hash, stateHash, changed: bool,
  timedOut: bool}`. Must not hold the RPC dispatch thread hostage for other
  clients: run awaits on a separate executor / ensure the server handles
  concurrent connections (check current JsonRpcHandler threading; if
  single-threaded, note the limitation and implement with a max concurrent
  awaits = 4).

## A4 Action outcomes (Kotlin)
- `tap`, `longPress`, `swipe`, `typeText`, `clearText`, `key`: accept
  `outcome?: {idleTimeoutMs?: number (default 300)}`. When present, record
  `before = {version, hash}` (cached if available, else build), perform the
  action, wait for idle bounded by `idleTimeoutMs` (use the AX-event clock:
  wait until no event for 80 ms or timeout), then compute `after = {version,
  hash, stateHash}` and return `{success, before, after, changed:
  before.hash != after.hash || before.stateHash != after.stateHash,
  newScreen: before.hash != after.hash, idleMs}`. Without `outcome`, behaviour
  unchanged.

## A5 DSL driver + session (TS)
- `android-rpc.ts`: typed methods `query`, `diff`, `awaitChange`, and
  outcome-capable variants of the action methods.
- `drivers/types.ts` Driver interface: add `query(selector)`, `diff(since)`,
  `awaitChange(opts)`, `state(opts)`; iOS driver implements `query` by
  filtering its `/source` tree host-side, `diff` by host-side keyed diff of
  two `/source` reads, `awaitChange` by polling `/source` hash every 150 ms,
  `state` by hashing the parsed tree host-side with the same H/H_text
  definition (share the hash implementation in TS: `src/selectors/hash.ts`,
  unit-tested against fixture trees; the Kotlin and TS hashes must agree on
  the same tree — add a golden test with a fixture tree + expected hash
  produced by the Kotlin code, or document that they are separate spaces if
  cross-platform equality is not achievable).
- `session.ts`: `ElementHandle.tap()/fill()/longPress()` and `Session.swipe()/
  pressKey()` return an `Outcome` object `{changed, newScreen, before, after,
  idleMs}` (additive: still awaitable as before; existing callers that
  ignore the return keep working). `awaitUntil(...).toAppear()/toDisappear()/
  changeTo()` use `driver.awaitChange` with `until` where possible, falling
  back to the current poll loop on drivers that lack it.
- `Session.query(selector)`, `Session.diff(since)`, `Session.state()` public.
- Export types; document in `packages/dsl/README.md`.

## Tests
- Kotlin: unit-test hash + diff on synthetic node lists if the module has a
  JVM test source set; else TS golden tests only (state which).
- TS (vitest): hash determinism + recycler rule; diff/patch property on
  fixtures (`patch(a, diff(a,b)) deep-equals b` for compact node records);
  driver mocks: `tap()` returns outcome; `awaitUntil` calls `awaitChange`;
  iOS fallbacks.
- On-device smoke (AVD `bench-api35`, boot headless, stop argent servers
  first — `com.argent.devicecontrol`/`androiddevtools` instrumentation must
  not be running; the physical device `ZF524RZBHD` must never be targeted):
  `getInfo.traversals` does not increase across two consecutive `getState`
  calls with no UI change; `awaitChange` resolves < 100 ms after a tap; a
  tap outcome on Settings root → Network reports `newScreen: true`; typing
  in the search box reports `newScreen: false, changed: true`. Record numbers.
  Tear the emulator down.

## Acceptance
- All tests green; Kotlin builds; README updated.
- Report: RPC list with shapes, measured smoke numbers (cache-hit describe
  latency vs traversal, awaitChange latency), deviations.
