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

## Result

Fix landed on `fix/open-server-outcome-default-off` (off `open/main` @ `e52c1db5`;
the header's `6106f9a6` is stale — `e52c1db5` is current HEAD). Commits:
`23bbc477` (src) and `ed5e844d` (tests). CI run **34806342684** (`suite=both`,
`sg_mode=matrix`, on `ed5e844d`).

### Fix shape: a flag check on the EXISTING `screenGraphRecordingEnabled()` — not a per-call param

`gesture-tap` / `gesture-swipe` / `paste` (android) now take the plain
`openServerTap` / `openServerSwipe` / `openServerTypeText` path (no `outcome`
request → `runAction` is the pass-through, no `settleAfterAction`) UNLESS
`screenGraphRecordingEnabled()` is true, in which case the `*WithOutcome` path is
used exactly as before. The result shape keeps `outcome` optional (absent on the
default path).

Item 3's per-call `outcome?` param was NOT needed. `screenGraphRecordingEnabled()`
= `isFlagEnabled("screen-graph") || process.env.ARGENT_SG_RECORD === "1"` already
separates the only two tool-driven callers that matter: the latency bench
(`bench-open-vs-proprietary.ts`) sets neither, so it gets the plain path and the
regression is fixed; the screen-graph harness (`bench-screen-graph.ts`) sets
`ARGENT_SG_RECORD=1` process-wide for EVERY open config incl. the graph-off
baselines B2/O1/O2 (`bench-screen-graph.ts:2322`), so its tool-driven taps still
record selector edges and per-config success is unchanged. `navigate-to`,
`bench-preflight.ts` and the harness's own reset/setup taps call `*WithOutcome`
(or `tapWithOutcome`) directly through the blueprint and are untouched. A single
flag check per call was therefore NOT too coarse, and it keeps the CI
screen-graph job green without touching its results.

### Latency verb table (p50/p95 ms) — my run 34806342684 vs run 7 (33975063607) vs run 34788497583 (regression)

gesture-tap and gesture-swipe, all four blocks; N=20 per cell.

| verb | metric | OFF-1 | ON-uiautomation | ON-scrcpy | OFF-2 |
|---|---|---|---|---|---|
| gesture-tap | run 34806342684 (fix) | 52/54 | **83/131** | **51/52** | 53/62 |
| gesture-tap | run 7 (33975063607, baseline) | 52/54 | 77/91 | 51/52 | 52/53 |
| gesture-tap | run 34788497583 (regression) | 54/61 | 852/1048 | 965/1049 | 54/62 |
| gesture-swipe | run 34806342684 (fix) | 297/308 | **294/319** | **258/261** | 295/319 |
| gesture-swipe | run 7 (33975063607, baseline) | 290/308 | 296/359 | 257/262 | 294/303 |
| gesture-swipe | run 34788497583 (regression) | 294/311 | 1267/1376 | 1237/1649 | 299/310 |

The +800–1000 ms tap/swipe cost on BOTH ON arms is gone: tap ON p50 back to 83
(uia) / 51 (scrcpy) — run-7 range 77 / 51; swipe ON p50 back to 294 (uia) / 258
(scrcpy) — run-7 296 / 257. ON-uia tap p50 83 is 6 ms over run 7's 77, inside the
~21 ms ON-path noise floor; OFF-1↔OFF-2 drift is 1 ms (tap) / 2 ms (swipe). Every
other verb is within its documented drift/noise and shows no settle signature
(describe idle ON 55/53 vs OFF 52 — 3i target ON≤OFF+10 met, magnitude documented
as non-reproducible; await-screen-idle / await-ui-element / paste / gesture-pinch
all in run-7 ballpark or faster; the await/describe deltas vs run 7 come from the
screen-graph-d tree already on `open/main`, not from this gate). scrcpyFallbacks 0;
describe fidelity OFF↔ON Jaccard 0.889 (sole diff a "5.08 GB"→"5.07 GB" free-space
string).

### Screen-graph per-config success — my run 34806342684 vs run 34794414764 (Wilson n=100)

| Config | run 34806342684 (fix) | run 34794414764 (ref) |
|---|---|---|
| B1 (proprietary) | 82/100 [73, 88] | 82/100 [73, 88] |
| B2 (open, no graph) | 100/100 [96, 100] | 98/100 [93, 99] |
| O1 (+ query/diff) | 100/100 [96, 100] | 98/100 [93, 99] |
| O2 (+ outcomes) | 99/100 [95, 100] | 99/100 [95, 100] |
| O3 (+ graph, blind) | 99/100 [95, 100] | 98/100 [93, 99] |
| O4 (graph, warm) | 100/100 [96, 100] | 100/100 [96, 100] |
| O5 (+ navigate-to) | 100/100 [96, 100] | 95/100 [89, 98] |

Screen-graph job **completed/success**. Every config is at-or-above the reference
with overlapping Wilson intervals — unchanged within noise. B1 (no open server) is
identical 82/100; B2/O1–O5 (which use the harness's own outcome calls under
`ARGENT_SG_RECORD`) are all ≥ reference, confirming the gate did not reduce the
harness's outcome-driven recording.

### Fling A/B (reported, NOT gated — 3k owns the gate)

Fling parity gate FAIL: 150ms/0.3=0.642, 400ms/0.3=0.844, 400ms/0.5=0.821 outside
±0.15 — the same structurally-red, "not establishable on x86_64 KVM" scrcpy
long-duration under-scroll seen on run 7 and the merge run (offending cells vary
with emulator scroll-physics noise). The latency JOB is red solely on this step;
the 4-block bench, scoreboard, device test (on-device suite passed) and artifact
upload all succeeded. The fling bench sends no `outcome` param, so this gate is
untouched by the fix.

### Not done / caveats

- Did not edit the scoreboard; did not fast-forward `open/main`. No PR opened
  (task did not ask). No user-facing MCP/CLI/config/flow change, so no
  `packages/docs` update is warranted (the `screen-graph` flag already documents
  "Off by default").
- Pre-existing repo state left as-is: `scripts/bench-describe-host.ts` has two
  `import.meta` TS1343 errors under `tsc -p tsconfig.test.json` (`module: commonjs`)
  on the base — out of scope (scripts), not touched.
