# Adversarial review — screen-graph phase D / D.1 (run 33958064084)

Read-only review of `feat/screen-graph-d` @ `757956c57` and `feat/bench-ci-d` @
`77cd4b9a`, against `2026-09-03-screen-graph-results-ci.md`, the D ticket, the
C.4 findings, and the rules of evidence in `2026-09-03-review-3h-3i-c3.md`.
Evidence: CI artifacts of runs **33958064084** (D.1), **33947160117** (D),
**33806639520** (C.4), and the branch source. No device used.

## VERDICT: ACCEPT-WITH-CAVEATS

Every published per-config number reproduces **to the digit** from the run's own
JSON by an independent recompute (my script, not the harness). The routing fix is
real: 45/60 known-target taps routed, arrival verified by a live `queryPresent`
on a destination identity distinct from the oracle needle, 0 mis-lands. The
C.4 REJECT items (denominator chosen by outcome, shared-pair intersection,
fallback guard, nav counters before the exclusion skip) are genuinely closed.

What blocks a clean ACCEPT: one factual claim in the results doc is contradicted
by the run's own store (D1-H1), one published statistic is a hand-written model
rather than a measurement (D1-H2), and one stated statistic is simply wrong
(D1-M1). None of these overturn H1/H3/H4.

## HIGH

- **D1-H1 · "0 pollutant nodes" is false; the second `Internet` node is reached by a tap for a different screen.**
  `graph-store/com.android.settings/34.json` (run 33958064084) holds two nodes
  labelled `Network & internet: Internet`: `284ef0302b28c5de` (visits 88) and
  `b2fbe9151b60b485` (visits 3). Their `compact` is **byte-identical**, their
  `resourceIds` identical, their `stateHash` identical (`a8cb4ce0e8a2d028`) — yet
  H_id differs. Worse, the edges into `b2fbe915` are
  `Settings root --tap{text:"Network & internet"}--> b2fbe915` (count 1) and
  **`Settings root --tap{text:"Sound & vibration"}--> b2fbe915` (count 2)**; a
  third bad edge is `root --tap{text:"Network & internet"}--> root` (count 1).
  Results doc lines 100-105 and 188-190 call this "a residual `H_id` variant of
  one screen" and assert "0 pollutant nodes". The store says otherwise: this is a
  node minted by an unstable/early after-fingerprint that two different
  destinations landed on. **Fix:** withdraw "0 pollutant nodes"; restate the 15
  no-routes as caused by a mis-recorded transient node, and say the cause is a
  transition-timing race in the after-fingerprint, not scroll.
- **D1-H2 · "Honest RTT 2 per routed step" is a hand-written model that undercounts by ~3×.**
  `bench-screen-graph.ts:1288-1301` (`effectiveRttCount`) assigns a routed
  known-target tap `1 (navigate) + 1 (verify) = 2`. The recorded field is
  `rttCount: 1`. The real RPCs for a one-step route in
  `src/tools/navigate-to/index.ts` are `getState` (:379), `query` inside
  `resolveTapPoint` (:274 or :297), `tapWithOutcome` (:183), `getState` after
  (:450) — four — plus the bench's `await-screen-idle` and `queryPresent`
  (`bench-screen-graph.ts:725,728`). Wall clock agrees: O5 routed tap
  `actionRttMs` p50 **1919 ms** vs O4 locate+tap **1226 ms** (run 33958064084).
  O5's published "RTT count/step p50 = 1" and O5-pure "2" are therefore modelled,
  not measured. **Fix:** instrument the RPC count, or label the column "modelled
  logical RTT" and drop it from the scoreboard.

## MEDIUM

- **D1-M1 · "20 000 resamples" is wrong.** Results doc line 124 says 20 000;
  `bench-screen-graph.ts:1469` is `const BOOTSTRAP_B = 10_000`. The intervals are
  10 000-resample, seeded `0x5eedc0de`. Cosmetic for the verdicts, but it is a
  hand-typed number in a doc that claims to be regenerated from JSON.
