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

## Result — run 1 (CI 34853156073, head 46fb3f79 on the merged 3m.1 base)

**Run outcome: the latency job FAILED at the fling step (step 16) — the pre-registered
BLOCKING scrcpy control-arm parity gate fired** (`scrcpy/off` out of ±0.15 at 250/0.3 =
**0.662** and 400/0.5 = **0.802**, the known scrcpy under-scroll deficit 3n exists to
replace — NOT a regression from 3n). Everything else on the latency job was green:
**Kotlin APK built in CI** (step 11), **device tests passed** (step 14, incl. all six 3n
cases + the 20-sample residual gate), **latency 6-block run + merge passed** (step 15 —
`run-bench.js` self-orchestrated the three strategy arms, all six `bench-block-*.json`
produced), scoreboard/artifacts/enforce-device-test all green. Screen-graph job: reported
separately (still running at write time).

### Verb latency p50 (ms), this run vs run 34813849446

| verb | OFF-1 | ON-uia-sync | ON-uia-async | ON-input-manager | ON-scrcpy | OFF-2 | floor | 34813849446 (ON-uia / scrcpy) |
|---|---|---|---|---|---|---|---|---|
| gesture-tap | 53 | 84 | 86 | **55** | 52 | 53 | ±2 | 78 / 51 |
| gesture-swipe | 307 | 311 | 291 | **268** | 258 | 300 | ±7 | 292 / 259 |
| gesture-pinch | 351 | 347 | 340 | **323** | 307 | 356 | ±5 | 346 / 307 |
| tap+describe(settle:false) | – | 437 | 422 | **400** | 340 | – | ±2 | 505 / 529 |
| await-ui-element | 84 | 47 | 48 | 47 | 44 | 80 | – | 45 / 47 |
| await-screen-idle | 509 | 314 | 312 | 312 | 310 | 504 | – | 294 / 294 |

**Headline: `input-manager` closes the UiAutomation tap gap** — 55 ms vs scrcpy 52
(the default UiAutomation tap was 78 in 34813849446), while the UiAutomation-pipe
strategies (`uia-sync` 84, `uia-async` 86) stay ~30 ms behind. `input-manager` is the
fastest Kotlin arm on every gesture verb and was **available on-device**
(`injectStrategyReported: input-manager`, confirmed — the reflective
`InputManager.injectInputEvent` pipe worked; no hiddenapi fallback).

### Pre-registered promotion gate — PASS/FAIL per strategy (deltas vs ON-scrcpy at the drift floor)

| gate | uia-sync | uia-async | input-manager |
|---|---|---|---|
| 1. tap RPC within scrcpy floor (±2) | +32 **FAIL** | +34 **FAIL** | +3 **FAIL by 1 ms** |
| 2. swipe RPC within floor (±7) | +53 **FAIL** | +33 **FAIL** | +10 **FAIL by 3 ms** |
| 3. pinch not slower than scrcpy by > floor (±5) | +40 **FAIL** | +33 **FAIL** | +16 **FAIL by 11 ms** |
| 4. tap+describe(settle:false) not worse than scrcpy | +97 **FAIL** | +82 **FAIL** | +60 **FAIL** |
| 5. first-attempt landing ≥ 95% | 60/60 **PASS** | 60/60 **PASS** | 60/60 **PASS** (scrcpy 58/60 = 96.7%) |
| 6. zero fallbacks | 0 **PASS** | 0 **PASS** | 0 **PASS** |
| 7. fling gate PASS every informative cell | = ON-uia arm (fling FAIL this run) | = ON-uia arm | **FAIL** (OUT on all 3 informative, noisy) |
| 8. input-manager available (not "unavailable") | n/a | n/a | **PASS** (confirmed on-device) |

**No strategy meets the full promotion gate.** `input-manager` is by far the closest —
within a few ms of scrcpy on every latency verb, cleaner reliability (100% landing vs
scrcpy 96.7%, 0 no-effect vs scrcpy 2) — but it does not clear this run's very tight drift
floors (tap +3 / floor 2, swipe +10 / floor 7, pinch +16 / floor 5), loses
tap+describe(settle:false) by 60 ms, and its fling arm is out (see below). The scrcpy
control arm itself FAILED its own fling parity gate, so scrcpy is not a clean winner either.

### Fling per-cell per arm (3k.1 rule; n per cell)

Scrcpy control gate (BLOCKING, scrcpyPacing arm = drift) — **FAIL**, 3 informative / 3 non-informative:
- 250/0.3: scrcpy/uia 0.973 OK · **scrcpy/off 0.662 dev 0.338 OUT**
- 400/0.3: scrcpy/uia 1.088 · scrcpy/off 0.958 — OK
- 400/0.5: scrcpy/uia 1.141 · **scrcpy/off 0.802 dev 0.198 OUT**
- 150/0.3, 150/0.5, 250/0.5 non-informative (reference q25 at the 0.175 floor).

