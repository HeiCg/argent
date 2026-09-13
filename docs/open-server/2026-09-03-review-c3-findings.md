# Adversarial review — Section C only (screen-graph C.3)

Reviewer: independent read-only pass. Branches read at
`origin/feat/screen-graph-c3` @ `a0f83004` and `origin/feat/bench-ci-c3` @
`05a539ca` in throwaway worktrees. Artifacts: `gh run download` for
33767073864 (capture), 33779983434 (matrix 1), 33786304637 (matrix FINAL),
33742435496 (C.2, pulled for the tier-code comparison the ticket §C.5 asks for).
No device used. Results doc under review:
`docs/specs/2026-09-03-screen-graph-results-ci.md` (present).

## Verdict: **REJECT**

The plumbing claims (pin, gate, pipefail, O5 `locateFailed` 30→0, Chrome FRE)
are TRUE and verified. The headline claim — "H4 measured with a valid oracle" —
does not hold. Three of the four success numbers H4 rests on are artifacts of
the harness, and the H1 ratio moved 40 % between C.2 and C.3 with **identical
tier code**, which is exactly the tripwire ticket §C.5 set. Token/RTT
descriptive statistics are accepted with labels; H4 is not scoreboard-grade.

## Findings

### Verified TRUE (no action)

- **C1-OK** `.github/workflows/bench-open-vs-proprietary.yml:` checkout `ref:
  a0f8300403156472132748cb04997a58b3b62f28` == `origin/feat/screen-graph-c3`
  head. Run 33786304637 ran workflow sha `05a539ca` == `feat/bench-ci-c3` head.
  Pin is correct **for this run**.
- **C2-OK** Both `run:` blocks start with `set -euo pipefail`; no
  `continue-on-error` on the pre-flight or matrix step. `tee` can no longer mask
  a non-zero gate.
- **C3-OK** `packages/tool-server/src/screen-graph/bench/preflight.ts:55`
  `preflightVerdict` is pure; `scripts/bench-preflight.ts:429` exits 1 on
  `!ok`. Run 33786304637 `logs/sg-preflight.log`: `PROBLEM needles: 0 — none` /
  `[preflight] GATE PASS: PROBLEM needles: 0`. Confirmed.
- **C4-OK** Unit tests run offline: `test/screen-graph-bench-preflight.test.ts`
  → **7 passed, 2 skipped**. The 6 `preflightVerdict — the matrix gate` cases
  cover ok/BAD/MISSING/mixed/empty as claimed.
- **C5-OK** O5 `locateFailed` 30/60 (run 33742435496) → 0/60 (run 33786304637).
  Root cause as stated: `bench-screen-graph.ts:730` now sends
  `target: { selector: … }`. Confirmed in both JSONs.
- **C6-OK** Chrome FRE: all six chrome-related tasks read `YYY` for all seven
  configs in run 33786304637 (regenerated from the JSON). Was NNN for all in
  33742435496.
- **C7-OK** No centre taps. `bench-screen-graph.ts:814` — `!located.found`
  returns `locateFailed`, `:1075` aborts the task and excludes it. B1
  `locateFailed 0, excluded 0`; matrix log line 2: `B1 precompute done in
  133626ms: 16 coords, 0 miss`. B1 taps were located through the tree.
- **C8-OK** Scoring/exclusion RULES are byte-identical C.2→C.3: `git diff
  5b1e6e98..a0f83004` touches only `bench-preflight.ts`,
  `bench-screen-graph.ts` (4 hunks: FRE, navigate fix, `located` for O5, main
  ordering), new `preflight.ts`, `tasks.ts`, the test. `oracle.ts` and
  `policy.ts` untouched.
- **C9-OK** `prepareChromeOnce` runs once before the config loop
  (`bench-screen-graph.ts:1696`), so no config is advantaged. The
  `settings-battery-then-back` extra step is in the one shared `TASKS` array;
  every config went 90→93 steps. Same task list, same oracle
  (`oracleRead`, open-server `query`, B1 via instrumentation switch).

### HIGH

