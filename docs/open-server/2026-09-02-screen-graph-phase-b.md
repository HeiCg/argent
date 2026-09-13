# Ticket: Screen-graph Phase B — host-side screen graph, describe tiers, navigateTo

Design: `2026-09-02-screen-graph-architecture.md` §2.2, §2.3, §3. Depends on
Phase A RPCs (`state{version,hash,stateHash}`, `query`, `diff`, `awaitChange`,
action outcomes) — read Phase A's report for exact shapes before starting.
Repo: argent fork worktree `argent-sg`, branch `feat/screen-graph`
(/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-sg).
Commit locally, conventional style `feat(screen-graph): …`; do not push.
Never target the physical device `ZF524RZBHD`; emulator use only when told
the AVD is free.

## B1 Screen graph store (`packages/tool-server/src/screen-graph/`)
- `types.ts`: `ScreenNode {hash, firstSeen, lastSeen, visits, label?, compact:
  string (rendered describe at first visit), index: Record<selectorKey,
  {bounds, flags}>, thumbnailPath?}`, `Edge {from, action: CanonicalAction, to,
  count, successes, lastSeen}`, `CanonicalAction` = `{kind:'tap'|'longPress'|
  'swipe'|'back'|'typeText'|'key', target?: {id?|text?}, dir?: 'up'|'down'|
  'left'|'right'}`.
- `store.ts`: in-memory graph + JSON persistence per `(packageName,
  versionCode)` under argent's config dir (find the existing config/cache dir
  helper in `packages/configuration-core`; use `<dir>/screen-graph/<pkg>/
  <versionCode>.json`). Debounced write (500 ms), atomic rename. Never
  persist text of nodes flagged password/secret (`flags.password` or when a
  `secretsUsed` outcome preceded the observation — drop `compact` for that
  node and mark `redacted: true`).
- `canonical.ts`: map tool invocations to `CanonicalAction` (prefer
  resource-id, else text, else coordinates bucketed to 1/16 screen).
- `plan.ts`: Dijkstra over edges with `w = 1/(successes+1) + staleness(days)/30`;
  `plan(from, to)` and `planToSelector(from, selector)` (targets nodes whose
  index contains the selector).

## B2 Wiring into the open Android path
- After every open-path action with an outcome: `store.observe(before.hash,
  action, after.hash)`; when `after.hash` unknown → fetch compact tree
  (existing describe open path, compact) and insert node with index built
  from the tree.
- `describe` tool (android open path): new param `tier: 'summary'|'compact'|
  'full'` (default `compact` — keep current behaviour default; the agent-facing
  default switch is a separate decision). `summary` = `{screen: label|hash8,
  visits, affordances: top-N outgoing edges by count with their targets'
  labels, changedSince?: diff vs last visit if `stateHash` differs}` rendered
  ≤ ~100 tokens. `compact` served from node cache when `stateHash` matches
  the stored one, else patched with `diff` when only text changed, else
  refreshed.
- New tool `navigate-to` (android, flag-gated by `open-device-server` AND a
  new flag `screen-graph`, default off): input `{target: {screen?: string,
  selector?: Selector}}`; executes the planned path step by step via the
  same action tools, verifying `after.hash` at each step; on divergence stops
  and returns `{reachedStep, expected, actual}`. Returns final `summary`.
- `await-ui-element` / `await-screen-idle`: use `awaitChange` (Phase A) —
  confirm Phase A already did this; otherwise do it here.

## B3 Labels
- Optional LLM labelling is out of scope; provide `label` from heuristics:
  activity name (`getInfo`/`state.screen.activity`) + first toolbar/title
  text (`android:id/action_bar`, `toolbar`, largest-font text at top) →
  e.g. `SubSettings: Network & internet`. Deterministic, tested.

## Tests (vitest, `packages/tool-server/test/screen-graph-*.test.ts`)
- store: observe/persist/load round-trip; secret redaction; debounce.
- plan: shortest path with weights; unreachable → null; staleness effect.
- describe tiers: summary rendering ≤ 120 tokens (chars/4) on the Settings
  fixture; compact cache hit when stateHash equal (no client call), patch
  path when only text differs (uses diff mock), refresh otherwise.
- navigate-to: happy path (3 edges), divergence at step 2, flag off → tool
  absent/not registered.
- Reuse fixtures from Phase A tests.

## Acceptance
- `npm run test -w @argent/tool-server` green; `tsc --noEmit` clean.
- Report: tool/param shapes, token size of `summary` on fixtures, files,
  deviations. On-device numbers later in Phase C.
