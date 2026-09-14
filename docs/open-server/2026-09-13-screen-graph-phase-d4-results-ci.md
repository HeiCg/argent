# Results (CI): screen-graph Phase D.4 — one symmetric locate resolver, unique navTarget, B1's describe rendering exposed

Phase D.4 closes the D.3 asymmetry caveat. In D.3 the open configs located with
`pickUniqueNode` (unique-or-refuse) while B1's describe locate was relaxed to
exact-first-then-**first-contains**, so B1 could tap `nodes[0]` of an ambiguous set.
That made B1's drop a harness property masquerading as a proprietary-capability claim.
D.4 gives **both renderings one resolver**: `parseDescribeLocate` (B1) and `locateNorm`
(open) both call the same `pickUniqueNode` with identical precedence — whole-field EXACT
resource-id → EXACT text → EXACT contentDescription → a CONTAINS match ONLY when exactly
one candidate matches → otherwise refuse (locate-fail, counted). The only thing that
differs between B1 and the open configs is the RENDERING fed in, not the policy.

- **Provenance.** Authoritative run **34794414764** (`HeiCg/argent`, workflow
  `bench-open-vs-proprietary.yml`, `suite=screen-graph`, `sg_mode=matrix`), branch
  `feat/screen-graph-d4` @ `13388c19`, base `open/main` @ `690e66bc`. Items 1 (symmetric
  resolver) and 3 (unique navTarget) landed earlier in `68f2d26f` (`fix(bench): symmetric
  locate resolver for B1 and open configs; unique navTarget [phase D.4]`), which `690e66bc`
  already contains. JSON `bench-sg-2026-09-14T01-06-47-293Z.json`; harness `results-ci.md`
  reproduced here to the digit. **7 configs × 20 tasks × 5 reps = 700 task-runs**, `skipped
  {}`, `excluded 0`, bootstrap `B = 10000` (`env.bootstrapB`), tokenizer o200k_base
  (primary) + chars/4 (secondary). Every number below names statistic, block, N and run id.
- A **reference run 34788497583** (`suite=both`, on the merged tree `merge/screen-graph-d`,
  the same resolver code) is used only where noted; its B1 describe excerpt for the
  "Internet" row was NOT in its artifact (see §Item 2), which is why one new run was taken
  after adding the capture. Do not blend the two runs' numbers.

## Per-config — success (full 100 denominator), tokens/step, RTT (run 34794414764)

`success` = ok/total on the FULL 100-run denominator (exclusions-as-failures, phase D §0.1).
PRIMARY interval = task-cluster bootstrap (n=20 tasks, the effective N); SECONDARY = naive
Wilson (n=100). `fail (L/A/O/T)` = locate/action/oracle/task reasons (NOT exclusions).
`fallbacks` = console describe/tree-fallback count — **for B1 any fallback would invalidate
its metrics (review HIGH-5); B1 = 0 here, so the proprietary path was genuinely exercised.**

| Config | n steps | tok/step o200k p50 | tok/step o200k p95 | chars/4 p50 | obs RTT ms/step p50 | RTT count/step p50 | success | cluster 95% (n=20) | Wilson (n=100) | fail (L/A/O/T) | fallbacks |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B1 (argent proprietary) | 145 | 657 | 4161 | 473 | 173 | 2 | **82 % (82/100)** | [65, 97] | [73, 88] | 18 (13/0/0/0) | 0 |
| B2 (open, no graph) | 151 | 645 | 4510 | 447 | 22 | 2 | 98 % (98/100) | [94, 100] | [93, 99] | 2 (0/0/0/1) | 2 |
| O1 (+ query/diff) | 155 | 138 | 515 | 77 | 3 | 2 | 98 % (98/100) | [95, 100] | [93, 99] | 2 (0/0/0/0) | 0 |
| O2 (+ outcomes) | 155 | 54 | 515 | 33 | 3 | 2 | 99 % (99/100) | [97, 100] | [95, 100] | 1 (0/0/0/0) | 0 |
| O3 (+ graph, graph-blind) | 155 | 627 | 4510 | 446 | 20 | 2 | 98 % (98/100) | [95, 100] | [93, 99] | 2 (0/0/0/0) | 0 |
| O4 (graph, warm) | 155 | 21 | 114 | 20 | 16 | 1 | 100 % (100/100) | [100, 100] | [96, 100] | 0 | 0 |
| O5 (+ navigate-to) | 155 | 22 | 114 | 20 | 16 | 1 | 95 % (95/100) | [87, 100] | [89, 98] | 5 (0/0/0/0) | 0 |

