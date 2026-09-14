# Adversarial closure review — screen-graph phase D.4.1 (run 34801849653)

Read-only review of `feat/screen-graph-d4` @ `c18550fc` (commits `fcc86ce9`,
`21759abe`, `c18550fc` on `4cd928de`; base `open/main` @ `690e66bc`) in the
worktree `../argent-fork-wt-d4`, against the rewritten
`2026-09-13-screen-graph-phase-d4-results-ci.md`, the `## Result (D.4.1)`
addendum on `2026-09-05-screen-graph-phase-d4-symmetric-locate.md`, the fix
ticket `2026-09-13-screen-graph-phase-d4-1-review-fixes.md`, my D.4 verdict
`2026-09-13-review-d4-findings.md` (its "Scoreboard rows allowed" is the
whitelist being tested), `2026-09-03-review-d2-findings.md` and the README
"Rules that paid for themselves". Evidence: the CI artifacts of runs
**34801849653** (`.bench-results/d4-final`), **34794414764**
(`.bench-results/d4-new`) and **34788497583** (`.bench-results/d4`) — run JSON,
`logs/sg-matrix.log`, `preflight-launch-screens.json`, `graph-store/` — plus the
branch source. Every published statistic was recomputed by my own script from
each run's JSON, never read off the harness's `results-ci.md` (the harness doc is
used only twice below, to show the report disagrees with it). `npx vitest run
--maxWorkers=2 test/screen-graph-bench-locate.test.ts` → **14 passed**. No
device, no new run, no `gh` call.

## VERDICT: ACCEPT-WITH-CAVEATS

Every D.4 REJECT item is genuinely fixed, and the headline reproduces to the
digit. B1 = 100/100, B2 = 100/100, O1 = 100/100, O2 = 99/100, O3/O4/O5 =
100/100; tokens p50 657 / 651 / 179 / 68 / 627 / 21 / 21 over n=155 non-launch
steps each; chars/4, obs RTT, RTT count, settleMs, the fail/unmet split, the
per-task matrix, the store shapes (11/10, 1/1, 2/1), the invariants line, the
O5 nav split 59 routed / 0 zero-step / 0 mis-land / 1 diverged / 0 no-route with
`measuredRpc` 7 on all 59, H1 0.275×, H3 0.033×, H4 and the three-run
same-code table (81/82/100, O5 100/95/100, `NLNLN`/`NNNNN`/`YYYYY`, 58/2 · 57/3 ·
59/1) all reproduce exactly from the JSON. The cluster intervals now reproduce
analytically without the seed ([100,100]; O2 [97,100]; O2 Δ [−3,0]) and the seed
is published and persisted (`env.bootstrapSeed` 1592639710 / `0x5eedc0de`). The
test fixtures are verbatim: I traced every row of the destination and root blocks
to `sg-matrix.log:29`, the graph-store node `284ef0302b28c5de` and
run 34794414764's `sg-matrix.log:25/27/38` — no invented row survives, and the
fabricated "Airplane mode" row is gone. No outcome-selected subset is published.

