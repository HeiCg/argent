# Results (CI): screen-graph Phase D.4.1 — symmetric settle + symmetric parser; B1's D.4 gap was a harness artifact

Supersedes the phase D.4 `## Result` and the earlier version of this file. Phase D.4.1
closes the D.4 REJECT (`2026-09-13-review-d4-findings.md`). The D.4 report attributed
B1's 82/100 to a "describe-rendering capability gap". The adversarial review showed the
supporting excerpt was the Settings **root** screen, not the destination (D4-H1); that
B1's tap-step describe read the SOURCE screen because the B1 path paid no post-tap settle
while the open path settles inside its tap RPC; and that the exact-text/exact-cd tiers of
the shared resolver were unreachable for B1's collapsed rows because the harness's own
describe parser left `cd` undefined (D4-H3). Both were **harness asymmetries**, not
proprietary-capability properties.

D.4.1 removes both and re-runs once:

- **Symmetric settle (D4-H1).** `settleScreen()` applies the same tool and the same
  timeout after every non-launch action, for EVERY config, before the next observation: a
  short fixed delay (`BENCH_SETTLE_FIXED_MS`, default 700 ms) then `await-screen-idle`. It
  is the same tool but **not the same backend algorithm** (D41-M3): on the open configs
  `await-screen-idle` takes the open-server branch (`awaitChange` → wait-for-CHANGE, then
  quiet); B1 has no open server, so it falls to the describe-tree poll (quiet-only, no
  wait-for-change). The fixed 700 ms pre-delay is what lets B1's quiet-only poll land on the
  post-transition screen rather than latch the pre-transition source — so **that constant is
  load-bearing for D4-H1, not a free latency knob: lowering it would reinstate D4-H1
  (B1 reading the source screen) silently, without re-running.** The elapsed ms are recorded
  per step as `settleMs`, and the idle tool's own `settled`/`polls` are now recorded per step
  too (D41-M3), so B1's poll actually observing the transition is direct evidence rather than
  inferred from the token count. `settleMs` is never folded into observation or action RTT.
  B1's tap-step describe now reads the SETTLED destination.
- **Symmetric parser (D4-H3).** `describeLinesToNodes` splits a collapsed
  `"<title> / <summary>"` describe row on the first `" / "` into `text`/`cd`, so the
  EXACT-text/EXACT-cd tiers of `pickUniqueNode` are reachable for B1's collapsed rows. This
  is a **B1-side normalisation, not an unconditional mirror of the open split** (D41-M4):
  the open tree is not guaranteed to keep the same content in two nodes, and the split has a
  known failure mode — labels whose own text contains `" / "`. This run's own store holds an
  example: node `3ed4975114523f07` ("Notifications: Manage") carries a single
  `StaticText "On / Conversations can appear as floating icons" id="summary"`; rendered by B1
  as one quoted label, the split turns it into `text="On"` / `cd="Conversations can appear as
floating icons"`, so `t("On / Conversations…")` matches on the open tree and never on B1,
  while `t("On")` matches exactly on B1 and only by contains on the open tree. No task
  selector in this run contains `" / "` (checked `bench/tasks.ts`) and no `[D4]`-logged row
  has two separators, so nothing published here is wrong.

**Result: with both asymmetries removed, B1 = 100/100 and every config is ~100%.** The
D.4 "82% describe-rendering gap" does not survive a symmetric harness — it was the stale
source-screen read plus the collapsed-label parser, both fixed here. The 100/100 is itself
**conditional on the same two harness-side devices**, symmetrically stated (D41-H2): B1's
100/100 holds under a harness that (i) performs the explicit post-action settle for every
config and (ii) splits B1's collapsed `"<title> / <summary>"` labels into text/cd before
resolution; the same B1 code without those two was 81/100 (run 34788497583) and 82/100
(run 34794414764). B1's rendering _does_ differ from the open tree (one collapsed string vs
two nodes); what is shown is that the difference is **not resolution-blocking once the
harness parses it**, not that there is no rendering difference. The point that survives is
narrow and correct: the D.4 82 % must not be read as a capability gap.

