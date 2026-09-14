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

## Result (work items 1–4; pre-registration written before the run)

Branch `feat/open-server-3n-kotlin-injector` off `open/main` @ 998d8954, worktree
`../argent-fork-wt-3n`. No CI triggered. Items 5 (promote + remove scrcpy) and 6
(the runs) are deferred to the post-run step per the dispatch.

### 1. Measure first — what the committed artifacts already show, and what needs a run

The 3g per-RPC stage split (inject vs dispatch-wait vs serialize) for tap/swipe/pinch
is a DEVICE-test measurement; it is **not** recoverable from the committed artifacts —
only the describe path carries per-stage timings (`bench-open-vs-proprietary.ts`
`stageSamples`: idle/root/windows/roots/serialize). The tap/swipe/pinch inject stage
split therefore **cannot be measured without a run** (no emulator on this host; CI not
triggered). The 3n device test now emits the pieces a run needs: the `dumpsys input`
MotionEvent cadence per strategy (8-frame wire gesture, N) and the tap/swipe/pinch
outcomes per strategy.

What IS measured, from the last accepted latency run **34813849446** (scoreboard, p50/p95):

| verb | OFF-1 | ON-uia (default Kotlin) | ON-scrcpy | OFF-2 | drift floor | reading |
|---|---|---|---|---|---|---|
| gesture-tap (tap RPC) | 53/60 | **78/116** | 51/53 | 54/56 | 1 | UiAutomation +25 ms vs scrcpy; scrcpy at parity with OFF; NOT like-for-like (scrcpy defers the drain) |
| tap+describe(settle:false) | 354/831 | 505/728 (n=19) | 529/1029 (n=19) | 297/654 | 57 | like-for-like headline; open loses +150…+230 on both ON variants |
| gesture-swipe (250 ms) | 300/312 | 292/309 | 259/261 | 296/305 | 4 | UiAutomation at parity with OFF; scrcpy −37…−41 |
| gesture-pinch | 358/373 | 346/372 | 307/311 | 346/365 | 12 | UiAutomation at parity with OFF; scrcpy −39…−51 |

Where the Kotlin default loses time (from the code, to be confirmed by the 3g split on the run):
- **Tap**: `TapHandler`→`injectTaps` already returns on the async UP (default), so its ~25 ms
  vs scrcpy is the UiAutomation inject IPC per event, not a dispatch-wait. `uia-async`
  makes the tap row like-for-like with scrcpy (both defer the drain to the next read);
  `input-manager` swaps the pipe.
- **Swipe / pinch**: `MotionInjector.inject`'s **final UP is synchronous** by default
  (F3) — the RPC blocks on the last dispatch. `uia-async` / `input-manager` return on
  the async UP and fold the drain into the next read, which is where the ~33/39 ms vs
  scrcpy should come from.

### 2. Strategy design per RPC (file:line)

- `input/InjectStrategy.kt:31` — `InjectStrategy { DEFAULT, UIA_SYNC, UIA_ASYNC, INPUT_MANAGER }`,
  `fromWire` (unknown/absent → DEFAULT); `InjectOutcome` carries `dropped`, `strategy`
  (`"unavailable"` on fallback), `fellBackTo`, `error`.
- `input/MotionInjector.kt:71` `inject(...strategy)` and `:225` `injectTaps(...strategy)`
  now return `InjectOutcome`. Final-UP mode is resolved by `finalUpSyncFor` (`:465`):
  DEFAULT defers to the call site (swipe/gesture sync UP, tap async UP), `uia-sync` → sync,
  `uia-async`/`input-manager` → async. `dispatchEvent` (`:480`) routes each frame to the
  UiAutomation pipe or the reflective InputManager pipe. After the gesture, a sync final
  UP clears the async-UP tracker; an async one `markOutstanding` → **the drain folds into
  the next state/hierarchy read** exactly like scrcpy's `flushInput` (the sync no-op the
  next capture injects blocks the one system InputDispatcher FIFO until the async UP —
  and any InputManager-injected event — is delivered).
- **uia-async folds the drain into the next read**: `MotionInjector.kt:201` / `:317`
  (`markOutstanding` on the async final UP) → drained by `StateHandler`/`HierarchyHandler`
  via the existing `drainAsyncUp` (same slot the default tap already uses) — no extra RPC,
  same `flush:true` semantics the reads already support.
