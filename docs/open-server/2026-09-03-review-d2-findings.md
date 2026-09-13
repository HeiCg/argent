# Adversarial closure review — screen-graph phase D.2 (run 33964414774)

Read-only review of `feat/screen-graph-d` @ `59791d460` and `feat/bench-ci-d` @
`77cd4b9a3`, against `2026-09-03-screen-graph-results-ci.md`, the D.2 ticket
(`2026-09-03-screen-graph-phase-d2-honest-routing.md`), the D.1 findings, and the
rules of evidence in `2026-09-03-review-3h-3i-c3.md`. Evidence: CI artifacts of
runs **33964414774** (D.2) and **33958064084** (D.1), and the branch source in a
throwaway worktree. No device used.

## VERDICT: ACCEPT-WITH-CAVEATS

Every published per-config number reproduces **to the digit** from the run's own
JSON by an independent recompute (my script, not the harness): success, tokens
p50/p95, chars/4, obs RTT, RTT count, `actionRttMs`, `recordMs`, Wilson
intervals, the 10 000-resample cluster bootstrap (seed `0x5eedc0de`) and the H4
paired deltas. One published cell is wrong (D2-M1). D.1's HIGH-1 node half is
genuinely closed — 0 duplicate screens in all four package stores, 0
structural-hash-keyed nodes, `skippedNoIdHash` 0, and `Internet` resolved by a
single exact index key.

What blocks a clean ACCEPT: the headline routing claim is inflated. **5 of the
60 "routed known-target taps" issue no tap at all** (D2-H1), their arrival check
is vacuous by construction (D2-H2), and the task those 5 belong to never reaches
its nominal destination in **any** config (D2-H3). The edge half of D.1 HIGH-1
is still open (D2-M2), and the H1 label's stated cause is contradicted by the
JSON (D2-M5).

## HIGH

- **D2-H1 · 5 of the 60 "routed" known-target taps perform no action.**
  `task.navTarget` is task-level and applies to EVERY `knownTarget` step
  (`packages/tool-server/scripts/bench-screen-graph.ts:1111-1115`), so
  `settings-network-internet`'s SECOND tap (`t("Internet")`,
  `src/screen-graph/bench/tasks.ts:147,153`) is routed to the identity of the
  screen it is already standing on (node `284ef0302b28c5de`). Records: O5 /
  `settings-network-internet` / reps 0-4 / `stepIndex 2` carry
  `nav {reached:true, completedSteps:0, totalSteps:0, rpcCount:2}`, `hash`
  unchanged at `284ef030`. `runAction` returns `strategy:"navigate"` on `reached`
  before any tap is issued (`bench-screen-graph.ts:783-800`). The remaining 55
  are genuine 1-step routes. **Fix:** publish the split (55 one-step / 5
  zero-step) and give the second step its own `navTarget`; "60/60 known-target
  taps routed" as written overstates coverage by 5.
- **D2-H2 · On a 0-step route the arrival verification is vacuous.**
  `queryPresent(target)` (`bench-screen-graph.ts:726-734`, called at `:788`) is
  the only guard that a route landed where intended. When the target is already
  on the current screen, `reached` and `present` are both true before anything
  happens. D.1's "routing cannot be faked" property holds against a FALLBACK
  (`navFallback` false on all 60; `strategy:"navigate"` requires `reached &&
  present`) but not against a NO-ACTION route. **Fix:** require
  `completedSteps > 0` for a step to count as routed, or score zero-step routes
  in their own row.
- **D2-H3 · `settings-network-internet` never reaches the Internet screen in ANY
  config; its second step is a dead tap that the oracle cannot see.** Every
  config's `stepIndex 2` ends on hash `284ef030` with `changed:false` (B2/O1/O2/
  O3/O4 records, reps 0-4; B1 has no hash). Cause: bench selectors are
  `contains` + case-insensitive (`bench-screen-graph.ts:437-442`) and
  `locateNorm` taps `q.nodes[0]` (`:475-481`), so `t("Internet")` matches the
  collapsing-toolbar title "Network & internet" first. The store records exactly
  that tap: `284ef030 --tap{"text":"Network & internet"} bucket 2,1--> 284ef030
  count 25 successes 25` (`graph-store/com.android.settings/34.json`). The oracle
  needle `SIMs` lives on the Network & internet screen, so the dead step passes
  for everyone. Pre-flight cannot catch it: it verifies the needle on the screen
  reached after both taps, which is the same screen. This predates D.2 but is now
  load-bearing — it is the task D.2 cites to show the D.1 no-routes are fixed.
  **Fix:** make the step's selector destination-unique (`exact` text, or the
  Internet row's resource id) and re-run before the "two-level nav" label stands.