- **Provenance.** Authoritative run **34801849653** (`HeiCg/argent`, workflow
  `bench-open-vs-proprietary.yml`, `suite=screen-graph`, `sg_mode=matrix`), branch
  `feat/screen-graph-d4` @ `fcc86ce9`, base `open/main` @ `690e66bc`. JSON
  `bench-sg-2026-09-14T03-20-27-137Z.json`. **7 configs × 20 tasks × 5 reps = 700
  task-runs**, `skipped {}`, `excluded 0`. Tokenizer o200k_base (primary) + chars/4
  (secondary). Bootstrap `B = 10000`, **RNG seed `0x5eedc0de` (published, fixed in the
  harness `env.bootstrapSeedHex`)** so the cluster intervals reproduce to the digit
  (D4-M6). Every number below names statistic, block, N and run id.
- Two **same-code reference runs** (34788497583 and 34794414764, the D.4 resolver code
  WITHOUT the settle/parser fixes) are carried side by side in `§Same-code reproducibility`
  as the noise floor. Runs are never blended.

## Scoreboard-eligible rows (reference run 34801849653)

Reference run for every row below: **34801849653** (`feat/screen-graph-d4` @ `fcc86ce9`,
base `open/main` @ `690e66bc`), 7 configs × 20 tasks × 5 reps = 700 task-runs,
`skipped {}`, o200k_base p50 over **non-launch steps, n=155 per config (launch observation
excluded)**, bootstrap B=10000 seed `0x5eedc0de`. These rows supersede the D.2 table
(run 33964414774) still in the scoreboard, naming both run ids; they must NOT be merged
with it. This section is the whitelist — only the rows and wording below are scoreboard-eligible.

| row                                                                                                 | wording required                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| success, full 100 denominator, cluster bootstrap (n=20 tasks, seed `0x5eedc0de`) + Wilson (n=100)   | B1 100 % (100/100) [100,100] / [96,100] · B2 100 % [100,100] / [96,100] · O1 100 % · O2 99 % (99/100) [97,100] / [95,100] · O3 100 % · O4 100 % · O5 100 %. Must carry: "success is at PARITY across all seven configs on this run; the differentiator is tokens, not success."                                                                              |
| B1 row caveat (mandatory, D41-H2)                                                                   | "B1 100/100 holds under a harness that performs an explicit post-action settle for every config and splits B1's collapsed `"<title> / <summary>"` describe labels into text/cd before resolution. The same B1 code without those two was 81/100 (run 34788497583) and 82/100 (run 34794414764); the D.4 82 % must not be read as a capability gap."          |
| tokens/agent-step, o200k p50, n=155 non-launch steps each                                           | B1 657 · B2 651 · O1 179 · O2 68 · O3 627 · O4 21 · O5 21. Add "launch-step observation excluded; each config's own observation sequence (B1's tap-step observation is the pre-tap describe it locates in, open configs observe the post-action state — D41-M5)" and "same-code run-to-run spread on these p50s: O1 138–179, O2 54–68, O3 598–627 (D41-M6)". |
| RTT count/step p50, same n                                                                          | B1 2 · B2 2 · O1 2 · O2 2 · O3 2 · O4 1 · O5 1. Not a latency column (D2-M4); modelled as action + observation, excludes the settle RPC (D41-L3).                                                                                                                                                                                                            |
| post-action wait (symmetry evidence, D41-H1)                                                        | `actionRttMs + settleMs` p50, non-launch: B1 2604 · B2 2642 · O1 2627 · O2 2639 · O3 2628 · O4 2642 · O5 2740 — equal within 5 %. Do NOT publish the `settleMs`-only comparison as proof of symmetry.                                                                                                                                                        |
| H1 tokens ratio                                                                                     | O1/B2 o200k p50 over all non-launch steps = 179/651 = **0.275×** (target ≤ 0.5×), PASS. Label "all non-launch steps, n=155 each"; note D.4 gave 0.214× on the same arms (run-to-run, D41-M6).                                                                                                                                                                |
| H2                                                                                                  | p50 over all non-launch steps: B2 − O2 = 0, FAIL (structural). Same-screen steps (task-structural subset, n=50 per arm): p50 2 − 1 = 1, PASS; means B2 2.00 vs O2 **1.22** (not 1.74 — D41-M1).                                                                                                                                                              |
| H3 warm/cold                                                                                        | O4/O3 o200k p50 = 21/627 = **0.033×** (target ≤ 0.2×), PASS; settings store 11 nodes / 10 edges, max out-degree 9, mean 0.91.                                                                                                                                                                                                                                |
| H4 non-inferiority, paired task-cluster bootstrap, B=10000, seed `0x5eedc0de`, full 100 denominator | vs B1 (100/100) and vs B2 (100/100): none inferior — O1 +0 [0,0] · O2 −1 [−3,0] · O3 +0 [0,0] · O4 +0 [0,0] · O5 +0 [0,0]. The vs-B1 column is now publishable (B1 is 100/100, so it is unremarkable); the D.4 "+13..+18 pp vs B1" must not appear anywhere.                                                                                                 |
| invariants gate                                                                                     | store invariants OK: 0 duplicate screens, 0 multi-destination edges (`logs/sg-matrix.log:198`); `skippedNoIdHash` 0; three stores — `com.android.settings` 11/10, `com.android.chrome` 1/1, `com.google.android.settings.intelligence` 2/1.                                                                                                                  |
| O5 routing coverage, n=60 known-target taps                                                         | 59 one-step routed · 0 zero-step no-op · 0 mis-landed · 1 diverged (hash-mismatch, `settings-connected` rep 4 step 1; fell back to locate+tap and passed) · 0 no-route (ambiguous 0, no-known-path 0). Coverage 59/60 (≥30 bar).                                                                                                                             |
| O5 measured RPCs per one-step routed tap, n=59                                                      | min 7 / p50 7 / max 7 — a LOWER bound (D2-L1).                                                                                                                                                                                                                                                                                                               |
| navTarget uniqueness (supporting note, not a metric)                                                | `t("Airplane mode")` occurs on exactly one of the 11 screens of this run's `graph-store/com.android.settings/34.json` (node `284ef0302b28c5de`).                                                                                                                                                                                                             |

