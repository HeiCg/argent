# Ticket: phase 3n — our Kotlin injector replaces scrcpy (owner decision 2026-09-14)

Owner's ask: stop depending on scrcpy and keep our own injection path. Answer to "port
scrcpy to Rust": the part that matters runs on the device and must be Java/Kotlin
(`InputManager.injectInputEvent` is a hidden framework API reachable from a Java process
with shell uid; the proprietary driver also ships a Java APK on the device). We already
own such a process: `com.argent.devicecontrol` (instrumentation, shell uid). Its
`MotionInjector` already injects device-timestamped timelines asynchronously with a
synchronous final UP (`handlers/SwipeHandler.kt:60-107`), and `GestureHandler.kt` does
multi-pointer timelines. That path is the `ON-uiautomation` arm: scroll fidelity correct
(uia/off 1.037 at 400/0.3, run 34813849446) but RPC latency behind scrcpy: tap 78 vs 51
ms, swipe 292 vs 259 (proprietary 53 / 296–300). scrcpy's only remaining role is those
~25–35 ms, and it under-scrolls. Goal of 3n: a Kotlin injection strategy at or below
scrcpy's RPC latency with correct scroll fidelity, then scrcpy removed.

## Where the Kotlin path loses time (verify first, do not assume)
- Tap: `TapHandler.kt` uses UiAutomator's tap with built-in sync (waits for the event
  to be fully dispatched) — scrcpy returns after the socket write and defers the drain
  to the next read (`flushInput`), which the bench already flags as an asymmetry
  (headline like-for-like row is `tap+describe(settle:false)`).
- Swipe: `MotionInjector.inject` blocks on the final UP dispatch; scrcpy does not.
- Measure with the 3g stage timings per RPC (inject vs dispatch-wait vs serialize) on
  the device test before changing anything; write the numbers in the Result.

## Work
1. Injection strategies in the Kotlin server, selectable per RPC via `inject:
   "uia-sync" | "uia-async" | "input-manager"` (default unchanged = today's behaviour):
   - `uia-async`: every frame including UP via `uiAutomation.injectInputEvent(ev,
     sync=false)`; the RPC returns after the last injection call; the drain is folded
     into the next read exactly like scrcpy's `flushInput` (same `flush:true` semantics
     the reads already support), so the row is like-for-like with today's scrcpy row.
   - `input-manager`: reflection on `android.hardware.input.InputManager
     .injectInputEvent(InputEvent, int)` with `INJECT_INPUT_EVENT_MODE_ASYNC`, device
     timestamps from the timeline, same as scrcpy-server does. Guard it: if the hidden
     API is blocked in the instrumentation process (hiddenapi policy), the RPC reports
     `strategy: "unavailable"` with the exception text and falls back to `uia-async`. Do
     NOT change the device's `hidden_api_policy` silently; if CI needs it, it is a
     separate, documented workflow step and the report says so.
   - All three share `MotionInjector`'s timeline builder (device `eventTime` = down time
     + offset). Tap, swipe (momentum and held), pinch/gesture all go through it.
2. Host: `open-server-input.ts` gains a strategy selector (flag
   `open-device-server-inject-strategy` in `configuration-core/src/flags.ts`, values as
   above, default = current) and threads it into tap/swipe/gesture RPCs. The scrcpy
   backend stays in place for this phase as the control arm only.
3. Bench (`scripts/bench-open-vs-proprietary.ts`, workflow): latency blocks
   `OFF-1, ON-uia-sync, ON-uia-async, ON-input-manager, ON-scrcpy, OFF-2` (drop a block
   only if the strategy reports unavailable, and say so); fling A/B arms the same, under
   the pre-registered 3k.1 gate (two-sided ±0.15 on informative cells, n ≥ 10 every arm,
   reference-bimodality exclusion on uia/off only). Pre-registered acceptance for a
   Kotlin strategy to become the default: tap RPC and swipe RPC within the OFF-1↔OFF-2
   drift floor of the ON-scrcpy block (or faster); pinch not slower than scrcpy by more
   than the floor; first-attempt landing ≥ 95 % with the effect oracle; zero fallbacks;
   fling gate PASS on every informative cell for that arm; `tap+describe(settle:false)`
   not worse than the scrcpy arm. Write these gates in the Result before reading the run.
4. Device test: one case per strategy (tap navigates, pinch zooms, momentum swipe >
   momentum-free), plus the dumpsys MotionEvent cadence row per strategy (label 8-frame
   wire gesture, N).
5. If a strategy passes: make it the default, then REMOVE scrcpy — `@yume-chan/adb-scrcpy`,
   `@yume-chan/scrcpy`, `@yume-chan/fetch-scrcpy-server` and the `postinstall` in
   `packages/tool-server/package.json`, `scrcpy-inject-backend.ts`,
   `scrcpy-inject-timeline.ts` and their tests, the `open-device-server-fast-inject`
   flag (or repurpose it to the strategy flag with a deprecation note), the workflow's
   scrcpy fetch/pump steps and block names, `fastInjectFallbacks` counters (rename to the
   strategy's fallback counter). Docs: `packages/docs/docs/reference/` config keys for
   the removed/added flags and `docs/features/` if the user-facing text mentions
   scrcpy; run `npx docusaurus build` in `packages/docs/` and `npm run format` at the
   root (in the MAIN checkout only after merge, or say it was not run). If no strategy
   passes: keep scrcpy off by default (hybrid: Kotlin for swipes, scrcpy for tap/pinch),
   keep the dependency, and report which gate failed by how much.
6. Two CI runs budget: run 1 = measurement with all arms; run 2 = only if a code change
   after run 1 is needed to make the winning strategy default (the removal itself needs
   a run to prove nothing else broke: device test + latency + screen-graph green).

## Process
Branch `feat/open-server-3n-kotlin-injector` off `open/main` (HEAD at dispatch:
6c849ca8), worktree `../argent-fork-wt-3n` (never /tmp; root `node_modules` symlinked;
no npm install/gradle/emulator; vitest `--maxWorkers=2`; Kotlin compiles only in CI —
read every Kotlin edit twice). Another agent is finishing 3m.1 on
`fix/open-server-fingerprints-opt-in` (StateHandler / TreeStore / HierarchyHandler /
bench per-sample arrays); avoid those files; before triggering run 1, STOP and report —
the planner merges 3m.1 first, then you merge `open/main` into your branch and run.
Polling: one `gh run view` per 10 min as a single `run_in_background` Bash call
`sleep 540; gh run view <id> --json status,conclusion,jobs`; never loop; one
`gh run download` per artifact. Append `## Result` here: stage table per strategy, the
pre-registered gates with PASS/FAIL, verb table vs run 34813849446, fling per-cell per
arm, device-test outcome per strategy, what was removed, docs touched. Scoreboard
untouched; `open/main` not fast-forwarded; adversarial review before any number lands.

## Acceptance
One Kotlin strategy is the default, scrcpy is gone from the repo and the workflow, all
pre-registered gates green on the run that proves it, screen-graph job green, docs
updated — or an honest report that no strategy met the gates, with the hybrid default
and the numbers.
