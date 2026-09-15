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
`churn=true` (→ `BENCH_CHURN=1`). Both arms in the one job on the same device.

## Out of scope for E-1

Device-side container/template emission (option A, needs a server `versionCode`
bump and a latency re-measure); AW-app external validity (E-2); the `index`
describe tier; episodic per-item memory; any claim that template edges reduce
tokens/step; genuine nested-overlap carousel misattribution (the churn app's
carousel is a fixed header — non-overlapping — so the row/carousel attribution
is measured but the overlap stress is E-2).

## Result

Run: **PENDING** — `bench-open-vs-proprietary.yml`, `suite=screen-graph`,
`sg_mode=matrix`, `churn=true`. This section is pre-registered BEFORE the run;
the outcomes column is filled from `churn-results.md` / `churn.json` /
`sg-matrix.log` in the run artifact and the invariants line, never blended with
run 34801849653 (D.4.1) or 34870686468 (`README.md:108-117`).

### Pre-registered gates (written before the run grades anything)

| gate  | statistic                                                    | pass condition                                                                                                                                                                                                | outcome |
| ----- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| E1-G1 | ON arm, `churn=100`: nodes/edges delta per session, k = 2..5 | ≤ 2 nodes and ≤ 4 edges per session (growth constant in content states); OFF arm reported beside it, expected linear (+ ~8n/+8e per session at 8 taps)                                                        | PENDING |
| E1-G2 | ON arm store bytes at K = 5                                  | ≤ 64 KB; OFF arm recorded (expected linear in tapped content states)                                                                                                                                          | PENDING |
| E1-G3 | ON arm `navigate-to` to off-screen items, n = 40 (8 × 5)     | ≥ 38/40 (non-inferiority margin 5 pp vs the D.4.1 O5 coverage 59/60 = 98.3 %, `2026-09-13-screen-graph-phase-d4-results-ci.md:88`); at n = 40 this detects gross failure only                                 | PENDING |
| E1-G4 | invariants G-I1..G-I6 on the ON arm                          | all green; the OFF arm's `duplicateEdgeTargets` is RECORDED, not gated (E-0 §F4)                                                                                                                              | PENDING |
| E1-G5 | regression: the Settings/Chrome matrix with templates OFF    | store shape within the published variance (11 nodes / 10 edges, `...d4-results-ci.md:87,358`) and tokens/step p50 inside the published run-to-run floor (O1 138–179, O4 20–22, `...d4-results-ci.md:294-299`) | PENDING |
| E1-G6 | summary tokens/step on the feed screen, ON vs OFF            | DESCRIPTIVE ONLY, never pass/fail — the `topN = 6` cap already bounds it (`describe-tiers.ts:41`)                                                                                                             | PENDING |

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
