# Adversarial review — screen-graph C.4 (run 33806639520)

Reviewer: independent read-only pass. Branches read in throwaway worktrees at
`origin/feat/screen-graph-c4` @ `212d7d58` and `origin/feat/bench-ci-c4` @
`2fb03fc7`. Artifact `bench-screen-graph` from runs **33806639520** (C.4 FINAL)
and **33786304637** (C.3 FINAL, pulled for the two-run comparison). No device
used. Run 33806639520 checkout step logs `212d7d58dc3094dea21bb220a7d7ce1ec90f034a`
— the code read here IS the code that ran. Doc under review:
`docs/specs/2026-09-03-screen-graph-results-ci.md`.

## Verdict: **REJECT** — scoped

Every C.3 REJECT item is genuinely fixed **except the one the phase is named
after**. B1 is now a valid live describe+tap agent; H1 is genuinely
needle-independent; the graph-store diagnosis is correct and better evidenced
than the doc claims. But **H4's "PASS — none inferior" and every published O5
success number are invalid**, for the same structural reason C.3's B1 was: the
denominator is chosen by the outcome. O5's 13 failures are removed from its own
comparison as "plumbing", and the H4 shared-pair intersection then removes the
same 13 pairs from the baseline — pairs on which B1/B2/O1–O4 all scored Y.
The C.3 defect was not eliminated, it was relocated from B1 to O5.

Three published numbers are additionally **wrong, not merely mislabelled**:
`navMisland 0`, `navFb 40/42`, and O3's matrix cell.

## Findings

### Verified TRUE (no action)

- **C4-OK1 · B1 is live, no cache, no precompute.** `bench-screen-graph.ts:1022-1027`:
  on every tap step B1 issues its own `describe` and derives the coordinate from
  **that call's** text via `parseDescribeLocate` (`bench/describe-locate.ts:24-46`,
  pure). `:1906` `const precomputeMs = 0` with the comment; `grep precompute`
  finds no coordinate cache anywhere in the tree. Records confirm it is live, not
  replayed: all 80 B1 tap steps have `obs:"describe"`, `rttMs` 79–1406 ms, **zero
  0-ms reads**; the same task's per-step tokens differ between reps
  (`settings-battery-then-back` reps 0/2/4 read a 112-token transient after
  `back`, reps 1/3 read 657). A cache cannot produce per-rep variation.
  `fallbacks 0` for B1 → the proprietary path was exercised (HIGH-5 guard,
  `:1966`). **B1's 100 % is a real number.**
- **C4-OK2 · The B1 exclusion is legitimate — and is an agent failure, not infra.**
  `B1/settings-battery-then-back/rep3` (`logs/sg-matrix.log:124`): step 3's live
  describe returned the 112-token transient screen that also appears mid-task in
  reps 0/2/4; "Battery" is absent from it, `parseDescribeLocate` returns
  `found:false`, the task aborts. No centre tap. It is exactly the failure mode a
  live describe+tap agent has. Counted as a failure B1 is **99/100**.
- **C4-OK3 · H1 is needle-independent, verified empirically.** `bench/observe.ts:31-36`
  never reads `task.assertion`; `bench-screen-graph.ts:1068` is its only caller.
  I executed `observationQuery` over the **shipped** 20 tasks with the needle
  swapped for `ZZZ_TOTALLY_DIFFERENT_NEEDLE`: **20/20 byte-identical, 0 selectors
  equal to their assertion.** The claim holds beyond the unit test's single task.
- **C4-OK4 · Full-tree needle gate + the new needle.** `bench/oracle.ts` gains
  `ignoreVisibility`; `scripts/bench-preflight.ts:345` passes it for navigating
  tasks. `logs/sg-preflight.log`: `settings-root nodes: 133` (full tree, C.3 saw
  visible-only), `PROBLEM needles: 0 — none`, `GATE PASS`. Every
  `Brightness level` pass in the run matched `{text:"Brightness level", id:"title"}`
  — no subtitle false-pass. `Calls & SMS`, `Special app access` likewise.
- **C4-OK5 · No config advantaged by prepareChromeOnce or the task edits.**
  `:1889` runs it once before the config loop. The needle change applies to one
  shared oracle. The `query` anchors are used only by open configs, and they made
  O1 look **worse** (0.107× → 0.285×), not better.
- **C4-OK6 · Workflow.** `bench-open-vs-proprietary.yml` checks out
  `ref: feat/screen-graph-c4` by branch name (C-L3 closed); both `run:` blocks
  start `set -euo pipefail`; no `continue-on-error` on the screen-graph job (the
  one at `:249` is the latency job); `BENCH_REPS: "5"`; timeout 180 min. Run
  green, all 15 steps success.
