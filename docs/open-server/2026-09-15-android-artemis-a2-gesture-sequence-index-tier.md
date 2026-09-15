# Ticket: Artemis A2 — `gesture-sequence` for transient UI + index-based describe tier (measure tokens first)

From README "Execution order" step 3 and the 2026-09-13 Artemis note (`click_sequence`
bursts for transient UI; element-index observations). Base: `open/main` @ HEAD
(≥ 0e50c5a2). Android open driver only; do not touch the A1 files another agent owns
(`feat/open-server-a1-verified-tap`: `gesture-tap`, incident state, describe header) —
if you need the describe tool, add a new tier module and wire it behind a param.

## A. `gesture-sequence` (transient UI bursts)

- New tool `gesture-sequence`: `steps: [{ kind: "tap"|"swipe"|"key"|"wait", ...same
params as the single tools..., delayMs? }]`, executed on the device in ONE RPC
  (`batch` already exists in `JsonRpcHandler.kt` — use it; if `batch` cannot carry
  per-step delays, add `delayMs` handling server-side in the batch loop, minimal Kotlin
  diff, read twice). Purpose: dismiss a transient sheet + tap the revealed control before
  it disappears, without a host round trip per step. Result: per-step `{ success,
dropped?, ms }` plus the total; on the first failure the remaining steps are skipped
  and reported as `skipped`. Injection strategy = the shipped default (`input-manager`).
- Effect oracle for the device test: Settings → Search → type → tap first result in one
  sequence; assert navigation by neutral pixels + nav title.

## B. Index-based describe tier (measure tokens FIRST, ship only if it pays)

- Add a describe tier `index` (behind the existing `tier` param, `screen-graph`
  machinery in `tools/describe/platforms/android/tiered.ts`): each interactive element
  rendered as `[i] label (role)` with a per-screen index; a companion param on
  `gesture-tap`/`gesture-sequence` `target: { index: i, version }` resolves the index on
  the device against the SAME snapshot version (refuse `stale_index` if the version
  moved) and taps the element bounds. This is the Artemis "element-index observation".
- Measurement before shipping as default anywhere: on the screen-graph matrix's 20 task
  screens (fixtures in `test/fixtures/screen-graph-*.json`), tokens (o200k) per screen
  for `full` / `summary` / `compact` / `index`, plus the task-success proxy the harness
  already has (locate exact-match). Write the table to the Result. If `index` is not at
  least 20 % below the current best tier at equal locate success, keep it opt-in and say
  so.

## Tests + CI

Unit: sequence schema/skip semantics, batch payload shape, index rendering, stale-index
refusal, token table generator. Device (`android-open-server.device.test.ts`): the
sequence case above; index tap navigates; stale index refuses after a navigation. One
CI run `suite=latency` default blocks: device suite green; latency verbs within floors
of run 34904658366 (nothing on the default path changes). Polling: one `gh run view` per
10 min as a single background `sleep 540; gh run view` call; never loop; one
`gh run download`.

## Docs

`packages/docs/docs/reference/` pages for the new tool and the `tier: index` / `target`
params; `features/` note. `npx docusaurus build` + `npm run format` in the MAIN checkout
after merge (say not run in the worktree). Prettier-clean before every push.

## Process

Branch `feat/open-server-a2-sequence-index`, worktree `../argent-fork-wt-a2` (never /tmp;
root `node_modules` symlinked; no npm install / gradle; Kotlin compiles in CI only). Open
a PR to `open/main` for the hygiene checks. Append `## Result` here (token table, device
outcomes, run id, verb table at floors). Adversarial review before merge; do not
fast-forward `open/main`.

## Result (2026-09-15)

Branch `feat/open-server-a2-sequence-index`, PR #6 → `open/main`. Commits: A
(`gesture-sequence` + `batch`), B (index tier + `target`), the flag guard, the
eslint/test hygiene fixes, and a merge of `origin/open/main` (A1 verified-tap +
incident), shared `gesture-tap` schema/result and the android describe hunks
resolved keeping both features.