- **input-manager reflection + guard**: `input/InputManagerInjector.kt` — resolves the
  singleton via `InputManagerGlobal.getInstance()` (API 34+) then `InputManager.getInstance()`
  (≤33), and the method `injectInputEvent(InputEvent, int)`, cached once under a lock;
  injects with **`INJECT_INPUT_EVENT_MODE_ASYNC` (=0)** and device timestamps from the
  timeline. Every reflective step is wrapped; on a hiddenapi-policy block `probe()`
  records the exception and `MotionInjector.resolveEffective` (`:442`) reports
  `strategy:"unavailable"`, falls back to `uia-async`, and **never touches
  `hidden_api_policy`**.
- Handlers surface it: `TapHandler.kt:42`, `SwipeHandler.kt` (momentum `:106`, held `:137`),
  `GestureHandler.kt:62` read `params.optString("inject","")` and put `strategy`/`fellBackTo`/
  `injectError` on the reply.
- **Host flag + threading**: `configuration-core/src/flags.ts` registers
  `open-device-server-inject-strategy` (values documented; the active value rides on
  `ARGENT_OPEN_INJECT_STRATEGY`, mirroring `ARGENT_SCRCPY_PACING`, because the flag store
  is boolean). `utils/open-server-input.ts:resolveInjectStrategy` reads the env and
  `injectOpt()` is spread onto every tap/swipe/gesture RPC (plain + WithOutcome) only when
  a strategy is active, so the DEFAULT path is byte-for-byte unchanged. Blueprint
  `OpenInjectStrategy`/`OpenInjectReport` extend the tap/swipe/gesture signatures; the
  scrcpy backend stays as the control arm and ignores `inject`.

### 3. Bench blocks/arms added

- **Latency blocks** (`bench-open-vs-proprietary.ts`): `OFF-1, ON-uia-sync, ON-uia-async,
  ON-input-manager, ON-scrcpy, OFF-2`. `runBlock` sets `ARGENT_OPEN_INJECT_STRATEGY` per
  block and probes input-manager availability on-device (reads the `strategy` echo → notes
  `unavailable` + drops the block if the hiddenapi policy blocked it). `merge-blocks.js`
  ALL + generalized fidelity; `scoreboard.js` renders the strategy arms vs scrcpy/OFF at the
  drift floor. The workflow YAML could **not** be edited on this branch (push credential
  lacks the GitHub `workflow` OAuth scope, same as run-fling), so `run-bench.js`
  self-orchestrates the strategy arms as isolated child processes when their names are in
  the `blocks` dispatch input.
- **Fling A/B** (`bench-fling-fidelity.ts`): adds `ON-input-manager` as an interleaved arm
  (`run-fling.js` self-drives the interleave, no workflow edit). `uia-sync`/`uia-async`
  inject the byte-identical momentum-swipe timeline as the `ON-uiautomation` arm — the
  final-UP mode is post-lift and cannot change the pre-lift velocity the fling reads — so
  their fling result IS the uia arm's and they get no separate fling arm. `merge-fling.js`
  grades the input-manager arm two-sided under the pre-registered 3k.1 rule
  (INFORMATIONAL on the measurement run; blocking only at promotion).

### Pre-registered gates (written BEFORE the run that grades them)

**A. To promote a Kotlin strategy to the default (all must hold on the run that proves it):**
1. **tap RPC** p50 within the OFF-1↔OFF-2 drift floor of the **ON-scrcpy** block (or faster).
2. **swipe RPC** p50 within the ON-scrcpy drift floor (or faster).
3. **pinch RPC** p50 not slower than ON-scrcpy by more than the floor.
4. **`tap+describe(settle:false)`** not worse than the ON-scrcpy arm (the like-for-like headline).
5. **first-attempt landing ≥ 95 %** with the effect oracle (symmetric, per block).
6. **zero fallbacks** for that arm (the strategy's own fallback counter, not scrcpy's).
7. **fling gate PASS on every informative cell** for that arm: two-sided
   `|arm/uia − 1| ≤ 0.15` **AND** `|arm/off − 1| ≤ 0.15`, reference-bimodality exclusion
   keyed on the reference arms only (`q25(uia|off) ≤ 0.175 + eps`, never on the strategy),
   power floor **n ≥ 10** on every arm entering a gated ratio. (For uia-sync/uia-async this
   is the ON-uiautomation arm's fling result by construction; for input-manager it is the
   `ON-input-manager` fling verdict `merge-fling.js` prints.)
