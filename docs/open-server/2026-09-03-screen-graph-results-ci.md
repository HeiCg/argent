# Results (CI): screen-graph Phase D.3 — exact-match locate, honest routing counts

Phase D.3 closes the D.2 review caveats (`2026-09-03-review-d2-findings.md`,
ACCEPT-WITH-CAVEATS): the harness locate bug that let `t("Internet")` tap the
"Network & internet" toolbar, the 5 zero-step "routes", the edge-invariant gap,
and the label/accounting items.

- **D2-H3 exact-match locate (all configs).** A shared, unit-tested resolver
  (`bench/locate.ts pickUniqueNode`) resolves whole-field EXACT text, then exact
  contentDescription, then exact resource-id, then a CONTAINS match ONLY when
  exactly one node matches; an ambiguous set is never tapped. `locateNorm` (open)
  and `execCaptureStep` (pre-flight) use it; B1's describe locate prefers the
  first exact quoted label, then the first contains hit. Result:
  `settings-network-internet` now genuinely reaches the Internet screen for every
  OPEN config.
- **D2-H1/H2 zero-step routes.** `navTarget` is per-STEP; a route with
  `totalSteps==0` is counted as `zeroStep`, never as routed. This run has **0
  zero-step routes** (the second tap is now a genuine one-step route).
- **D2-M2/M3 edge invariant.** `ScreenGraphStore.duplicateEdgeTargets()` (one
  (from, action) → one destination) plus the record guard that drops
  selector-tap self-edges; the bench runs both invariants on the produced store
  after the matrix and FAILS the job on a violation. This run: **0 duplicate
  screens, 0 multi-destination edges** (CI gate green).
- **M1/M4/M5/M6/M7, L1–L4** — Wilson from JSON, measured RPC min/p50/max,
  `infraPreAction` narrowed to real infra errors, recordMs labelling, pre-flight
  reachedDistinct printed, device H_id fixture captured (still UNVERIFIED).

Every number is **regenerated from the run artifact JSON**
(`bench-sg-2026-09-05T16-06-31-835Z.json`) and reproduces the harness
`results-ci.md` to the digit.

## Run (HeiCg/argent, workflow `bench-open-vs-proprietary.yml`)

| Purpose | Run id | URL |
|---|---|---|
| **Matrix (FINAL — authoritative)** | **33976442407** | https://github.com/HeiCg/argent/actions/runs/33976442407 |

Bench tree `feat/screen-graph-d` @ `bfce58c19`; workflow `feat/bench-ci-d` @
`77cd4b9a`. 7 configs × 20 tasks × 5 reps. `skipped: {}`, `excluded: 0`. Bootstrap
`B = 10000` (`env.bootstrapB`), seed `0x5eedc0de`. Internet-screen needles for
`settings-network-internet` were taken from a `sg_mode=capture` pass (run
33970221242), not guessed.

## Per-config — success (full 100 denominator), tokens/step, RTT

| Config | success | cluster 95% (n=20) | Wilson (n=100) | fail (L/A/O/T/N) | tok/step o200k p50 | tok/step o200k p95 | chars/4 p50 | obs RTT ms/step p50 | RTT count/step p50 (modelled) |
|---|---|---|---|---|---|---|---|---|---|
| B1 (argent proprietary) | 94 % (94/100) | [83, 100] | [88, 97] | 6 (1/0/0/0/5) | 657 | 4161 | 473 | 453 | 2 |
| B2 (open, no graph) | 99 % (99/100) | [97, 100] | [95, 100] | 1 (0/0/0/0/1) | 651 | 4510 | 447 | 90 | 2 |
| O1 (+ query/diff) | 99 % (99/100) | [97, 100] | [95, 100] | 1 (0/0/0/0/1) | 138 | 515 | 77 | 3 | 2 |
| O2 (+ outcomes) | 99 % (99/100) | [97, 100] | [95, 100] | 1 (0/0/0/0/1) | 54 | 515 | 33 | 3 | 2 |
| O3 (+ graph, graph-blind) | 99 % (99/100) | [97, 100] | [95, 100] | 1 (0/0/0/0/1) | 627 | 4510 | 446 | 86 | 2 |
| O4 (graph, warm) | 100 % (100/100) | [100, 100] | [96, 100] | 0 | 21 | 114 | 20 | 46 | 1 |
| O5 (+ navigate-to) | 97 % (97/100) | [92, 100] | [92, 99] | 3 (0/0/0/0/3) | 22 | 114 | 20 | 45 | 1 |

