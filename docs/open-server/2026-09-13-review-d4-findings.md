# Adversarial closure review — screen-graph phase D.4 (run 34794414764)

Read-only review of `feat/screen-graph-d4` @ `4cd928de` (on `13388c19`, base
`open/main` @ `690e66bc`) in the worktree `../argent-fork-wt-d4`, against
`2026-09-13-screen-graph-phase-d4-results-ci.md`, the D.4 ticket
(`2026-09-05-screen-graph-phase-d4-symmetric-locate.md`, header + 2026-09-13
addendum + `## Result`), the D.2 findings, `2026-09-03-review-3h-3i-c3.md`,
`2026-09-03-screen-graph-phase-d3-closure.md`,
`2026-09-03-screen-graph-results-ci.md` and the README "Rules that paid for
themselves". Evidence: the CI artifacts of runs **34794414764** (D.4, in
`.bench-results/d4-new`) and **34788497583** (the reference run on the same
resolver code, in `.bench-results/d4`) — run JSON, `logs/sg-matrix.log`,
`preflight-launch-screens.json`, `graph-store/` — plus the branch source. Every
published statistic was recomputed by my own script from the run JSON, never
read off the harness's `results-ci.md`. `npx vitest run --maxWorkers=2
test/screen-graph-bench-locate.test.ts` → 15 passed. No device, no new run, no
`gh` call.

## VERDICT: REJECT

The arithmetic is clean; the explanation is not. Every per-config cell
reproduces to the digit from the run JSON on the (undisclosed) non-launch step
set — tokens p50/p95, chars/4, obs RTT, RTT count/step, success, Wilson, the
fail split, the per-task matrix, the O5 nav split 57 routed / 0 zero-step / 0
mis-land / 3 diverged / 0 no-route with hash-mismatch 3, `measuredRpc` 7 on all
57, the five store shapes, H1/H2/H3 arithmetic and every H4 point estimate. What
fails is the ticket's own acceptance criterion #2, "B1's two-level outcome
explained by a quoted rendering". **The quoted excerpt is the Settings ROOT
screen, not Network & internet** — B1's step-2 describe is 657 tokens in all 5
reps, identical to its own root describe, and the quoted row's bounds
`(0.000, 0.321, 1.000, 0.096)` are byte-identical to the step-1 root row, while
the open capture of the real destination screen contains no such node and no
string "Mobile, Wi‑Fi, hotspot" at all (D4-H1). B1 never described the screen
the report characterises. The "CAPTURED … (run 34794414764)" unit test that the
report lists as proof contains a fabricated fixture row that appears nowhere in
the artifact (D4-H2), and the symmetric-policy test synthesises its "describe
rendering" from the same array through the test's own serializer, in the one
shape the parser round-trips — it cannot fail on the divergence that actually
occurs (D4-H3). O5-pure 100 % is selection-on-outcome (D4-H4), the exact C4-H2
error the README banned. And the report downloaded, then withheld, a same-code
reference run in which O5 is 100/100 and B1's two-level task is NLNLN — both
headline narratives refuted by evidence already in hand (D4-H5).

Only **10 of B1's 18 failures** (the `settings-display` / `same-display-slider`
`t("Display")` refusals) are the describe-collapse rendering property the report
claims; those 10 are real and well evidenced. The 82 % count itself looks robust
(81/100 in the reference run) — it is the _attribution_ that must not enter the
scoreboard.

## HIGH

- **D4-H1 · The Item 2 excerpt is the Settings root screen, not the
  Network & internet screen; B1 never observed the destination.** Report
  lines 94-108, 247 and 258 build the whole "no discrete Internet row on that
  screen" claim on `logs/sg-matrix.log:28`. That line's row is
  `LinearLayout "Network & internet / Mobile, Wi‑Fi, hotspot" [clickable]