- **C-H1 · O5's 0.817 is a MIXED-STRATEGY number and the table hides it.**
  Run 33786304637 JSON: O5 used `navigate-to` on **9 of 153 steps**, on only 2
  tasks (`settings-network` 1×3, `settings-network-internet` 2×3). The other
  27 of 36 known-target taps fell back to plain locate+tap — identical to O4.
  `logs/sg-matrix.log:111-137` has 27 `navigate-to did not reach …; falling
  back to locate+tap` lines, yet `:138` reports `fallbacks 0`. The counter is
  honest for its own definition (`bench-screen-graph.ts:162` `fallbacksSince`
  scans the monkey-patched `console.debug`; the navigate message goes through
  `realDebug` and is invisible to it) but the per-config table publishes
  `fallbacks 0` for O5 with no asterisk. **Fix:** add a `navFallbacks` column
  (O5 = 27/36) and state that O5's tokens (85) and RTT-count (1) are O4's
  numbers, since navigate-to ran on 5.9 % of steps.
  **Worse:** every one of the 9 navigate steps is in a task that FAILED.
  navigate-to's own task success where it routed is **0/9**.
- **C-H2 · The results doc misattributes `settings-sound`.** Doc lines 137-139
  name settings-network, settings-sound and settings-network-internet as
  "reached but mis-landed" navigate-to cases. The JSON says
  `settings-sound` has `usedNavigate=false` on all 3 reps with
  `changed=true` — it fell back to locate+tap and still read N 3/3, while O4
  passed 3/3 on the identical path. That is an unexplained O5-only regression,
  not a navigate-to cost. The likely mechanism is that `runNavigation`
  (`src/screen-graph/navigate.ts:44`) executes plan steps and only then
  reports `ok:false` on divergence, so the fall-through tap fires on a screen
  the failed route already moved. **Fix:** log `completedSteps`/`totalSteps`/
  `error` from the tool result and re-classify.
- **C-H3 · "No route (27/36)" is unverifiable from the artifacts.**
  `bench-screen-graph.ts:741` logs the same string for `planned===null` and for
  a mid-route divergence that already tapped. The doc's claim that
  `planToSelector` returned null is an assumption the run cannot confirm.
- **C-H4 · B1's 93.3 % is a stale-coordinate artifact, not a proprietary-path
  number.** `precomputeB1Coords` (`bench-screen-graph.ts:462`) locates every tap
  ONCE, 133 s before the run, and B1 replays those fixed coordinates for all 3
  reps while every open config re-locates live each step
  (`:1008`). All **4** B1 failures are on the only 2 tasks that swipe the root
  before tapping (`settings-display` 1, `same-display-slider` 3); B1 is
  **54/54** on the other 18 tasks. Fling scroll offset is not deterministic, so
  B1 alone taps a coordinate from a different scroll state. The doc's "B1
  exercised the proprietary path … so its success is valid for H4" is not
  supported. The doc's caveat "B1 read (none) where B2 matched Brightness" is
  also stale: in run 33786304637 B1 reps 1-2 matched `Brightness`/`Brightness
  level`@title.
- **C-H5 · H1's 0.107× is not comparable across phases; the needle change moved
  the metric.** `bench-screen-graph.ts:1040` feeds `task.assertion` as the
  `query` selector on every NON-tap step, and `runObservation`'s `query` branch
  tokenises the matched nodes. Narrowing the needles therefore shrank the
  measurement. Per action kind, chars/4 p50, O1, C.2 33742435496 → C.3
  33786304637: `tap` 77 → 77 (unchanged, tap selector unchanged), `swipe`
  22 → 48, `back` 38 → 1, `type` 184 → 1, `tapXY` 133 → 41. Net O1 tokens/step
  67 → 43 chars/4 (114 → 67 o200k) with identical tier code — H1 was 0.182× and
  is now 0.107×. Ticket §C.5 named exactly this: "a large change means the
  harness changed what it measures." H1 still PASSES ≤0.5× either way, but the
  ratio must be labelled needle-dependent, and tokens/step is **not**
  oracle-independent for O1/O2.