What holds it back from a clean ACCEPT is one wrong proof and one missing
qualifier on the headline, plus a cluster of transcription/labelling slips of
exactly the class D.4 was rejected for. The report's stated "proof of symmetry"
— `settleMs` p50 B1 2226 vs open ~1015, "B1 now pays the LARGEST wall wait …
inverted, if anything" — is the wrong statistic and false in direction: the open
arms' settle wait excludes the ≈1.6 s settled `getState` inside their own tap
RPC. Counting the whole post-action wait (`actionRttMs + settleMs`, non-launch
p50) the arms are B1 **2604**, B2 2642, O1 2627, O2 2639, O3 2628, O4 2642, O5
2740 — B1 waits marginally *less* than every open config, not the most (D41-H1).
That correction makes the symmetry case stronger, not weaker, but the published
sentence and the acceptance-table PASS cite a number that does not show what they
say. Second, the report states only half the conditionality: "the 82 % was a
harness artifact, not a capability or rendering property" is asserted without the
symmetric statement that the 100 % is equally conditional on two harness-side
devices — an explicit post-action settle the harness performs for B1, and a
`" / "` split the harness applies to B1's collapsed labels. The same B1 code was
81/100 and 82/100 without them (D41-H2). Everything else is MEDIUM: H2's
same-screen mean is the all-steps mean (1.74 vs the true 1.22), the single
non-`Y` cell of the per-task matrix is transcribed to the wrong rep
(`NYYYY` published, `YYNYY` in both the JSON and the harness doc), the two arms'
settles are the same tool but not the same algorithm, the `" / "` split has a
real counterexample already in this run's store, the arms' observations are
index-shifted so the token columns are over different screen multisets, and the
run-to-run noise floor is carried for success but not for tokens — the metric the
report now calls "the entire story".

## Prior findings status