- **C4-OK7 · The per-task matrix and every descriptive statistic regenerate
  exactly** from `bench-sg-2026-09-03T21-17-54-188Z.json` (one cell excepted, see
  C4-L2). Wilson recomputed independently for all 7 configs: identical to the doc
  to the rounding (B2's `[92,99]` is a rounded 91.5).

### HIGH

- **C4-H1 · O5's 99 % is the C.3 B1 artifact wearing a different hat; the honest
  number is 86/100.** `oracle.ts:145` treats *any* `locateFailed` as
  plumbing/infra and `:171-189` drops it from the denominator. All 13 O5
  exclusions sit at `stepIndex 1`, **immediately after O5's own `navigate-to`
  moved the device off the source screen**: 10 with `{reached:true,
  completedSteps:1/1, misland:true}` (settings-network ×5, settings-network-internet
  ×5) and 3 with `{reached:false, completedSteps:0/1}` whose recorded `hash` is
  already `2bf46d4f…`, i.e. the sub-screen (settings-apps ×3). The re-locate then
  correctly reports the row is gone. That is a **strategy** failure, not
  plumbing. The C.1 rule it invokes (`phase-c1-oracle.md` fix 1+2) was written for
  a locate that is *"plumbing, identical for all configs"*; C.4 deliberately broke
  that premise by giving B1 its own describe-locate and by letting O5 move the
  device before locating. Counted as failures: **O5 = 86/100, Wilson [78, 91]** —
  which lies entirely below B1's [96, 100]. **Fix:** exclude only pre-action
  infra failures; classify a locate-fail that follows the config's own navigation
  as a task failure.
- **C4-H2 · The H4 verdict is circular for O5.** `bench-screen-graph.ts:1580`
  intersects the two configs' *scored* pairs, so the 13 pairs O5 could not do are
  removed **from the baseline too**. The generated report states it plainly:
  `O5 99% [94,100] vs 100% [96,100] (n=86)` — B1 scored Y on all 14 removed
  pairs. Non-inferiority measured only where the challenger did not
  catastrophically fail is not non-inferiority. For O1–O4 the intersection is
  98–100 of 100 pairs and the verdict survives; for O5 it does not.
  Paired cluster bootstrap over the 20 tasks with exclusions as failures:
  `O5 − B1 = −13.0 pp, 95 % CI [−29, 0]`; `O5 − B2 = −11.0 pp [−27, +2]`.
  O1–O4 vs both baselines: all point estimates within ±3 pp, all CIs straddling 0.
- **C4-H3 · `navMisland 0` is a false published number.** `aggregate()` skips
  excluded runs at `bench-screen-graph.ts:1274` **before** the nav counters at
  `:1283-1290`, so every navigate attempt that caused an exclusion is invisible to
  them. The CI report therefore prints *"fallbacks 40 (no-route/divergence 40,
  reached-but-mis-landed **0**)"* while the per-step records hold **10 mislands**.
  The hand-written doc's prose says the opposite of its own generated table.
  True counts over all 55 attempted known-target taps: **2 routed, 10 mis-landed,
  3 diverged-after-tap, 40 no-route → 53 fallbacks**, not 40/42.