- **D1-M2 · O4's 85→22 token drop is a store-shape effect, and the doc does not say so.**
  `describe-tiers.ts` is **unchanged** between `212d7d58` and `757956c57`
  (`git diff --stat` empty), so the summary renderer did not shrink. The step
  composition is also nearly unchanged (C.4 O4: graph-lookup 106 / none 45 /
  describe 4; D.1 O4: 106 / 47 / 2). What changed is the graph: the settings
  store went from **4 nodes / 26 edges, max out-degree 12** (C.4 33806639520) to
  **11 nodes / 20 edges, out-degree ~1.8** (D.1). `buildSummary`
  (`describe-tiers.ts:48-68`) lists up to 6 outgoing edges, so a finer graph
  yields a shorter summary. It is a real saving of the same kind of payload, not
  a shrunken observation format — but H3's 0.037× is a property of this store's
  shape and will move with graph density. **Fix:** state the mechanism and report
  out-degree alongside H3.
- **D1-M3 · The H_id unit tests validate a test-only host twin, not the device implementation that produced the store.**
  `identityHash` is defined in `src/utils/screen-hash.ts:164` and referenced
  **nowhere else in `src/`** — only by `test/screen-graph-screen-hash.test.ts`.
  The store's `idHash` comes from Kotlin `ScreenHash.identity` via
  `TreeStore.kt:136`; there is no Kotlin test for it in this branch. Ticket test
  (c) ("same sub-screen scrolled → same H_id",
  `screen-graph-screen-hash.test.ts:216`) passes on an authored fixture; the live
  instability in D1-H1 is a different cause and is not covered. The test header
  itself admits Battery/Sound/Display trees are authored, not captured, so test
  (b) is weaker than the ticket asked. **Fix:** drop "the H_id unit tests pass"
  as evidence that device H_id is stable; add a device-side or golden-tree test.
- **D1-M4 · Half of O5's runs never exercise navigate-to, and O5-pure is a task-level selection.**
  50 of 100 O5 runs contain no known-target tap at all (all 5 chrome tasks + all
  5 same-screen tasks); on those O5 is identical to O4. The 15 no-routes fall
  entirely on two tasks (`settings-network` 5, `settings-network-internet` 10),
  so "O5-pure = 40/40" is the same 18 tasks minus those two, and both excluded
  tasks passed anyway (per-task matrix, all `Y`). O5-pure 100 % [91,100] is
  therefore not evidence that routing improves success. **Fix:** label O5-pure as
  a task-level subset and stop pairing it with the mixed row as if it were an
  outcome-selected contrast.

## LOW

- **D1-L1 · One pre-flight needle passes without destination verification.**
  `logs/sg-preflight.log` (33958064084): `settings-display needle="Brightness
  level" :: ok (absent from launch; destination unreachable — presence NOT
  verified)`. `bench-preflight.ts:474-483` treats that case as `ok` by design.
  `PROBLEM needles: 0` is quoted in the doc without this exception. False-pass
  risk is low (the needle is absent from the launch screen), but C.4's C-M2 is
  19/20 closed, not 20/20 — and `settings-display` is one of the two tasks
  carrying nearly all the scattered failures.
- **D1-L2 · `isExcludedRun` can never fire.** `infraPreAction` (`oracle.ts:145`)
  is declared and read at `oracle.ts:158` but **never set** anywhere in `src/` or
  `scripts/`. The doc's "none occurred" is true by construction, not by
  observation. This is the behaviour the ticket wanted; say it that way.
- **D1-L3 · O3 is graph-blind, not cold-store.** `bench-screen-graph.ts:1069`
  (`config !== "O3"`) and `:2165` force O3 to ignore a store that other configs
  already populated. The code comment at `:2152` says so; the results doc calls
  O3 "cold" without it. H3 is warm-graph vs graph-blind, which is the intended
  contrast but should be labelled.