| Finding | Status | Evidence |
|---|---|---|
| D4-H1 excerpt was the root screen; B1 never observed the destination | **fixed** | `settleScreen` (`bench-screen-graph.ts:159-169`) called for every non-launch step of every config (`:1256`); `settleMs` present on all 700 records (non-launch min ≥ 982 ms, zero on launch). B1 `settings-network-internet` step 2 = **598 tok in all 5 reps**, the same screen B2 reads at its step 1 (598) — no longer the 657-tok root. `sg-matrix.log:29` quotes the destination rows. See D41-H1/M3 for the proof statistic and the residual semantic gap. |
| D4-H2 fabricated "CAPTURED" fixture | **fixed** | Every row traced: `test:105` ↔ `d4-new/logs/sg-matrix.log:27`; `test:107-108` ↔ `d4-new:25`; `test:110` ↔ `d4-new:38`; `test:221-224` ↔ `d4-final/logs/sg-matrix.log:29`; `test:214-217` ↔ graph-store `284ef0302b28c5de` rows `FrameLayout "Network & internet"`, `StaticText "Internet" id="title" (0.175,0.267,0.167,0.030)`, `StaticText "T-Mobile" id="summary" (0.175,0.296,0.130,0.021)` (w/h → x2/y2 conversion correct). No "Airplane mode" row anywhere in the tests. 14/14 green locally. |
| D4-H3 exact tiers unreachable for collapsed rows | **fixed** (with D41-M4) | `describe-locate.ts:59-77` splits on the first `" / "` when `cd` is undefined. `sg-matrix.log:25/48` now log FOUND-UNIQUE for `t("Display")` where run 34794414764 logged AMBIGUOUS on the identical two rows. |
| D4-H4 O5-pure 47/47 | **fixed** | No O5-pure cell in the report; only 59/60 coverage and `measuredRpc` n=59. (The harness's own `d4-final/.bench-results/screen-graph/results-ci.md:44` still prints O5-pure 49/49 — D41-L2.) |
| D4-H5 withheld same-code reference run | **fixed** | `§Same-code reproducibility` carries all three runs; I reproduced every cell from the three JSONs (B1 81/82/100; O5 100/95/100; `settings-battery-then-back` LYLYL/LYYLL/YYYYY; nav 58/2, 57/3, 59/1). |
| D4-M1 3 locate-fails from a degenerate 112-tok describe | **fixed (moot)** | B1 has 0 locate-fails; `settings-battery-then-back` step 3 = 657 tok in all 5 reps (`sg-matrix.log:33`). |
| D4-M2 O5's Display failures were its own divergences | **fixed (moot)**, new claim unsupported | O5 100/100, 1 divergence on `settings-connected` rep 4 step 1 (`nav {reached:false, completedSteps:0, fromVia:"exact"}`, `navFallback:true`, success true) — reproduced. But the report's new causal claim about the D.4 divergences is unsupported: D41-M7. |
| D4-M3 divergence attributed to `same-display-slider` | **fixed** | Single divergence named exactly; `same-display-slider` still has 0 known-target steps. |
| D4-M4 taskError legend | **partially fixed** | `T` is in the legend and 0 taskErrors occur (verified). But the one non-`Y` matrix cell is wrong: D41-M2. |
| D4-M5 H1 statistic mislabelled | **partially fixed** | H1 is correctly "all non-launch steps" (and the p50 is in fact 179/651 on all three subsets: all, `sameScreen`, `changed===false`). The same error moved into H2: D41-M1. |
| D4-M6 bootstrap seed | **fixed** | `env.bootstrapSeed 1592639710`, `bootstrapSeedHex 0x5eedc0de`, set in the harness (`bench-screen-graph.ts:2495-2496`). With 100/100 and the single 4/5 task the intervals are seed-independent: `[100,100]`, `[97,100]`, Δ `[−3,0]` all follow analytically from the 20-task cluster resample. |
| D4-M7 "Airplane mode" provenance | **fixed** | Verified independently: across all 11 nodes of `d4-final/.../graph-store/com.android.settings/34.json`, the string occurs only in node `284ef0302b28c5de` (`StaticText "Airplane mode" id="title" (0.175,0.524,0.317,0.030)`). |
| D4-L1 undisclosed denominators | **fixed** | Column note states non-launch only, n=155 each, launch observation excluded — and 155 is what I recompute for all 7 configs. |
| D4-L2 `fail (L/A/O/T)` header | **fixed** | Renamed `fail (L/A/oracleErr/T)` + separate `unmet` column; O2's single unmet is in the `unmet` column, not the split. |
| D4-L3 O5-pure N conflation | **fixed** | Cell removed; `measuredRpc` carries its own n=59. |
| D4-L4 H2 same-screen n per arm | **fixed** | Both arms n=50 (recomputed); no taskError this run. |
| D4-L5 blanket "reproduced to the digit" | **fixed** | Report states it recomputes from each run's JSON, "never from a harness `results-ci.md`". |

## HIGH

- **D41-H1 · The published "proof of symmetry" is the wrong statistic, and its
  direction claim is false.** Report lines 65-70 ("`settleMs` is the proof of
  symmetry … B1 now pays the LARGEST wall wait (p50 2226 ms vs the open configs'
  ~1010–1025 ms) … inverted, if anything") and the acceptance row at line 246
  ("PASS — settleMs p50 B1 2226 vs open ~1015 (B1 no longer under-waits)") compare
  only the *explicit* settle. The open arms' post-action wait is split in two: the
  tap RPC itself blocks on the settled `getState` — recomputed tap
  `actionRttMs` p50 B2 1627 / O1 1628 / O2 1674 / O3 1608 / O4 1649 / O5 1918 vs
  B1 **167** — and only the remainder falls into `settleMs`. Total post-action
  wait (`actionRttMs + settleMs`, non-launch p50): B1 **2604**, B2 2642, O1 2627,
  O2 2639, O3 2628, O4 2642, O5 2740. So B1 does *not* pay the largest wait; the
  arms are equal within ~5 %, which is the actual (and better) evidence that the
  settle is symmetric. The same mis-reading generates the follow-up at lines
  253-256 ("the symmetric settle roughly doubles B1's per-step wall wait") —
  B1's wall/task p50 is 8689 ms vs B2 7682, a 13 % gap, not a doubling. **Fix:**
  publish an `actionRtt + settle` column (or state the two components), replace
  "B1 now pays the largest wall wait / inverted" with "total post-action wait is
  equal within 5 % across configs (B1 2604 ms p50 vs open 2627–2740 ms)", and
  re-word the acceptance row and the latency follow-up on that number.

- **D41-H2 · The headline states only half the conditionality: B1's 100/100 is as
  harness-dependent as the 82 % was.** Line 25-27 and the superseded table at
  line 235 say the 82 % "was a harness artifact, not a capability or rendering
  property". The evidence supports "not resolution-blocking once the harness
  parses it", not "not a rendering property": B1's rendering *does* differ from
  the open tree (one collapsed `"<title> / <summary>"` string vs two nodes), and
  the harness now normalises that difference away on B1's side only
  (`describe-locate.ts:59-77`). B1's 100/100 therefore holds under a harness that
  (i) performs an explicit post-action settle on B1's behalf — ~2.2 s/step that
  B1's own backend cannot obtain from a change-driven wait, and that is charged to
  no published column — and (ii) splits B1's collapsed labels before resolution.
  The same B1 code without either is 81/100 and 82/100 (runs 34788497583,
  34794414764, both reproduced). **Fix:** state the conditionality in the result
  line and carry it on the B1 scoreboard row: "100/100 under a harness that
  settles for every config and splits collapsed describe labels into text/cd; the
  same code without those two is 81–82/100 (runs 34788497583 / 34794414764)". No
  number changes; the claim "the D.4 82 % must not be read as a capability gap"
  survives intact.

## MEDIUM

- **D41-M1 · H2's same-screen mean is the all-steps mean (D4-M5 repeated).**
  Report line 162: "the saving is real only on the 50 same-screen steps (O2 mean
  RTT/step **1.74** vs B2 2.0)". Recompute: O2's mean `rttCount` over the 50
  same-screen steps is **1.22** (B2 2.00); 1.74 is O2's mean over all 155
  non-launch steps. The harness's own table says the same (`d4-final/.bench-results/screen-graph/results-ci.md:70`:
  O2 all-mean 1.74, same-screen mean 1.22). The p50-based verdict (2 − 1 = 1,
  PASS) is unaffected. **Fix:** "O2 same-screen mean 1.22 vs B2 2.00 (n=50 each);
  over all 155 non-launch steps O2 1.74 vs B2 2.00".