### A — `gesture-sequence` contract

- Tool `gesture-sequence` (Android open-device-server only; `run-sequence` covers
  other targets). Schema: `{ udid, steps: [{ kind: "tap"|"swipe"|"key"|"wait",
...params, delayMs? }] }`. `tap`: `{x,y}` normalized or `{target:{index,version}}`,
  `clickCount?`. `swipe`: `{fromX,fromY,toX,toY}` normalized, `durationMs?`,
  `momentum?`. `key`: `{key}`. `wait`: `{waitMs}`.
- Result `{ completed, total, totalMs, steps:[{ kind, success, dropped?, ms,
skipped? }] }`. Per-step `ms` is the on-device wall time; `totalMs` is the host
  round-trip of the one `batch` RPC.
- Skip semantics: on the FIRST failing step (JSON-RPC `error`, `success:false`, or a
  dropped injection) the device runs no further step and reports each remaining one
  as `{skipped:true}`.
- Batch payload: one `batch` RPC, `params.actions = [{ method, params, delayMs? }]`;
  taps/swipes carry device pixels + the shipped `inject` strategy; a `wait` step is
  `{ method:"wait", delayMs:<waitMs> }`.
- Kotlin change (`JsonRpcHandler.executeBatch`, minimal): per-action `delayMs`
  (on-device pause), per-step `ms` timing, stop-on-first-failure with the rest
  `skipped`, and a `wait` pseudo-method. `JsonRpcHandler.kt:281`.

### B — index tier + `target` contract, stale-index rule

- `describe` `tier:"index"` (own module `describe/platforms/android/index-tier.ts`,
  behind the flag) renders a version header + one `[i] label (role)` line per
  interactive element (`buildIndexElements` = clickable/scrollable/labelled in
  document order, 0-based index). The same builder backs the tap resolution, so an
  index always denotes the same element for a snapshot.
- `gesture-tap` / `gesture-sequence` take `target:{ index, version }`. The host
  reads the live tree (`getState` fingerprints), and `resolveIndexTarget`
  (`open-server-input.ts`) taps the element's bounds centre.
- Stale-index rule: if the live AX `version` moved off `target.version` →
  `IndexTargetError("stale_index")` (nothing injected); an index off the current
  screen → `index_out_of_range`. `gesture-tap target` is additive (x/y ignored when
  set); it merges with A1's `verify` under one refine (x/y required unless `verify`
  OR `target`).

### Token table (o200k)

Reproduce: `npx vitest run test/index-tier-tokens.test.ts --disableConsoleIntercept`.
Scope and caveats (review A2-M1/M2):

- The 24 rows are **two CI captures of one Settings crawl**: **14 distinct screen
  hashes / 15 distinct compact texts** (some screens recur). This is NOT the ticket's
  "20-screen matrix" — it is what the committed fixtures contain.
- The `index` column is a **reconstruction** from the stored describe text
  (`renderIndexFromDescribe(node.compact)`), NOT the shipped renderer
  (`buildIndexElements(state.tree)`) — same line format, different source/filter, so
  the delta is representative, not measured on a device (A2-M1; an on-device
  `tier:"index"` vs `tier:"compact"` pair is queued for the next run).
- `full` is **not measured** — it is set equal to `compact` by construction (the open
  path serves the pruned tree; no larger un-pruned rendering exists in the capture).
- The fixtures were captured before the A1 incident feature existed — **no incident
  header line is present in any measured screen**.

| tier    | median tokens                  | total tokens |
| ------- | ------------------------------ | ------------ |
| full    | 1294 (= compact, not measured) | 35249        |
| compact | 1294                           | 35249        |
| summary | 25.5                           | 753          |
| index   | 367.5                          | 10253        |