- **D1-L4 · Out-of-band recording costs device time that no published column shows.**
  Recording runs **inside** the awaited tap (`open-server-input.ts:265-292`:
  `getState` before, `recordOpenServerObservation` after, which itself issues
  `getInfo` + `fetchScreen` + an adb `versionCode` lookup). Its RPCs are excluded
  from `rttCount` by construction and produce no tokens, and its wall clock lands
  in `actionRttMs`, which the doc does not publish. Every open config's tap costs
  ~1.05 s more than B1's (D.1 p50: B1 180 ms, B2 1244, O1 1254, O2 1257, O3 1276,
  O4 1226). The D run shows B2 at 1110 ms with the same pattern, so most of that
  gap is the open server's outcome idle-wait, **not** recording — the split is
  unattributed from these artifacts. No published number is inflated; flag it
  before any wall-clock row enters the scoreboard.
- **D1-L5 · Tokens/step is observation payload, not the agent's locator.** For
  `settings-connected` / `-notifications` / `-storage`, O4's launch observation is
  the 110-token root summary whose top-6 affordances (sorted by count: Battery 75,
  swipe 60, Network 58, Apps 55, Sound 53, Display 46) **do not contain** the row
  the task then taps. The tap target comes from `locateNorm`
  (`bench-screen-graph.ts:430`), not from the observation. This is symmetric
  across configs (B1/B2 also locate by query), so H1/H3 stand, but "13× fewer
  tokens" means "13× smaller observation payload", not "solved with 13× less
  context". The artifact header already says "Per-step observation tokens"; the
  results doc's reading at line 131-134 should too.

## Checks that came back CLEAN

- Workflow (`feat/bench-ci-d`): the screen-graph job checks out the **branch
  head** (`ref: feat/screen-graph-d`), and both the pre-flight and matrix steps
  run `set -euo pipefail` with **no `continue-on-error`**. No hidden-failure
  void. (The `continue-on-error: true` at line 249 is the *other* job's
  open-server device smoke test, outside D/D.1 scope — but note it is back on
  that branch after 3h required it removed.)
- Tasks and needles are **identical** between C.4 (33806639520) and D.1: the set
  of `task=assertionNeedle` pairs compares equal. No config was advantaged by a
  task or needle change (`git diff 212d7d58..757956c57 -- bench-screen-graph.ts`
  touches no TASKS entry).
- One oracle for every config: `assertionObs = "query"` on 100/100 runs for
  B2/O1/O2/O3/O4/O5 and 98/100 for B1 (the 2 locate-failed runs), assertion
  tokens p50 41 everywhere. The oracle **does** read the live screen for O4/O5.
  B1's flag-flip cost is timed into `plumbingMs` (`bench-screen-graph.ts:986-1006`),
  outside every published metric, so B1 is not penalised by it.
- `fallbacks 0` for all seven configs (`logs/sg-matrix.log:174-195`) — B1's
  proprietary path was exercised; its metrics are valid under review HIGH-5.
- Routing cannot be faked: `strategy: "navigate"` requires `reached` **and** a
  live `queryPresent(navTarget)` (`bench-screen-graph.ts:725-740`); a fallback
  sets `strategy: "locate-tap"` and is excluded from O5-pure. No harness
  workaround found that lets a fallback count as routed.
- Fix A matches its description: `tappedSelectorFromTree`
  (`open-server-input.ts:74-90`) counts matches over the visible tree and sets
  `via` = id / text-or-cd / position; replay refuses unless exactly one live node
  matches (`navigate-to/index.ts:274-300`). All 20 stored edges carry `via`.
- Run-to-run robustness (D 33947160117 → D.1 33958064084), tokens/step o200k p50:
  B1 657→657, B2 627→627, O1 138→138, O2 54→54, O3 598→598, O4 21→22. Success:
  B1 98→98, B2 99→99, O1 98→99, O2 99→99, O3 99→97, O4 97→98, O5 62→99. Only O5
  moved beyond ±2. The C.4→D shift in **O1** (179→138) predates D.1 and is
  undocumented, so H1's exact ratio is not comparable across phases (0.285× at
  C.4, 0.220× at D and D.1); the ≤0.5× verdict holds in all three.