- **D41-M2 · The one non-`Y` cell in the per-task matrix names the wrong rep.**
  Report line 225 publishes O2 `same-display-slider` = `NYYYY` and line 228 says
  "rep 1". The JSON has reps 0,1,3,4 success and **rep 2** failing
  (`assertionMatches` empty, needle "Brightness level"), i.e. `YYNYY` — which is
  also what the harness prints (`d4-final/.bench-results/screen-graph/results-ci.md:143`) and what its per-rep success
  row shows (100/100/95/100/100). Rep indices are 0-based everywhere else in this
  series (D4-M2 used the same convention). **Fix:** `YYNYY`, "rep 2".

- **D41-M3 · Same tool, not the same algorithm: the two settles differ
  semantically, and B1's freshness rests on an untested 700 ms constant.** The
  open path's `await-screen-idle` takes the open-server branch
  (`src/tools/await-screen-idle/index.ts:168-184`, `awaitScreenIdleViaOpenServer`
  → device `awaitChange`): wait for a CHANGE, then quiet. B1 has no open server,
  so it falls to the describe-tree poll (`:187-212`): quiet-only, no
  wait-for-change. `settleScreen` compensates with a fixed
  `BENCH_SETTLE_FIXED_MS = 700` sleep first (`bench-screen-graph.ts:159-169`), so
  B1's read is fresh only while transitions begin inside 700 ms. Nothing in the
  JSON records whether B1's poll actually observed the transition (the tool's
  `settled`/`polls` are discarded); the evidence that it did is indirect —
  B1's step-2 describe is 598 tok in all 5 reps, matching B2's destination read.
  The report's own follow-up (lines 253-256) proposes tuning
  `BENCH_SETTLE_FIXED_MS` **down**, which would reinstate D4-H1 silently.
  **Fix:** describe the two settles as "same tool and same timeout, different
  backend algorithm (change-then-idle vs fixed delay + idle poll)", record
  `settled`/`polls` per step, and mark the 700 ms constant as load-bearing for
  D4-H1 — not a free latency knob.

