# Ticket: open-server phase 3c — remove hidden UiAutomator idle gates, one-RPC describe

Repo: ARGENT FORK checkout
`/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-p3`,
branch `feat/android-open-server` @ 3113010b (pushed). Commit locally,
conventional style; do not push. AVD `bench-api35` (`-grpc 8554
-grpc-use-token`); never `ZF524RZBHD`. Another agent may be finishing a
measurement run on the AVD — check `adb devices`; if `emulator-5554` is up
and not yours, do all code work first and poll every 60 s (≤ 30 min) before
booting your own.

Root cause (code diagnosis, decompiled uiautomator 2.3.0): several
`UiDevice` getters call `waitForIdle()` implicitly = `UiAutomation.waitForIdle(500 quiescence, 10 s cap)`:
`getDisplayRotation()`, `getCurrentPackageName()`. `getDisplayWidth/Height`
do not. The open path hits these on EVERY gesture (`getScreenSize` peek) and
twice more in `getInfo`, and the describe path uses `waitForIdle(2000)`
where the proprietary comparator uses 500. The injector itself is correct
(one multi-pointer MotionEvent per frame, real-clock pacing, ~22 events for
a 300 ms pinch).

## Fixes

1. **Idle-free rotation/package reads (Kotlin).**
   `handlers/InfoHandler.kt:33-39` (`screenSize`): read rotation and real
   size from the SAME `Display` object
   (`context.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)`,
   `display.rotation`, `display.getRealSize(point)` / `getRealMetrics`),
   never `uiDevice.displayRotation`. Same in `InfoHandler.kt:17,20`
   (`getInfo`) and `handlers/StateHandler.kt:87,89`: replace
   `uiDevice.currentPackageName` with the package of
   `uiAutomation.rootInActiveWindow?.packageName` (already obtained for the
   tree; if null, fall back to `windows.firstOrNull{ it.isActive }?.root?.packageName`),
   and rotation as above. Fix the wrong doc comments at `InfoHandler.kt:26-32`
   and `blueprints/android-open-server.ts:37-41` ("~1 ms even mid-animation")
   to state the truth and the rule: "never call UiDevice getters that
   trigger waitForIdle on hot paths".
   Grep the whole server for other implicit-idle callers
   (`uiDevice.currentPackageName`, `uiDevice.displayRotation`,
   `uiDevice.currentActivityName`, `uiDevice.click`, `UiObject2`, `wait(`),
   list them in the report, and remove any on tap/swipe/gesture/describe/
   state paths.

2. **Describe = one RPC, comparator-matched idle cap.**
   `tools/describe/platforms/android/index.ts:68-71`: replace the fake
   `Promise.all([getAccessibilityTree{nested}, getInfo])` with a single
   `server.getNestedState({ waitTimeoutMs: 500 })` (as
   `utils/open-server-describe.ts:34` already does); keep the `await-*`
   paths at their current `waitTimeoutMs`. Surface `waitedMs`/`captureMs`
   from `StateHandler` in the describe result metadata (not in the rendered
   text) so the idle-vs-capture split is measurable. Also convert the ADT
   branch's `Promise.all` at `:113` to sequential-but-single if it is the
   same fake pattern — only if trivially safe; otherwise leave it and note.

3. **Client concurrency.** `utils/android-open-server-client.ts:50-64`
   serializes all requests on one chain, so `Promise.all` never overlaps.
   Keep serialization (the device server is single-thread per connection),
   but document it, and make sure no caller relies on parallelism.

4. **Serializer payload.** `accessibility/NodeSerializer.kt` nested JSON
   emits ~15 booleans per node; emit only true flags (omit false) and omit
   empty strings. Host `nestedToParsed` (`open-server-tree.ts`) must treat
   missing as false/empty. Golden tests (F14) must still produce identical
   `formatDescribeTree` output. Do NOT prune by `isImportantForAccessibility`
   in this ticket (fidelity risk); report `captureMs` so we can decide later.

5. **Bench fairness.** `scripts/bench-open-vs-proprietary.ts:599-610`:
   give `gesture-pinch` the same untimed per-iteration reset the other
   gestures get (reset Chrome zoom to minimum + untimed `await-screen-idle`
   before each iteration). Add `describe` variant `describe(after-tap)` if
   not already the `tap+describe` verb. Assert in the script that both
   backends run identical `holdMs`/`durationMs`.

## Tests
- Unit (vitest): describe open path issues exactly one RPC (`getNestedState`)
  with `waitTimeoutMs: 500`; serializer-omitted flags parse as false (golden
  outputs unchanged); bench parity assertion present.
- Device test: extend `android-open-server.device.test.ts` with a timing
  assertion: 5 consecutive `getScreenSize` calls during a running animation
  (start a swipe fling, then call) each return in < 50 ms.
- On-device bench (N=20, OFF-1/ON/OFF-2) for: gesture-tap, gesture-swipe,
  gesture-pinch, describe, tap+describe, await-ui-element, await-screen-idle,
  paste. Also record `waitedMs`/`captureMs` p50 for describe on an idle
  screen and for tap+describe.

## Targets (measured, like-for-like, p50)
- gesture-pinch ON ≤ 1.1× OFF (expected ~340 vs 340).
- tap+describe ON ≤ 1.2× OFF (expected ~800 vs 700; if `captureMs` shows
  serialization is the residual, say so with the number — do not prune).
- gesture-tap ON ≤ OFF + 5 ms.
- describe tokens still identical (o200k) on both screens; goldens green.
- 0 fallbacks; suite green; APK builds.

## Output
Report v4: `/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-02-open-vs-proprietary-results-v4.md`
(same layout as v3, plus `waitedMs/captureMs` table and the list of removed
implicit-idle call sites). Tear down the emulator.