Token rows are the **per-step observation payload** the scripted agent would see under the
config policy. `obs RTT ms/step` for open configs INCLUDES `recordMs` and the 2 500 ms
settle wait B1 does not pay — NOT a like-for-like latency column (D2-M4); screen-graph
compares tokens and success, not latency.

- **B1 = 82/100.** Its 18 failures split **13 locate-fails + 5 oracle-unmet**, and both
  buckets are explained by B1's describe RENDERING under the shared policy, not by the
  resolver (§Item 2). B1's console `fallbacks = 0`, so its numbers are valid (HIGH-5).
- **O5 = 95/100.** Its 5 failures are all on the two Display tasks (`settings-display`
  YNNNY, `same-display-slider` NYNYY) — the known scrcpy fling under-scroll flakiness,
  config-neutral (B2 `same-display-slider` YNNYY, O3 has Display Ns too), plus the
  `Brightness` navTarget divergence that falls back (§O5). It is NOT a routing regression
  on `settings-network`.
- **B2** carried 1 taskError (a single-rep display/infra flake, wall 0 ms on that run) and
  2 console fallbacks; config-neutral and single-rep.

## Item 1 — one resolver, two renderings (proved by unit test)

`packages/tool-server/src/screen-graph/bench/locate.ts` defines `pickUniqueNode` (the sole
policy). `describe-locate.ts` (`parseDescribeLocate`) parses B1's describe payload into the
same `QueryNodeLite` shape and runs `pickUniqueNode`; `locateNorm` runs it on the open
`query` nodes. `test/screen-graph-bench-locate.test.ts` (13 tests, all green) feeds the SAME
screen through BOTH renderings and asserts the same node is chosen or both refuse, including
the D2-H3 case (`t("Internet")` picks the exact "Internet" row over the "Network & internet"
toolbar) and the ambiguous case (two identical-text rows → both renderings return
`found:false, ambiguous:true` — no `nodes[0]` tap). A CAPTURED-screen test (added this phase)
pins the real Network & internet rendering from this run (§Item 2). Verbatim (15/15):

```
✓ phase D.4 — ONE resolver policy for both renderings (B1 describe vs open query) > both renderings resolve t("Internet") to the same node
✓ phase D.4 — ONE resolver policy for both renderings (B1 describe vs open query) > both renderings resolve t("Calls & SMS") to the same node
✓ phase D.4 — ONE resolver policy for both renderings (B1 describe vs open query) > both renderings resolve t("Airplane mode") to the same node
✓ phase D.4 — ONE resolver policy for both renderings (B1 describe vs open query) > D2-H3 the exact 'Internet' row wins over the 'Network & internet' toolbar in BOTH renderings
✓ phase D.4 — ONE resolver policy for both renderings (B1 describe vs open query) > BOTH renderings REFUSE an ambiguous selector (no exact, >1 contains) — no nodes[0] tap
✓ phase D.4 — CAPTURED Network & internet screen (run 34794414764) > open query resolves the discrete 'Internet' row; B1 describe has only the collapsed 'Network & internet' summary
✓ phase D.4 — CAPTURED Network & internet screen (run 34794414764) > 'Airplane mode' (settings-network navTarget) resolves cleanly in BOTH renderings
Test Files  1 passed (1)
     Tests  15 passed (15)
```

## Item 2 — B1's rendering of the "Internet" row (the two-level task)

**B1 fails `settings-network-internet` NNNNN** (5/5 oracle-unmet, 0 locate-fail this run).
The two-level task launches Settings, taps `Network & internet` (step 1), then `Internet`
(step 2), and asserts the needle **"Add network"**, which the pre-flight (needleEval)
confirmed lives ONLY on the Internet (Wi-Fi) screen (`navigates=true, matchesLaunch=false,
"absent from launch, present on destination"`). Every open config reaches it; B1 does not.