- **C-H6 · H4's ±2 pp margin is an order of magnitude below the noise floor.**
  Same code, same tasks, two runs: B1 88.3→93.3, B2 95.0→100.0, O1 93.3→96.7,
  O2 91.7→98.3, O3 91.7→100.0, O4 93.2→100.0, O5 86.7→81.7. |Δ| spans
  3.4-8.3 pp. With 20 tasks × 3 correlated reps the effective N is ~20, so a
  95 % interval on a ~95 % rate is roughly ±10 pp. **"O1 97 % vs B2 100 %,
  −3 pp ✗" is noise and must be withdrawn.** Only O5's −11 pp (vs B1) /
  −18 pp (vs B2) survives, and per C-H1 it is a mixed-strategy number.

### MEDIUM

- **C-M1 · `brightness` IS in the launch tree; the gate passes it on
  visibility.** Capture 33767073864: the Settings root dump contains
  "Dark theme, font size, brightness". The pre-flight scores
  `matchesLaunch=false` only because `isVisibleNode`
  (`src/screen-graph/bench/oracle.ts:68`) rejects it as below-fold at dump
  time. Both tasks that use it (`settings-display`, `same-display-slider`)
  **swipe the root up before tapping**, which brings that row on-screen. A
  missed Display tap can therefore false-pass. **Not realized in run
  33786304637** — every pass matched `Brightness`/`Brightness level`@title,
  never the root subtitle — so the run stands, but the gate's guarantee is void
  for these two tasks. **Fix:** dump the launch screen in its post-swipe state
  for swipe tasks, or move the needle to `Brightness level`.
- **C-M2 · "ok (unique to destination)" never checks the destination.**
  `scripts/bench-preflight.ts:342-347`: for a navigating task the verdict is
  decided purely by `matchesLaunch`. A needle on neither screen reads "ok". The
  label overstates what was tested.
- **C-M3 · The BLOCKER-1 fixture guard is dead code in CI.**
  `test/fixtures/preflight-launch-screens.json` is not committed, so
  `describe.skipIf` skips both real needle-vs-launch assertions (verified: 2
  skipped). Only the pure-verdict tests run offline.
- **C-M4 · O5's route target is the oracle's needle.** `tasks.ts`: every
  settings task now sets `navTarget === assertion`. O5 is told the exact string
  the oracle will look for; the other configs tap a different selector and are
  judged on a string they were never given. An information asymmetry in O5's
  favour (which did not help it, but must be disclosed).
- **C-M5 · `settings-network-internet` does not test what it says.** Capture
  33767073864: its destination dump is byte-identical to `settings-network`'s
  (58 nodes, Network & internet). The second tap never entered the Internet
  sub-screen during capture. The doc discloses this; the task should be
  renamed or fixed, not counted as a 2-level navigation.
- **C-M6 · `same-display-slider`'s needle was never confirmed on its
  destination.** Capture destination for that task is 23 nodes,
  "Search settings | Settings Services" — the search screen, not Display. The
  gate still labelled it "ok (unique to destination)".
- **C-M7 · O5's RTT-count of 1/step undercounts.** `bench-screen-graph.ts:1057`
  scores a step as 1 action RTT + 0 for a graph-lookup. On the 27 fallback
  steps O5 actually paid a `navigate-to` round-trip **plus** a locate **plus**
  a tap. O5 `actionRttMs` p50 is 677 ms vs O4's 678 ms and p95 1840 vs 1442.

### LOW

- **C-L1** H1's row is labelled "unchanged steps" but the 0.107× is computed
  over all 93 non-launch steps. Recomputed independently: 67/627 = 0.107.
  Relabel.
- **C-L2** H3: the doc's O4 warm p50 of 77 is a percentile-index artifact; the
  standard median over the same 90 steps is 81, giving 0.135× not 0.129×. Both
  PASS ≤0.2×. State the percentile convention.
- **C-L3** The SHA pin will go stale on the next commit to
  `feat/screen-graph-c3` — the exact mechanism of root cause #1. Pin the branch
  or add a step that fails when the pin ≠ branch head.