- Median index-vs-compact savings: **71.2%** (index 367.5 vs compact 1294); robust to
  dedup (per the reviewer's recompute over the 15 distinct texts: **71.0%**).
- Locate (exact-match proxy), counted the SAME way on both sides (target label unique
  among the rows): compact **608/676**, index **608/676** — **parity**. The earlier
  "676/676 addressable" counted a different thing (label present, not unique); the
  `indexAddressable >= uniqueByLabel` gate is an identity, so the honest claim is
  **parity at 71% fewer tokens**, not "index locate ≥ compact".

### Ship / opt-in decision

Only the **savings** half of the rule carries: index is 71% below compact at
**parity** locate (608/676 both). It ships this phase as an **opt-in** tier
(`tier:"index"`) plus the `target` tap path; the global `describe` default stays
`compact`. `index` is NOT made a default — beyond the coordinate-removing behavior
change, the tier is active-window-only with a silent node cap (A2-M7), skips `settle`
/ the incident line / the graph observation (A2-M9), and its on-device token delta is
still unmeasured (A2-M1). Default-tier promotion is deferred to a future phase.

### Unit tests (all green, `--maxWorkers=2`)

- `test/gesture-sequence.test.ts` (12): schema, `buildSequenceActions` payload,
  `mapSequenceResults` skip/dropped/error, `resolveIndexTarget` stale/out-of-range.
- `test/describe-index-tier.test.ts` (4): `buildIndexElements` ordering/filter,
  `renderIndexTier` lines + version header.
- `test/index-tier-tokens.test.ts` (6): parser/render, `measureScreenTiers`,
  `summarizeTierTable` ship rule, the fixture table.
- Count-guard tests bumped `EXPECTED_TOOL_COUNT` 78 → 79. Cross-checked green with
  A1's `open-server-verify*` / `open-server-incident*` after the merge (145 tests
  across the 9 files).

### Device test outcomes — run 34939934318 (`suite=latency`, benched SHA 4fb1916b)

`android-open-server.device.test.ts`, `OPEN_SERVER_DEVICE_TESTS=1`, x86_64/KVM:
**24/25 passed**. The three core A2 cases passed:

- A2 sequence — one `batch` of 3 (ms=[91.5, 520.4, 91.0]); search→type→tap moved the
  UI +18/−39 labels (navigation confirmed).
- A2 sequence skip — step 0 error → step 1 `skipped`.
- A2 index tap — index [7] "Network & internet" @v175 → tap (407,860); +17/−40.

The one failure, **A2 stale index**, was a TEST-ORDERING bug: it ran on the sub-screen
the prior test left, so its tap did not navigate and the AX version stayed 184
(`expect(184).not.toBe(184)`). Fixed (commit `e2688918`): both §B device cases now
`freshSettings()` first and poll for the version to advance before asserting the
`stale_index` refusal. The stale-index rule itself is unit-green. Not re-benched — the
one-bench-run rule reserves a second run; a confirming device-suite run of the fixed
case is pending.

### Latency verb table (p50 ms) vs the same-run proprietary control (N=20)

Nothing on the default path changed; the profile matches the accepted reference
(swipe/pinch win, tap accepted-parity, awaits win):

| verb              | ON-uiautomation | ON-input-manager (default) | OFF-1 | OFF-2 | Δ(im−off)            |
| ----------------- | --------------- | -------------------------- | ----- | ----- | -------------------- |
| describe          | 38              | 38                         | 48    | 48    | −10                  |
| gesture-tap       | 78              | 54                         | 52    | 52    | +2 (accepted parity) |
| gesture-swipe     | 282             | 263                        | 298   | 299   | −35.5 win            |
| gesture-pinch     | 336             | 314                        | 349   | 347   | −34 win              |
| await-screen-idle | 293             | 295                        | 491   | 486   | −193 win             |
| await-ui-element  | 32              | 33                         | 71    | 71    | −38 win              |
| paste             | 362             | 284                        | 475   | 505   | win                  |