input-manager arm (INFORMATIONAL) — OUT on all 3 informative cells, and the metric is
noisy this run:
- 250/0.3: **im/uia 1.54** (uia read a low 0.30 median here) · im/off 1.048 — OUT on im/uia
- 400/0.3: im/uia 0.959 · **im/off 0.844** (n=11) — OUT on im/off
- 400/0.5: im/uia 1.132 · **im/off 0.796** — OUT on im/off (input-manager under-scrolls vs
  off at 400 ms, similar to scrcpy — the fling deficit is not eliminated by the Kotlin path,
  though the 250/0.3 uia anomaly shows the anchor-displacement metric is noisy on this KVM
  emulator). uia-sync/uia-async inject the identical momentum timeline as the ON-uia arm, so
  their fling result is the ON-uia arm's (also not clean this run).

### Device tests per strategy (all PASS; `OPEN_SERVER_DEVICE_TESTS=1`, step 14 green)

| strategy | ran as | tap navigates | fling > momentum-free | pinch zoom | 8-frame cadence (deliveredSpan, MOVE ms) |
|---|---|---|---|---|---|
| uia-sync | uia-sync | +2/−40 labels | 1168 > 540 px | 2.9% | 122 ms, [23,9,17,15,16,16,26] |
| uia-async | uia-async | +2/−40 labels | 1168 > 631 px | 2.9% | 118 ms, [17,15,16,17,15,19,19] |
| input-manager | **input-manager** | +2/−40 labels | 1168 > 566 px | 2.9% | 120 ms, [16,16,16,16,17,18,21] |

`input-manager` was **available** and delivered the cleanest ~16 ms MOVE cadence — the
reflective ASYNC pipe preserves the timeline. (The 3g per-RPC inject-vs-dispatch-vs-serialize
stage split was, as pre-registered, not emitted — the server carries per-stage timings only
for the describe path; the dumpsys cadence above is the delivered-cadence measurement.)

### Verdict (item 4 close-out; item 5 is the planner's)

Per the ticket's "if no strategy passes" branch: **keep scrcpy off by default; the honest
result is that no Kotlin strategy cleared the promotion gate on run 1.** `input-manager` is
the standout candidate — near-scrcpy latency on every verb, better landing, available and
cadence-clean on-device — failing tap by 1 ms and swipe by 3 ms over unusually tight drift
floors, and losing tap+describe by 60 ms. The scrcpy arm also failed its own fling gate, so
neither path is clean on fling this run (a noisy metric on the KVM emulator). Recommendation
for the planner's review (NOT applied here): either (a) a second run to tighten the fling/drift
noise before deciding, or (b) the hybrid default (Kotlin `input-manager` for tap/swipe/pinch —
it already beats scrcpy on reliability and is within a few ms — keeping scrcpy only if the
fling deficit proves real and Kotlin-unfixable). Promotion/removal (item 5) is deferred for
review.

### Screen-graph (run 34853156073, job SUCCEEDED — green)

The screen-graph matrix job passed on the same run — 3n's injection-path changes and the
3m.1 merge did not disturb the outcome path the graph records from.

- **Success (ok/total, exclusions-as-failures)**: B1 100/100 · B2 97/100 · O1 99/100 ·
  **O2 100/100** · O3 99/100 · O4 98/100 · O5 98/100.
- **Tokens/agent-step, o200k p50 (n=155 non-launch steps)**: B1 657 · B2 646 · O1 138 ·
  **O2 54** · O3 627 · O4 21 · O5 22.
- **Hypotheses**: H1 O1/B2 = **0.214×** (≤0.5, PASS) · H2 all-steps 0 (FAIL, structural) /
  same-screen n=50 = 1 (PASS) · H3 O4/O3 = **0.033×** (≤0.2, PASS).
- **O5 routing**: one-step routed **58/60**; O5-mixed 98/100, O5-pure 48/48 = 100%.
- **Invariants**: `store invariants OK: 0 duplicate screens, 0 multi-destination edges`
  (`sg-matrix.log:200`); **skippedNoIdHash = 2**.

### Run 1 close-out

Overall run conclusion: **failure** — driven solely by the pre-registered BLOCKING scrcpy
fling gate (the known scrcpy under-scroll), with the screen-graph job green and every other
latency step green. All item 1–4 code is proven on-device: Kotlin strategies compile and run
in CI, the host threading works, all six latency arms + the input-manager fling arm are
produced, the device suite (incl. the 20-sample residual gate) passes, and input-manager is
available on this emulator. The measurement stands; the promotion/removal decision (item 5)
is the planner's.

## Result (3n.1) — run 2 pre-registration (gates P0–P10 written BEFORE the run)

