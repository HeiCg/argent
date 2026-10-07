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

Final result: **run 5 (37600322190)**, the E-1.1 rerun after the adversarial
review of run 4 (`2026-10-07-review-e1-findings.md`). Runs 1 to 4 are kept below
for the record.

### Run 5 (37600322190), final

Run **37600322190** (`HeiCg/argent`, `bench-open-vs-proprietary.yml`,
`workflow_dispatch`, `suite=screen-graph`, `sg_mode=matrix`, `blocks=churn`),
branch `feat/screen-graph-e1-templates` @ `03dab1e3`, 2026-10-07 (job started
09:23:55Z). Emulator 36.4.10.0 (build 15004761, pinned), sysimg
`android-34;google_apis;x86_64` r14, gpu `swiftshader_indirect`, runner image
20260927.320.1, device server APK 0.1.24 (versionCode 28). Job conclusion
**success**. Outcomes are read from this run's artifact only (`churn-results.md`,
`churn.json`).

Churn setup: `com.argent.churnapp`, items=50, sessions=5, taps/session=8,
scrolls/session=10. New in E-1.1: an OFF-nograph arm that runs the same
scroll-and-exact-text search with no store and no template; arrival checked on
the detail headline (`Headline <seed>-<target>`) plus the layout; matching
scoped to the template's container and routed by the requested item; per-attempt
wall time and per-swipe device timing; 4 deliberately absent targets; presence
observed by a sweep instead of taken from the app model; E1-G5 graded in code.

Gates, verbatim from `churn-results.md`:

| gate          | statistic                                                       | verdict           | detail                                                                                                                       |
| ------------- | --------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| E1-G1         | store growth per session (ON, churn100)                         | PASS              | ON [k2: +0n/+0e, k3: +0n/+0e, k4: +0n/+0e, k5: +0n/+0e] (<= 2n/4e); OFF [k2: +9n/+9e, k3: +9n/+9e, k4: +9n/+9e, k5: +9n/+9e] |
| E1-G2         | store bytes at K=5 (ON)                                         | PASS              | ON 23300 B (<= 65536); OFF 203334 B                                                                                          |
| E1-G3         | template-step search reliability (ON)                           | PASS              | ON present-only 37/37 (bar 36/37 = 38/40); raw 40/40; vs OFF-nograph 37/37                                                   |
| E1-G3-nograph | same search without store or template (OFF-nograph, comparator) | PASS (comparator) | OFF-nograph present-only 37/37 (bar 36/37 = 38/40); raw 40/40                                                                |
| E1-G4         | invariants G-I1..G-I6 (ON)                                      | PASS              | ON dupScreens=0 dupEdges=0 dangling=0 hygiene=0 nodes=3 edges=2; OFF dupEdgeTargets=9 (recorded, not gated)                  |
| E1-G5         | D.4.1 matrix non-regression (templates OFF)                     | PASS              | store 10n/9e in 10-11n/9-11e; O1 179 in 138-179; O4 21 in 20-22 (pre-registered, 2026-09-15-screen-graph-phase-e1.md)        |
| E1-G6         | feed summary tokens/step, ON vs OFF                             | DESCRIPTIVE       | mean of per-session p50s: ON ~82 vs OFF ~111 (descriptive; cap-bound, topN=6 caps both)                                      |

Template-step search, ON vs OFF-nograph (same targets, same sessions, same
relaunch; the 4 absent probes excluded), verbatim from `churn-results.md`:

| arm         | present ok / present | raw ok / attempts | wallMs p50 / max    | swipeMs p50 / max   | deliveredMs p50 / max | attempts with gaps | scrolls p50 / max |
| ----------- | -------------------- | ----------------- | ------------------- | ------------------- | --------------------- | ------------------ | ----------------- |
| ON          | 37/37                | 40/40             | 8704 / 37128 (n=40) | 1011 / 1760 (n=216) | 277 / 387 (n=216)     | 39/40              | 4 / 22 (n=40)     |
| OFF-nograph | 37/37                | 40/40             | 8907 / 31926 (n=40) | 1028 / 1770 (n=207) | 277 / 338 (n=207)     | 39/40              | 4 / 18 (n=40)     |