## MEDIUM

- **D2-M1 · O4's Wilson interval in the results doc is wrong.** Doc line 66 gives
  O4 (99/100) Wilson `[93, 99]`; the harness's own
  `.bench-results/screen-graph/results-ci.md:32` and my recompute both give
  `[95, 100]`. `[93, 99]` is B1's interval (98/100). A hand-typed cell in a doc
  whose lead claim is "regenerated from the run artifact JSON" — same class as
  D1-M1.
- **D2-M2 · The EDGE half of D.1 HIGH-1 is not closed.** The store still holds one
  node + one selector + one bucket with two destinations:
  `9039b5e4 --tap{"text":"Apps"} b=3,8--> 487ac481 (c=53)` and the same action
  `--> 9039b5e4 (c=2)` (settings store). The new guard
  (`src/utils/screen-graph-open-wiring.ts`,
  `if (afterId === beforeId && outcomeReportedChange) return;`) drops only the
  mid-transition case; a navigating tap that genuinely failed still mints a
  root→root self-edge that competes with the real edge. `duplicateScreens()`
  checks NODES only. The doc's "0 duplicate screens" is true but narrower than
  D1-H1, which was about a selector with two destinations. **Fix:** add an
  edge-level invariant (no `from`+action key with >1 `to`) and say what the
  node-level invariant does and does not cover.
- **D2-M3 · The duplicate-screen invariant is not enforced on the run's store.**
  `duplicateScreens()` (`src/screen-graph/store.ts:129`) is referenced only by
  `test/screen-graph-store-migration.test.ts:214,224`. No field in the run JSON
  reports it, and no CI step runs it against the produced store. The "0 duplicate
  screens" claim is true (I reproduce it over all four package stores) but it is
  hand-checked, not gated: a future run with duplicates would still be green.
- **D2-M4 · `recordMs` does not attribute the gap the doc says it attributes.**
  Doc lines 78-80 claim it "attributes the ~1 s open-config gap vs B1". Measured
  per-step `actionRttMs − recordMs` p50: B2 1038, O1 1068, O2 1066, O3 1033, O4
  1028, O5 1184, against B1's 190. Recording explains ~355-387 ms of a ~1 200 ms
  gap; ~70 % stays unattributed. The doc also never states that `actionRttMs`
  INCLUDES `recordMs` — it does (`screen-graph-open-wiring.ts` accumulates in the
  `finally` of the awaited call; read at `bench-screen-graph.ts:1162`, stored at
  `:1177`), so the two columns must not be added.
- **D2-M5 · The H1 label's stated cause is contradicted by the JSON.** Doc line
  138 says the ratio "moves with O1's selector policy". O1's per-bucket token
  medians are IDENTICAL in D.1 and D.2 (`query/tap` 134 n=80, `query/swipe` 138
  n=20, `query/back` 68 n=5, `query/type` 1 n=10, `query/tapXY` 179 n=40) and the
  MEAN ratio barely moves (D.1 209.3/993.6 = 0.211 → D.2 215.1/976.6 = 0.220).
  O1's distribution is bimodal with a plateau boundary at the median: 78 of 155
  values are ≤138 in D.1 versus 76 in D.2, so a two-observation reshuffle flips
  p50 from 138 to 179 and the ratio from 0.220× to 0.285×. H1 PASSES on either,
  but the published p50 ratio is an unstable statistic; report the mean ratio or
  a bootstrap interval beside it and drop the "selector policy" explanation.