Matches run 34870686468 / the reference profile; the pre-registered P2 tap inequality
is the same planner-accepted parity (Δ +2, floor 0), not a new A2 regression. First-
attempt landing 100% every block; 0 `unavailable` inject fallbacks (161/161).

### Docs

`packages/docs/docs/reference/tools.mdx` (gesture-sequence row + "Gesture bursts" and
"Element-index taps" subsections) and `packages/docs/docs/features/open-device-server.mdx`
(burst + index-tap notes). `npx docusaurus build` + `npm run format` to run in the
MAIN checkout after merge — NOT run in the worktree (docs devDeps not installed).

### Adversarial-review fixes (2026-09-15-review-a2-findings.md → merge-with-fixes)

Applied on the same branch (PR #6 hygiene only, no new bench run):

- **A2-H1** — `gesture-tap { target, verify }` no longer drops `verify`: the target
  resolves to its coordinate and the verify path then cross-checks the selector on
  the LIVE tree (mismatch → `verify_mismatch`). Tested both the match and the refusal.
- **A2-H3** — `gesture-sequence` registered in `flow-nested-outcome.ts`, so an aborted
  burst FAILS the flow step (a step `error`/`dropped`/`skipped` → fail), closing the
  #606 class. Tested.
- **A2-H2/M1/M2** — Result wording above: locate is **parity** (608/608, counted the
  same way); "eligible to be a default" removed; the token table is a reconstruction
  over 14 distinct Settings screens from 2 runs with `full` = `compact` by
  construction. The generator now scores index locate like-for-like (identity gate
  retired).
- **A2-M5** — at most ONE index `target` per burst; a later index target is refused
  `stale_index_in_burst` before any injection (every index resolves against the
  pre-burst snapshot). Tested + documented in the tool and `tools.mdx`.
- **A2-M6** — `resolveIndexTarget` now fails **closed**: an undefined live version
  refuses `stale_index` (was fail-open). The fail-open test is inverted.
- **A2-M7** — the `index` header states **active window only** and flags `truncated`
  at the node cap; documented in `tools.mdx`.
- **A2-M8** — `gesture-sequence` is `alwaysLoad: false` (Android-open-only, ~918
  tokens/session); the `searchHint` surfaces it on demand.
- **A2-M10** — `target` off the open path returns a structured
  `targetCode:"target_unsupported"` (not a thrown Error); a successful index tap
  returns `targetIndex`/`targetLabel`; `IndexTargetError` codes surface as structured
  `targetCode`. Tested.
- **Docs (A2-L6)** — "on the device" corrected to a host resolve; `index_out_of_range`,
  the one-index-per-burst rule, and active-window-only documented.

Pending for the NEXT pre-registered device/bench run (not done here):

- **A2-M3** — tool-level device coverage: drive `gesture-sequence`,
  `gesture-tap { target }`, `describe tier:"index"` through the registry (not
  `api.batch`), and a `{method:"wait"}` step.
- **A2-M4** — bench the MERGED head, not a pre-merge SHA, and diff the full verb table
  against 34939934318 at the OFF↔OFF floors.
- **A2-M1 (device half)** — one on-device `tier:"index"` vs `tier:"compact"` token pair
  on the same screen, to replace the reconstruction.
- **A2-M9** — `settle` threading, the A1 incident line, and the screen-graph
  observation in the index tier (blockers only for a future default-tier promotion).

### Could not verify

- The fixed **A2 stale-index device case** and all the review fixes above are
  unit-green but NOT re-benched on a device (one-bench-run rule); their on-device
  green is inferred, and is batched into the next pre-registered run (A2-M3/M4).
- Full type-aware **ESLint** ran in CI (green after removing an unused
  `eslint-disable`); locally it could not run (docs `@docusaurus/tsconfig` not
  installed in the worktree — resource policy forbids `npm install`).
- Default-tier promotion of `index` is deferred (A2-M7/M9/M1), not decided here.