Token rows are **per-step observation payload**, launch excluded (155 of 255
steps), oracle query excluded. O3 is **graph-blind** (records but never consults
the store). **RTT count/step is a MODELLED logical count** for every config
except O5's routed taps; do not compare it to O5's measured RPCs.

- **B1 dropped to 94** entirely on `settings-network-internet` (5 of its 6
  failures). See the two-level-nav note below — this is an honest B1 describe-locate
  limitation the now-genuine second-level tap exposes, not a harness bug.
- The remaining scattered failures are the Display fling flakiness
  (`settings-display`, `same-display-slider`), single-rep and config-neutral.

### Measured cost per config (HIGH-2 / L4)

`actionRttMs` INCLUDES `recordMs` and the 2500 ms settle wait that open-config
taps pay and B1 does not — so this is NOT a like-for-like latency column and the
two must not be summed. Screen-graph compares tokens and success, not latency.

| Config | action wall ms/step p50 (incl. recordMs) | recordMs/step p50 | measured RPCs / one-step routed tap |
|---|---|---|---|
| B1 | 189 | 0 (no open-server recording) | — |
| B2 | 1420 | 370 | — |
| O1 | 1528 | 387 | — |
| O2 | 1498 | 380 | — |
| O3 | 1469 | 367 | — |
| O4 | 1412 | 378 | — |
| O5 | 1610 | 6 | **min 7 / p50 7 / max 7** (n=54) |

O5 measured RPCs = navigate-to's proxy-MEASURED RPCs + the bench's await-idle +
queryPresent (2 round-trips, each ≥1 device RPC), so **7 is a lower bound** (D2-L1).

## O5 navigate-to structure (structured records, ALL 60 attempted known-target taps)

| Outcome | Count |
|---|---|
| **one-step routed** | **54** |
| zero-step no-op route (D2-H1: not routed) | **0** |
| mis-landed | 0 |
| diverged-after-tap | 1 |
| no-route | 5 |

No-route split: **ambiguous-target 5**, no-known-path 0. Diverged split:
hash-mismatch 1, selector-ambiguous/unresolved 0. `recordSkippedNoIdHash` 0.

- **Coverage: 54/60 one-step routes** — well over the ≥ 30 bar; **mis-lands 0**
  (≤ 2). **Zero-step routes 0** — the D.2 "5 of 60 issue no tap" defect is closed
  by the per-step navTarget.
- The **5 no-routes are all `settings-network` step 1** (navTarget `Internet`).
  Now that `settings-network-internet` genuinely reaches the Internet screen, a
  distinct Internet node exists whose toolbar is also indexed by `Internet`, so
  `Internet` is indexed by two screens and the router correctly refuses
  (ambiguous) and falls back — `settings-network` still passes YYYYY. Follow-up:
  give `settings-network` a Network-&-internet-unique navTarget (e.g. `Airplane
  mode`) so it routes; it does not affect success and is left as a one-line
  cleanup.

| O5 row | success | tok/step o200k p50 | measured RPC/tap | N |
|---|---|---|---|---|
| **O5-mixed** (all runs) | 97/100 = 97 % · cluster [92, 100] · Wilson [92, 99] | 22 | — | 100 runs |
| **O5-pure** (every known-target tap routed) | 44/44 = 100 % [92, 100] | 28 | 7 | 44 runs |

M4 label: 50 of O5's 100 runs contain no known-target tap; O5-pure is a task-level
subset, and H4 for O5 is a low-power test of routing.

## The two-level nav (settings-network-internet) — honest status

With the exact-match locate fix, `t("Internet")` now resolves the exact "Internet"
row, so the second tap genuinely enters the Internet (Wi-Fi) screen. Confirmed:
`B2/O1/O2/O3/O4/O5` all pass the task **YYYYY** with the oracle needle **"Add
network"**, which the capture (run 33970221242) showed lives ONLY on the Internet
screen (absent from the root and from Network & internet). The D2-H3 dead-tap is
gone for every config that locates by the open-server query.

