# Ticket: tap/swipe latency regression after the screen-graph-d merge (outcome path always on)

Status: dispatched 2026-09-14. Blocks: 3k "unchanged verbs" check, scoreboard update,
any latency claim on `open/main` since `57ca43e6`.

## Evidence (run 34788497583, `open/main` @ 5edb4b6c, same runner class as run 7)
| verb (p50/p95 ms) | OFF-1 | ON-uiautomation | ON-scrcpy | OFF-2 | run 7 ON (uia / scrcpy) |
|---|---|---|---|---|---|
| gesture-tap | 54/61 | 852/1048 | 965/1049 | 54/62 | 77 / 51 |
| gesture-swipe | 294/311 | 1267/1376 | 1237/1649 | 299/310 | 290 / 257 |
| describe, await-*, paste, pinch | unchanged vs run 7 within drift floors | | | | |
Both 3k runs (34795811096, 34800933407) reproduce it on the same base. The merge
review (`2026-09-13-merge-screen-graph-d-into-open-main.md`) missed it because the
planner accepted the merge on gate colour without comparing verbs against the drift
floor. Rule from now on: every latency run's verb table is diffed against the last
accepted run before a merge is accepted.

## Root cause (verified read-only)
- `packages/tool-server/src/tools/gesture-tap/index.ts:136-138` and
  `gesture-swipe/index.ts:154-164`: when `shouldUseOpenServer(device)` the tool
  unconditionally calls `openServerTapWithOutcome` / `openServerSwipeWithOutcome`
  (`src/utils/open-server-input.ts:262-370`), which sends an `outcome` object.
- `JsonRpcHandler.kt:208-230` `runAction`: with `outcome` present it does
  `TreeStore.ensure()` before, the action, then `TreeStore.settleAfterAction(fromVersion,
  firstEventTimeoutMs=600, quietMs=80, idleTimeoutMs=1500)` and an `after` snapshot.
  That is the +800–1000 ms on every ON tap/swipe, on both backends.
- `packages/configuration-core/src/flags.ts:82` declares `screen-graph` "Off by
  default", but nothing on the tool path checks it.

## Fix (contract)
1. Default path restores pre-merge semantics: with the `screen-graph` flag OFF,
   `gesture-tap` / `gesture-swipe` (and `paste`, check `paste/platforms/android.ts`)
   call the plain `openServerTap` / `openServerSwipe` / clipboard path — no `outcome`
   param leaves the host, so `runAction` is the pass-through. The tools' result shape
   keeps `outcome` optional (absent when the flag is off).
2. With the flag ON, the outcome path is used as today. `navigate-to`,
   `bench-screen-graph.ts` and `bench-preflight.ts` call `*WithOutcome` directly
   through the blueprint and must keep working unchanged (they do not depend on the
   tool default). Grep every caller listed by `grep -rl WithOutcome packages/tool-server`.
3. If a single flag check per call is too coarse for the screen-graph harness (it
   runs configs B1/B2 without the graph), expose an explicit per-call `outcome?:
   boolean | OutcomeOpts` parameter on the tool schema instead, default false; the
   harness passes it for the open configs only. Pick whichever keeps the CI
   screen-graph job green without touching its results; say which in the Result.
4. Unit tests: (a) with the flag off, the RPC sent for a tap contains no `outcome`
   key (spy on the client); (b) with the flag on, it does; (c) existing
   `open-server-gesture-outcome.test.ts` / `open-server-tap.test.ts` /
   `open-server-swipe-hold.test.ts` still pass. vitest `--maxWorkers=2`.
5. Kotlin: no change expected. If `TreeStore.ensure()` or any listener registered at
   instrumentation start (`DeviceControlInstrumentation.kt:73 TreeStore.init`) adds
   per-RPC cost even without `outcome`, measure it from the 3g stage timings in the
   run and report; do not "fix" it blind.

## Verification
- Branch `fix/open-server-outcome-default-off` off `open/main` @ 6106f9a6, worktree
  `../argent-fork-wt-outcome` (never /tmp; root `node_modules` symlinked; no npm
  install/gradle; no emulator).
- One CI run `suite=both`, `sg_mode=matrix`: latency verb table must return to run 7
  within drift floors for gesture-tap and gesture-swipe on BOTH ON arms (tap ~50–80,
  swipe ~250–300 p50), with every other verb unchanged; screen-graph job must stay
  green with per-config success unchanged vs run 34794414764 within its Wilson
  intervals (the harness uses its own outcome calls). Fling A/B is reported, not gated,
  for this ticket (3k owns the gate).
- Polling: one `gh run view` per 10 min as a single `run_in_background` Bash call
  `sleep 540; gh run view <id> --json status,conclusion,jobs`; never loop.
- Append `## Result` here: run id, the verb table (OFF-1 / ON-uia / ON-scrcpy / OFF-2
  p50/p95) side by side with run 7 and run 34788497583, screen-graph per-config
  success, and which fix shape (flag vs per-call param) was chosen and why. Do not
  edit the scoreboard; do not fast-forward `open/main`.