The captured excerpt is the reason, quoted verbatim from the run artifact
(`logs/sg-matrix.log`, line 28):

```
[bench-sg][D4] B1 locate FOUND-UNIQUE for {"text":"Internet"} on settings-network-internet step 2; describe rows containing "internet": LinearLayout "Network & internet / Mobile, Wi‑Fi, hotspot" [clickable]  (0.000, 0.321, 1.000, 0.096)
```

B1's proprietary `describe` **collapses the row into a combined string**: the ONLY node
whose text contains "internet" is the summary `"Network & internet / Mobile, Wi‑Fi,
hotspot"`. There is no discrete "Internet" list row. Under the identical symmetric policy,
`t("Internet")` has no exact whole-field match and exactly one contains-hit (the combined
summary), so `pickUniqueNode` returns it FOUND-UNIQUE — B1 taps the combined toolbar-style
row, never reaches the Internet (Wi-Fi) screen, and "Add network" is absent. This is a
**describe RENDERING property, documented by the exact excerpt** — it is NOT the resolver
being relaxed, and NOT B1 refusing where the open path resolves. The open `query` surfaces a
clean, discrete "Internet" row, which is why all six open configs pass the task.

Assertion evidence (run 34794414764, `results-ci.md` B1 per-task failure table):

| Task | Needle | B1 met | B2 met | B1 matched text | B2 matched text |
|---|---|---|---|---|---|
| settings-network-internet | Add network | N | Y | (none) | Add network |

**Corroboration — the same collapse across the whole Settings list.** The `[D4]` capture
shows every first-level row is a combined summary, e.g. `"Battery / 100%"`, `"Storage / 36%
used - 5.10 GB free"`, `"Sound & vibration / Volume, haptics, Do Not Disturb"`. First-level
navigation still works because the combined string is a UNIQUE contains-hit for its prefix
(`t("Network & internet")` → the one row containing it → correct row). It breaks only where
the selector is a sub-label the describe folds into a summary and a *second* node also
contains it — `t("Display")` (line 25):

```
[bench-sg][D4] B1 locate AMBIGUOUS for {"text":"Display"} on settings-display step 2; describe rows containing "display": LinearLayout "Display / Dark theme, font size, brightness" [clickable]  (0.000, 0.457, 1.000, 0.096) || LinearLayout "Accessibility / Display, interaction, audio" [clickable]  (0.000, 0.650, 1.000, 0.096)
```

Two rows contain "display" and neither is an exact whole-field "Display", so the symmetric
resolver **refuses** (AMBIGUOUS → locate-fail) rather than tapping `nodes[0]`. That is B1's
`settings-display` LLLLL and `same-display-slider` LLLLL (10 of the 13 B1 locate-fails); the
remaining 3 are `settings-battery-then-back` (a MISS after the back step, `describe rows
containing "battery": (none)`). All are honest rendering outcomes of the shared policy.

**Harness change that captured it (this branch).** In run 34788497583 the `[D4]`
describe-rows diagnostic was gated to `!located.found && rep === 0`. The two-level "Internet"
step resolves a unique-but-wrong node at rep 0 (FOUND-UNIQUE → oracle-unmet, not a
locate-fail), and its locate-fails in D.3 happened at reps ≠ 0, so the excerpt was never
emitted and the artifact lacked it — the one legitimate reason for the new run. The
diagnostic now fires at rep 0 for EVERY B1 tap step, tagged FOUND-UNIQUE / AMBIGUOUS / MISS.
It is a log line only: it changes no tap, route, oracle read or success count.

## Item 3 — unique navTarget for `settings-network`; O5 routing

`settings-network`'s navTarget is `t("Airplane mode")` (`tasks.ts`), a label present only on
the Network & internet screen. **O5 no-route on `settings-network` = 0** (all 5 reps
`success=true`; `settings-network` = YYYYY for O5). The D.3 follow-up (a Network-&-internet
row indexed by two screens making `Internet` ambiguous) is resolved: no O5 route on
`settings-network` falls back.

O5 navigate-to structure (structured records, all 60 attempted known-target taps, run
34794414764):

| Outcome | Count |
|---|---|
| one-step routed | **57** |
| zero-step no-op route (D2-H1: not routed) | 0 |
| mis-landed | 0 |
| diverged-after-tap | 3 |
| no-route | **0** |