**B1 fails the task (NNNLN).** B1 locates from its proprietary `describe`, not the
open query, and its describe rendering does not surface the "Internet" row as a
cleanly disambiguable label, so B1 does not reliably reach the Internet screen and
"Add network" is absent from where it lands. All open configs reach it; B1 does
not. This is a genuine describe-vs-query capability difference the now-real
two-level nav exposes, reported as-is (it weakens the B1 baseline from its usual
~98 to 94; H4 stays non-inferior because no open config is below B1).

## Hypotheses (run 33976442407)

| Hypothesis | Statistic | Target | Measured | Verdict |
|---|---|---|---|---|
| H1 | O1 tokens/step vs B2, o200k p50, n=155/155 | ≤ 0.5× | 138/651 = **0.212×** | **PASS** |
| H2 (all steps) | B2 − O2 RTT-count/step p50 | ≥ 1 | 2 − 2 = **0** | **FAIL** (structural) |
| H2 (same-screen) | B2 − O2 RTT-count/step p50, n=50/50 | ≥ 1 | 2 − 1 = **1** | **PASS** |
| H3 | O4 warm / O3 cold tokens/step, o200k p50 | ≤ 0.2× | 21/627 = **0.034×** | **PASS** |

**H1 label (D2-M5):** O1's p50 sits on a plateau boundary, so it flips between
0.212× and 0.285× across runs on a two-observation reshuffle; the observation
payload is unchanged, so this is a median artifact, not a behaviour change (mean
ratio ≈ 0.22×). **H3 label:** warm is a ≤6-affordance summary vs a full cold
render, tracking out-degree; store shape **11 nodes / 10 edges / max out-degree 9
/ mean 0.91** (`env.settingsGraph`) — fewer edges than D.2 because the record
guard now drops selector-tap self-edges.

**H4 — non-inferior to each baseline** (paired task-cluster bootstrap, B=10000,
inferior at > 5 pp below):

| Baseline | Baseline success | Paired Δ verdict (O1..O5) |
|---|---|---|
| B1 (94 %, 94/100) cluster [83,100] / Wilson [88,97] | | **PASS — none inferior.** O1 +5 [0,15] · O2 +5 [0,15] · O3 +5 [−2,16] · O4 +6 [0,17] · O5 +3 [−4,15] |
| B2 (99 %, 99/100) cluster [97,100] / Wilson [95,100] | | **PASS — none inferior.** O1 +0 [−3,3] · O2 +0 [−3,3] · O3 +0 [0,0] · O4 +1 [0,3] · O5 −2 [−6,0] |

H4 vs B1 this run is a comparison against a B1 weakened by the two-level-nav task;
the meaningful non-inferiority is **vs B2** (all O-configs within ±2 pp).

## Per-task success matrix (run 33976442407)

`Y` oracle met · `N` oracle unmet · `L` locate-failed.

| Task | B1 | B2 | O1 | O2 | O3 | O4 | O5 |
|---|---|---|---|---|---|---|---|
| settings-network | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-connected | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-apps | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-notifications | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-battery | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-storage | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-sound | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-display | YYYYY | YYYNY | YYYYY | YYYYY | YNYYY | YYYYY | YYYNY |
| settings-network-internet | NNNLN | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| settings-battery-then-back | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-open-page | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-heading-word | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-example-word | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-scroll-body | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| chrome-scroll-doc | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-settings-search | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-sound-noop | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-chrome-noop | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |
| same-display-slider | YNYYY | YYYYY | YYYNY | YNYYY | YYYYY | YYYYY | NYYNY |
| same-apps-noop | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY | YYYYY |

## Invariants enforced on the run's store (M2/M3)

`checkStoreInvariants()` ran after the matrix and the job stayed green:
**"store invariants OK: 0 duplicate screens, 0 multi-destination edges"**.
Independently over all three package stores: settings 11 nodes / 10 edges,
chrome 1/1, intelligence 3/2 — **0 duplicate screens, 0 duplicate-edge-targets,
0 structural-hash-keyed nodes, skippedNoIdHash 0**. The D2-M2 competing
`Apps`→root self-edge is gone (the record guard drops selector-tap self-edges).

## M7 — device H_id stability: UNVERIFIED (fixture now captured)