- **C4-H4 · The "re-observe before the fallback tap" guard keys on a field that
  cannot carry that meaning.** `bench-screen-graph.ts:742` re-observes only when
  `completedSteps > 0 || misland`. But `navigate.ts:65-75` executes the action
  and returns `completedSteps: completed` **without incrementing** on divergence —
  so `completedSteps:0` is emitted for a step that already tapped. The 3
  settings-apps exclusions are exactly that case: `completedSteps:0` with the
  post-tap sub-screen hash. The code comment at `:740-741` ("A no-route
  (completedSteps 0) never tapped, so the source screen is intact") is factually
  wrong. No blind tap resulted here only because `locateNorm` is a live query.
  **Fix:** gate on `totalSteps > 0` or on an observed hash change.
- **C4-H5 · Wilson at n = 100 assumes 100 independent trials; the reps are
  correlated by task and the doc never states an effective N.** Failures cluster:
  O5's 13 are 3 whole tasks (5/5, 5/5, 3/5). Task-level cluster bootstrap over the
  20 tasks, exclusions as failures, vs the naive Wilson the doc publishes:
  O5 [71, 99] vs [78, 91]; B2 [92, 100] vs [91.5, 99]; O4 [95, 100] vs [93, 99].
  Where failures cluster the naive interval is **too narrow by a factor of ~2**.
  The doc's cross-check against the C.3 3.4–8.3 pp noise floor is a coincidence
  of magnitude, not a correlation correction.

### MEDIUM

- **C4-M1 · The Jaccard from-side localizer never ran; the run is zero evidence
  it works.** `plan.ts:248-256` returns `via:"exact"` whenever the live hash is
  already a node, and **both** root hashes are in the store, so `fromVia` was
  `exact` on all 55 nav records. The doc's *"The from-side fix I added … works —
  `fromVia` was `exact` on every O5 step this run"* inverts the logic: `exact`
  means the fallback was never reached. Worse, the dominant root node
  `77a189ce…` carries **no `resourceIds`** (`hasRids false`), so
  `bestNodeByResourceIds` could not have scored it. Only the unit test supports
  the matcher.
- **C4-M2 · "The root did NOT drift" is refuted by the uploaded store.**
  `graph-store/com.android.settings/34.json` holds **two** root nodes with
  near-identical 64-key text indexes and the same label `Settings: Network &
  internet`: `77a189ce…` (the operative one — the `from` of 194 of the 225
  recorded traversals) and `299378e0…` (visits 34, 23 distinct resource-ids,
  reached from `77a189ce…` by a `swipe up` edge, count 30). Two structural hashes
  for one screen **is** drift — the RecyclerView first-child rule
  (`ScreenHash.kt:84-89`) makes scroll position part of `H`. The doc also
  mislabels them: it calls `299378e0…` "the root" and `77a189ce…` "one empty
  transient root"; the latter is neither empty (64 index keys) nor transient.
  `82827b4a…` (Apps, visits 2) shows the same instability on a sub-screen —
  the Apps screen hashed distinctly on 2 reps and collapsed into `2bf46d4f…` on
  3, which is precisely why settings-apps routed 2/5.
- **C4-M3 · O5's tokens/step and RTT/step are measured on its surviving subset.**
  n = 137 steps vs 155 for every other config, because `aggregate` skips the 13
  aborted runs. The dropped steps are the expensive ones (navigate + re-observe +
  locate). Publishing O5's 85 tok / 1 RTT alongside O4's without the N difference
  overstates the parity.
- **C4-M4 · O5's RTT-count of 1/step still undercounts (C.3 C-M7 unfixed).**
  `policy.ts` returns `graph-lookup` for every `knownTarget` step, and `:1078`
  scores `graph-lookup` as 0 observation RTTs. On the 53 fallback steps O5 paid a
  `navigate-to` + a `locate` query + a tap and is recorded as 1. Its
  `actionRttMs` p50 is 46 ms only because the observation is a summary describe.
- **C4-M5 · C.3's C-M2 is unfixed and undisclosed.** `bench-preflight.ts:345-350`
  still decides a navigating task's verdict purely from `matchesLaunch`; the
  destination is never consulted. A needle on **neither** screen still prints
  `ok (unique to destination, full-tree gate)`. The label is stronger than the test.
- **C4-M6 · C.3's C-M3 is unfixed and undisclosed.**
  `packages/tool-server/test/fixtures/preflight-launch-screens.json` is still not
  committed (the dir holds only `electron-smoke-app/`, `vega-*.xml`), so the
  BLOCKER-1 needle-vs-launch assertions still `describe.skipIf` away.
- **C4-M7 · O5's headline improvement is entirely accounting.** C.3 → C.4 on the
  same 20 tasks: scored rate 81.7 % → 98.9 % (+17.2 pp), but
  **exclusions-as-failures 81.7 % → 86.0 % (+4.3 pp)** — inside the doc's own
  3.4–8.3 pp noise floor. navigate-to routed 9/153 steps in C.3 and 2/55
  known-target taps in C.4. O5's routing did not measurably improve.

### LOW

- **C4-L1** The observation anchor is not the assertion *string*, but for
  `chrome-example-word` (assertion `example`, anchor `Example`) the two are the
  same predicate under `contains + caseInsensitive`
  (`toOpenSelector`, `oracle.ts:87`). The tested invariant still holds; the doc's
  "never the needle" is literally false for that task.
- **C4-L2** The doc's per-task matrix renders O3's `settings-network-internet`
  rep 1 as `N`; the JSON has `taskError:true`. Its legend has no `T` symbol, so a
  3rd `N` appears in a row that reports only 2 scored failures.
- **C4-L3** O3's `fallbacks 2` appears in the generated table and is dropped from
  the hand-written doc without explanation.
- **C4-L4** Checking out by branch name (the C-L3 fix) removes the stale-pin
  failure but leaves the run irreproducible from the artifact alone: neither the
  bench JSON `env` nor the results doc records the bench-tree SHA. Only the CI
  checkout log does. Record `git rev-parse HEAD` in `env`.
- **C4-L5** C.3's C-L2 is resolved: O4 warm n = 151 is odd, so `pct` (`tokens.ts:64`,
  `ceil(p/100·n)−1`) and the standard median both give **77**. H3 = 0.129× stands
  under either convention.