- **C-L4** In run 33786304637 the FRE was already gone by the time
  `prepareChromeOnce` ran (matrix log line 1: "example.com is up; done"); the
  pre-flight's own dismissal did the work.

## Numbers I accept as scoreboard-grade

All from **run 33786304637**, 7 configs × 20 tasks × 3 reps, **n = 93 non-launch
steps per config**, 60 task-runs per config. Independently recomputed from
`bench-sg-2026-09-03T17-50-09-621Z.json`; all reproduce the doc.

| Statistic (p50) | B1 | B2 | O1 | O2 | O3 | O4 | O5 |
|---|---|---|---|---|---|---|---|
| tokens/step o200k | 657 | 627 | 67 | 54 | 598 | 85 | 85 |
| tokens/step chars/4 | 473 | 447 | 43 | 32 | 397 | 69 | 70 |
| observation RTT ms/step | 668 | 94 | 4 | 4 | 90 | 50 | 48 |
| RTT count/step, all | 2 | 2 | 2 | 2 | 2 | 1 | 1 |
| RTT count/step, same-screen (n=30) | 2 | 2 | 2 | 1 | 1 | 1 | 1 |
| task success | 56/60 | 60/60 | 58/60 | 59/60 | 60/60 | 60/60 | 49/60 |

Labels that must travel with them: O1/O2 tokens are needle-coupled (C-H5); O5's
tokens and RTT-count are O4's numbers for 94 % of steps (C-H1); B1's success is
a stale-coordinate replay (C-H4); B1's observation RTT includes the proprietary
describe.

Hypotheses I accept, run 33786304637:

- **H1 PASS** — O1/B2 tokens/step o200k p50, n=93 each: 67/627 = **0.107×**
  (target ≤0.5×). Needle-dependent: 0.182× in run 33742435496, same tier code.
- **H2 all-steps FAIL** — B2 2 − O2 2 = **0** removed (target ≥1), n=93.
- **H2 same-screen PASS** — B2 2 − O2 1 = **1** removed, n=30.
- **H3 PASS** — O4 revisited-steps p50 / O3 all-steps p50 = 77/598 = **0.129×**
  (81/598 = 0.135× with the standard median), n=90 / n=93, target ≤0.2×.
- **H4 VOID as stated** — see C-H4 and C-H6. The ±2 pp margin is unusable
  against a 3.4-8.3 pp observed run-to-run spread. The only survivor is the
  qualitative statement: **O2, O3 and O4 match both baselines within noise while
  spending an order of magnitude fewer tokens; O5 is clearly worse.**

The per-task Y/N/L matrix in the results doc regenerates **exactly** from the
JSON and is accepted as published.

## Minimum to reach ACCEPT

1. Publish O5 with a `navFallbacks` column (27/36) and state its 0.817 is
   O4-plus-navigate-attempts, not a navigate-to success rate.
2. Re-classify `settings-sound`; log `completedSteps`/`totalSteps`/`error` from
   `navigate-to`.
3. Either re-locate B1's coordinate per rep, or exclude the two swipe tasks
   from H4 and report B1 as 54/54 on the remaining 18.
4. State the run-to-run noise floor next to H4 and widen the margin past it, or
   raise reps until ±2 pp is defensible.
5. Label H1 needle-dependent and fix `bench-screen-graph.ts:1040` so the
   observation selector is not the oracle needle.
6. Commit `preflight-launch-screens.json` so the BLOCKER-1 test stops skipping.

## Addendum — why `navigate-to` failed to route on 27/36 (for the next ticket)

**No graph store is in ANY artifact.** Runs 33767073864 / 33779983434 /
33786304637 / 33742435496 ship only `logs/*` and
`.bench-results/screen-graph/{capture,bench-sg-*,results-ci}`. The differing
hashes cannot be shown. Everything below is derived from the C.3 code plus the
run JSON and is labelled as inference where it is inference.