Totals over the 40 attempts per arm (absent probes excluded): ON 216 swipes with
81 gaps (38 %), reversals in 11/40; OFF-nograph 207 swipes with 86 gaps (42 %),
reversals in 9/40. Run 4 had 90 gaps over 204 swipes (44 %).

#### Reading

- **The template step's search reliability equals the no-graph search.** ON
  37/37 present-only and 40/40 raw; OFF-nograph the same, with the same median
  wall time (8704 vs 8907 ms). The template edge decides which container to
  search and which detail layout to expect; it does not make the search find the
  row more often.
- **E-1's demonstrated benefit is the bounded store and the non-regression.**
  E1-G1: +0 nodes / +0 edges per session ON against +9n/+9e OFF. E1-G2: 23 300 B
  against 203 334 B at K=5. E1-G5: with templates OFF the D.4.1 matrix stays in
  its pre-registered range (store 10n/9e, O1 179, O4 21), now graded in code.
- **Navigation speed is not improved by templates.** A navigation takes 8.7 s at
  the median (37 s worst case) on both arms. The time goes to scrolling and
  reading: median 4 scrolls, each a ~1 s swipe RPC plus at least two settled
  container reads. The graph plays no part in that loop.
- **The swipe still skips rows.** 39/40 attempts recorded at least one gap on
  both arms, and targets 32 to 39 are reached in a median 4 scrolls, fewer than a
  drag-only scroll needs (run 2 estimate: ~819 px per drag, Story 39 at 7). The
  search succeeds because it turns around and re-scans, not because the swipe
  stopped flinging. See open defect D1 below.
- **Absent targets cost ~49 s.** Each of the 4 deliberately absent probes ran to
  the 30-scroll cap: give-up wall time p50 / max 49 254 / 50 320 ms ON and
  49 395 / 50 782 ms OFF-nograph, `swept` 0/4 on both arms. The search stops
  early only after a gap-free end-to-end pass, and with gaps in nearly every
  attempt that pass never happens.
- Presence sweeps observed 48, 50, 45, 48 and 50 of 50 rows (none completed a
  gap-free pass). Session 3 missed rows 34 to 36, so its targets 34 to 36 count as
  not present: hence 37 present targets, while all 40 were reached (raw 40/40).
- Containment audit: row taps attributed to `#list` 80/80 (0 misattributed),
  carousel taps to `#carousel` 10/10.

#### Open defect D1: the held swipe still moves more than one drag

Numbers (run 37600322190): gaps in 39/40 attempts on both arms; 81/216 (ON) and
86/207 (OFF-nograph) swipes with a gap; swipe RPC p50 1011 / 1028 ms;
`deliveredMs` p50 277 ms, min 271 ms, max 387 ms (ON) / 338 ms (OFF-nograph);
absent-target give-up ~49 s, `swept` 0/8. APK 0.1.24 was installed (it is the
first APK that reports `deliveredMs`).