**Explicitly NOT allowed:**

- "B1 now pays the largest wall wait / the settle is inverted, if anything", and `settleMs`
  p50 alone as proof of settle symmetry (D41-H1).
- "B1's 82 % was not a rendering property" unqualified — the renderings do differ; what is
  shown is that the difference is not resolution-blocking once the harness splits the label (D41-H2).
- "O2 same-screen mean RTT/step 1.74" (D41-M1) and the matrix cell `NYYYY` / "rep 1" for
  O2 `same-display-slider` (D41-M2).
- O5 `fallbacks` 0 (D41-L1) and anything copied from the harness `results-ci.md`, which still
  prints O5-pure 49/49 (D41-L2).
- "The D.4 O5 divergences were under-settled transitions removed by the settle" as a causal
  claim (D41-M7).
- Any token ×-factor without its statistic (per-step median vs per-run total — 30× vs 11×, D41-L6).

## Per-config — success (full 100 denominator), tokens/step, RTT (run 34801849653)

`success` = ok/total on the FULL 100-run denominator (exclusions-as-failures, phase D §0.1).
PRIMARY interval = task-cluster bootstrap (n=20 tasks, seed `0x5eedc0de`); SECONDARY = naive
Wilson (n=100). Token/RTT columns are over **non-launch steps only (n=155 each;
launch-step observation excluded)** (D4-L1). **Each config uses its own observation
sequence** (D41-M5): B1's tap-step observation is the **pre-tap** describe it locates in
(`bench-screen-graph.ts:1204-1209`), while the open configs observe the **post-action**
state — so the token columns are over each arm's own screen multiset, not the same screens
step-for-step (see the item-1 note). `post-action wait ms/step p50` = `actionRttMs +
settleMs` p50, the total wait after each non-launch action (D41-H1 — the symmetry evidence;
`settleMs` alone is NOT the proof). `fail (L/A/oracleErr/T)` = locate / action /
oracleError(exception) / taskError; `unmet` = oracle-unmet runs, counted separately (D4-L2).
`fallbacks` = the run's aggregate `fallbacks`/`navFallbacks` count (D41-L1). **For B1 any
console describe/tree-fallback would invalidate its metrics (HIGH-5); B1 = 0 here**, so the
proprietary path was genuinely exercised. O5 = 1 is the single nav locate+tap fallback from
the `settings-connected` divergence (fell back and passed), not a describe fallback.

