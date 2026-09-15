# Ticket: Artemis A1 — verified tap (`verify: {selector}`) + execution incident in context (Android open driver)

From README "Execution order" step 3 and the 2026-09-13 Artemis note (ideas, not code:
XML-first target verification before executing; an execution incident with a
consecutive-failure count kept in the agent's context). Base: `open/main` @ HEAD
(≥ 2d1befb1). Android only, open driver only (`shouldUseOpenServer`), proprietary path
untouched.

## A. Verified tap

- `gesture-tap` (and `gesture-swipe` start point) accept an optional `verify` param:
  `{ selector: <ScreenSelector grammar as in QueryHandler.kt / ScreenSelector.kt>,
tolerancePx?: number }`. Before injecting, the host runs the server-side `query` RPC on
  the LIVE tree (never a cached describe), with `fingerprints: true` so the read arms the
  version clock: exactly one match → tap its bounds center (if x/y were also given and
  they fall outside the match's bounds ± tolerance, refuse with `verify_mismatch` and
  return both); zero matches → refuse with `verify_not_found` (no tap issued); several →
  refuse with `verify_ambiguous` listing up to 5 candidates (label, bounds). The reply
  carries `verified: true`, `resolvedBounds`, `version`. Reuse `pickUniqueNode`'s
  precedence (`src/screen-graph/bench/locate.ts`) so the tool and the screen-graph
  harness resolve identically. No extra RPC when `verify` is absent (latency rows must
  not move: the default path is byte-identical).
- Cost: one `query` RPC (server-side selector on the last snapshot) — record its ms in
  the reply (`verifyMs`) so the bench can report it.

## B. Execution incident

- Per device, the tool-server keeps `lastIncident = { tool, code, message, at,
consecutiveFailures }` updated on every tool failure (verify refusals, no-effect taps
  when the caller asked for `verify`, timeouts) and reset on the next success. `describe`
  (open path) prepends ONE line to its output when an incident is active:
  `incident: <tool> <code> ×<n> — <hint>` (hint table: not_found → "re-describe and pick
  a visible label"; ambiguous → "add a second field to the selector"; mismatch → "your
  coordinates point at <label>"). After 3 consecutive failures the line adds
  "consider a different approach". Tokens: the line is ≤ 30 tokens; measure and state.
- Nothing persists across tool-server restarts; no new RPC on the device.

## Tests

- Unit: selector resolution (unique / none / ambiguous / mismatch), precedence parity
  with `pickUniqueNode`, incident state machine (set / count / reset / hint table), the
  describe header line, and the default path sending no `query` RPC.
- Device (`android-open-server.device.test.ts`): tap with `verify: {text:"Network &
internet"}` navigates (effect oracle); `verify: {text:"Internet"}` on the root refuses
  `verify_not_found` (or `ambiguous` if the collapsed row matches — record which) and
  issues no tap; a wrong x/y with a correct selector refuses `verify_mismatch`.
- One CI run `bench-open-vs-proprietary.yml` `suite=latency` default blocks: device suite
  green; every latency verb within its OFF↔OFF floor of run 34904658366 (the default
  path is untouched — prove it); report `verifyMs` p50 from the device test (N ≥ 10).
  Polling one `gh run view` per 10 min as a single background `sleep 540; gh run view`
  call; never loop; one `gh run download`.

## Docs

`packages/docs/docs/reference/` tool page for `gesture-tap` (`verify` param, error
codes) and `describe` (incident line); a short `features/` note. Run
`npx docusaurus build` in `packages/docs/` and `npm run format` in the MAIN checkout
after merge (say it was not run in the worktree). Prettier-clean before every push.

## Process

Branch `feat/open-server-a1-verified-tap`, worktree `../argent-fork-wt-a1` (never /tmp;
root `node_modules` symlinked; no npm install / gradle; Kotlin unchanged unless the
`query` RPC lacks a field you need — say so). Do not touch iOS files (another agent on
`feat/ios-open-server-2-1-harness`). Open a PR to `open/main` for the hygiene checks.
Append `## Result` here; adversarial review before merge; do not fast-forward `open/main`.
