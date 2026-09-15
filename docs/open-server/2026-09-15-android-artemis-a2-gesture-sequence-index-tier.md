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