Code check (read-only, 2026-10-07). `deliveredMs` is the device-clock span from
the first DOWN's `eventTime` to the final UP's `eventTime`
(`MotionInjector.inject`, `HoldAnchor.spanMs(firstDownAt, upAt)`). Each
`eventTime` is taken just before that event is dispatched, so it is DOWN-to-UP
send time: it includes the hold but not the synchronous dispatch of the final
UP. The held path is taken for the template scroll: `scrollContainer` sends
`steps: 19, holdEndMs: 120` (`navigate-to/index.ts:396-397`, `:575-582`), the
blueprint forwards `holdEndMs` when > 0, and `SwipeHandler.execute` routes
`holdEndMs > 0` to `injectHeldSwipe` with `holdAnchorFrame = travelSteps`. The
held path paces frames at a fixed 8 ms (`STEP_MS`), so the schedule is 19 × 8 =
152 ms of travel plus 15 × 8 = 120 ms of hold, **272 ms DOWN to UP**, not
250 + 120 ms. The flinging path would schedule 19 × 16 = 304 ms. Observed
`deliveredMs` is 272 to 273 ms in 191 of the 663 swipes in `churn.json` and
277 ms at the median, so the gesture is injected on schedule with the full
120 ms hold on the injector's clock. The anchor only adds delay after a late
travel frame, which accounts for the tail up to 387 ms. `deliveredMs` therefore
does not show the hold collapsing at injection. The previous suspect (late
frames sent back to back collapse the hold, run 3 diagnosis) does not explain
the skipping in this run. What the app receives is not measured: `heldMs` comes
back in the swipe reply but the host does not record it (`SwipeTiming` has no
`heldMs`), the intermediate MOVEs are dispatched async, and the app's input
consumer batches by frame. The open question is why a list that receives a
120 ms stationary tail before the UP still moves more than the drag on this
emulator.

#### Review findings (`2026-10-07-review-e1-findings.md`)

| finding                                                            | state  | where                                                                                             |
| ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------- |
| 1 G5 labelled descriptive                                          | closed | graded in code, PASS (gate table above)                                                           |
| 2 G3 measures the search, not the edge                             | closed | OFF-nograph comparator arm; G3 renamed "template-step search reliability"; result: equal (37/37)  |
| 3 arrival accepts any detail page                                  | closed | headline check, container-scoped match, routing by the requested item                             |
| 4 momentum-free scroll still flings                                | open   | wall time now logged; device fling not fixed (D1 above)                                           |
| 5 present-only grading inert                                       | closed | presence observed by a sweep per session                                                          |
| 6 churn app lacks insert/delete/reorder, no eviction exercised     | open   | E-2                                                                                               |
| 7 G6 cap-bound, "p50" is a mean of per-session p50s                | open   | relabelled in the gate detail; still cap-bound and descriptive                                    |
| 8 flag check in `navigate-to`, byte check on every flush           | closed | template route behind `ARGENT_SG_TEMPLATES` (`bcdb3ff7`); byte check near a cap only (`02b59662`) |
| 8 NUL bytes in `store.ts`, `lastItemTexts` persists item text (R5) | open   | not addressed; pinned template nodes and the `results-ci.md` `[object Object]` not rechecked      |
| 9 tests pin numbers CI contradicts                                 | closed | tests updated                                                                                     |

#### What this proves and does not prove

On the churn app, one emulator image and N=5 sessions, template edges keep the
store constant in content states and the D.4.1 matrix does not regress with
templates OFF. Navigation through a template step is as reliable as a plain
scroll-and-text search and no faster. Nothing here claims a navigation speed or
a tokens/step win from templates. It does not cover a real app (E-2), another
emulator or a physical device, rows that are inserted, deleted or reordered, or
store eviction (3 nodes against a 300 cap). n=40 detects gross failure only.

### Run 4 (37584222236)

Run **37584222236** (`HeiCg/argent`, `bench-open-vs-proprietary.yml`,
`workflow_dispatch`, `suite=screen-graph`, `sg_mode=matrix`, `blocks=churn`),
branch `feat/screen-graph-e1-templates` @ `c0851a9f`, 2026-10-07 (job started
07:03:13Z). Emulator 36.4.10.0 (build 15004761, pinned), sysimg r14, gpu
`swiftshader_indirect`, runner image 20260927.320.1; proprietary comparator
`@swmansion/argent@0.27.0`. Job conclusion **success**; the harness exits with
`process.exitCode`, so a gate FAIL would have turned it red. Outcomes are read
from this run's artifact only (`churn-results.md`, `churn.json`,
`results-ci.md`, `bench-sg-2026-10-07T07-03-18-485Z.json`, `sg-matrix.log`,
`graph-store/`).

