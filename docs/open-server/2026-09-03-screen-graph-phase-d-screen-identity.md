# Ticket: screen-graph phase D — screen identity hash, selector-carrying edges, honest O5

Repo: ARGENT FORK. Worktrees: `argent-c3` (branch `feat/screen-graph-c4` → create
`feat/screen-graph-d` from 212d7d58) and `argent-c3-ci` (`feat/bench-ci-c4` → create
`feat/bench-ci-d`). Device-side hash lives on the open-server branches
(`packages/android-device-server/.../ScreenHash.kt`); the screen-graph branch already
carries its own copy of the server tree — change it there and note the file so the
consolidation merges it. NO local emulator/adb; CI only (`-f suite=screen-graph`,
foreground `gh run watch`).

Read first: `2026-09-03-review-c4-findings.md` (verdict REJECT scoped to O5/H4-O5),
`2026-09-03-screen-graph-results-ci.md`, `2026-09-02-screen-graph-architecture.md`
(§ on H / H_text), `ScreenHash.kt`, `src/screen-graph/plan.ts`, `navigate.ts`,
`tools/navigate-to/index.ts`, `bench/oracle.ts`, `scripts/bench-screen-graph.ts`.

## 0. Republish C.4 honestly (harness, same run 33806639520, no new device time)
1. O5 = 86/100 everywhere: exclusions caused by the config's own prior action are
   failures. `isExcludedRun` (oracle.ts:145) restricted to pre-action infrastructure
   failures identical for all configs.
2. Nav counters computed over ALL attempts, before the exclusion skip
   (bench-screen-graph.ts:1274 vs :1283-1290); republish 2 routed / 10 mis-landed /
   3 diverged / 40 no-route / 53 fallbacks of 55.
3. Drop the shared-pair intersection in the H4 comparison (:1580); compare on the
   full 100 denominator per config with a task-cluster bootstrap interval (reps are
   correlated; state effective N = tasks). Keep Wilson only as a secondary column.
4. Fix the fallback guard (:742) to key on `totalSteps > 0` (navigate.ts:65-75 does
   not increment `completedSteps` on divergence); fix the wrong comment at :740-741.
5. Withdraw "the Jaccard fix works" (plan.ts:248-256 returns `via:"exact"` whenever
   the live hash is a node, so the fallback never ran; root 77a189ce has no
   resource-ids to score) and "the root did not drift" (77a189ce and 299378e0 are
   two hashes for one screen, joined by a swipe edge).
6. Close C-M2 (bench-preflight.ts:345-350 must require presence on the destination
   dump, not only absence on launch) and C-M3 (commit `preflight-launch-screens.json`
   so the two skipped tests run).
7. O5 tokens over all 155 steps; O5 RTT/step must include navigate + locate RPCs.
Regenerate the results doc from the JSON (no hand-typed numbers); keep C.4's
published numbers in a "superseded" block with the reason per number.

## 1. Screen identity hash (device side, `ScreenHash.kt`)
Problem (proven from the uploaded store): node 2bf46d4f absorbs every Settings
sub-screen (7+8 root buckets route into it) because H never appends text or
contentDescription (:78-83), hashes a scrolling container as container + first-child
class sequence (:84-89), and quantises bounds to 1/32 (:66). Two hashes exist for
the Settings root (scroll-dependent first-child sequence + bucket crossings).
Design `H_id` (the identity used for nodes and routing), keeping `H` and `H_text` as
they are for diff/awaitChange:
- window package + the texts of "identity nodes": toolbar/collapsing-toolbar title,
  action-bar title, tab labels, dialog titles (by resource-id patterns
  `*:id/action_bar`, `*collapsing_toolbar*`, `*:id/title` when its parent is a
  toolbar, `*:id/alertTitle`, tab indicators) and the first non-list header text;
- the resource-id multiset of NON-scrollable subtrees (order-free, so scroll and
  focus do not move it), excluding volatile texts (`isVolatileText`: time, %, dates,
  counters);
- for scrollable containers: container class + resource-id only, never child
  sequence, never bounds;
- no bounds at all in `H_id`; no focus flags.
Unit tests with captured roots from the run 33806639520 store: (a) 77a189ce and
299378e0 → same `H_id`; (b) Network & internet, Battery, Sound, Display, Apps
sub-screens → five distinct `H_id`; (c) the same sub-screen scrolled → same `H_id`.
Return `H_id` in `getState`/`getNestedState` alongside `H`/`H_text`; the host graph
keys nodes by `H_id`.

## 2. Edges carry the acted element's selector
Record on every edge: `{ text?, contentDescription?, resourceId?, className,
indexInParent, boundsBucket }` of the tapped node (from the tree at action time), plus
outcome. Planning (`plan.ts`) prefers edges with a selector; replay resolves the
selector on the live tree (exact text/resource-id match, then contentDescription),
and only falls back to the bounds bucket when no selector exists. An edge whose
selector cannot be resolved on the live screen is not taken. Weight stays
1/(successes+1) but per (from `H_id`, selector) pair.

## 3. navigate-to correctness
Route only when the target `H_id` is unambiguous (one node); verify arrival by
`H_id` equality (tolerant match only for the same `H_id` with a different `H`).
Divergence → stop, re-observe, return `ok:false` with `totalSteps`, `completedSteps`,
`divergedAt`. The bench's O5 fallback taps only after a fresh describe.

## 4. Matrix run and acceptance
`BENCH_REPS=5`, same task list, same oracle. Accept when: O5-pure covers ≥ 30 of the
known-target taps; O5 success (exclusions as failures) within the cluster-bootstrap
interval of B1; mis-land count reported and ≤ 2; results doc regenerated from JSON;
H1–H4 restated with the corrected accounting; the `H_id` unit tests pass; branches
pushed; run URL in the final message. If O5 still cannot route, report the store
evidence and stop — no harness workaround.