Base: `feat/open-server-3n-kotlin-injector` @ a61c47d5 with `open/main` @ 2905f0d5 merged
(docs only). Default flip to `input-manager` shipped in code (Work 1); scrcpy NOT removed
(3n.2 after run 2 is green). Blocks: `OFF-1, ON-uiautomation (control, `default` sentinel),
ON-input-manager, ON-scrcpy, OFF-2`. Fling arms: `ON-uia-A, ON-uia-B, ON-input-manager,
ON-scrcpy, OFF` interleaved per sample. N=20 per verb per block; fling N=12 per cell-arm.

Pre-registered gates P0–P10, verbatim from `2026-09-14-review-3n-run1-findings.md`
"Promotion recommendation (b)":

> **P0 — control arm present.** `ON-uiautomation` (the current default, no
> `ARGENT_OPEN_INJECT_STRATEGY`) runs as a latency block. If it is absent the run is void.
>
> **P1 — drift floor is measured, never defaulted.** For every gated verb the floor is
> `|OFF-1 p50 − OFF-2 p50|` on the SAME verb name in the OFF blocks. A verb with no OFF
> counterpart is gated on the OFF verb the scoreboard already declares its comparator
> (`tap+describe(settle:false)` → OFF `tap+describe`). `scoreboard.js` must NOT substitute
> a constant; a missing comparator makes the gate `N/A`, never `±2`.
>
> **P2 — tap RPC vs proprietary.** `ON-input-manager` `gesture-tap` p50 ≤ `max(OFF-1,
> OFF-2)` + floor.
>
> **P3 — swipe RPC vs proprietary.** `ON-input-manager` `gesture-swipe` p50 ≤ `min(OFF-1,
> OFF-2)` + floor.
>
> **P4 — pinch RPC vs proprietary.** `ON-input-manager` `gesture-pinch` p50 ≤ `min(OFF-1,
> OFF-2)` + floor.
>
> **P5 — headline, vs proprietary (restates 3m G6).** `ON-input-manager`
> `tap+describe(settle:false)` p50 ÷ same-run OFF `tap+describe` p50 ≤ **1.15** against
> **each** of OFF-1, OFF-2 and their pooled p50.
>
> **P6 — no regression of the default.** `ON-input-manager` is not slower than
> `ON-uiautomation` by more than the floor on any of the four gated verbs.
>
> **P7 — landing and fallbacks.** First-attempt landing ≥ 95 % with the effect oracle on
> every block, oracle self-test passed, and **0** `input-manager` fallbacks; the
> `strategy` echo is recorded on **every** measured tap/swipe/gesture reply and the block
> reports `injectStrategyReported` as a count (`input-manager: n/n`), not a single probe.
>
> **P8 — fling instrument first, arms second.** The fling job runs `ON-uia-A` and
> `ON-uia-B` as two independent same-code arms, interleaved per sample. If
> `|A/B − 1| > 0.15` on any informative cell, the fling section is reported as
> **INSTRUMENT-UNRESOLVED** and no arm verdict — PASS or FAIL — is issued for any arm.
> Only if the A/B control holds are the arms graded under the 3k.1 rule, two-sided on
> `arm/off` (proprietary) with `arm/uia` reported for information only, informative =
> `q25(off) > 0.175 + eps` **or** `q25(uia) > 0.175 + eps`, graded against whichever
> reference is above the floor, n ≥ 10 per arm-cell. Fling is **not** a promotion blocker
> for run 2: the current default fails it too (run 34853156073: uia/off 0.680, 0.881,
> 0.703), so it cannot select between arms.
>
> **P9 — availability and portability.** `input-manager` resolves on the CI image with no
> `hidden_api_policy` write, AND the `uia-async` fallback is exercised at least once by a
> test that forces `InputManagerInjector.probe()` to fail, asserting
> `strategy == "unavailable"`, `fellBackTo == "uia-async"` and an unchanged outcome.
>
> **P10 — screen-graph.** Job green, store invariants OK, `skippedNoIdHash` reported
> alongside 34813849446 (0) and 34840929610, per-config success and tokens reported with
> the H4 paired-cluster intervals. A drop below the reference's 100/100 is reported, not
> called "undisturbed".
>
> **Promotion is P0–P7 + P9 + P10 all green.** P8 is reported, never gating. If P2–P6 are
> green the default becomes `input-manager` and scrcpy removal ships in the following PR.

Implementation summary (Work 1–5, all committed, gates.test 26/26, tsc clean): default flip
+ `default` sentinel control (Work 1); P9 benchDebug `_forceInjectUnavailable` seam + host
+ device tests; per-block strategy echo COUNTS on `getInfo` (Work 2, P7); per-sample
latency arrays + 10 000-draw seeded bootstrap CI (Work 3, H5); run-2 blocks + fling A/B
arms (Work 4); scoreboard P1 measured floor (no constant) + P2–P6 CI-based vs proprietary,
merge-blocks P0 void, merge-fling 3n.1 instrument-first NON-GATING mode (Work 5). Wall-time
estimate for the latency job (5 blocks + 5 fling arm-streams): ~90 min < 120 (run 1 was
~95–100 min with 6 blocks); no split, N unchanged.
