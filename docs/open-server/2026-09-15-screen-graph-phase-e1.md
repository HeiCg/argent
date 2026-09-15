# Ticket: E-1 — template edges per scrollable container + bounded store, with a churn experiment

Derived from `## E-1 ticket proposal` in
`2026-09-15-screen-graph-phase-e-research.md` (the E-0 findings + design this
ticket implements). This file is the ticket AND the result log; the `## Result`
gates below were pre-registered BEFORE the run that grades them (house rule,
`README.md:116`).

## Goal

Make the graph's size independent of content states, and prove it on an app
whose content states are counted. Behind the `screen-graph` flag
(`packages/configuration-core/src/flags.ts:82`) plus `ARGENT_SG_TEMPLATES=1`, so
every D.4.1 arm can run unchanged in the same job (non-regression gate E1-G5).

## Scope (files)

| file                                                                                        | change                                                                                                                          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/tool-server/src/screen-graph/template.ts` (new)                                   | `containerKey`, `itemTemplate`, `templateNodeHash`, `destinationShape`, flat-list geometric containment resolver (D1 option B)  |
| `packages/tool-server/src/screen-graph/types.ts`                                            | `Edge.template?`, `ScreenNode.template?` / `instances?` / `volatility?`, template branch in `actionSignature`, `isNodeVolatile` |
| `packages/tool-server/src/screen-graph/store.ts`                                            | caps + LRU + pins + edge decay + volatility maintenance + referential integrity, all on `flush()`, gated by `enforceBounds`     |
| `packages/tool-server/src/screen-graph/plan.ts`                                             | `PlanStep.template`, `planToTemplate`                                                                                           |
| `packages/tool-server/src/screen-graph/describe-tiers.ts`                                   | template affordance line, `volatile` marker                                                                                     |
| `packages/tool-server/src/utils/screen-graph-open-wiring.ts` + `utils/open-server-input.ts` | resolve container/template at record time; write the template edge instead of the per-item edge when `ARGENT_SG_TEMPLATES=1`    |
| `packages/tool-server/src/tools/navigate-to/index.ts`                                       | template step: live `query` resolution + bounded in-container scroll + tolerant arrival + fail-closed                           |
| `packages/tool-server/scripts/bench-screen-graph.ts` + `src/screen-graph/bench/churn.ts`    | churn experiment (per-session store metrics, per-arm scoping, G-I1..G-I6), gated by `BENCH_CHURN=1`                             |
| `bench/churn-app/**` (new)                                                                  | minimal framework-only Gradle app: seeded feed, nested carousel, explosion + merge detail activities                            |
| `.github/workflows/bench-open-vs-proprietary.yml`                                           | `churn` input: build + install the churn app in the screen-graph job; `BENCH_CHURN=1`                                           |

## Template identity (as implemented)

Everything host-side, on the FLAT open-server tree (no hierarchy, E-0 §F7), so
containment is recovered GEOMETRICALLY (design D1 option B): an element belongs
to the SMALLEST scrollable whose bounds contain it, ties on the flat index.

- `containerKey = fnv1a( idHash · SC:<class>#<id> · ordinal )` — the feed's
  `H_id`, the container's `SC` token (the token `H_id` already folds,
  `screen-hash.ts:214`) and its ordinal among same-token siblings. Invariant
  under scroll / item count / refresh.
- `itemTemplate = fnv1a( classSeq(item) · sorted rid multiset(item) )` — text-
  and bounds-free; the rid multiset keeps a content row and an ad row two
  templates.
- `destinationShape = fnv1a( pkg · ID:* · RID:<non-scroll rids> · SC:<tokens> )` —
  `H_id` with the identity title replaced by `*`, so both F2 regimes (explosion,
  false merge) collapse to one shape.
- `templateNodeHash = fnv1a( "TPL" · containerKey · itemTemplate · destinationShape )`.

## Tests (unit)

`screen-graph-template.test.ts` (container identity stable across scroll /
refresh; two item shapes → two templates; destinationShape collapses titles;
nested-carousel containment; template node has no `stateHash` and never serves
`cache`; one edge folds every item tap; summary renders one template line),
`screen-graph-store-bounds.test.ts` (LRU keeps pinned / evicts unpinned;
eviction removes incident edges; edge ratio + staleness decay; volatility flips
and drops compact; bounds-off is unchanged), `screen-graph-navigate-template.ts`
(template step resolves after scroll, fails closed on ambiguous, gives up after
the budget; `planToTemplate` routes).

## CI

One run: `bench-open-vs-proprietary.yml`, `suite=screen-graph`, `sg_mode=matrix`,
`blocks=churn` (→ `BENCH_CHURN=1`). Both arms in the one job on the same device.

## Out of scope for E-1

Device-side container/template emission (option A, needs a server `versionCode`
bump and a latency re-measure); AW-app external validity (E-2); the `index`
describe tier; episodic per-item memory; any claim that template edges reduce
tokens/step; genuine nested-overlap carousel misattribution (the churn app's
carousel is a fixed header — non-overlapping — so the row/carousel attribution
is measured but the overlap stress is E-2).

## Result

Run: **34957934222** (`HeiCg/argent`, `bench-open-vs-proprietary.yml`,
`suite=screen-graph`, `sg_mode=matrix`, `blocks=churn`, branch
`feat/screen-graph-e1-templates` @ 9de873b8), job **conclusion success**. The
gates were pre-registered above BEFORE this run; the outcomes are read from
`churn.json` / `churn-results.md` / `sg-matrix.log` in the run artifact, never
blended with run 34801849653 (D.4.1) or 34870686468.

**Verdict: the template mechanism holds (E1-G1/G2/G4/G5 PASS), but two churn
HARNESS defects made E1-G3 fail 0/40. Both are fixed in commit ce4793b5; NOT
re-run — the planner decides on a second CI run.**

### First-run outcomes (run 34957934222)

- **E1-G1 PASS** — ON `churn=100` deltas k2..k5 = **+1 node / +0 edges** each
  (feed + one template node, then constant); OFF **+1n/+1e** each. (The OFF
  linear growth is smaller than the F5 worked example's +50 because a harness
  defect — below — let only item 0 be tapped; with the fix each session taps 8
  distinct items, so OFF grows ~+8n/+8e.)
- **E1-G2 PASS** — ON store **34 299 B** at K=5 (≤ 64 KB); OFF 34 047 B (also
  small for the same defect reason).
- **E1-G3 FAIL (0/40) — harness defects, fixed:** (1) the navigate arrival
  Jaccard compared the LIVE full rid multiset against the template node's
  `nonScrollRids`, so the decor `statusBar`/`navigationBar` ids dropped it to
  **7/9 = 0.78 < 0.9** ("tapped=true, reason=arrival" for ~38/40); (2) a detail
  `back` did not return to a queryable feed on this app/emulator, so the tap
  phase got stuck on the first detail and only ever tapped item 0 (edge
  `lastItemTexts` all "Story 0"; the item-0 detail node had `visits=50` from the
  scroll phase running on it). Fixes (ce4793b5): `executeTemplateStep` returns
  `nonScrollRids(after)` so arrival is compared like-for-like (regression test
  asserts Jaccard 1.0), and the churn tap/scroll phases RELAUNCH the feed (the
  nav phase's working pattern) instead of relying on `back`.
- **E1-G4 PASS** — ON `dupScreens=0 dupEdges=0 dangling=0 hygiene=0`, nodes 8,
  edges 1; OFF `duplicateEdgeTargets=1` (RECORDED — the stable-title/churning-
  detail control break, E-0 §F4). Job invariants line green (0 duplicate
  screens, 0 multi-destination edges) — the OFF store is outside the gated dir,
  so the per-arm scoping held.
- **E1-G5 PASS** — the D.4.1 matrix ran with templates OFF, unchanged: success
  B1/B2 100/100, O1 98, O2 99, O3 98, O4/O5 99 (~100 %, within the D.4.1 noise
  floor); tokens/step o200k p50 B1 657, B2 651, O1 **138**, O4 **21**
  (all inside the published floors O1 138–179, O4 20–22, B1/B2 657/651,
  `2026-09-13-screen-graph-phase-d4-results-ci.md:294-299`); settings store
  **11 nodes / 11 edges** (D.4.1 10–11 edge variance); invariants gate green;
  `skippedNoIdHash` 1.
- **E1-G6 DESCRIPTIVE** — feed summary tokens/step p50 ON ~23 vs OFF ~23 (the
  `topN=6` cap bounds both, as pre-registered).
- Containment audit: row taps attributed to `#list` 10/10 (0 misattributed);
  carousel taps 0/0 (the defect stopped the carousel tap from running).

Original pre-run gate table (outcomes appended from this run):

### Pre-registered gates (written before the run grades anything)

| gate  | statistic                                                    | pass condition                                                                                                                                                                                                | outcome                                                    |
| ----- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| E1-G1 | ON arm, `churn=100`: nodes/edges delta per session, k = 2..5 | ≤ 2 nodes and ≤ 4 edges per session (growth constant in content states); OFF arm reported beside it, expected linear (+ ~8n/+8e per session at 8 taps)                                                        | PASS (+1n/+0e/session)                                     |
| E1-G2 | ON arm store bytes at K = 5                                  | ≤ 64 KB; OFF arm recorded (expected linear in tapped content states)                                                                                                                                          | PASS (34 299 B)                                            |
| E1-G3 | ON arm `navigate-to` to off-screen items, n = 40 (8 × 5)     | ≥ 38/40 (non-inferiority margin 5 pp vs the D.4.1 O5 coverage 59/60 = 98.3 %, `2026-09-13-screen-graph-phase-d4-results-ci.md:88`); at n = 40 this detects gross failure only                                 | FAIL 0/40 — 2 harness defects, fixed ce4793b5 (not re-run) |
| E1-G4 | invariants G-I1..G-I6 on the ON arm                          | all green; the OFF arm's `duplicateEdgeTargets` is RECORDED, not gated (E-0 §F4)                                                                                                                              | PASS (OFF dupEdge=1 recorded)                              |
| E1-G5 | regression: the Settings/Chrome matrix with templates OFF    | store shape within the published variance (11 nodes / 10 edges, `...d4-results-ci.md:87,358`) and tokens/step p50 inside the published run-to-run floor (O1 138–179, O4 20–22, `...d4-results-ci.md:294-299`) | PASS (tokens+shape+invariants in-floor)                    |
| E1-G6 | summary tokens/step on the feed screen, ON vs OFF            | DESCRIPTIVE ONLY, never pass/fail — the `topN = 6` cap already bounds it (`describe-tiers.ts:41`)                                                                                                             | DESCRIPTIVE (ON~23 vs OFF~23)                              |

### Invariants added (checked per arm)

| id   | invariant                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| G-I1 | existing: `duplicateScreens() == []` (template nodes excluded — synthetic, keyed by construction)          |
| G-I2 | existing: `duplicateEdgeTargets() == []` — enforced on the ON arm, RECORDED on the OFF (control) arm       |
| G-I3 | bounded: `nodes <= 300`, `edges <= 600`, file bytes `<= 2 MB`                                              |
| G-I4 | referential integrity: every `edge.from` / `edge.to` exists in `nodes` (new failure mode created by LRU)   |
| G-I5 | template hygiene: every `template: true` node has no `stateHash`; every template edge has exactly one `to` |
| G-I6 | redaction unchanged: no `compact` persisted for a node holding a secret                                    |

Per-arm scoping (decided BEFORE the run, the hard constraint): the ON arm's
store persists into the gated graph dir (`checkStoreInvariants` enforces G-I2
there); the OFF (control) arm persists OUTSIDE it (`OUT_DIR/churn-off-graph`), so
its expected `duplicateEdgeTargets` break is recorded in `churn.json`, never fed
to the job-failing gate.