- **D2-M6 · `infraPreAction` fires on any thrown task error, not the "pre-action
  shared-infra fault" its comment claims.** `bench-screen-graph.ts:2277-2288`:
  any exception out of `runTask` yields `erroredTaskRecord` with
  `infraPreAction: true` (`:1264-1280`), and `isExcludedRun` drops that run from
  the denominator (`src/screen-graph/bench/oracle.ts:157-158`;
  `bench-screen-graph.ts:1459,1570`). That reopens an outcome-shaped exclusion
  path — the C.4 REJECT item D.1 closed. It did NOT fire this run (`excluded: 0`,
  `total`/`scored` 100 for all seven configs), so no published number is affected.
- **D2-M7 · M3's empirical substitute does not evidence device H_id stability.**
  Doc line 210 offers "one H_id per screen and 0 duplicates" as empirical
  evidence. A clean store is consistent with a stable H_id but does not test it,
  and the same store contains an edge minted from a mis-attributed selector
  (D2-H3). The Kotlin `ScreenHash.identity` test and the host/device cross-check
  are still absent. The doc's PARTIAL label is honest; the empirical sentence
  should be dropped or marked as consistency, not evidence.

## LOW

- **D2-L1 · `measuredRpc` is 5/7 measured, 2/7 modelled.**
  `bench-screen-graph.ts:1165-1167` is `nav.rpcCount + 2`: the bench's own
  `await-screen-idle` and `queryPresent` are ASSUMED to cost one RPC each, not
  instrumented. The proxy (`src/tools/navigate-to/index.ts:414-427`) counts only
  calls on that one server handle over a fixed `RPC_METHODS` set; `adb` work
  (`resolveVersionCode`) and any nested handle are uncounted. 7 is a lower bound.
- **D2-L2 · The measured RPC p50 hides the zero-step routes.** `measuredRpc`
  n=60, p50 7, p95 7, min 4, max 7, mean 6.75. The 5 zero-step routes cost 4.
  Publish 7 (n=55, one-step) and 4 (n=5, zero-step), not a single p50.
- **D2-L3 · No measured RPC counterpart exists for any other config**
  (`measuredRpc.n = 0` for B1/B2/O1-O4), so the "RTT count/step" column
  (2,2,2,2,2,1,1) is still a logical model everywhere except O5 and cannot be
  compared with O5's 7. The doc labels it "a logical count"; keep the modelled
  and measured rows separate on the scoreboard.
- **D2-L4 · The pre-flight gate is real but cannot distinguish reliability.**
  UNVERIFIED is now a gate PROBLEM (`src/screen-graph/bench/preflight.ts:42-45`;
  `scripts/bench-preflight.ts:490,552`) and `logs/sg-preflight.log` shows all 20
  needles "present on destination" with `PROBLEM needles: 0` — L1 is closed for
  this run, and the controlled `gesture-swipe` (`bench-preflight.ts:226-244`)
  legitimately removes the D.1 false negative by matching the matrix gesture. But
  `ATTEMPTS` went 3 → 10 (`:399`) and the summary prints only the verdict, not
  `reachedDistinct/ATTEMPTS`: a destination reachable 1-in-10 verifies exactly
  like one reachable 10-in-10. `settings-display` is the task that then failed one
  matrix rep. It does not hide a genuinely unreachable destination; it hides
  flakiness.
- **D2-L5 · Open configs get an idle-wait that B1 does not.** The settled
  `getState({ waitTimeoutMs: 2500 })` runs INSIDE every open-config tap
  (`screen-graph-open-wiring.ts`, `RECORD_SETTLE_TIMEOUT_MS`), so B2/O1-O4 always
  observe a settled screen; B1 and O5's routed taps do not (O5 `recordMs` p50 8).
  B1 carries this run's only two locate failures. No published number is provably
  affected, but success rates are no longer strictly like-for-like on settling.

## Checks that came back CLEAN

- **Full independent reproduction.** Recomputed from
  `bench-sg-2026-09-05T11-57-59-850Z.json` without the harness: success, tokens
  o200k p50/p95, chars/4 p50, obs RTT p50, RTT-count p50, `actionRttMs` p50,
  `recordMs` p50 — all seven configs match the doc exactly (only D2-M1 differs,
  and there the harness is right and the doc is wrong). Wilson and the cluster
  bootstrap (B=10 000, seed `0x5eedc0de`) match; H4 deltas match to the digit.