| Config                    | n steps | tok o200k p50 | tok o200k p95 | chars/4 p50 | obs RTT ms/step p50 | RTT count/step p50 | settleMs p50 | post-action wait ms/step p50 (actionRtt+settle) | success             | cluster 95% (n=20, seed 0x5eedc0de) | Wilson (n=100) | fail (L/A/oracleErr/T) | unmet | fallbacks |
| ------------------------- | ------- | ------------- | ------------- | ----------- | ------------------- | ------------------ | ------------ | ----------------------------------------------- | ------------------- | ----------------------------------- | -------------- | ---------------------- | ----- | --------- |
| B1 (argent proprietary)   | 155     | 657           | 4510          | 473         | 57                  | 2                  | 2226         | **2604**                                        | **100 % (100/100)** | [100, 100]                          | [96, 100]      | 0 (0/0/0/0)            | 0     | 0         |
| B2 (open, no graph)       | 155     | 651           | 4510          | 447         | 20                  | 2                  | 1015         | 2642                                            | 100 % (100/100)     | [100, 100]                          | [96, 100]      | 0 (0/0/0/0)            | 0     | 0         |
| O1 (+ query/diff)         | 155     | 179           | 515           | 103         | 3                   | 2                  | 1021         | 2627                                            | 100 % (100/100)     | [100, 100]                          | [96, 100]      | 0 (0/0/0/0)            | 0     | 0         |
| O2 (+ outcomes)           | 155     | 68            | 515           | 36          | 3                   | 2                  | 1011         | 2639                                            | 99 % (99/100)       | [97, 100]                           | [95, 100]      | 0 (0/0/0/0)            | 1     | 0         |
| O3 (+ graph, graph-blind) | 155     | 627           | 4510          | 446         | 22                  | 2                  | 1025         | 2628                                            | 100 % (100/100)     | [100, 100]                          | [96, 100]      | 0 (0/0/0/0)            | 0     | 0         |
| O4 (graph, warm)          | 155     | 21            | 114           | 20          | 18                  | 1                  | 1010         | 2642                                            | 100 % (100/100)     | [100, 100]                          | [96, 100]      | 0 (0/0/0/0)            | 0     | 0         |
| O5 (+ navigate-to)        | 155     | 21            | 114           | 20          | 17                  | 1                  | 1013         | 2740                                            | 100 % (100/100)     | [100, 100]                          | [96, 100]      | 0 (0/0/0/0)            | 0     | 1         |

- **Every config is ~100 % at equal success.** B1 100/100, B2 100/100, O1 100/100,
  O2 99/100 (one oracle-unmet run, config-neutral), O3/O4/O5 100/100. The token spread is
  now the entire story: at the SAME success, the describe arms (B1 657, B2 651) pay, **as a
  ratio of per-step p50s**, ~30× the warm-graph observation (O4/O5 21) and ~3.6× the
  query+diff observation (O1 179). **As a ratio of per-run observation totals** (D41-L6) the
  same comparison is B1 1947 vs O4 177 (**11×**) and B2 2104 vs O1 465 (**4.5×**) — the
  per-step and per-run ratios differ because the arms observe **different screen multisets**
  (D41-M5): B1's tap-step observation is the pre-tap describe (it reads the root twice on
  `settings-network-internet` and never the 747-tok Internet screen), while the open arms
  observe the post-action state. Direction is unchanged either way; which statistic is meant
  is named.
