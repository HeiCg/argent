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

- **Symmetric settle (D4-H1).** `settleScreen()` applies the same wait — a short fixed
  delay then `await-screen-idle` (on B1 the tool falls back to the describe-tree poll; on
  the open configs it uses the device `awaitChange`) — after every non-launch action, for
  EVERY config, before the next observation. Recorded per step as `settleMs`, never folded
  into observation or action RTT. B1's tap-step describe now reads the SETTLED destination.
- **Symmetric parser (D4-H3).** `describeLinesToNodes` splits a collapsed
  `"<title> / <summary>"` describe row on the first `" / "` into `text`/`cd`, mirroring the
  open title/summary split, so the EXACT-text/EXACT-cd tiers of `pickUniqueNode` are
  reachable for B1's collapsed rows exactly as for the open configs.

**Result: with both asymmetries removed, B1 = 100/100 and every config is ~100%.** The
D.4 "82% describe-rendering gap" does not survive a symmetric harness — it was the stale
source-screen read plus the collapsed-label parser, both fixed here.

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

## Per-config — success (full 100 denominator), tokens/step, RTT (run 34801849653)

`success` = ok/total on the FULL 100-run denominator (exclusions-as-failures, phase D §0.1).
PRIMARY interval = task-cluster bootstrap (n=20 tasks, seed `0x5eedc0de`); SECONDARY = naive
Wilson (n=100). Token/RTT columns are over **non-launch steps only (n=155 each;
launch-step observation excluded)** (D4-L1). `fail (L/A/oracleErr/T)` = locate / action /
oracleError(exception) / taskError; `unmet` = oracle-unmet runs, counted separately (D4-L2).
`fallbacks` = console describe/tree-fallback count — for B1 any fallback would invalidate
its metrics (HIGH-5); B1 = 0 here, so the proprietary path was genuinely exercised.

| Config | n steps | tok o200k p50 | tok o200k p95 | chars/4 p50 | obs RTT ms/step p50 | RTT count/step p50 | settleMs p50 | success | cluster 95% (n=20, seed 0x5eedc0de) | Wilson (n=100) | fail (L/A/oracleErr/T) | unmet | fallbacks |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B1 (argent proprietary) | 155 | 657 | 4510 | 473 | 57 | 2 | 2226 | **100 % (100/100)** | [100, 100] | [96, 100] | 0 (0/0/0/0) | 0 | 0 |
| B2 (open, no graph) | 155 | 651 | 4510 | 447 | 20 | 2 | 1015 | 100 % (100/100) | [100, 100] | [96, 100] | 0 (0/0/0/0) | 0 | 0 |
| O1 (+ query/diff) | 155 | 179 | 515 | 103 | 3 | 2 | 1021 | 100 % (100/100) | [100, 100] | [96, 100] | 0 (0/0/0/0) | 0 | 0 |
| O2 (+ outcomes) | 155 | 68 | 515 | 36 | 3 | 2 | 1011 | 99 % (99/100) | [97, 100] | [95, 100] | 0 (0/0/0/0) | 1 | 0 |
| O3 (+ graph, graph-blind) | 155 | 627 | 4510 | 446 | 22 | 2 | 1025 | 100 % (100/100) | [100, 100] | [96, 100] | 0 (0/0/0/0) | 0 | 0 |
| O4 (graph, warm) | 155 | 21 | 114 | 20 | 18 | 1 | 1010 | 100 % (100/100) | [100, 100] | [96, 100] | 0 (0/0/0/0) | 0 | 0 |
| O5 (+ navigate-to) | 155 | 21 | 114 | 20 | 17 | 1 | 1013 | 100 % (100/100) | [100, 100] | [96, 100] | 0 (0/0/0/0) | 0 | 0 |

- **Every config is ~100 % at equal success.** B1 100/100, B2 100/100, O1 100/100,
  O2 99/100 (one oracle-unmet run, config-neutral), O3/O4/O5 100/100. The token spread is
  now the entire story: at the SAME success, the describe arms (B1 657, B2 651) pay
  ~30× the warm-graph observation (O4/O5 21) and ~3.6× the query+diff observation (O1 179).