- **M1 closed:** `env.bootstrapB = 10000` is in the JSON and the doc reads it.
- **M2 closed:** `env.settingsGraph = {nodes:10, edges:19, maxOutDegree:14,
  meanOutDegree:1.9}` is in the JSON and matches the doc's H3 label.
- **Store invariants hold.** Across all four package stores: no two nodes share
  `compact` + `resourceIds` + `stateHash`; no node is keyed by its
  `structuralHash`; `env.skippedNoIdHash` 0.
- **The HIGH-1 causal story is correct.** `Internet` is resolved by EXACT index
  key (`selectorKeys` → `holders` over `n.index`,
  `navigate-to/index.ts:443-455`); only `284ef030` carries `text\x1fInternet`
  (the root carries `text\x1fNetwork & internet`). D.1's transient duplicate is
  what made that key ambiguous, and it is gone. `navNoRouteAmbiguous` 0.
- **No fallback counts as routed.** `navFallback` false on all 60 O5
  known-target steps; aggregate `navRouted 60`, `navFallbacks 0`, `navMisland 0`,
  `navDiverged 0`, `navNoRoute 0`, `fallbacks 0`.
- **H2 reproduces:** all-steps B2 2 − O2 2 = 0 (FAIL); same-screen n=50/50, B2 2
  − O2 1 = 1 (PASS).
- **H3 reproduces:** O4 22 / O3 598 = 0.037× (p50); mean ratio 0.110×, same order.
  O4's `warmTokens` n=153 vs O3's 155 is the doc's "n=153/155"; recomputing O4
  over all 155 steps also gives p50 22, so the two dropped cold steps do not move
  it.
- **L2 setter exists** (`erroredTaskRecord`, `bench-screen-graph.ts:1280`) and
  **L3 relabel is present** (`config !== "O3"` guard, doc calls O3 graph-blind).
- **Run-to-run D.1 33958064084 → D.2 33964414774.** Success: B1 98→98, B2 99→99,
  O1 99→99, O2 99→100, O3 97→100, O4 98→99, O5 99→99. Tokens/step o200k p50: B2
  627→627, O2 54→54, O3 598→598, O4 22→22, O5 29→28, **O1 138→179** (median
  plateau, D2-M5). All D.1 verdicts survive; H1's PASS survives at either ratio.

## NOT VERIFIED

- "236 pass / 2 pre-existing skips" and "tsc clean" (doc lines 197-200): no
  dependency tree in a read-only worktree and no test log in the artifact. The two
  named tests do exist (`test/screen-graph-store-migration.test.ts:208`, the
  `screen-hash.test.ts` golden) and the D.1 store fixture they assert against is
  committed.

## Scoreboard-grade numbers

All from run **33964414774**, workflow `bench-open-vs-proprietary.yml`, bench tree
`feat/screen-graph-d` @ `59791d460`, 7 configs × 20 tasks × 5 reps, `skipped: {}`,
`excluded: 0`, tokenizer js-tiktoken `o200k_base`. Independently recomputed from
`bench-sg-2026-09-05T11-57-59-850Z.json`. Required label on every token row:
**per-step observation payload, launch step excluded (n = 155 of 255 steps),
oracle assertion query excluded.**