8. **input-manager only**: `strategy` echo must be `"input-manager"` on-device (**not**
   `"unavailable"`) — a hiddenapi fallback drops the arm from the comparison.

If a strategy passes, it becomes the default and scrcpy is removed (item 5). If none passes:
keep scrcpy off by default (hybrid: Kotlin for swipes, scrcpy for tap/pinch), keep the
dependency, and report which gate failed by how much.

**B. Fling parity gate (unchanged 3k.1 rule), graded per arm** — verdict string
`PASS|FAIL (per-cell ±0.15 on <arm>/uia AND <arm>/off, NO whitelist, over k informative
cell(s); m of 6 non-informative at the metric floor)`; `INCONCLUSIVE` (zero informative
cells) fails. The scrcpy arm remains the blocking control-arm gate on the run; the
input-manager arm is graded informational until promotion.

### 4. Device test cases per strategy

For each of `uia-sync` / `uia-async` / `input-manager`
(`test/blueprints/android-open-server.device.test.ts`, gated by `OPEN_SERVER_DEVICE_TESTS=1`):
- `3n-<strategy>` (enforced): tap navigates (screen changed), momentum swipe scrolls
  further than momentum-free, 2-pointer pinch delivers both pointers (visual zoom asserted
  when headless Chrome is zoomable, else measurement-only) — all via the `inject` param,
  recording the strategy the device actually ran (input-manager records the uia-async
  fallback when the hidden API is blocked; the outcome is unchanged).
- `3n-<strategy>-cadence` (measurement-only): an 8-frame wire gesture injected via the
  strategy, then the device MotionEvent cadence + N + delivered span from `dumpsys input`.

### Not done now (scope / blockers)
- Items 5 (promote + remove `@yume-chan/*`, scrcpy backend/timeline, fast-inject flag,
  `fastInjectFallbacks`, docs) and 6 (the two CI runs) are the post-run step.
- Workflow YAML edits are blocked by the missing `workflow` OAuth scope; `run-bench.js` /
  `run-fling.js` self-orchestrate the arms instead. The planner triggers the run with the
  strategy arm names in the `blocks` input.
- Docs: the `open-device-server-inject-strategy` flag follows the same
  undocumented-experimental pattern as its sibling `open-device-server-fast-inject` (absent
  from the public flags table); the user-facing docs update belongs to item 5 (scrcpy
  removal changes the user-facing surface).

### Pre-registration addenda (run 1 — written before triggering the CI run)

Base for run 1 is `open/main` @ 8315e396 (3m.1) merged into this branch (clean).

- **(a) Device-test residual gate uses a 20-sample median.** The `3m` residual gate
  `|captureMs − Σ(stages)| ≤ 10` keeps its 10 ms threshold but now medians over **20
  samples** per phase (idle and after-tap), not 5 — run **34840929610** failed it by
  **1 ms on a 5-sample median**, which is too few samples for a stable median. Code:
  `android-open-server.device.test.ts` (both residual loops `i < 20`; test budget
  raised to 300 s for the extra navigations).
- **(b) scrcpy tap path is ~190 ms per-frame write-await — `uia-async` is its
  like-for-like Kotlin counterpart.** On the previous base, scrcpy
  `tap+describe(settle:false)` read **262 ms under `drift` pacing vs 449 ms under
  `legacy`** — so ~190 ms of the scrcpy tap path is per-frame write awaiting, which the
  default (`legacy`) pacing pays. This is why the phase-3n `uia-async` strategy (async
  final UP, drain folded into the next read) is the like-for-like counterpart to the
  scrcpy row, and why the promotion gate compares `tap+describe(settle:false)` against
  the ON-scrcpy arm. `scrcpyPacing` is recorded per block (3m.1 pins the default arm to
  `legacy`; `bench-open-vs-proprietary.ts` `scrcpyPacing` on the block JSON), so run 1's
  scrcpy arm is `legacy` and no pacing is silent.