Churn setup: `com.argent.churnapp`, items=50, sessions=5, taps/session=8,
scrolls/session=10.

Gates, verbatim from `churn-results.md`:

| gate  | verdict     | detail                                                                                                                       |
| ----- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| E1-G1 | PASS        | ON [k2: +0n/+0e, k3: +0n/+0e, k4: +0n/+0e, k5: +0n/+0e] (<= 2n/4e); OFF [k2: +9n/+9e, k3: +9n/+9e, k4: +9n/+9e, k5: +9n/+9e] |
| E1-G2 | PASS        | ON 23299 B (<= 65536); OFF 203333 B                                                                                          |
| E1-G3 | PASS        | present-only 40/40 (bar 38/40 = 38/40); raw 40/40; D.4.1 O5 baseline 59/60                                                   |
| E1-G4 | PASS        | ON dupScreens=0 dupEdges=0 dangling=0 hygiene=0 nodes=3 edges=2; OFF dupEdgeTargets=9 (recorded, not gated)                  |
| E1-G5 | DESCRIPTIVE | D.4.1 matrix (templates OFF) non-regression — see the run's settingsGraph + tokens                                           |
| E1-G6 | DESCRIPTIVE | feed summary tokens/step p50: ON ~82 vs OFF ~111 (descriptive; topN=6 caps both)                                             |