| Statistic | N | B1 | B2 | O1 | O2 | O3 | O4 | O5 |
|---|---|---|---|---|---|---|---|---|
| success, exclusions-as-failures | 100 runs | 98 | 99 | 99 | 100 | 100 | 99 | 99 |
| cluster bootstrap 95 %, n=20 tasks, B=10 000 | 20 | [95,100] | [97,100] | [97,100] | [100,100] | [100,100] | [97,100] | [97,100] |
| Wilson 95 % | 100 | [93,99] | [95,100] | [95,100] | [96,100] | [96,100] | **[95,100]** | [95,100] |
| obs tokens/step o200k p50 | 155 | 657 | 627 | 179 | 54 | 598 | 22 | 28 |
| obs tokens/step o200k p95 | 155 | 4161 | 4510 | 515 | 515 | 4510 | 114 | 114 |
| obs tokens/step chars/4 p50 | 155 | 473 | 447 | 103 | 33 | 397 | 20 | 24 |
| obs RTT ms/step p50 | 155 | 447 | 90 | 4 | 3 | 86 | 43 | 46 |
| RTT count/step p50 (MODELLED) | 155 | 2 | 2 | 2 | 2 | 2 | 1 | 1 |
| action wall ms/step p50 (includes recordMs) | 155 | 190 | 1406 | 1441 | 1465 | 1381 | 1359 | 1553 |
| recordMs/step p50 | 155 | 0 | 387 | 368 | 361 | 355 | 374 | 8 |
| action wall − recordMs, p50 | 155 | 190 | 1038 | 1068 | 1066 | 1033 | 1028 | 1184 |

- **O5 navigate-to, all 60 attempted known-target taps:** routed **60**, of which
  **55 one-step** and **5 zero-step (no tap issued, D2-H1)**; mis-landed 0,
  diverged 0, no-route 0, fallbacks 0, `recordSkippedNoIdHash` 0. Accept the
  outcome counts as measured; do NOT publish "60/60 known-target taps routed"
  without the split.
- **O5 measured RPCs per routed tap:** p50 **7**, n=60, min 4, max 7, mean 6.75 —
  7 for the 55 one-step routes, 4 for the 5 zero-step. 5 of the 7 come from the
  instrumented proxy; the last 2 are a hand-written constant (D2-L1). No measured
  counterpart exists for any other config.
- **H1** — O1/B2 obs tokens/step o200k p50, n=155/155: **179/627 = 0.285×**,
  target ≤ 0.5×, **PASS**. Label: the p50 sits on a plateau boundary; the mean
  ratio is 0.220× here and 0.211× at D.1, so 0.220× vs 0.285× across runs is a
  median artifact, not a behaviour change (D2-M5).
- **H2** — B2−O2 RTT-count/step p50 (modelled count): all steps **0**, **FAIL**;
  same-screen n=50/50 **1**, **PASS**. Accept both.
- **H3** — O4 warm / O3 tokens/step o200k p50, n=153/155: **22/598 = 0.037×**,
  target ≤ 0.2×, **PASS**. Label: warm is a ≤6-affordance summary, cold is a full
  render; store shape 10 nodes / 19 edges / max out-degree 14 / mean 1.9. O3 is
  graph-blind, not cold-store.
- **H4** — paired task-cluster bootstrap of Δ = config − baseline, full 100
  denominator, B=10 000, inferior at >5 pp below: **no config inferior to B1 or
  B2**. vs B1: O1 +1 [−2,4], O2 +2 [0,5], O3 +2 [0,5], O4 +1 [−2,4],
  **O5 +1 [−2,4]**. vs B2: O1 +0 [0,0], O2 +1 [0,3], O3 +1 [0,3], O4 +0 [−3,3],
  **O5 +0 [0,0]**. Accept. Label: low-power for routing — 50 of O5's 100 runs
  contain no known-target tap, and 5 of the 60 taps that exist are no-ops.

## VOID / do not publish as written

- "**O5 routes 60/60**" and "**O5-pure coverage: 60 of 60 known-target taps
  routed**" — 5 of the 60 issue no tap (D2-H1) and their arrival check is vacuous
  (D2-H2). Restate as 55 one-step routes + 5 already-at-target no-ops.
- "**Two-level nav: Network & internet then Internet**" as a task description —
  the second level is never entered by any config (D2-H3).
- O4 Wilson "**[93, 99]**" — the run's own JSON gives [95, 100] (D2-M1).
- "`recordMs` … **attributes the ~1 s open-config gap vs B1**" — it attributes
  ~30 % of it (D2-M4).
- "the ratio … **moves with O1's selector policy**" — the observation payload is
  unchanged run to run; the p50 moved (D2-M5).
- "Device H_id stability is **evidenced empirically**" — a clean store is
  consistent with it, not evidence for it (D2-M7).