No-route split: **ambiguous-target 0, no-known-path 0**. Diverged split: hash-mismatch **3**,
selector-ambiguous/unresolved 0. `recordSkippedNoIdHash` 0. **The 3 divergences are all
`{"text":"Brightness"}`** (the Display navTarget on `settings-display` / `same-display-slider`,
`logs/sg-matrix.log` lines 188–190) — a drifted Display hash under fling flakiness, NOT
`settings-network`. Coverage **57/60 one-step routes** (≥ 30 bar), **mis-lands 0** (≤ 2).

| O5 row | success | tok/step o200k p50 | measured RPC/tap | N |
|---|---|---|---|---|
| O5-mixed (all runs) | 95/100 = 95 % · cluster [87, 100] · Wilson [89, 98] | 22 | — | 100 runs |
| O5-pure (every known-target tap routed) | 47/47 = 100 % [92, 100] | 22 | min 7 / p50 7 / max 7 | 47 runs (n=57 taps) |

O5 measured RPCs = navigate-to's proxy-MEASURED RPCs + the bench's await-idle + queryPresent
(2 round-trips), so **7 is a lower bound** (D2-L1).

## Invariants gate (M2/M3) — CI green

`checkStoreInvariants()` ran after the matrix and the job stayed green (`logs/sg-matrix.log`
line 194):

> **`[bench-sg] store invariants OK: 0 duplicate screens, 0 multi-destination edges`**

Produced store shape: `com.android.settings` **11 nodes / 11 edges**
(`env.settingsGraph = {nodes 11, edges 11, maxOutDegree 9, meanOutDegree 1}`),
`com.android.chrome` 1/1, `com.google.android.settings.intelligence` 3/2,
`com.google.android.permissioncontroller` 1/1, `unknown` 2/1 — **0 duplicate screens, 0
multi-destination edges, skippedNoIdHash 0** across all stores.

## Hypotheses (run 34794414764)

| Hypothesis | Statistic | Target | Measured | Verdict |
|---|---|---|---|---|
| H1 | O1 tokens/step vs B2, o200k p50, unchanged steps | ≤ 0.5× | 138/645 = **0.214×** | **PASS** |
| H2 (all steps) | B2 − O2 RTT-count/step p50 | ≥ 1 | 2 − 2 = **0** | **FAIL** (structural) |
| H2 (same-screen, n=50) | B2 − O2 RTT-count/step p50 | ≥ 1 | 2 − 1 = **1** | **PASS** |
| H3 | O4 warm / O3 cold tokens/step, o200k p50 | ≤ 0.2× | 21/627 = **0.033×** | **PASS** |

**H2 label:** navigation tasks change the screen every step, so O2's unchanged-outcome skip
saves nothing there (all-steps ≈ 0); the saving is real only on the 50 SAME-SCREEN steps
(O2 mean RTT/step 1.2 vs B2 2.0). **H3 label:** warm is a ≤6-affordance graph-lookup summary
vs a full cold describe; store shape 11 nodes / 11 edges / max out-degree 9 / mean 1.

**H4 — non-inferior to each baseline** (paired task-cluster bootstrap, B=10000; inferior at
> 5 pp below the baseline point estimate):

| Baseline | Baseline success (cluster / Wilson) | Paired Δ verdict (O1..O5) |
|---|---|---|
| B1 (82 %, 82/100) [65, 97] / [73, 88] | | **PASS — none inferior.** O1 +16 [3, 31] · O2 +17 [3, 33] · O3 +16 [3, 31] · O4 +18 [3, 35] · O5 +13 [2, 26] |
| B2 (98 %, 98/100) [94, 100] / [93, 99] | | **PASS — none inferior.** O1 +0 [−3, 3] · O2 +1 [−3, 6] · O3 +0 [−3, 3] · O4 +2 [0, 6] · O5 −3 [−9, 0] |

H4 vs B1 is now an HONEST comparison: B1's 82 is a describe-rendering limit under the SAME
resolver every config uses, not a relaxed-vs-strict artifact. The meaningful non-inferiority
is **vs B2** (all O-configs within ±3 pp; O5 −3 pp with the interval touching 0, driven by
the config-neutral Display flakiness).

