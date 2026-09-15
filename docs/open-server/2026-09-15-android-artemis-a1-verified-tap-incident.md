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

## Result

Delivered on branch `feat/open-server-a1-verified-tap` (off `open/main` @ d1d4b34c),
worktree `../argent-fork-wt-a1`. PR **#5** → `open/main`. Root `node_modules`
symlinked; no npm install / gradle; Kotlin untouched (the `query` RPC already
returns `version` + the compact node records the resolver needs, and `QueryHandler`
arms the version clock on every read, so no field was missing).

### Commits (per part)

- `f510f094` — B: incident state machine + describe line
- `7b32602f` — A: verified tap/swipe (`verify: {selector}`)
- `c31fc81c` — tests
- `ed02f027` — docs
- `aa4bb319` — hygiene fix (knip `OpenServerIncident` use, eslint no-useless-assignment)

### A — verify contract as implemented

- Param: `verify: { selector: <ScreenSelector grammar>, tolerancePx?: number }`,
  optional, on `gesture-tap` and `gesture-swipe` (start point). Zod:
  `verifyParamSchema` in `src/utils/open-server-verify.ts:60`. Selector = bare string
  (exact) or `{ contains|equals|regex, caseInsensitive? }` per `id`/`text`/`class`,
  plus `index`/`visible`/`containsDescendant` (mirrors `ScreenSelector.kt`).
- Flow: host runs the server-side `query` RPC on the LIVE tree (arms the version
  clock), then `resolveVerify` (`src/utils/open-server-verify.ts:88`) resolves a unique
  node via `pickUniqueNode`'s precedence (`src/screen-graph/bench/locate.ts`), the same
  resolver the bench `locateNorm` uses. Host funcs `openServerVerifiedTap` /
  `openServerVerifiedSwipe` in `src/utils/open-server-input.ts:334` / `:430`.
- One match → tap the bounds center (swipe: start at center, end as given). Coordinate
  cross-check: x/y outside `bounds ± tolerancePx` → refuse `verify_mismatch`, return the
  requested px + matched bounds + label.
- Error codes (reply, tool result): `verify_not_found` (0 matches, no bounds),
  `verify_ambiguous` (>1, up to 5 `candidates` {label,bounds}), `verify_mismatch`.
  Refusals issue no tap and never fall back to the proprietary backend.
- Reply fields: `verified`, `resolvedBounds`, `version`, `verifyMs` (the one `query`
  RPC ms), plus `verifyCode`/`candidates`/`requestedPx`/`mismatchLabel` on refusals.
  Wired in `src/tools/gesture-tap/index.ts:192` and `src/tools/gesture-swipe/index.ts:210`.
- Cost: exactly one `query` RPC per verified gesture; none when `verify` is absent.

### B — incident state machine + describe header

- `src/utils/open-server-incident.ts`: per-device `lastIncident = { tool, code, message,
at, consecutiveFailures, label? }` in a host Map (no device RPC, no restart
  persistence). `recordIncident` (set/increment), `clearIncident` (reset on success),
  `getIncident`. Codes: `verify_not_found` / `verify_ambiguous` / `verify_mismatch` /
  `no_effect` (verified tap that landed, `changed:false`) / `timeout` (RPC error).
- Wiring: each verify refusal and each no-effect verified tap records; a landed change
  and every plain successful tap/swipe clears (`gesture-tap`/`gesture-swipe`).
- describe header (open Android path only), set in
  `src/tools/describe/platforms/android/index.ts` and prepended in
  `src/tools/describe/index.ts`:
  `incident: <tool> <code> ×<n> — <hint>`; after 3 in a row adds
  `; consider a different approach`. Hints: not_found → "re-describe and pick a visible
  label"; ambiguous → "add a second field to the selector"; mismatch → "your coordinates
  point at <label>". **Measured token cost (js-tiktoken o200k_base): 19 tokens at ×1,
  worst case 24 tokens (escalated).**

### Unit tests (all green, `vitest --maxWorkers=2`)

- `open-server-verify.test.ts` (23): unique/none/ambiguous/mismatch, CONTAINS-tier,
  tolerance, `toBenchSelector`, and precedence parity with `pickUniqueNode`.
- `open-server-incident.test.ts` (11): set/count/reset, per-device isolation, hint table,
  header line, ≤30-token budget (worst 24).