- The terminal-observation worry does not bite: recomputing tokens/step over
  **non-final steps only** gives O4 29 / O3 627 = 0.046× (vs 0.037× published)
  and O1 136 / B2 651 = 0.209× (vs 0.220×). H1 and H3 survive.

## Scoreboard-grade numbers

All from run **33958064084**, workflow `bench-open-vs-proprietary.yml`, bench
tree `feat/screen-graph-d` @ `757956c57`, 7 configs × 20 tasks × 5 reps,
`skipped: {}`, tokenizer js-tiktoken `o200k_base`. Independently recomputed from
`bench-sg-2026-09-05T09-35-41-230Z.json`; they match the harness `results-ci.md`
exactly. Required label on every token row: **per-step observation payload,
launch step excluded (n = 155 of 255 steps), oracle assertion query excluded.**

| Statistic | N | B1 | B2 | O1 | O2 | O3 | O4 | O5 |
|---|---|---|---|---|---|---|---|---|
| success, exclusions-as-failures | 100 runs | 98 | 99 | 99 | 99 | 97 | 98 | 99 |
| cluster bootstrap 95 %, n=20 tasks, B=10 000 | 20 | [94,100] | [97,100] | [97,100] | [97,100] | [92,100] | [95,100] | [97,100] |
| obs tokens/step o200k p50 | 155 | 657 | 627 | 138 | 54 | 598 | 22 | 29 |
| obs tokens/step o200k p95 | 155 | 4161 | 4510 | 515 | 515 | 4510 | 110 | 110 |
| obs tokens/step chars/4 p50 | 155 | 473 | 447 | 77 | 33 | 397 | 20 | 24 |
| obs RTT ms/step p50 | 155 | 503 | 90 | 4 | 3 | 87 | 44 | 46 |

- **O5 navigate-to, over all 60 attempted known-target taps:** routed **45**,
  mis-landed **0**, diverged-after-tap **0**, no-route **15** (ambiguous-target
  15, no-known-path 0), `recordSkippedNoIdHash` **0**. Accept as measured. All 15
  no-routes are the `Internet` navTarget on tasks `settings-network` (5) and
  `settings-network-internet` (10).
- **H1** — O1/B2 obs tokens/step o200k p50, n=155/155: **138/627 = 0.220×**,
  target ≤ 0.5×, **PASS**. Label: ratio is not stable across phases (0.285× at
  C.4 on the same O1 code path).
- **H2** — B2−O2 RTT-count/step p50: all steps **0**, **FAIL**; same-screen
  n=50/50 **1**, **PASS**. Accept both, reported honestly.
- **H3** — O4/O3 obs tokens/step o200k p50, n=153/155: **22/598 = 0.037×**,
  target ≤ 0.2×, **PASS**. Label: warm observation is a ≤6-affordance summary,
  cold is a full screen render; the ratio tracks graph out-degree (D1-M2).
- **H4** — paired task-cluster bootstrap of Δ = config − baseline, full 100
  denominator, B=10 000, inferior at >5 pp below: **no config inferior to B1 or
  B2**. vs B1: O1 +1 [−3,6], O2 +1 [−3,6], O3 −1 [−7,5], O4 +0 [−4,5],
  **O5 +1 [−3,6]**. vs B2: O1 +0 [−3,3], O2 +0 [−3,3], O3 −2 [−6,0],
  O4 −1 [−3,0], O5 +0 [−3,3]. Accept. Label: for O5 this is a low-power test of
  routing — 50 of its 100 runs contain no known-target tap (D1-M4).

## VOID / do not publish as written

- "The store carries **0 pollutant nodes**" — contradicted by the store's own
  edges (D1-H1). "0 nodes keyed by a structural hash" is separately true and can
  stand on its own.
- "On the ROUTED known-target taps the **honest count is 2**" and O5-pure
  "RTT-count/step p50 2" — modelled, not measured; understates the router's real
  RPCs by roughly 3× (D1-H2).
- "**20 000 resamples**" — the code does 10 000 (D1-M1).
- "the `H_id` unit tests pass" as evidence that **device** H_id is stable — the
  tests exercise a test-only host twin (D1-M3).