- **D41-M4 · The `" / "` split is not a universal mirror of the open split;
  this run's own store holds a counterexample.** `describe-locate.ts:59-77`
  splits any single-quoted label on the first `" / "`. The open tree is not
  guaranteed to keep that content in two nodes: in this run's store, node
  `3ed4975114523f07` ("Notifications: Manage") carries a single node
  `StaticText "On / Conversations can appear as floating icons" id="summary"`.
  Rendered by B1 as one quoted label, the split turns it into `text="On"`,
  `cd="Conversations can appear as floating icons"` — so `t("On / Conversations…")`
  matches exactly on the open tree and never on B1, and `t("On")` matches exactly
  on B1 and only by contains on the open tree. No task selector in this run
  contains `" / "` (checked `bench/tasks.ts`), and no `[D4]`-logged row has two
  separators, so nothing published is wrong. **Fix:** state the split as a B1-side
  normalisation with a known failure mode (labels whose own text contains
  `" / "`), and cite the store node as the example; drop "mirroring the open
  split" as an unconditional claim.

- **D41-M5 · The arms' observations are index-shifted, so the token columns are
  not over the same screens.** B1's tap-step observation is taken BEFORE the
  action (it is the describe B1 locates in, `bench-screen-graph.ts:1204-1209` (`b1Obs` at `:1207`));
  the open configs' observation is the post-action state
  (`observeAfterAction`). Recomputed consequence on
  `settings-network-internet`: B1's three observations are 657 / 657 / 598 (root,
  root, destination) while B2's are 657 / 598 / 747 — B1 reads the root twice and
  **never observes the final Internet screen** (747 tok), the most expensive one.
  On `settings-battery-then-back` B1 is 657/657/657/657 (the root four times, the
  Battery screen never) vs B2 657/627/657/627. The direction of the token result
  is unaffected — per-run observation totals are B1 mean 1947 vs B2 2104, O4 177
  — but "at the SAME success the describe arms pay ~30×" (line 61-64) compares
  per-step medians over different screen multisets. **Fix:** add to the column
  note "each config's own observation sequence (B1's tap-step observation is the
  pre-tap describe it locates in; open configs observe the post-action state)".

- **D41-M6 · The noise floor is carried for success but not for the metric the
  report calls "the entire story".** `§Same-code reproducibility` gives the
  run-to-run spread for success and the nav split only. Recomputed token p50s on
  the same code move materially: O1 **179 / 138 / 179**, O2 **54 / 54 / 68**,
  O3 **598 / 627 / 627**, O4 20/21/21, O5 20/22/21 (runs 34788497583 /
  34794414764 / 34801849653; B1 657 and B2 645–651 are stable). So H1 is 0.275×
  here and 0.214× in D.4 — a 29 % move of the headline ratio with no code change
  between those arms — and the "~3.6× vs O1" in line 64 is 4.7× on the D.4 run.
  **Fix:** add the token p50 row per run to the same-code table, and give H1's
  ratio the same "noise floor" sentence the success rows get.

- **D41-M7 · A new causal claim about O5 contradicts the report's own noise
  floor.** Lines 196-198 and the superseded table line 238 say "the D.4
  authoritative run's O5 95/100 and its 3 `settings-display` divergences were the
  under-settled Display transitions, also removed by the symmetric settle". Run
  34788497583 has **no settle** and is O5 100/100 with 58/60 routed and 2
  divergences — which is exactly why lines 191-193 call the O5 spread the noise
  floor. Both readings cannot be load-bearing. **Fix:** keep the noise-floor
  reading and demote the settle explanation to "consistent with, not
  demonstrated by, this run" — or drop it.

## LOW

- **D41-L1 · O5's `fallbacks` cell disagrees with the artifact.** Report line 59
  publishes `fallbacks` 0 for O5; the JSON aggregate has `fallbacks: 1`
  (and `navFallbacks: 1`), as does the harness table
  (`d4-final/.bench-results/screen-graph/results-ci.md:37`: `navFb 1/60`, `fallbacks 1`). The prose (lines 128-131)
  describes the fallback correctly, so only the cell is wrong. The B1 = 0 claim
  (the one that matters for HIGH-5) is correct.