Every navigate-to target was present (40/40 by the app's row model), so the
present-only grading added after run 3 and the raw count agree: 40/40 either
way. Containment audit: row taps attributed to `#list` 80/80 (0 misattributed),
carousel taps to `#carousel` 10/10.

#### Per-attempt scroll distribution (navigate-to, churn100, n = 5 per target)

min / median / max over the 5 sessions. `feed ready` is the harness wait until
the feed shows `Story 0`. No attempt ended in a sweep (`swept` 0/40).

| target   | scrolls    | reversals | gaps      | feed ready ms   |
| -------- | ---------- | --------- | --------- | --------------- |
| Story 32 | 3 / 4 / 5  | 0 / 0 / 0 | 0 / 1 / 2 | 290 / 345 / 492 |
| Story 33 | 2 / 3 / 4  | 0 / 0 / 0 | 0 / 2 / 2 | 131 / 324 / 392 |
| Story 34 | 2 / 3 / 5  | 0 / 0 / 0 | 1 / 2 / 2 | 246 / 422 / 483 |
| Story 35 | 3 / 5 / 8  | 0 / 0 / 1 | 0 / 3 / 4 | 273 / 332 / 471 |
| Story 36 | 4 / 4 / 20 | 0 / 0 / 2 | 1 / 2 / 8 | 220 / 454 / 517 |
| Story 37 | 3 / 4 / 6  | 0 / 0 / 0 | 1 / 1 / 3 | 146 / 449 / 472 |
| Story 38 | 3 / 7 / 20 | 0 / 0 / 2 | 2 / 4 / 5 | 275 / 364 / 445 |
| Story 39 | 4 / 4 / 6  | 0 / 0 / 1 | 2 / 2 / 4 | 299 / 368 / 402 |
| all 40   | 2 / 4 / 20 | 0 / 0 / 2 | 0 / 2 / 8 | 131 / 367 / 517 |

Totals: 204 scrolls over 40 attempts; 90 gaps, in 37/40 attempts; reversals in
5/40 attempts (s2 Story 39, s3 Story 35, s3 Story 38, s4 Story 38, s5 Story
36). The two 20-scroll attempts (s3 Story 38, s5 Story 36) each reversed twice
and still resolved.

#### What changed between run 3 and run 4

Run 3 ran at `93cbf758`: held, momentum-free swipe (19 steps, 120 ms hold),
down-only search, end of list on two `changed:false` outcomes in a row, cap 30.
Run 4 ran at `c0851a9f`, the only commit between the two runs. It keeps the
held swipe and changes the search around it:

- Bidirectional search: scroll down until the list stops moving, turn around,
  keep going between the two ends until the item resolves, a gap-free end-to-end
  pass (`swept`), or the 30-scroll cap.
- Screen-based move detection: after each swipe the step reads the container's
  visible texts until two consecutive reads agree (at most 5 reads, 150 ms
  apart) and compares that window with the one before the swipe. A moved window
  sharing no text with the previous one is a gap. The server's `changed` is a
  fallback for a container with no readable text.
- Feed-ready wait: the harness waits up to 6 s for `Story 0` before each nav
  attempt (observed 131 to 517 ms).
- Telemetry: `reversals`, `gaps`, `swept`, `targetPresent`, `feedReadyMs` per
  attempt.

Run 3 missed 10/40, all `selector unresolved`. Run 4 missed 0/40.

#### E1-G5: templates-OFF matrix vs the D.4.1 baseline

The harness does not grade E1-G5; the numbers below are read from
`results-ci.md` and the run JSON (`env.settingsGraph`) and compared with the
D.4.1 run 34801849653 and the pre-registered floors.

| metric                       | run 37584222236                                    | D.4.1 (34801849653)          | pre-registered floor / published range                      |
| ---------------------------- | -------------------------------------------------- | ---------------------------- | ----------------------------------------------------------- |
| success (n=100 each)         | B1 100, B2 98, O1 100, O2 99, O3 100, O4 99, O5 99 | all 100                      | 5 pp noise floor; H4 none inferior vs B1 or B2              |
| tokens o200k p50 B1 / B2     | 657 / 651                                          | 657 / 651                    | 657 / 645 to 651                                            |
| tokens o200k p50 O1          | **136**                                            | 179                          | **138 to 179**                                              |
| tokens o200k p50 O2 / O3     | 54 / 627                                           | 68 / 627                     | 54 to 68 / 598 to 627                                       |
| tokens o200k p50 O4 / O5     | 20 / 20                                            | 21 / 21                      | 20 to 22                                                    |
| H1 / H3                      | 0.209× / 0.032×                                    | 0.275× / 0.033×              | ≤ 0.5× / ≤ 0.2×                                             |
| O5 one-step routed           | 60/60                                              | 59/60                        | ≥ 30                                                        |
| settings store nodes / edges | 10 / 9 (max out-degree 8, mean 0.9)                | 11 / 10                      | 11/10 (D.4.1), 11/11 (D.4), 10/9 (34870686468, 34888577404) |
| other stores                 | chrome 2/1, settings.intelligence 2/1              | chrome 1/1, intelligence 2/1 | —                                                           |
| invariants                   | 0 duplicate screens, 0 multi-destination edges     | same                         | gate                                                        |
| `skippedNoIdHash`            | 2                                                  | 0                            | 0 to 2 across published runs                                |

Reading: success, B1/B2/O2/O3/O4/O5 tokens, H1 to H4, O5 routing and the
invariants match D.4.1 within noise. The store shape 10/9 is one node and one
edge under D.4.1 and equal to the 3n reference runs. **O1 is 136, 2 tokens
below the pre-registered floor of 138**, in all 5 reps (136 per rep), so it is
a run-level shift, not a rep outlier. By the letter of the pre-registered
condition, E1-G5 misses on that one number; the floor itself spans 41 tokens
(138 to 179) on identical code, templates are OFF in the matrix, and run 1 of
this ticket measured O1 138 with the same template code, so this reads as
noise. It is recorded as a miss, not rounded into a pass. The B2 2/100 and
O2/O4 1/100 failures are all `settings-display`; the O5 1/100 is
`chrome-open-page`, 4th rep.

#### Open caveats

- `gaps > 0` in 37/40 attempts: the held swipe still skips rows on the loaded
  CI emulator. Run 4 passes because the search turns around and re-scans, not
  because the swipe stopped flinging. The swipe cause (late frames collapsing
  the 120 ms hold, run 3 diagnosis) is still unconfirmed on the device side.
- Cost per scroll is at least 2 container reads plus 150 ms, on top of the
  swipe itself, because the move decision waits for two agreeing reads. Median
  4 scrolls per attempt; worst case 20.
- E1-G3 grading was changed after run 3 to count present targets only. In this
  run every target was present, so the raw and the present-only counts are the
  same 40/40.
- E1-G5: O1 136 is under the pre-registered floor by 2 (above).
- OFF arm `dupEdgeTargets=9` is recorded, not gated (E-0 §F4).

#### What this proves and does not prove

On one app (the churn app), one emulator image (36.4.10.0, build 15004761,
swiftshader) and N=5 sessions of 8 taps and 8 navigate-to attempts, template
edges keep the ON store constant in content states (+0n/+0e per session against
+9n/+9e OFF, 23 299 B against 203 333 B at K=5), the store invariants hold, and
the template navigate-to step reaches 40/40 off-screen rows with the
bidirectional search. It does not show that this holds on a real app (E-2),
on another emulator or a physical device, with nested overlapping scrollables,
or with rows that are deleted or reordered; n=40 detects gross failure only.
It does not show that the swipe is fixed: most attempts still recorded gaps,
and the search compensates for them at a measurable cost per scroll. Nothing
here claims a tokens/step win from templates.

### Run 1 (34957934222)

Run: **34957934222** (`HeiCg/argent`, `bench-open-vs-proprietary.yml`,
`suite=screen-graph`, `sg_mode=matrix`, `blocks=churn`, branch
`feat/screen-graph-e1-templates` @ 9de873b8), job **conclusion success**. The
gates were pre-registered above BEFORE this run; the outcomes are read from
`churn.json` / `churn-results.md` / `sg-matrix.log` in the run artifact, never
blended with run 34801849653 (D.4.1) or 34870686468.

**Verdict: the template mechanism holds (E1-G1/G2/G4/G5 PASS), but two churn
HARNESS defects made E1-G3 fail 0/40. Both are fixed in commit ce4793b5; NOT
re-run — the planner decides on a second CI run.**

#### First-run outcomes (run 34957934222)

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

### Run 2 (34970043301)

Branch @ 117d8f5a (the ce4793b5 fixes in). Graded from the job log; the
artifact had expired. **nav 28/40, E1-G3 FAIL**; E1-G1/G2/G4 pass, G5/G6
descriptive. All 12 misses are `tapped=false, selector unresolved on live
tree`, on targets 33-39 (Story 32 5/5): s1 36, 38, 39; s2 34, 36; s3 33, 35,
37; s4 39; s5 33, 36, 37. The job concluded success because the harness at
117d8f5a ended with `process.exit(0)`; open/main exits with `process.exitCode`,
so a gate FAIL now turns the job red.

Diagnosis: not the scroll count. The misses are not a prefix (s1 missed 36 and
reached 37; s3 missed 33 and reached 34), and at the estimate below the list
bottoms out in ~3 of the 8 scrolls. `executeTemplateStep` scrolled with a flinging swipe
(`swipeWithOutcome(..., 10)`: 10 frames x 16 ms, no hold). Estimated from the
churn app's layout on the pixel_6 AVD (1080x2400, 420 dpi): rows ~179 px, list
viewport ~1908 px (y 366..2274), 50 rows, so ~7042 px of scroll range. The drag
is 0.44 x 1908 = 840 px in 160 ms; the lift carries ~5.3 px/ms and the fling
adds ~1700 px, so one swipe moves ~2500 px, more than a viewport. The rows
between two queried windows (~3 rows per swipe) are never seen, and where the
gap falls moves with the fling's timing (the next touch-down or query cuts it
short). The selector itself is not the problem: the template step queries the
caller's item text on the live tree, nothing per row comes from the capture.