(0.000, 0.321, 1.000, 0.096)` — identical in text and bounds to
  `logs/sg-matrix.log:27` (the same task's **step 1**, on the root) and to
  `:2` (`settings-network` step 1, on the root). The run JSON gives B1
  `settings-network-internet` step 2 an observation of **657 tokens in all 5
  reps** — exactly B1's root describe value (657 on 100/100 launches) — while
  B2's step-1/step-2 describes on the real screens are 598 and 740. The open
  capture of the destination (`graph-store/com.android.settings/34.json`, node
  `284ef0302b28c5de`, label `Network & internet: Internet`) has
  `FrameLayout "Network & internet" id="collapsing_toolbar" (0.000, 0.000,
1.000, 0.249)` and `StaticText "Internet" id="title" (0.175, 0.267, 0.167,
0.030)`, and contains no node at y 0.321 and no substring "Mobile, Wi‑Fi,
  hotspot". Mechanism (`packages/tool-server/scripts/bench-screen-graph.ts:
1164-1169`): B1's describe is issued at the top of the step, and B1 pays no
  settle — `currentHash` returns `""` without a device call for a non-open
  config (`bench-screen-graph.ts:536-545`), `traversals` likewise (`:547-556`),
  `recordMs` is 0. B1's step-1 tap `actionRttMs` is 53-62 ms; B2's is
  1593-1738 ms because the open tap RPC carries the settled `getState`. **Fix:**
  delete the claim. Either state it as "B1's step-2 describe read the source
  screen (657 tok, root row bounds) because the B1 path has no post-tap settle
  — a harness-timing asymmetry, phase 3k" and re-run with a symmetric settle
  before B1's describe, or capture the proprietary describe _of the Network &
  internet screen_ and quote that. Nothing about the destination screen's
  proprietary rendering is currently in evidence.

- **D4-H2 · The "CAPTURED Network & internet screen (run 34794414764)" test
  fixture is not a capture; one row is fabricated and one is from a different
  screen.** `packages/tool-server/test/screen-graph-bench-locate.test.ts:
152-164` says "quoted verbatim from run 34794414764 (logs/sg-matrix.log line
  28)". Line 28 contains exactly one row. Of the three fixture rows:
  `test:161` is the root row from line 28 (mislabelled, see D4-H1); `test:162`
  (`Connected devices / Bluetooth, pairing`) is from `sg-matrix.log:5`, the
  `settings-connected` step 1 — a _different task, on the root_; `test:163`
  (`LinearLayout "Airplane mode" id="airplane" [clickable] (0.000, 0.700,
1.000, 0.060)`) **appears nowhere in any artifact** — `grep -ri airplane`
  over `logs/`, `preflight-launch-screens.json`, the run JSON and
  `results-ci.md` returns nothing (the only artifact hit is the graph-store,
  where the real node is `StaticText "Airplane mode" id="title" (0.175, 0.524,
0.317, 0.030)`, a different shape and position). `openNodes` (`test:167-172`)
  is likewise hand-written, not the capture. The report cites this test twice as
  evidence (line 79-80 verbatim listing, line 257 acceptance PASS), and test
  case `test:194-199` — the one the report quotes as "'Airplane mode' resolves
  cleanly in BOTH renderings" — asserts entirely on the invented row. **Fix:**
  rename the block (it is a hand-built fixture, not a capture), remove the
  fabricated row, and stop citing it as run evidence. If a captured-screen test
  is wanted, persist the actual B1 describe payload per step in the run JSON and
  build the fixture from it.

- **D4-H3 · The symmetric-policy test cannot detect the divergence that
  actually happens, and the real asymmetry has moved into the describe parser.**
  `test:100-108` renders the "describe payload" _from the same `screen` array_
  with the test's own serializer, emitting `text` and `cd` as two separate
  quoted strings — precisely the shape `describeLinesToNodes` splits back into
  `text`/`cd` (`describe-locate.ts:47,54-55`). It is a round-trip of the test's
  serializer, not a test of B1's rendering; it would pass unchanged if the
  policies diverged. In the run, B1's real describe emits the row as ONE quoted
  string, `"Display / Dark theme, font size, brightness"`, so
  `describeLinesToNodes` sets `text` to the joined label and leaves `cd`
  **undefined** — which makes tiers 2 and 3 of `pickUniqueNode` (`locate.ts:
48-51`, EXACT text, EXACT contentDescription) structurally unreachable for
  every collapsed B1 row, and forces it into the contains tier. The open path
  receives the same content as separate nodes (`preflight-launch-screens.json`
  `settingsRoot`: `{"id":"title","text":"Network & internet"}` and
  `{"id":"summary","text":"Display, interaction, audio"}` as distinct entries;
  same split in the graph-store compact renders) and gets the EXACT-text hit for
  free. So the report's line 10-11, "The only thing that differs between B1 and
  the open configs is the RENDERING fed in, not the policy", is true of
  `pickUniqueNode` and false of the resolution pipeline: a one-line change in
  the harness's own parser (split the collapsed label on `" / "` into
  `text`/`cd`, mirroring the open title/summary split) would resolve
  `t("Display")` uniquely and turn all 10 of B1's `Display` locate-fails into
  hits. That answers the ticket's own question "could B1 have succeeded under a
  reasonable policy the agent-facing text supports": **yes.** **Fix:** either
  implement the split and re-run, or state explicitly that B1's contains-only
  path is a harness parsing limitation and drop "one symmetric resolver" as a
  closure claim.

- **D4-H4 · O5-pure 47/47 = 100 % is selection on the outcome (C4-H2
  repeated).** Report line 170 publishes it as an O5 row. Recompute: of O5's 100
  runs, 50 contain a known-target tap; 47 routed everything, 3 did not. **All 3
  non-pure runs failed and all 47 pure runs succeeded** — the filter "every
  known-target tap routed" selects exactly the failures out (the 3 are
  `settings-display` reps 1-3, i.e. O5's `YNNNY`). Worse, the other 2 O5
  failures live in `same-display-slider`, whose 5 runs contain **zero**
  known-target taps, so they are outside the O5-pure denominator by
  construction. A statistic whose denominator is defined by a variable perfectly
  correlated with success is not a success rate. **Fix:** delete the O5-pure
  success cell. Keep only routing coverage (57/60 one-step routes) and the
  RPC row, both of which are legitimate; if a conditional rate is wanted, it
  must be reported as "47/47 among the runs that routed, versus 0/3 among those
  that did not".

- **D4-H5 · The report withholds a same-code reference run it downloaded, which
  refutes two of its headline claims.** Lines 22-25 name run 34788497583 ("the
  same resolver code") and say it is "used only where noted" and "do not blend".
  Not blending is right; not _checking_ is not. In that run's JSON
  (`.bench-results/d4/.bench-results/screen-graph/bench-sg-2026-09-13T23-09-59-641Z.json`):
  **O5 = 100/100**, `settings-display` YYYYY and `same-display-slider` YYYYY —
  versus 95/100 in D.4. **B1 `settings-network-internet` = NLNLN**, not NNNNN
  (reps 1 and 3 locate-fail with a degenerate 112-token launch describe).
  **B1 `settings-battery-then-back` = LYLYL**, versus LYYLL here. B1 overall
  81/100 versus 82/100. So: report line 247's "B1 taps the collapsed summary
  uniquely **each rep**" is false on the same code; and report lines 55-57's "O5
  = 95 %, its 5 failures … the known scrcpy fling under-scroll flakiness" is
  describing run-to-run noise around a result that was 100/100 on identical
  code. **Fix:** add a same-code reproducibility paragraph giving both runs'
  numbers for B1 and O5 per task, and downgrade every per-task causal claim that
  does not hold in both.

## MEDIUM

- **D4-M1 · 3 of the 13 B1 locate-fails come from a degenerate 112-token
  describe, not from a rendering.** Report lines 130-132 attribute
  `settings-battery-then-back`'s locate-fails to "a MISS after the back step"
  and conclude "All are honest rendering outcomes of the shared policy". In the
  run JSON every B1 locate-fail on that task (reps 0, 3, 4, step 3) has an
  observation of **112 tokens**; the passing reps 1-2 have 657 at the same step.
  112 is the same value that, in reference run 34788497583, appears as a failed
  _launch_ describe (reps 1/3 of `settings-network-internet`) — a screen that is
  not Settings. The `[D4]` line `sg-matrix.log:32` confirms `describe rows