- **Post-action wait is symmetric across configs (D4-H1, corrected — D41-H1).** The open
  arms' post-action wait is split in two: the tap RPC itself blocks on the settled
  `getState` (tap `actionRttMs` p50 ≈ 1.6 s for the open configs vs B1's ≈ 167 ms), and only
  the remainder falls into the explicit `settleMs`. Comparing `settleMs` alone therefore
  compares only part of the open wait and reads backwards. The correct statistic is the
  **total post-action wait** (`actionRttMs + settleMs`, non-launch p50): B1 **2604**, B2
  2642, O1 2627, O2 2639, O3 2628, O4 2642, O5 2740 — **equal within ~5 % across all seven
  configs**. So B1 does _not_ pay the largest wait; the arms are equal, which is the actual
  (and stronger) evidence that the settle is symmetric. The D.4 asymmetry (B1 paid ~0 settle
  and read the pre-transition screen) is gone. `settleMs` is never counted inside `obs RTT
ms/step` or the action RTT.
- **`obs RTT ms/step` is not a latency column (D2-M4)** and excludes `settleMs` and the
  open recording `recordMs`; screen-graph compares tokens and success, not latency. The
  `RTT count/step` column is modelled as action + observation and does NOT include the
  settle's `await-screen-idle` RPC (D41-L3); B1's idle-poll describes and the open
  `awaitChange` waits are tokenised in no column (D41-L4).

## Item 1/§2 — B1's rendering of the two-level "Internet" row, AFTER the settle (run 34801849653)

`settings-network-internet` launches Settings, taps `Network & internet` (step 1), then
`Internet` (step 2), and asserts **"Add network"** (present only on the Internet/Wi-Fi
screen). **B1 now passes YYYYY** (D.4 had NNNNN). The reason is the settle: B1's step-2
describe now reads the **destination** Network & internet screen (598 tok), not the 657-tok
root it read in D.4. Verbatim from the run artifact (`logs/sg-matrix.log` line 29):

```
[bench-sg][D4] B1 locate FOUND-UNIQUE for {"text":"Internet"} on settings-network-internet step 2 (describe 598 tok o200k, post-settle); describe rows containing "internet": FrameLayout "Network & internet" id="com.android.settings:id/collapsing_toolbar"  (0.000, 0.000, 1.000, 0.249) || LinearLayout "Internet / T-Mobile" [clickable]  (0.000, 0.249, 1.000, 0.086)
```

The destination screen **does carry a discrete "Internet" row** (`"Internet / T-Mobile"`,
at y 0.249) — the D.4 claim that "the only internet node is the collapsed
`Network & internet` summary, there is no discrete Internet row" was reading the ROOT
(review D4-H1). Under the shared policy with the D4-H3 split, `"Internet / T-Mobile"`
becomes `text="Internet"`, so `t("Internet")` takes the EXACT-text tier over the toolbar
`"Network & internet"` (which only CONTAINS "internet") and taps the discrete row —
reaching the Internet screen where "Add network" lives. The open tree of the same screen
(graph-store node `284ef0302b28c5de`, `com.android.settings/34.json`) carries the same row
as a discrete `StaticText "Internet" id="title" (0.175, 0.267, 0.167, 0.030)`, resolved the
same way. The unit test `phase D.4.1 (D4-H2/H1, item 4) — DESTINATION Network & internet
screen` pins both renderings from these verbatim rows.

**Observation sequence (D41-M5).** B1 locates _in_ its pre-tap describe, so on this task
B1's three step observations are 657 / 657 / 598 (root, root, destination) — B1 reads the
root twice and never observes the final Internet screen (747 tok, the most expensive one),
whereas B2 observes the post-action state 657 / 598 / 747. The success is identical; the
token columns are simply over each arm's own screen multiset, not the same screens
step-for-step. This does not change the direction of the token result (per-run observation
totals B1 1947 vs B2 2104), but the per-step token medians are compared over different
screens — hence the two ×-factors in the per-config note (per-step median vs per-run total,
D41-L6).

**The other B1 D.4 failures, resolved by the two fixes (verbatim `[D4]` excerpts):**

- `settings-display` / `same-display-slider` (D.4 LLLLL, "AMBIGUOUS"): now FOUND-UNIQUE
  (`sg-matrix.log` lines 25, 48). Both rows still contain "display", but the split gives
  the first EXACT text "Display" (tier 2 resolves it): `LinearLayout "Display / Dark theme,
font size, brightness" [clickable]` — B1 = YYYYY.
- `settings-battery-then-back` (D.4 LYYLL, a degenerate 112-tok describe after the back
  step — D4-M1): the settle removes the degenerate capture; step-3 reads the settled root
  (657 tok, `sg-matrix.log` line 33, `Battery / 100%` present) — B1 = YYYYY.

## Item 3 — unique navTarget for `settings-network`; O5 routing (run 34801849653)

`settings-network`'s navTarget is `t("Airplane mode")` (`tasks.ts`). Evidence for its
uniqueness is the graph-store, in this run's artifact: across the 11 screens of
`graph-store/com.android.settings/34.json`, "Airplane mode" appears only on the Network &
internet screen node `284ef0302b28c5de` (D4-M7 — the report now cites the store, not a run
absent from the artifact set). **O5 no-route on `settings-network` = 0**; `settings-network`
= YYYYY for O5.

O5 navigate-to structure (structured records, all 60 attempted known-target taps):

| Outcome                                   | Count  |
| ----------------------------------------- | ------ |
| one-step routed                           | **59** |
| zero-step no-op route (D2-H1: not routed) | 0      |
| mis-landed                                | 0      |
| diverged-after-tap                        | 1      |
| no-route                                  | **0**  |

No-route split: ambiguous-target 0, no-known-path 0. Diverged split: hash-mismatch **1**,
selector-ambiguous/unresolved 0. `recordSkippedNoIdHash` 0. The **1 divergence is
`settings-connected` rep 4 step 1** (post-tap hash `c0f355cf56c0`, the Connected-devices
node): the arrival check against the `Saved devices` identity mismatched, the step fell
back to locate+tap and **passed** — so O5 = 100/100 with no success cost. Coverage
**59/60 one-step routes** (≥ 30 bar), mis-lands 0 (≤ 2). O5 measured RPCs per one-step
routed tap: **min 7 / p50 7 / max 7** (n=59) — a LOWER bound (D2-L1: navigate-to's RPCs are
proxy-measured; the bench's `await-screen-idle` + `queryPresent` add ≥2). No O5-pure
success cell is published (D4-H4: it is selection on the outcome).

## Invariants gate (M2/M3) — CI green

`checkStoreInvariants()` ran after the matrix and the job stayed green
(`logs/sg-matrix.log` line 198):

> **`[bench-sg] store invariants OK: 0 duplicate screens, 0 multi-destination edges`**

Produced store shapes: `com.android.settings` **11 nodes / 10 edges**
(`env.settingsGraph = {nodes 11, edges 10, maxOutDegree 9, meanOutDegree 0.91}`),
`com.android.chrome` 1/1, `com.google.android.settings.intelligence` 2/1 — **0 duplicate
screens, 0 multi-destination edges, skippedNoIdHash 0** across all stores.

## Hypotheses (run 34801849653)

| Hypothesis       | Statistic                                                              | Target | Measured             | Verdict               |
| ---------------- | ---------------------------------------------------------------------- | ------ | -------------------- | --------------------- |
| H1               | O1 tokens/step vs B2, o200k p50, **all non-launch steps** (n=155 each) | ≤ 0.5× | 179/651 = **0.275×** | **PASS**              |
| H2 (all steps)   | B2 − O2 RTT-count/step p50                                             | ≥ 1    | 2 − 2 = **0**        | **FAIL** (structural) |
| H2 (same-screen) | B2 − O2 RTT-count/step p50, **O2 n=50 · B2 n=50**                      | ≥ 1    | 2 − 1 = **1**        | **PASS**              |
| H3               | O4 warm / O3 cold tokens/step, o200k p50                               | ≤ 0.2× | 21/627 = **0.033×**  | **PASS**              |

**H1 label (D4-M5):** the ratio is over all non-launch steps (O1 p50 179 / B2 p50 651), n=155
each. **This ratio carries the same run-to-run noise floor the success rows do (D41-M6):**
the same arms gave **0.214× on the D.4 authoritative run 34794414764** (O1 p50 138 / B2 645)
— a 29 % move of the headline ratio with no code change between those arms — so 0.275× is a
point on a noisy metric, not a fixed constant. **H2 label:**
navigation tasks change the screen every step, so O2's unchanged-outcome skip saves nothing
there (all-steps ≈ 0); the saving is real only on the 50 same-screen steps: **O2 same-screen
mean RTT/step 1.22 vs B2 2.00 (n=50 each)** — over all 155 non-launch steps O2 is 1.74 vs
B2 2.00, so 1.74 is the all-steps mean, not the same-screen mean (D41-M1). Both arms now
have **n=50** on the same-screen subset (no taskError this run — D4-L4). The p50-based
verdict (2 − 1 = 1, PASS) is unaffected.
**H3 label:** warm is a ≤6-affordance graph-lookup summary vs a full cold describe.

**H4 — non-inferior to each baseline** (paired task-cluster bootstrap, B=10000, seed
`0x5eedc0de`; inferior at > 5 pp below the baseline point estimate):

| Baseline (success, cluster / Wilson)       | Paired Δ verdict (O1..O5)                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| B1 (100 %, 100/100) [100, 100] / [96, 100] | **PASS — none inferior.** O1 +0 [0,0] · O2 −1 [−3,0] · O3 +0 [0,0] · O4 +0 [0,0] · O5 +0 [0,0] |
| B2 (100 %, 100/100) [100, 100] / [96, 100] | **PASS — none inferior.** O1 +0 [0,0] · O2 −1 [−3,0] · O3 +0 [0,0] · O4 +0 [0,0] · O5 +0 [0,0] |

H4 vs B1 is now honest and unremarkable: B1 is 100/100, so there is no gap to explain —
the D.4-vs-B1 deltas (+13..+18 pp) were an artifact of B1's harness-suppressed 82 %.

## Same-code reproducibility — the two D.4 runs vs this run (D4-H5)

Both reference runs ran the D.4 resolver code (no settle, no parser split). This run adds
both fixes. Recomputed from each run's JSON (never from a harness `results-ci.md`):

| Metric                           | run 34788497583 (D.4 same-code ref) | run 34794414764 (D.4 authoritative) | run 34801849653 (**D.4.1, settle+split**) |
| -------------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------------- |
| B1 success                       | 81/100 [72, 87]                     | 82/100 [73, 88]                     | **100/100 [96, 100]**                     |
| O5 success                       | 100/100                             | 95/100                              | **100/100**                               |
| B1 `settings-network-internet`   | NLNLN                               | NNNNN                               | **YYYYY**                                 |
| B1 `settings-battery-then-back`  | LYLYL                               | LYYLL                               | **YYYYY**                                 |
| B1 `settings-display`            | LLLLL                               | LLLLL                               | **YYYYY**                                 |
| B1 two-level task string         | NLNLN                               | NNNNN                               | **YYYYY**                                 |
| O5 one-step routed / diverged    | 58 / 2                              | 57 / 3                              | **59 / 1**                                |
| tok o200k p50 — O1 (D41-M6)      | 179                                 | 138                                 | **179**                                   |
| tok o200k p50 — O2               | 54                                  | 54                                  | **68**                                    |
| tok o200k p50 — O3               | 598                                 | 627                                 | **627**                                   |
| tok o200k p50 — O4 / O5          | 20 / 20                             | 21 / 22                             | **21 / 21**                               |
| tok o200k p50 — B1 / B2 (stable) | 657 / 651                           | 657 / 645                           | **657 / 651**                             |
| H1 ratio (O1/B2 p50)             | 0.275×                              | **0.214×**                          | 0.275×                                    |

**Reading:** the two same-code runs bracket B1 at 81–82/100 and O5 at 95–100/100 — a
~1 pp B1 spread and a ~5 pp O5 spread is the run-to-run noise floor on identical code
(D4-H5). The same floor moves the **token** p50s (D41-M6): O1 179↔138, O2 54↔68, O3
598↔627, and the H1 ratio 0.214×↔0.275× — the metric this report calls "the entire story"
is itself noisy at ±29 %, so its ×-factors are points on a noisy metric, not fixed
constants. This run's B1 jump to **100/100 (+18 pp)** is an order of magnitude above the
success floor and is mechanistically evidenced (settle → destination read on line 29; split
→ Display/Internet exact-text hit; settle → non-degenerate battery-back read on line 33), so
it is the fix, not noise. O5 also returns to 100/100 with routed 59/60. **The claim that the
D.4 O5 95/100 and its `settings-display` divergences were under-settled transitions removed
by the settle is NOT load-bearing and is not made here (D41-M7):** run 34788497583 has no
settle at all and is O5 100/100 with 58/60 routed — which is exactly why the O5 spread is
read as the noise floor above. The settle explanation is at most _consistent with_ this run,
not demonstrated by it; the noise-floor reading is the one that holds.

## Per-task success matrix (run 34801849653)

`Y` oracle met · `N` oracle unmet · `L` locate-failed (aborted) · `A` action-failed ·
`T` taskError (run never executed — legend includes `T` per D4-M4; none occur this run).

| Task                       | B1    | B2    | O1    | O2    | O3    | O4    | O5    |
| -------------------------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| settings-network           | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-connected         | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-apps              | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-notifications     | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-battery           | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-storage           | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-sound             | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-display           | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-network-internet  | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-battery-then-back | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-open-page           | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-heading-word        | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-example-word        | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-scroll-body         | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-scroll-doc          | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-settings-search       | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-sound-noop            | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-chrome-noop           | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-display-slider        | YYYYY | YYYYY | YYYYY | YYNYY | YYYYY | YYYYY | YYYYY |
| same-apps-noop             | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |

(O2's single oracle-unmet is `same-display-slider` **rep 2** (0-based; `assertionMatches`
empty, needle "Brightness level") — reps 0,1,3,4 met, i.e. `YYNYY` — a config-neutral
Display-slider read, not a routing or rendering property. D41-M2 corrected the earlier
`NYYYY`/"rep 1".)

## Superseded D.4 numbers

| D.4 number                                                                                           | Why superseded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1 82/100, "18 fails explained by the describe RENDERING under the shared policy"                    | D.4 ran WITHOUT the symmetric settle (B1 read the pre-transition source screen — D4-H1) and WITHOUT the parser split (collapsed labels blocked the exact-text tier — D4-H3). With both, **B1 = 100/100**. The 82 % must not be read as a capability gap. B1's rendering _does_ differ from the open tree (one collapsed `"<title> / <summary>"` string vs two nodes); what is shown is that the difference is **not resolution-blocking once the harness splits the label** — not that there is no rendering difference (D41-H2). The 100/100 is itself conditional on the same two harness devices (settle + label split): the same B1 code without them was 81/100 (34788497583) and 82/100 (34794414764). |
| B1 `settings-network-internet` NNNNN "because the proprietary describe has no discrete Internet row" | The D.4 excerpt was the ROOT screen (D4-H1). After the settle, B1's step-2 describe reads the destination, which HAS a discrete `Internet / T-Mobile` row (`sg-matrix.log` line 29); B1 = **YYYYY**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| "O5-pure 47/47 = 100 %"                                                                              | Removed (D4-H4: selection on the outcome). Only routing coverage (59/60) and the measured-RPC row are published.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| "O5's failures are config-neutral Display flakiness" (95/100)                                        | O5 = **100/100** here; its single divergence is `settings-connected` (fell back, passed), not Display. The D.4 O5 95/100 is within the run-to-run O5 noise floor (run 34788497583 has no settle and is O5 100/100); the settle is _consistent with_ the return to 100/100, not shown to have caused it, so no causal "under-settled transitions removed by the settle" claim is made (D41-M7).                                                                                                                                                                                                                                                                                                               |
| B1 cluster interval [65, 97] with no published seed                                                  | Seed now published (`0x5eedc0de`); B1 [100, 100] this run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| store 11 nodes / 11 edges                                                                            | This run **11 nodes / 10 edges** (max out-degree 9, mean 0.91); gate still 0/0 (run-to-run edge count varies with which revisits landed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Acceptance check

| Criterion                                                                                     | Status                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same settle policy in both renderings, proven by the post-action wait in JSON for all configs | **PASS** — `settleScreen` after every non-launch action; total post-action wait (`actionRttMs + settleMs`) p50 equal within 5 % across configs: B1 2604 vs open 2627–2740 (the `settleMs`-only 2226-vs-1015 comparison omits the ≈1.6 s settled `getState` inside the open tap RPC and is NOT the proof — D41-H1) |
| Same parser tiers reachable in both renderings, proven by tests on verbatim artifact rows     | **PASS** — D4-H3 split; 14/14 locate tests on verbatim rows (root + destination), no invented rows                                                                                                                                                                                                                |
| B1's two-level outcome explained by the destination screen's quoted proprietary rendering     | **PASS** — `sg-matrix.log` line 29: discrete `Internet / T-Mobile` row on the settled destination; B1 = YYYYY                                                                                                                                                                                                     |
| Both same-code reference runs carried; no O5-pure; seed published; every M/L fix applied      | **PASS** — §Same-code reproducibility; no O5-pure; seed `0x5eedc0de`; D41-M1–M7 and D41-L1/L2/L3/L4/L6/L7 applied (L5 is the test-fixture geometry note, unchanged this pass)                                                                                                                                     |
| Run green with the invariants gate; scoreboard untouched; `open/main` not fast-forwarded      | **PASS** — gate green; `2026-09-03-scoreboard.md` untouched; no fast-forward                                                                                                                                                                                                                                      |
| B1 metrics valid (fallbacks 0)                                                                | **PASS** — B1 console fallbacks 0                                                                                                                                                                                                                                                                                 |

Open follow-ups (do not affect the bar): (1) the settle does NOT roughly double B1's wall
wait — total post-action wait is equal within 5 % across configs (B1 2604 ms p50 vs open
2627–2740 ms, D41-H1), and B1's per-task wall p50 is 8976 ms vs B2 7733 (recomputed from
this run's JSON), a ~16 % gap, not a doubling. B1's _explicit_ `settleMs` is larger (2226 vs ~1015) only because the open configs
already spent ≈1.6 s settling inside their tap RPC, which `settleMs` does not include.
**The fixed pre-delay `BENCH_SETTLE_FIXED_MS` (default 700 ms) is load-bearing for D4-H1,
not a free latency knob (D41-M3):** it is what lets B1's quiet-only describe-tree poll land
on the post-transition screen rather than latch the pre-transition source. Lowering it would
reinstate D4-H1 (B1 reading the source screen) silently, without a re-run — so any tuning
must re-verify B1's destination read, not just the wall time. (2) M7 device H_id stability
stays UNVERIFIED until the Kotlin `ScreenHash.identity` test lands (fixture
`identityFixture` in the pre-flight artifact).