## Per-task success matrix (run 34794414764)

`Y` oracle met · `N` oracle unmet · `L` locate-failed (aborted).

| Task | B1 | B2 | O1 | O2 | O3 | O4 | O5 |
|---|---|---|---|---|---|---|---|
| settings-network | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-connected | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-apps | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-notifications | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-battery | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-storage | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-sound | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-display | LLLLL | YYYYY | NYYYY | NYYYY | YYNYY | YYYYY | YNNNY |
| settings-network-internet | NNNNN | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-battery-then-back | LYYLL | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-open-page | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-heading-word | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-example-word | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-scroll-body | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-scroll-doc | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-settings-search | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-sound-noop | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-chrome-noop | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-display-slider | LLLLL | YNNYY | NYYYY | YYYYY | YNYYY | YYYYY | NYNYY |
| same-apps-noop | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |

## Superseded D.3 numbers (from `2026-09-03-screen-graph-results-ci.md`, run 33976442407)

| D.3 number | Why superseded |
|---|---|
| B1 94/100, failures 6 (1/0/0/0/5) all on `settings-network-internet` | D.3 relaxed B1's describe locate to exact-then-first-contains. D.4 uses the SAME `pickUniqueNode` for B1. Under the symmetric policy B1 is **82/100** (18 fails = 13 locate/5 oracle), all attributable to the describe RENDERING (collapsed rows), documented with excerpts. |
| B1 `settings-network-internet` = NNNLN (1 describe-limit L, mixed) | Now **NNNNN**: with the symmetric resolver B1 taps the collapsed `"Network & internet / Mobile, Wi‑Fi, hotspot"` summary uniquely each rep (FOUND-UNIQUE, wrong target), so it is oracle-unmet, not locate-fail. Matched text (none) vs B2 "Add network". |
| O5 no-route 5, all on `settings-network` step 1 (navTarget `Internet`) | Fixed by navTarget `t("Airplane mode")`. **O5 no-route = 0** (ambiguous-target 0, no-known-path 0); `settings-network` YYYYY for O5. |
| O5 one-step routed 54/60, diverged 1 | This run **57/60 one-step routed, 3 diverged** (all hash-mismatch on the `Brightness` Display navTarget), 0 no-route, 0 zero-step. |
| H1 0.212×, H4-vs-B1 Δ around +3..+6 pp | Recomputed on 34794414764: H1 **0.214×**; H4-vs-B1 Δ +13..+18 pp (larger because B1 is honestly 82, not 94). H4-vs-B2 all within ±3 pp. |
| store 11 nodes / 10 edges | This run **11 nodes / 11 edges** (max out-degree 9, mean 1); gate still 0/0. |

## Acceptance check

| Criterion | Status |
|---|---|
| Same resolver policy in both paths; unit test proves it | **PASS** — `parseDescribeLocate` and `locateNorm` both call `pickUniqueNode`; 15 tests green incl. the captured-screen test |
| B1's two-level outcome explained by a quoted rendering, not a relaxed resolver | **PASS** — verbatim `[D4]` excerpt: only "internet" node is the collapsed `"Network & internet / Mobile, Wi‑Fi, hotspot"` summary; NNNNN, matched (none) |
| O5 no-route on `settings-network` = 0 | **PASS** — 0 (navTarget `Airplane mode`; settings-network YYYYY for O5) |
| Run green with the invariants gate | **PASS** — `store invariants OK: 0 duplicate screens, 0 multi-destination edges`; job success |
| B1 metrics valid (fallbacks 0) | **PASS** — B1 console fallbacks 0 (proprietary path exercised) |
| Doc from JSON; branch pushed; run id | **PASS** — run 34794414764; branch `feat/screen-graph-d4` |

Open follow-ups (do not affect the acceptance bar): (1) the Display fling under-scroll
flakiness that scatters `settings-display`/`same-display-slider` failures across configs is a
scrcpy pacing issue owned by phase 3k, not screen-graph; (2) M7 device H_id stability stays
UNVERIFIED until the Kotlin `ScreenHash.identity` test lands (fixture `identityFixture`
captured in the pre-flight artifact).