- **`settleMs` is the proof of symmetry (D4-H1).** Every config pays the same
  `await-screen-idle` settle after every non-launch action, and B1 now pays the LARGEST
  wall wait (p50 2226 ms vs the open configs' ~1010–1025 ms) because its describe-tree idle
  poll is slower to confirm stillness than the open `awaitChange`. The D.4 asymmetry (B1
  paid ~0 settle and read the pre-transition screen) is gone — inverted, if anything.
  `settleMs` is not counted inside `obs RTT ms/step` or the action RTT.
- **`obs RTT ms/step` is not a latency column (D2-M4)** and excludes `settleMs` and the
  open recording `recordMs`; screen-graph compares tokens and success, not latency.

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

| Outcome | Count |
|---|---|
| one-step routed | **59** |
| zero-step no-op route (D2-H1: not routed) | 0 |
| mis-landed | 0 |
| diverged-after-tap | 1 |
| no-route | **0** |

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

| Hypothesis | Statistic | Target | Measured | Verdict |
|---|---|---|---|---|
| H1 | O1 tokens/step vs B2, o200k p50, **all non-launch steps** (n=155 each) | ≤ 0.5× | 179/651 = **0.275×** | **PASS** |
| H2 (all steps) | B2 − O2 RTT-count/step p50 | ≥ 1 | 2 − 2 = **0** | **FAIL** (structural) |
| H2 (same-screen) | B2 − O2 RTT-count/step p50, **O2 n=50 · B2 n=50** | ≥ 1 | 2 − 1 = **1** | **PASS** |
| H3 | O4 warm / O3 cold tokens/step, o200k p50 | ≤ 0.2× | 21/627 = **0.033×** | **PASS** |

**H1 label (D4-M5):** the ratio is over all non-launch steps (O1 p50 179 / B2 p50 651); on
this run that value coincides with the harness "unchanged steps" figure. **H2 label:**
navigation tasks change the screen every step, so O2's unchanged-outcome skip saves nothing
there (all-steps ≈ 0); the saving is real only on the 50 same-screen steps (O2 mean
RTT/step 1.74 vs B2 2.0), and both arms now have **n=50** (no taskError this run — D4-L4).
**H3 label:** warm is a ≤6-affordance graph-lookup summary vs a full cold describe.

**H4 — non-inferior to each baseline** (paired task-cluster bootstrap, B=10000, seed
`0x5eedc0de`; inferior at > 5 pp below the baseline point estimate):

| Baseline | Baseline success (cluster / Wilson) | Paired Δ verdict (O1..O5) |
|---|---|---|
| B1 (100 %, 100/100) [100, 100] / [96, 100] | | **PASS — none inferior.** O1 +0 [0,0] · O2 −1 [−3,0] · O3 +0 [0,0] · O4 +0 [0,0] · O5 +0 [0,0] |
| B2 (100 %, 100/100) [100, 100] / [96, 100] | | **PASS — none inferior.** O1 +0 [0,0] · O2 −1 [−3,0] · O3 +0 [0,0] · O4 +0 [0,0] · O5 +0 [0,0] |

H4 vs B1 is now honest and unremarkable: B1 is 100/100, so there is no gap to explain —
the D.4-vs-B1 deltas (+13..+18 pp) were an artifact of B1's harness-suppressed 82 %.

## Same-code reproducibility — the two D.4 runs vs this run (D4-H5)

Both reference runs ran the D.4 resolver code (no settle, no parser split). This run adds
both fixes. Recomputed from each run's JSON (never from a harness `results-ci.md`):

| Metric | run 34788497583 (D.4 same-code ref) | run 34794414764 (D.4 authoritative) | run 34801849653 (**D.4.1, settle+split**) |
|---|---|---|---|
| B1 success | 81/100 [72, 87] | 82/100 [73, 88] | **100/100 [96, 100]** |
| O5 success | 100/100 | 95/100 | **100/100** |
| B1 `settings-network-internet` | NLNLN | NNNNN | **YYYYY** |
| B1 `settings-battery-then-back` | LYLYL | LYYLL | **YYYYY** |
| B1 `settings-display` | LLLLL | LLLLL | **YYYYY** |
| B1 two-level task string | NLNLN | NNNNN | **YYYYY** |
| O5 one-step routed / diverged | 58 / 2 | 57 / 3 | **59 / 1** |

**Reading:** the two same-code runs bracket B1 at 81–82/100 and O5 at 95–100/100 — a
~1 pp B1 spread and a ~5 pp O5 spread is the run-to-run noise floor on identical code
(D4-H5). This run's B1 jump to **100/100 (+18 pp)** is an order of magnitude above that
floor and is mechanistically evidenced (settle → destination read on line 29; split →
Display/Internet exact-text hit; settle → non-degenerate battery-back read on line 33), so
it is the fix, not noise. Correspondingly O5 returns to 100/100 with routed 59/60 — the
D.4 authoritative run's O5 95/100 and its 3 `settings-display` divergences were the
under-settled Display transitions, also removed by the symmetric settle.

## Per-task success matrix (run 34801849653)

`Y` oracle met · `N` oracle unmet · `L` locate-failed (aborted) · `A` action-failed ·
`T` taskError (run never executed — legend includes `T` per D4-M4; none occur this run).

| Task | B1 | B2 | O1 | O2 | O3 | O4 | O5 |
|---|---|---|---|---|---|---|---|
| settings-network | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-connected | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-apps | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-notifications | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-battery | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-storage | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-sound | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-display | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-network-internet | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-battery-then-back | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-open-page | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-heading-word | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-example-word | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-scroll-body | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-scroll-doc | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-settings-search | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-sound-noop | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-chrome-noop | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-display-slider | YYYYY | YYYYY | YYYYY | NYYYY | YYYYY | YYYYY | YYYYY |
| same-apps-noop | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |

(O2's single oracle-unmet is `same-display-slider` rep 1 — a config-neutral Display-slider
read, not a routing or rendering property.)

## Superseded D.4 numbers

| D.4 number | Why superseded |
|---|---|
| B1 82/100, "18 fails explained by the describe RENDERING under the shared policy" | D.4 ran WITHOUT the symmetric settle (B1 read the pre-transition source screen — D4-H1) and WITHOUT the parser split (collapsed labels blocked the exact-text tier — D4-H3). With both, **B1 = 100/100**. The 82 % was a harness artifact, not a capability or rendering property. |
| B1 `settings-network-internet` NNNNN "because the proprietary describe has no discrete Internet row" | The D.4 excerpt was the ROOT screen (D4-H1). After the settle, B1's step-2 describe reads the destination, which HAS a discrete `Internet / T-Mobile` row (`sg-matrix.log` line 29); B1 = **YYYYY**. |
| "O5-pure 47/47 = 100 %" | Removed (D4-H4: selection on the outcome). Only routing coverage (59/60) and the measured-RPC row are published. |
| "O5's failures are config-neutral Display flakiness" (95/100) | O5 = **100/100** here; its single divergence is `settings-connected` (fell back, passed), not Display. The D.4 Display divergences were under-settled transitions, removed by the settle (D4-M2). |
| B1 cluster interval [65, 97] with no published seed | Seed now published (`0x5eedc0de`); B1 [100, 100] this run. |
| store 11 nodes / 11 edges | This run **11 nodes / 10 edges** (max out-degree 9, mean 0.91); gate still 0/0 (run-to-run edge count varies with which revisits landed). |

## Acceptance check

| Criterion | Status |
|---|---|
| Same settle policy in both renderings, proven by `settleMs` in JSON for all configs | **PASS** — `settleScreen` after every non-launch action; settleMs p50 B1 2226 vs open ~1015 (B1 no longer under-waits) |
| Same parser tiers reachable in both renderings, proven by tests on verbatim artifact rows | **PASS** — D4-H3 split; 14/14 locate tests on verbatim rows (root + destination), no invented rows |
| B1's two-level outcome explained by the destination screen's quoted proprietary rendering | **PASS** — `sg-matrix.log` line 29: discrete `Internet / T-Mobile` row on the settled destination; B1 = YYYYY |
| Both same-code reference runs carried; no O5-pure; seed published; every M/L fix applied | **PASS** — §Same-code reproducibility; no O5-pure; seed `0x5eedc0de`; M1–M7/L1–L5 applied |
| Run green with the invariants gate; scoreboard untouched; `open/main` not fast-forwarded | **PASS** — gate green; `2026-09-03-scoreboard.md` untouched; no fast-forward |
| B1 metrics valid (fallbacks 0) | **PASS** — B1 console fallbacks 0 |

Open follow-ups (do not affect the bar): (1) the symmetric settle roughly doubles B1's
per-step wall wait (settleMs p50 2226 ms) because its describe-tree idle poll is slower
than the open `awaitChange`; the fixed pre-delay (`BENCH_SETTLE_FIXED_MS`, default 700 ms)
could be tuned down now that correctness is established — a latency-only concern, phase 3k.
(2) M7 device H_id stability stays UNVERIFIED until the Kotlin `ScreenHash.identity` test
lands (fixture `identityFixture` in the pre-flight artifact).