Fix (this branch, after the rebase onto open/main): the template scroll is
momentum-free (19 steps, 120 ms held before the lift, the `gesture-swipe`
`momentum: false` values), so each scroll moves the list by the drag minus the
touch slop, ~819 px < 1908 px, and consecutive windows overlap. The search stops
when the item resolves, when two swipes in a row report `changed: false` (end of
the list), or at a cap of 30 scrolls. At the estimate above, Story 39 needs
ceil(5168 / 819) = 7 scrolls and the last row 9. `executeTemplateStep` returns
`scrolls`; the churn harness logs it per attempt and writes `navAttempts`
(session, target, scrolls, tapped, arrived, reason) to `churn.json` and
`churn-results.md`. A unit test replays the 50-row geometry: every row
resolves held (Story 39 at 7, max 9); the old flinging scroll misses rows 11-13,
25-27, 39 in the same model.

### Run 3 (37572199458)

Branch @ 93cbf758. **nav 30/40, E1-G3 FAIL**; E1-G1/G2/G4 pass. All 10 misses
are `tapped=false, selector unresolved on live tree`, at 9, 4, 9, 5, 7, 9, 6, 2,
5, 9 scrolls.

Diagnosis:

- Every target was present. The churn app never deletes, renames or reorders a
  row (`Items.rowTitle(i) = "Story i"`; the seed churns only the summary and the
  detail headline), so a miss is never a correct "absent".