- **C4-L6** B1's locate (`parseDescribeLocate`, first line whose annotations
  *contain* the text, including non-clickable subtitles) and the open configs'
  locate (`query(limit:5).nodes[0]`) are different "topmost match" definitions.
  Harmless in this run (B1 99/99) but it is no longer one locate for all configs.

## Numbers I accept as scoreboard-grade

All from **run 33806639520**, 7 configs × 20 tasks × 5 reps, bench tree
`212d7d58`. Independently recomputed from
`.bench-results/screen-graph/bench-sg-2026-09-03T21-17-54-188Z.json`; all
reproduce the doc.

| Statistic (p50) | B1 | B2 | O1 | O2 | O3 | O4 | O5 |
|---|---|---|---|---|---|---|---|
| n steps (non-launch, scored) | 152 | 155 | 155 | 155 | 153 | 155 | **137** |
| tokens/step o200k | 657 | 627 | 179 | 54 | 598 | 85 | 85 |
| tokens/step chars/4 | 473 | 447 | 103 | 33 | 397 | 70 | 70 |
| observation RTT ms/step | 462 | 91 | 4 | 4 | 87 | 47 | 46 |
| RTT count/step, all | 2 | 2 | 2 | 2 | 2 | 1 | 1 |
| RTT count/step, same-screen (n=50) | 2 | 2 | 2 | 1 | 1 | 1 | 1 |

Labels that must travel with them: O5's row is over **137** steps, not 155, and
its RTT-count of 1 omits the navigate + locate round-trips on 53 of its 55
known-target taps (C4-M3, C4-M4). O1/O2 tokens are needle-independent but
selector-policy-dependent — they move if a task's own selectors change.
B1's observation RTT includes the proprietary describe.

**Task success — I accept only the exclusions-as-failures column** (denominator
fixed at 100 for every config, so it cannot be chosen by the outcome):

| Config | ok/100 | Wilson (naive, n=100) | Task-cluster bootstrap (n=20 tasks) |
|---|---|---|---|
| B1 | 99 | [94.6, 99.8] | [97, 100] |
| B2 | 97 | [92, 99] | [92, 100] |
| O1 | 100 | [96, 100] | [100, 100] |
| O2 | 98 | [93, 99] | [94, 100] |
| O3 | 97 | [92, 99] | [94, 100] |
| O4 | 98 | [93, 99] | [95, 100] |
| O5 | **86** | [78, 91] | [71, 99] |

The doc's `ok/scored` column (B1 100 %, O3 98 %, O5 99 %) is **not** scoreboard-grade
for O5, whose denominator moves by 13 %; it is acceptable for B1 and O3, whose
single exclusions are pre-action and config-independent.

Hypotheses, run 33806639520:

- **H1 PASS** — O1/B2 tokens/step o200k p50, n = 155/155: **179/627 = 0.285×**
  (target ≤ 0.5×). Needle-independence verified over all 20 shipped tasks, not
  just the unit test. Accept.
- **H2 all-steps FAIL** — B2 2 − O2 2 = **0**, n = 155. Accept.
- **H2 same-screen PASS** — B2 2 − O2 1 = **1**, n = 50 each. Accept.
- **H3 PASS** — O4 warm p50 / O3 cold p50 = **77/598 = 0.129×**, n = 151/153,
  target ≤ 0.2×. Same value under both percentile conventions. Accept.
- **H4 — PARTIAL.** Accepted for **O1–O4 only**: on the full 100-run denominator
  with exclusions as failures, the paired task-cluster bootstrap gives
  O1..O4 − B1 ∈ {+1, −1, −2, −1} pp and O1..O4 − B2 ∈ {+3, +1, 0, +1} pp, every
  95 % CI containing 0 → **indistinguishable at N**, against a *valid* B1.
  **VOID for O5**: the published 99 % [94, 100] is measured on the 87 runs O5's
  own routing did not destroy, and the H4 intersection removes the same 13 pairs
  from the baseline (C4-H1, C4-H2). O5's honest figure is **86/100**, point
  estimate **−13 pp vs B1**, CI [−29, 0].

O5 routing, corrected counts (all 55 attempted known-target taps, not the 42
scored ones): **routed 2 · mis-landed 10 · diverged-after-tap 3 · no-route 40 ·
fallbacks 53.** O5-pure at N = 2 carries no information.