**The doc's stated cause is REFUTED by the run's own JSON.** Doc line 133-135
says `planToSelector` returned null "because the live root hash does not match
the node O3 recorded (the Settings root carries dynamic content — clock,
battery, signal — so its structural hash is not stable run-to-run)". Two
independent reasons that is wrong:

1. **The structural hash excludes text by construction.**
   `packages/android-device-server/.../accessibility/ScreenHash.kt:78-93`
   (`appendStructural`) hashes `className | resourceId | quantised bounds |
   flags` per node in DFS order and **never appends `text` or `contentDesc`**.
   The state hash at `:107-116` (`appendState`) is the one that adds them. A
   clock tick, a battery percentage or a signal-strength label changes
   `H_text`, never `H`. `planToSelector` and `runNavigation` both use `H`.
2. **The live root hash WAS in the warm graph, every time.** Run 33786304637
   JSON: all **42/42** O5 Settings launches and 41/42 O4 Settings launches have
   `knownScreen: true` on step 0. `knownScreen` is `knownBefore.has(hash)` and
   `knownBefore` for O4/O5 is `loadKnownHashes()` off O3's store
   (`bench-screen-graph.ts:1746`). So `from` was always a node in the graph.
   The null came from the target side or the edge side, not from `from`.

**What CAN destabilise `H`** (candidates for the real cause, in order):

- **Quantised bounds.** `ScreenHash.kt:66` buckets to 1/32 of each screen
  dimension: 2400/32 = **75 px vertically**, 1080/32 ≈ 34 px horizontally. Any
  layout shift past a bucket boundary changes `H`.
- **The `focused` flag.** `FLAG_FOCUSED` (bit 5) is inside `flagsOf`
  (`ScreenHash.kt:56`), so which node holds focus is part of the screen
  identity.
- **The RecyclerView first-child rule.** `ScreenHash.kt:84-89`: a scrolling
  container is hashed as the container node plus the **class sequence of its
  FIRST child subtree only**. Scrolling the Settings root changes which item is
  first, so `H` changes with scroll offset. This is the likely cause on
  `settings-display` and `same-display-slider`, the two tasks that swipe.
- **Node insertion/removal**, e.g. a late-loading contextual card, shifts the
  whole DFS record sequence.

**The target side is exact-match, text-only.**
`packages/tool-server/src/utils/screen-graph-open-wiring.ts:108` builds the
index as `index[selectorKeyForText(el.text.trim())]`, from `el.text` **only** —
no `contentDescription`, no case folding. `planToSelector`
(`src/screen-graph/plan.ts:125`) then does `keys.some(k => k in node.index)`, a
literal object-key lookup. A navTarget that differs from the recorded label by
one character, or that lives in a content-description, is unreachable. Note
`Media volume` on the Sound screen exists both as text and as a
content-description in the capture; the Settings search clear button exists
**only** as a content-description, so nothing in that family is indexable.

**`dijkstra` prunes nothing.** `plan.ts:29` weights edges by
`1/(successes+1) + stalenessDays/30` but never drops one, so "no route" means
there is genuinely no edge chain from the live root to any indexed target.

**The 9 "reached but wrong" cases have a separate, structural cause.**
`runNavigation` (`src/screen-graph/navigate.ts:44-56`) accepts a step when
`afterHash === step.to`, comparing the **text-free** `H`. Hash equality is
therefore *structural* equality, not *content* equality: arriving on a
structurally identical list screen satisfies `reached` while the needle is
absent. `planToSelector` selects targets **by text** and `runNavigation`
verifies **without text**. That mismatch, not a "stale bucket", is the defect.
Also note `plan.ts:57`: when the current screen already indexes the target,
dijkstra returns a **zero-step** plan and `navigate-to` reports `reached:true`
having tapped nothing.

**What the next ticket must log to settle this:** `completedSteps`,
`totalSteps`, `error`, `divergence.expected`, `divergence.actual` and the live
`from` hash from every `navigate-to` result, plus upload the graph store as an
artifact. `bench-screen-graph.ts:741` currently collapses no-route and
mid-route divergence into one indistinguishable log line.