- The list did not start scrolled. `launchFeed` runs `am force-stop` then
  `am start` before every attempt, so each attempt starts at the top of a cold
  feed.
- The held swipe still flung on CI. Drag-only, Story 33 needs 5 scrolls, 34
  needs 6 and 38 needs 7, yet run 3 reached 33, 34 and 38 in 2 scrolls and 39 in 3. A swipe moved two to three drags, more than a viewport, so rows fell
  between two windows. `MotionInjector` paces frames against `downTime + slot`
  and injects late frames back to back, so a stall on the loaded emulator (Davey
  frames of 785 and 822 ms in the logcat tail) can collapse the 120 ms hold and
  lift with velocity. This is the likely cause; the device side was not changed.
- The search only scrolled down. Once a flung swipe skipped the item, the
  search ran to the end of the list and stopped after two `changed:false`
  swipes: 9 scrolls when it got there by drag, 4 to 7 when flings got there
  sooner.
- The end detection trusted the server's `changed`. It is `false` whenever no AX
  event lands within the 600 ms first-event window (`settled:"no-event"`), even
  if the list moved. The 2-scroll miss (s4, Story 36) stopped at the top, so
  both swipes reported no change. Either they ran before the feed was drawn
  (logcat: `Displayed .../.FeedActivity: +1s464ms`, against the harness's
  1.2 s sleep) or the AX event came too late.

There was no per-swipe telemetry, so each miss is attributed by its scroll
count, not observed.

Fix (this branch):

- The template search is bidirectional. It scrolls down until the list stops
  moving, turns around, and keeps going between the two ends until the item
  resolves, until a pass from one end to the other has no gap, or until the
  30-scroll cap.
- "Moved" is decided from settled reads. The step reads the container's visible
  texts until two consecutive reads agree, then compares that window with the
  one before the swipe. A moved window that shares no text with the previous one
  counts as a gap. The server's `changed` is only a fallback, for a container
  with no readable text.
- `executeTemplateStep` returns `reversals`, `gaps` and `swept`.
- The harness waits until the feed shows `Story 0` (up to 6 s) before each nav
  attempt.
- Each attempt records `targetPresent`, taken from the app's row model.
- E1-G3 is graded over present targets only, with the 38/40 bar scaled to that
  denominator. The raw number is published next to it.

Unit tests replay the 50-row geometry with the list starting at the bottom,
down swipes that fling, an outcome that always says `changed:false`, and a
screen that trails the list by two reads. All 50 rows resolve in each case. An
absent row stops after one clean sweep (22 scrolls).

Original pre-run gate table (outcomes appended from run 1; run 4's are in its
section above):

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