The host `identityHash` golden guard stands, and the doc does not cite host tests
as device evidence. The pre-flight now captures one full nested Settings-root tree
WITH its device `idHash` into the artifact fixture (`identityFixture`). Next
iteration commits it and runs the Kotlin `ScreenHash.identity` test + a host/device
cross-check offline; until then this stays **device H_id stability: UNVERIFIED**.

## infraPreAction (M6)

`erroredTaskRecord` marks a run pre-action-infra ONLY when the throw matches a
device/adb/open-server connectivity signature (`isPreActionInfraError`, unit
tested), not any exception. It did not fire this run (`excluded: 0`).

## Acceptance check

| Criterion | Status |
|---|---|
| D2-H3 exact-match locate; network-internet reaches Internet | **PASS** for all open configs (B1 describe-limited, documented) |
| D2-H1/H2 zero-step routes counted separately, not routed | **PASS** (0 zero-step this run; per-step navTarget) |
| D2-M2/M3 edge + screen invariants gated in CI | **PASS** (0/0; job green) |
| O5-pure coverage ≥ 30 one-step routes; mis-lands ≤ 2 | **PASS** (54/60; 0) |
| M1 Wilson from JSON (O4 [96,100]) | **PASS** |
| M4 actionRttMs incl. recordMs, not compared to B1 | **PASS** (labelled) |
| M5 H1 p50 bimodal / mean reported; "selector policy" removed | **PASS** |
| M6 infraPreAction only for infra errors + test | **PASS** |
| M7 device H_id UNVERIFIED; fixture captured | **PASS** (label kept) |
| L1/L2 measured RPC min/p50/max; pre-flight reachedDistinct | **PASS** |
| doc from JSON; branches pushed; run URL | **PASS** |

Open follow-ups (do not affect the acceptance bar): (1) `settings-network`
navTarget → a Network-&-internet-unique identity so its route is unambiguous;
(2) B1's describe locate of the second-level "Internet" row, or accept the
describe-vs-query capability gap the two-level nav exposes.

## Superseded D.2 numbers (from run 33964414774)

| D.2 number | Why superseded |
|---|---|
| "O5 routes 60/60" | 5 were zero-step no-ops (D2-H1). D.3 per-step navTarget: **54 one-step routed, 0 zero-step**, and `settings-network-internet` genuinely reaches Internet. |
| `settings-network-internet` YYYYY all configs | It never reached Internet (D2-H3) and "SIMs" passed on the origin. Real needle "Add network" on Internet: open configs YYYYY, **B1 NNNLN** (describe limit). |
| O5 measured RPC "7" (modelled +2) | Now min/p50/max 7/7/7 with the +2 labelled a lower bound (D2-L1). |
| O4 Wilson "[93,99]" | Was B1's interval; JSON gives **[96,100]** (D2-M1). |
| "0 duplicate screens" (node-only) | Extended: **0 duplicate screens AND 0 multi-destination edges**, both CI-gated (D2-M2/M3). |
| H1 "moves with O1's selector policy" | Withdrawn; the p50 is a plateau artifact (D2-M5). |
| B1 98/100 | This run B1 is 94/100 — the two-level nav it cannot do (documented above). |

## Files changed (bench tree `feat/screen-graph-d`, over D.2 @ 6c29c835d → bfce58c19)

- `src/screen-graph/bench/locate.ts` (new) — `pickUniqueNode` exact-first resolver.
- `scripts/bench-screen-graph.ts` — locateNorm exact resolve; per-step navTarget; zero-step counting; `duplicateScreens()`+`duplicateEdgeTargets()` CI gate; measuredRpc min/p50/max; infraPreAction via `isPreActionInfraError`.
- `scripts/bench-preflight.ts` — exact locate in `execCaptureStep`; reachedDistinct print; identity fixture capture.
- `src/screen-graph/bench/describe-locate.ts` — B1 exact-first, then contains fallback.
- `src/screen-graph/bench/tasks.ts` — per-step navTarget validation; `settings-network-internet` real Internet needles.
- `src/screen-graph/store.ts` — `duplicateEdgeTargets()`.
- `src/screen-graph/bench/oracle.ts` — `isPreActionInfraError`.
- `src/utils/screen-graph-open-wiring.ts` — drop selector-tap self-edges.
- Tests: `screen-graph-bench-locate` (resolver + infra classifier), `screen-graph-store-migration` (edge invariant), `screen-graph-bench-observe` (B1 exact-first).