## The graph-collision diagnosis: accepted, and stronger than stated

The doc's central structural claim is **TRUE and now directly evidenced** by the
store it uploaded:

- Node `2bf46d4fd2e567c9`, **visits 285**, label `Network & internet: Internet`,
  is the destination of **seven distinct root buckets** from `77a189ce…`
  (`(6,5) (6,7) (3,8) (5,10) (4,11) (4,13) (5,14)`, counts 19/14/24/15/45/15/30)
  plus eight more from `299378e0…` — i.e. Network, Connected devices, Apps,
  Notifications, Battery, Storage, Sound & vibration and Display all collapse
  onto one node. Its text index holds **only Network & internet's** strings
  (`Internet, AndroidWifi, Calls & SMS, T-Mobile, SIMs, Airplane mode, …`), the
  last screen `upsertNode` wrote.
- Cause confirmed device-side: `ScreenHash.kt:78-83` appends only
  `className | resourceId | quantised bounds | flags`, never `text`/`contentDesc`;
  `:84-89` hashes a scrolling container as the container plus **its first child's
  class sequence only**; `:66` quantises to 1/32 (75 px vertically at 2400).
  `AppBar + CollapsingToolbar + RecyclerView(first row)` is identical across every
  Settings detail screen.
- Consequence, now traceable edge-by-edge: for `navTarget "Internet"` the only
  target node is the collapsed one, and dijkstra (`plan.ts:29`,
  weight `1/(successes+1) + staleness/30`) takes the **cheapest** root edge —
  bucket `(4,11)`, 45 successes, weight ≈ 0.022 — which is not the Network row.
  It lands on a sibling detail screen, hashes to `2bf46d4f…` → `reached:true`,
  `queryPresent("Internet")` fails → the 10 mislands. The other 40 navTargets
  (`Saved devices`, `Battery Saver`, `Trash`, `Call volume`, `Notification
  history`, `Brightness`) are indexed nowhere → no route.

Nothing in C.4's harness could have fixed this; the follow-up is device-side
(separate sibling list screens in `H`) plus semantic edges. Accept as written,
with the two corrections in C4-M1/C4-M2.

## Run-to-run stability (33786304637, 3 reps → 33806639520, 5 reps)

Exclusions-as-failures, same 20 tasks:

| | B1 | B2 | O1 | O2 | O3 | O4 | O5 |
|---|---|---|---|---|---|---|---|
| C.3 33786304637 | 93.3 | 100.0 | 96.7 | 98.3 | 100.0 | 100.0 | 81.7 |
| C.4 33806639520 | 99.0 | 97.0 | 100.0 | 98.0 | 97.0 | 98.0 | 86.0 |
| Δ pp | +5.7 | −3.0 | +3.3 | −0.3 | −3.0 | −2.0 | +4.3 |

**Robust verdicts** (survive both runs and the noise floor): H1, H2 (both rows),
H3; the qualitative H4 statement *O1–O4 match both baselines within noise at an
order of magnitude fewer tokens*; and **O5 is the only config that is worse**,
in both runs, by a margin larger than the floor.
**Not robust:** any per-config success ranking among B1/B2/O1–O4 (every Δ is
inside 3.4–8.3 pp), and O5's apparent recovery — +4.3 pp is inside the floor.
B1's +5.7 pp is the precompute fix, not noise, and is the one C.3→C.4 delta with
a mechanism.

## Minimum to reach ACCEPT

1. Report O5 as **86/100** in the per-config table, the Wilson column and H4.
   Keep 86/87 only as a clearly labelled secondary "conditional on completing".
2. Reclassify a `locateFailed` that follows the config's own navigate as a task
   failure; restrict `isExcludedRun` to pre-action infra.
3. Move the nav counters above `bench-screen-graph.ts:1274` (or count over all
   records) and republish: routed 2, mis-landed 10, diverged 3, no-route 40,
   fallbacks 53, of 55 attempts.
4. Drop or heavily caveat the H4 shared-pair intersection: report each config on
   the full 100-run denominator, and state the effective N / cluster-corrected
   interval next to every Wilson.
5. Fix the `bench-screen-graph.ts:742` guard (gate on `totalSteps > 0`) and the
   wrong comment at `:740-741`.
6. Withdraw "the from-side fix works" and "the root did NOT drift"; the store has
   two root nodes and `fromVia` was `exact` 55/55, so the Jaccard path never ran.
   Relabel `77a189ce…` as the operative root.
7. Commit `preflight-launch-screens.json` (C-M3) and fix the preflight verdict
   label to check the destination (C-M2), or say both are still open.