- `open-server-verify-tap.test.ts` (11): **default path sends NO `query` RPC** and the
  plain tap/swipe args are byte-identical; verify taps the center; each refusal issues no
  tap and no proprietary fallback; records/clears the incident; tolerance widens the band.
- `open-server-describe-incident.test.ts` (4): open describe prepends the line while active,
  per device.
- Full tool-server unit suite green in CI (Unit tests check, run 34936814986). `tsc`
  clean for src and tests; Prettier-clean.

### Device-test outcomes (bench run 34935973523, CI emulator android-34 google_apis x86_64/KVM)

Device suite **green** (enforced step passed). The three A1 cases + verifyMs, driving the
same `resolveVerify` resolver against the live `query`:

- `verify:{text:"Network & internet"}` → resolved unique, tapped center, **navigated**
  (+17/−40 labels). PASS.
- `verify:{text:"Internet"}` on the root → **verify_not_found** (0 query nodes — bare
  string is exact, so it never matches "Network & internet"); no tap, screen unchanged.
  PASS. (Recorded which: not_found.)
- correct selector + wrong x/y (5,5) off bounds [189,824,625,895] → **verify_mismatch**,
  no tap. PASS.
- **`verifyMs` p50 = 2 ms** over N=12 `[54,2,2,2,2,2,2,2,2,2,2,2]` (first call 54 ms is the
  cold clock-arm). PASS.

### Latency floors — bench run 34935973523 (`suite=latency`, blocks OFF-1/ON-uiautomation/ON-input-manager/OFF-2, N=20), conclusion success

Verb p50 (ms):

| verb              | OFF-1 | ON-uia | ON-input-manager | OFF-2 | OFF↔OFF drift |
| ----------------- | ----- | ------ | ---------------- | ----- | ------------- |
| describe          | 52    | 49     | 52               | 52    | 0             |
| gesture-tap       | 53    | 80     | 55               | 53    | 0             |
| gesture-swipe     | 296   | 300    | 272              | 296   | 0             |
| gesture-pinch     | 344   | 343    | 322              | 349   | 5             |
| await-screen-idle | 497   | 305    | 304              | 499   | 2             |
| await-ui-element  | 76    | 43     | 44               | 76    | 0             |
| tap+describe      | 421   | —      | —                | 420   | 1             |

Default (verify-absent) path unchanged vs the reference verdict of run 34904658366:
gesture-swipe −24 (P3 PASS, CI [−33,−6.5]), gesture-pinch −24.5 (P4 PASS), gesture-tap
+2 at a ±0 floor (P2 pre-registered fail-by-2, planner-accepted parity), P6 PASS; the
untouched proprietary OFF blocks reproduce the reference floor (describe 52, tap 53, swipe
296). `injectStrategyCounts.unavailable` = 0/161; first-attempt landing PASS. The
byte-identical default path is proven at the unit level (no `query` RPC, identical plain
tap/swipe args when `verify` is absent).

### Docs

- `packages/docs/docs/reference/tools.mdx`: `verify` param, selector grammar, reply
  fields + the three error codes; the describe execution-incident line + hint table.
- `packages/docs/docs/features/open-device-server.mdx`: short conceptual note (verified
  taps + incident line).
- `npx docusaurus build` (Docs build CI check green, run 34936814912) + `npm run format`
  are to be run in the MAIN checkout after merge — **not run in the worktree**.

### CI

- One bench run: **34935973523** (`suite=latency`, default blocks) — success; screen-graph
  job correctly skipped. One `gh run download` used for the artifacts above.
- PR #5 hygiene checks (on `aa4bb319`), all green: Prettier 34936814872, ESLint
  34936814861, Knip 34936814862, Docs build 34936814912, Lockfile 34936814854, Static
  checks 34936814936, Tool Description Quality 34936814997, Unit tests 34936814986.

### Not verified / open

- Adversarial review + merge are deferred per the ticket (do not fast-forward `open/main`).
- A direct cell-by-cell diff vs run 34904658366 was not tabulated: its full verb table is
  not in-repo and the one-download budget was spent on the run under test. The equivalence
  is instead established by the reproduced proprietary OFF floor, the matching gate
  verdicts, and the unit-level no-`query` proof.