- **D41-L2 · The harness doc still emits claims the review banned.** Its
  `results-ci.md` still prints "O5-pure 49/49 = 100 % [93,100]" and labels H1
  "(unchanged steps)". Nothing of that is in the report — but it must not be
  copied into the scoreboard from the harness file.
- **D41-L3 · The settle adds one uncounted device RPC per non-launch step for
  every config.** `rttCount` is modelled as action + observation
  (`bench-screen-graph.ts:1293-1294`) and does not include `settleScreen`'s
  `await-screen-idle` (nor `currentHash`). Equal across configs, so H2's
  difference is unaffected, but the RTT-count column is now one further step from
  a real device-RPC count (already flagged D2-M4/D2-L1).
- **D41-L4 · B1's settle costs proprietary describes that are tokenised
  nowhere.** B1's idle path polls the describe tree; those payloads are not
  counted in any token column (nor are the open `awaitChange` waits). The bias is
  conservative for the open thesis (it understates B1's traffic), but the report
  should say the token column excludes settle traffic for every config.
- **D41-L5 · The root-screen fixture is pinned to the previous run's geometry.**
  `test:105-110` uses run 34794414764 rows (Display at y 0.457, Accessibility at
  0.650) and asserts `yNorm ≈ 0.505` (`test:140`), while run 34801849653 renders the same rows
  at 0.389 / 0.581 (`sg-matrix.log:25`). Provenance is labelled per row, so this
  is not a fabrication — but a reader may take the geometry as this run's.
- **D41-L6 · The "~30×" and "~3.6×" are ratios of medians.** Over per-run
  observation totals the same comparison is B1 1947 vs O4 177 (11×) and B2 2104
  vs O1 465 (4.5×). Both statistics are legitimate; the prose must name which.
- **D41-L7 · H4 table formatting.** Report lines 168-171: the header declares
  three columns and both rows leave the middle column empty, so "Baseline
  success" reads as blank. Cosmetic.

## Scoreboard rows allowed

Reference run for every row below: **34801849653** (`feat/screen-graph-d4` @
`fcc86ce9`, base `open/main` @ `690e66bc`), 7 configs × 20 tasks × 5 reps = 700
task-runs, `skipped {}`, o200k_base p50 over **non-launch steps, n=155 per
config (launch observation excluded)**, bootstrap B=10000 seed `0x5eedc0de`.
Rows must not be merged with the D.2 table (run 33964414774) still in the
scoreboard; supersede it, naming both run ids.

| row | wording required |
|---|---|
| success, full 100 denominator, cluster bootstrap (n=20 tasks, seed `0x5eedc0de`) + Wilson (n=100) | B1 100 % (100/100) [100,100] / [96,100] · B2 100 % [100,100] / [96,100] · O1 100 % · O2 99 % (99/100) [97,100] / [95,100] · O3 100 % · O4 100 % · O5 100 %. Must carry: "success is at PARITY across all seven configs on this run; the differentiator is tokens, not success." |
| B1 row caveat (mandatory, D41-H2) | "B1 100/100 holds under a harness that performs an explicit post-action settle for every config and splits B1's collapsed `\"<title> / <summary>\"` describe labels into text/cd before resolution. The same B1 code without those two was 81/100 (run 34788497583) and 82/100 (run 34794414764); the D.4 82 % must not be read as a capability gap." |
| tokens/agent-step, o200k p50, n=155 non-launch steps each | B1 657 · B2 651 · O1 179 · O2 68 · O3 627 · O4 21 · O5 21. Add "launch-step observation excluded; each config's own observation sequence (B1's tap-step observation is the pre-tap describe it locates in, open configs observe the post-action state — D41-M5)" and "same-code run-to-run spread on these p50s: O1 138–179, O2 54–68, O3 598–627 (D41-M6)". |
| RTT count/step p50, same n | B1 2 · B2 2 · O1 2 · O2 2 · O3 2 · O4 1 · O5 1. Not a latency column (D2-M4); modelled as action + observation, excludes the settle RPC (D41-L3). |
| post-action wait (symmetry evidence, D41-H1) | `actionRttMs + settleMs` p50, non-launch: B1 2604 · B2 2642 · O1 2627 · O2 2639 · O3 2628 · O4 2642 · O5 2740 — equal within 5 %. Do NOT publish the `settleMs`-only comparison as proof of symmetry. |
| H1 tokens ratio | O1/B2 o200k p50 over all non-launch steps = 179/651 = **0.275×** (target ≤ 0.5×), PASS. Label "all non-launch steps, n=155 each"; note D.4 gave 0.214× on the same arms (run-to-run, D41-M6). |
| H2 | p50 over all non-launch steps: B2 − O2 = 0, FAIL (structural). Same-screen steps (task-structural subset, n=50 per arm): p50 2 − 1 = 1, PASS; means B2 2.00 vs O2 **1.22** (not 1.74 — D41-M1). |
| H3 warm/cold | O4/O3 o200k p50 = 21/627 = **0.033×** (target ≤ 0.2×), PASS; settings store 11 nodes / 10 edges, max out-degree 9, mean 0.91. |
| H4 non-inferiority, paired task-cluster bootstrap, B=10000, seed `0x5eedc0de`, full 100 denominator | vs B1 (100/100) and vs B2 (100/100): none inferior — O1 +0 [0,0] · O2 −1 [−3,0] · O3 +0 [0,0] · O4 +0 [0,0] · O5 +0 [0,0]. The vs-B1 column is now publishable (B1 is 100/100, so it is unremarkable); the D.4 "+13..+18 pp vs B1" must not appear anywhere. |
| invariants gate | store invariants OK: 0 duplicate screens, 0 multi-destination edges (`logs/sg-matrix.log:198`); `skippedNoIdHash` 0; three stores — `com.android.settings` 11/10, `com.android.chrome` 1/1, `com.google.android.settings.intelligence` 2/1. |
| O5 routing coverage, n=60 known-target taps | 59 one-step routed · 0 zero-step no-op · 0 mis-landed · 1 diverged (hash-mismatch, `settings-connected` rep 4 step 1; fell back to locate+tap and passed) · 0 no-route (ambiguous 0, no-known-path 0). Coverage 59/60 (≥30 bar). |
| O5 measured RPCs per one-step routed tap, n=59 | min 7 / p50 7 / max 7 — a LOWER bound (D2-L1). |
| navTarget uniqueness (supporting note, not a metric) | `t("Airplane mode")` occurs on exactly one of the 11 screens of this run's `graph-store/com.android.settings/34.json` (node `284ef0302b28c5de`). |

### Explicitly NOT allowed

- **"B1 now pays the largest wall wait / the settle is inverted, if anything"**,
  and `settleMs` p50 alone as proof of settle symmetry (D41-H1).
- **"B1's 82 % was not a rendering property"** unqualified — the renderings do
  differ; what is shown is that the difference is not resolution-blocking once
  the harness splits the label (D41-H2).
- **"O2 same-screen mean RTT/step 1.74"** (D41-M1) and the matrix cell
  **`NYYYY` / "rep 1"** for O2 `same-display-slider` (D41-M2).
- **O5 `fallbacks` 0** (D41-L1) and anything copied from the harness
  `results-ci.md`, which still prints **O5-pure 49/49** (D41-L2).
- **"The D.4 O5 divergences were under-settled transitions removed by the
  settle"** as a causal claim (D41-M7).
- Any token ×-factor without its statistic (per-step median vs per-run total —
  30× vs 11×, D41-L6).