containing "battery": (none)`. By contrast the 10 `Display` locate-fails all
  have 665-693-token describes, i.e. a real scrolled root — those are genuine.
  **Fix:** split B1's 13 locate-fails into "10 rendering (collapsed-row
  ambiguity, evidenced) + 3 degenerate capture (112-token describe, infra)" and
  drop "All are honest rendering outcomes".

- **D4-M2 · O5's 3 `settings-display` failures coincide exactly with its 3
  navigate-to divergences; "config-neutral" is unsupported.** Report lines 55-57
  and 213 call O5's failures config-neutral Display flakiness. Recompute: O5
  `settings-display` fails on reps 1, 2, 3 — the same three records whose step 2
  carries `navFallback:true`, `nav {reached:false, completedSteps:0,
totalSteps:1, fromVia:"exact"}`. The two passing reps routed
  (`strategy:"navigate"`). On the same task B2 and O4 are YYYYY and O1/O2/O3
  fail once each. A config-neutral fling flake does not land 3/5 on the one
  config that routes and 0/5 on two others. Note also the post-step `hash` on
  all three failing reps is `9039b5e414…` (the Settings **root**), not
  `c367c6d328…` (Display) — so the report's "a drifted Display hash" (line 164)
  is contradicted: the run never left the source screen; the harness classes it
  `navDivergedHashMismatch` because the arrival check compares against the
  Display hash. Plausible (inference, not proven) mechanism: the route taps,
  diverges, and the fallback path taps a second time
  (`bench-screen-graph.ts:881-889`). **Fix:** report the 3 as "O5-specific:
  divergence + double-tap fallback on `settings-display`, 3/5 reps, perfectly
  correlated with failure", and reserve "config-neutral" for
  `same-display-slider`, where failures do scatter across configs.

- **D4-M3 · The divergences are attributed to a task that issues no
  navigate-to at all.** Report line 163 places the 3 `{"text":"Brightness"}`
  divergences on "`settings-display` / `same-display-slider`". Recompute:
  `same-display-slider` has **zero** `knownTarget` steps (its 5 O5 runs are in
  the no-known-target bucket), hence zero navigate attempts. All 3 are
  `settings-display` reps 1-3. **Fix:** strike `same-display-slider` from that
  sentence.

- **D4-M4 · A taskError with zero steps is printed as an oracle-unmet `N`, and
  then used as evidence.** The per-task matrix (report line 239) gives B2
  `same-display-slider` = `YNNYY`; the JSON shows rep 1 is
  `taskError:true, steps:[], wallMs:0, success:false` — the run never executed.
  The legend (line 217) defines only Y/N/L. The report then cites exactly this
  cell at line 56 ("config-neutral (B2 `same-display-slider` YNNYY…)") to argue
  Display flakiness is config-neutral; B2 in fact has **one** real Display
  oracle failure, not two. **Fix:** add `T` to the legend, render the cell
  `YTNYY`, and restate the config-neutrality sentence on the corrected counts.

- **D4-M5 · H1's statistic is mislabelled.** Report line 192 reads "O1
  tokens/step vs B2, o200k p50, **unchanged steps** … 138/645 = 0.214×". 138 and
  155, and 645 and 151, are the p50s over **all** non-launch steps (I reproduce
  both exactly on that set). Restricted to unchanged steps the ratio is
  **179/651 = 0.275×** (`sameScreen`, n=50 / n=48) or **225/586 = 0.384×**
  (`changed === false`, n=43 / n=38). Verdict stays PASS either way, but the
  README rule is that a number names its statistic. **Fix:** relabel as "all
  non-launch steps", or publish the unchanged-step ratio with its own n.

- **D4-M6 · The cluster-bootstrap intervals are not reproducible: no seed is
  published and they move.** Report publishes B1 `[65, 97]`. My 10 000-resample
  task-cluster bootstrap gives `[64, 97]` on seeds 1/7/12345, `[65, 97]` on seed
  42 and `[65, 95]` on `0x5eedc0de`. H4-vs-B1 lower bounds likewise land at
  `[4, 31] / [4, 33] / [4, 31] / [5, 35] / [2, 26]` on `0x5eedc0de` against the
  published `[3, 31] / [3, 33] / [3, 31] / [3, 35] / [2, 26]`. All point
  estimates, all Wilson intervals, all vs-B2 intervals and O4/O5/B2/O1/O2/O3
  cluster intervals reproduce exactly. The D.2 review reproduced D.2's bootstrap
  _because D.2 published its seed_. **Fix:** publish the RNG seed (and use a
  fixed one in the harness), or round the interval to a resolution stable across
  seeds.

- **D4-M7 · The navTarget "Airplane mode" uniqueness claim carries no evidence
  in the report, and its in-code provenance is a run not in the artifact set.**
  Report line 144 asserts "a label present only on the Network & internet
  screen" citing only `tasks.ts`; `tasks.ts:29-30` in turn cites "capture run
  33970221242", which is neither downloaded nor referenced by this report, and
  `preflight-launch-screens.json` for run 34794414764 contains no Airplane-mode
  capture (its `needleEval` covers assertion needles only; `settingsRoot` is the
  root screen). I verified the claim independently and it **holds**: across all
  11 screens of `graph-store/com.android.settings/34.json`, "Airplane mode"
  occurs only in node `284ef0302b28c5de`. On the second half of the question —
  O5's 0 no-route does depend on this choice (with the D.3 navTarget `Internet`
  the target was ambiguous between `284ef…` and `af75c426…`, whose
  `collapsing_toolbar` is also labelled "Internet"), but the change fixes a real
  ambiguity rather than inflating anything: it moves 5 taps from no-route to
  routed (coverage 52/60 → 57/60, both over the ≥30 bar) and does not touch
  success, since a no-route still falls back and passes. **Fix:** cite the
  graph-store node as the evidence, in this run's artifact.

## LOW

- **D4-L1 · The denominator of every token/RTT column is undisclosed.** "n
  steps" 145 / 151 / 155 is the **non-launch** step count (B1 has 245 steps of
  which 100 are launches); all published p50/p95 reproduce only on that set. The
  report never says the launch observation is excluded. The exclusion is not
  systematically favourable (it raises O1's and O4's p50, leaves B1's at 657),
  but it must be stated. **Fix:** add "launch-step observation excluded" to the
  column note.

- **D4-L2 · The `fail (L/A/O/T)` header does not describe its own contents.**
  Report line 31 glosses `O` as "oracle", but the field is `oracleError` (an
  exception), not oracle-unmet, so B1 reads `18 (13/0/0/0)` where 13 + 0 + 0 + 0
  ≠ 18 and the 5 oracle-unmet runs appear nowhere in the split. The prose at
  line 50 has it right. **Fix:** rename the column `fail (L/A/oracleErr/T)` and
  add an explicit `unmet` count.

- **D4-L3 · The O5-pure N conflates runs and taps.** Report line 170 gives
  "47 runs (n=57 taps)". The 57 routed taps are over **all 100** O5 runs; the
  47 pure runs contain 57 known-target taps only by coincidence of the 3
  excluded runs holding 1 tap each. The token p50 22 on that row is over n=64
  steps (harness `results-ci.md`), a third N again. **Fix:** give each cell its
  own N.

- **D4-L4 · H2's same-screen n is not the same for both arms.** Report line 199
  writes "the 50 SAME-SCREEN steps (O2 mean RTT/step 1.2 vs B2 2.0)". O2's
  same-screen n is 50; B2's is **48** (it lost 2 steps to the taskError run).
  Both means reproduce exactly. **Fix:** "O2 n=50 mean 1.2 vs B2 n=48 mean 2.0".

- **D4-L5 · The "reproduced here to the digit" claim inherits a harness
  inconsistency.** Report line 18 says the harness `results-ci.md` is reproduced
  to the digit. That file's "Per-rep ranges across the **3** repetitions" table
  lists 5 reps and reports B1 at 94 % per rep (a scored denominator) against the
  82 % headline (full denominator). The D.4 report does not republish that table,
  so nothing published is wrong — but the blanket endorsement of the harness doc
  should be narrowed. **Fix:** endorse the specific tables reproduced, not the
  file.

## Scoreboard rows allowed

Only these may enter `2026-09-03-scoreboard.md`, worded as given. Nothing about
B1's _cause_, nothing about O5-pure, nothing from Item 2.

| row                                                                                              | wording required                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tokens/agent-step, o200k p50, run 34794414764, n = non-launch steps                              | B1 657 (n=145) · B2 645 (n=151) · O1 138 · O2 54 · O3 627 · O4 21 · O5 22 (n=155 each). Add "launch-step observation excluded".                                                                                                                                                                                                                                       |
| RTT count/step p50, same run, same n                                                             | B1 2 · B2 2 · O1 2 · O2 2 · O3 2 · O4 1 · O5 1. Not a latency column (D2-M4).                                                                                                                                                                                                                                                                                         |
| success, full 100 denominator, Wilson (n=100), run 34794414764                                   | B1 82 % [73, 88] · B2 98 % [93, 99] · O1 98 % [93, 99] · O2 99 % [95, 100] · O3 98 % [93, 99] · O4 100 % [96, 100] · O5 95 % [89, 98]. Cluster intervals only if the seed is published (D4-M6). B1's row must carry "82 % is a count, not an explained capability gap — see `2026-09-13-review-d4-findings.md` D4-H1/H5; 81/100 on the same code in run 34788497583". |
| H1 tokens ratio, run 34794414764                                                                 | O1/B2 o200k p50 over all non-launch steps = 0.214× (target ≤ 0.5×), PASS. Label "all non-launch steps", not "unchanged steps".                                                                                                                                                                                                                                        |
| H3 warm/cold ratio, run 34794414764                                                              | O4/O3 o200k p50 = 21/627 = 0.033× (target ≤ 0.2×), PASS; store 11 nodes / 11 edges, max out-degree 9.                                                                                                                                                                                                                                                                 |
| H4 non-inferiority **vs B2 only**, paired task-cluster bootstrap, B=10 000, full 100 denominator | none inferior: O1 +0 · O2 +1 · O3 +0 · O4 +2 · O5 −3. Publish the seed. The vs-B1 column must NOT be published while B1's 82 is unexplained (D4-H1, D4-H5).                                                                                                                                                                                                           |
| invariants gate, run 34794414764                                                                 | store invariants OK: 0 duplicate screens, 0 multi-destination edges; `skippedNoIdHash` 0; five stores 11/11, 3/2, 2/1, 1/1, 1/1.                                                                                                                                                                                                                                      |
| O5 routing coverage, run 34794414764, n=60 known-target taps                                     | 57 one-step routed · 0 zero-step · 0 mis-landed · 3 diverged (hash-mismatch, all on `settings-display`) · 0 no-route (ambiguous 0, no-known-path 0). Must carry "the 3 divergences are exactly O5's 3 `settings-display` failures (D4-M2)".                                                                                                                           |
| O5 measured RPCs per routed tap, n=57                                                            | min 7 / p50 7 / max 7, a LOWER bound (D2-L1).                                                                                                                                                                                                                                                                                                                         |

### Explicitly NOT allowed

- **"B1's 82 % is a describe-rendering property"** in any form — true for 10 of
  18 failures, false for the other 8 (D4-H1, D4-M1).
- **"B1 `settings-network-internet` NNNNN because the proprietary describe has
  no discrete Internet row"** — the excerpt is the root screen (D4-H1); NLNLN on
  the same code in run 34788497583 (D4-H5).
- **"One symmetric resolver; the only difference is the rendering"** as a closed
  item — the exact-text/exact-cd tiers are unreachable for collapsed B1 rows via
  the harness's own parser (D4-H3).
- **"O5-pure 47/47 = 100 % [92, 100]"** — selection on outcome (D4-H4).
- **"O5's failures are config-neutral Display flakiness"** — 3 of 5 are
  O5-specific divergences; O5 was 100/100 on the same code (D4-M2, D4-H5).
- **B1 cluster interval [65, 97]** and the **H4-vs-B1 deltas** until a seed is
  published (D4-M6).
