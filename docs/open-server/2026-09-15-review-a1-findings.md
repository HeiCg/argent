# Adversarial review — Artemis A1 (verified tap `verify:{selector}` + execution incident line)

Subject: branch `feat/open-server-a1-verified-tap` @ `e4bf8aba` (commits `f510f094`,
`7b32602f`, `c31fc81c`, `ed02f027`, `aa4bb319`, `e4bf8aba` off `open/main` @ `d1d4b34c`),
worktree `../argent-fork-wt-a1`, PR **#5** → `open/main`. Ticket + Result:
`docs/open-server/2026-09-15-android-artemis-a1-verified-tap-incident.md`.

## Reviewed + evidence

Read (worktree paths, all read-only): `src/utils/open-server-verify.ts`,
`src/utils/open-server-input.ts`, `src/utils/open-server-incident.ts`,
`src/tools/gesture-tap/index.ts`, `src/tools/gesture-swipe/index.ts`,
`src/tools/describe/index.ts`, `src/tools/describe/contract.ts`,
`src/tools/describe/platforms/android/index.ts`, `src/screen-graph/bench/locate.ts`,
`packages/android-device-server/.../QueryHandler.kt`, `.../ScreenSelector.kt`,
`.../TreeStore.kt`, the four A1 unit tests, the device-test block, and both docs pages.

Ran: `npx vitest run --maxWorkers=2` over the four A1 unit files — **42 passed / 4 files**
(no emulator, no install). One `gh run download 34935973523 -n bench-latency` (verb table,
`scoreboard.md`, `logs/device-test.log`) and one `gh pr view 5 --json files,additions,deletions`.

PR scope: 16 files, +1756/−1. No iOS file, no Kotlin file, no workflow file. Within the
ticket's scope; `describe/contract.ts` and `describe/index.ts` are shared, but the new field
is only ever set by the Android open branch.

Confirmed as specified: one `query` RPC per verified gesture and none otherwise; query +
gesture run under one device lock (`withServer`, `open-server-input.ts:209-216`); the
resolver is `pickUniqueNode` itself, imported, not copied (`open-server-verify.ts:14,127`);
`QueryHandler.kt:21-22` calls `TreeStore.armClock()` on every `query`, so the ticket's
`fingerprints:true` is moot for `query` (the RPC has no such option and always returns
`version`/`hash`/`stateHash`); the guard compares device **pixels** to pixel bounds after
`toPixels` (`open-server-input.ts:428-431`, `:493-496`) — no px/normalized unit bug;
refusals return before any `tap`/`swipe` RPC and rethrow instead of falling through to the
proprietary branch (`gesture-tap/index.ts:207-214` vs the plain branch's swallowing
`catch`); the device suite was green (25 tests, `logs/device-test.log:157-158`) and the
Result's verb table reproduces the artifact cell for cell.

## VERDICT

**merge-with-fixes.** The default path is genuinely untouched (no new RPC, no new await —
see the proof section), the contract and the incident machine are well-factored and tested,
and the bench evidence checks out against the artifact. But three HIGH items make the
feature unsafe to advertise as shipped: most of the documented selector grammar cannot
resolve at all and hard-fails closed, a refusal still tells the agent "Tapped at (x%, y%)",
and the mandatory `x`/`y` with `tolerancePx` defaulting to 0 makes the guard refuse exactly
the drifted-coordinate case the feature exists to fix. H1 and H2 are small, local fixes;
H3 is a contract decision for the planner. Nothing here justifies reverting the branch.

## HIGH

### A1-H1 — most of the documented selector grammar always refuses `verify_not_found`

`toBenchSelector` (`src/utils/open-server-verify.ts:100-108`) projects the selector onto
`{id?, text?}` via `needle` (`:94-98`), which keeps only a bare string or an
`equals`/`contains` literal. Everything else is dropped: `class`, `containsDescendant`,
`index`, `visible`, and a pure `regex` matcher. `resolveVerify` then calls
`pickUniqueNode(nodes, {})` (`:127`), and `pickUniqueNode` with neither `wid` nor `wt` falls
straight through to `return { ambiguous: false }` (`src/screen-graph/bench/locate.ts:36-55`)
— so `resolveVerify` returns `{kind:"not_found"}` (`:150`) **even when the server returned
exactly one node**. Concretely, every one of these refuses and records an incident:

- `verify:{selector:{class:"android.widget.Button"}}`
- `verify:{selector:{text:{regex:"Net.*"}}}` — the existing test asserts the empty
  projection (`test/open-server-verify.test.ts:161-163`) without asserting the consequence
- `verify:{selector:{containsDescendant:{text:"Wi-Fi"}}}` / `{visible:true}` / `{index:2}` alone
- `verify:{selector:{id:{contains:"title"}}}` — the id tier in `pickUniqueNode` is
  whole-field EXACT only (`locate.ts:44-47`), there is no contains tier for `id`

All six shapes are accepted by `verifyParamSchema` (`open-server-verify.ts:37-59`),
advertised in the tool description (`gesture-tap/index.ts:42-51`) and tabulated as
supported in `packages/docs/docs/reference/tools.mdx` ("`class`", "`index`", "`visible`",
"`containsDescendant`", "`{ regex }`"). The docstring at `open-server-verify.ts:88-93`
rationalises the drop with "the query result set already reflects the regex" — true of the
server, but the host resolver never consults the result set when the projection is empty.

The "precedence parity" test (`test/open-server-verify.test.ts:166-190`) cannot catch this:
it feeds `pickUniqueNode` the same projected selector and compares, so it is tautological
over the projection.

Fix options for the planner: (a) accept the server's answer when `q.nodes.length === 1` and
the projection is empty (consistent with the ambiguous branch's own comment, "the matches
ARE the candidates", `:144-146`); or (b) narrow schema + docs to `id`/`text` literals and
reject the rest with a distinct code. Either way the docs table must match.

### A1-H2 — a refusal still reports "Tapped at (50%, 15%)" to the agent

`gesture-tap`'s `completedMsg: ({ params }) => tapDescription(params, "past")`
(`src/tools/gesture-tap/index.ts:138`, `:87-100`) ignores the result, so a
`verify_not_found` / `_ambiguous` / `_mismatch` return — which sets `tapped:false` and
issues no injection — is still narrated as `Tapped at (x%, y%)`. Same in
`gesture-swipe/index.ts:153-154` (`Swiped from … to …`). The framework supports
`completedMsg: ({ result }) => …` (see `src/tools/screenshot/index.ts:135`) and a
`failedMsg`/`failureSignal` channel (`gesture-swipe/index.ts:155`), so a refusal can be
narrated or signalled as a failure. As shipped, the agent's most visible line contradicts
the structured result, which defeats the point of refusing.

### A1-H3 — `x`/`y` are mandatory and `tolerancePx` defaults to 0, so verify refuses the drift it was built to catch

The ticket says "**if** x/y were also given"; `gesture-tap`'s schema makes `x` and `y`
required (`src/tools/gesture-tap/index.ts:29-30`), and the host always builds a guard with
`tolerancePx: verify.tolerancePx ?? 0` (`src/utils/open-server-input.ts:431`, `:496`). There
is no way to express "I do not know where it is, resolve it for me": the caller must already
supply a coordinate that lands **inside** the element's bounds, otherwise `verify_mismatch`
— even though the selector resolved uniquely and the correct center is in hand
(`open-server-verify.ts:130-139`). The documented promise in
`packages/docs/docs/features/open-device-server.mdx` ("a stale coordinate no longer taps the
wrong thing") is only half true: a stale coordinate produces a refusal plus an incident, not
a corrected tap. Options: make `x`/`y` optional when `verify` is present; or default the
guard off (guard only when `tolerancePx` is supplied, or add `guard:false`); or keep the
behaviour and rewrite ticket + docs to say the coordinate is a mandatory cross-check.

## MEDIUM

### A1-M1 — the incident is cleared only by a successful tap/swipe; no TTL

`clearIncident` is called from exactly four places, all in `gesture-tap` (`:218`, `:273`,
`:283`) and `gesture-swipe` (`:232`, `:296`, `:309`). No other tool clears it: `type-text`,
`press-key`, `launch-app`, `navigate-to`, `describe` itself all leave it standing. The
`at` timestamp is recorded (`open-server-incident.ts:31`, `:66`) and never read, so there is
no age-out either. Result: after one `verify_not_found` the agent can run a dozen successful
non-gesture steps and every `describe` still prepends `incident: gesture-tap
verify_not_found ×1 — …`. The planner should decide whether "success on a different tool"
clears (my read: it should, or at minimum an age-out of a few minutes / a `describe` after N
reads), and the docs sentence "The next successful gesture clears the line" should say
_gesture_, which it currently does — the feature note in `open-device-server.mdx` says "The
next success clears the line", which is wrong as implemented.

### A1-M2 — the `label` in the incident line is unbounded, so the "≤30 tokens" budget is not a bound

`incidentHint` interpolates `incident.label` verbatim (`open-server-incident.ts:99-104`),
and the label comes from `nodeLabel` (`open-server-verify.ts:111-113`), which returns the
node's full `text`, else `cd`, else `id` — untruncated. The ≤30-token test only ever uses
`"Network & internet"` (`test/open-server-incident.test.ts:124-158`). A mismatch against a
paragraph-sized `TextView` or a long content-description injects that whole string into
every subsequent `describe`. Clamp the label (e.g. 40 chars + ellipsis) before storing.

### A1-M3 — the verify `query` carries no `limit`

`server.query(verify.selector)` (`open-server-input.ts:428`, `:493`) passes no options,
unlike `navigate-to/index.ts:309` (`{limit: 20}`). `ScreenSelector.query` returns _every_
match (`ScreenSelector.kt:22-37`), so a broad selector (`{visible:true}`,
`{class:"android.widget.TextView"}`) serialises the whole matching forest over the RPC. The
`verifyMs` p50 of 2 ms was measured with a single-node selector only
(`device.test.ts:1411-1423`), so it does not bound the broad case. A limit must stay > 1 (a
limit of 1 would turn ambiguity into a false unique), e.g. 50.

### A1-M4 — the device tests bypass the tool entirely

The three A1 device cases call `api.query` + `resolveVerify` + `api.tap` directly
(`test/blueprints/android-open-server.device.test.ts:1319-1424`); they never go through
`createGestureTapTool` / `openServerVerifiedTap`. So on device the review has proof that the
_resolver_ behaves against a live tree, but no proof that the _tool_ issues no injection on
a refusal — the "no tap issued, screen unchanged" assertion is trivially true because the
test itself never taps. Nothing device-side exercises the incident recording or the describe
header. The unit tests do cover the tool-level refusal
(`test/open-server-verify-tap.test.ts:178-232`), which is why this is MEDIUM and not HIGH.

### A1-M5 — `verify` is silently ignored on iOS and on the proprietary Android path

The iOS open-server branch is evaluated first (`gesture-tap/index.ts:177-191`), and the
verify branch is guarded by `shouldUseOpenServer(device)` (`:192`). Passing
`verify:{selector:…}` to an iOS device or an Android device off the open path therefore
issues a plain, unverified tap and returns `tapped:true` with no `verified` field. Docs say
"Ignored off the Android open path", but silently downgrading an explicit safety request is
the wrong default; refusing with an `unsupported` code would be safer.

### A1-M6 — `verify_ambiguous` candidates are the first 5 of _all_ query nodes, not of the ambiguous tier

`resolveVerify` builds candidates from `nodes.slice(0, 5)` (`open-server-verify.ts:147`).
`pickUniqueNode` can report ambiguity at a tier that is a strict subset of the result set
(e.g. 2 exact-text hits inside 8 contains-hits), so the listed candidates can include nodes
that were never the ambiguity, and can omit the ones that were (if they sit past index 5).
The hint tells the agent to "add a second field to the selector" based on a list that may
not describe the actual collision.

### A1-M7 — the `paste` verb is missing from the Result's floor table, and it has the largest OFF↔OFF drift

From the downloaded artifact of run 34935973523: `paste` p50 OFF-1 **891** vs OFF-2 **723**
(Δ 168 ms, p95 1411/1373). Every other verb in the Result's table matches the artifact
exactly (describe 52/49/52/52, gesture-tap 53/80/55/53, gesture-swipe 296/300/272/296,
gesture-pinch 344/343/322/349, await-screen-idle 497/305/304/499, await-ui-element
76/43/44/76, tap+describe 421/—/—/420). `paste` is simply absent from the table, while the
ticket asked for "every latency verb within its OFF↔OFF floor". `paste` does not touch the
A1 code path, so this is a reporting gap, not a regression signal — but it should be stated
rather than dropped.

### A1-M8 — a verified tap records no screen-graph observation

`openServerTapWithOutcome` reads the before-tree and calls `recordOpenServerObservation`
when recording is on (`open-server-input.ts:325-365`). `openServerVerifiedTap` does neither
(`:415-470`). If the screen-graph recorder is enabled and a caller uses `verify`, the edge
is lost from the graph. No harness uses `verify` today, so this is latent, not live.

## LOW

- **A1-L1** — the Result's unit counts are overstated: measured 18 / 10 / 10 / 4 = **42**
  (`open-server-verify` / `-verify-tap` / `-incident` / `-describe-incident`), not the
  23 / 11 / 11 / 4 = 49 written in the Result.
- **A1-L2** — the actual prepend seam is untested: no test asserts that
  `DescribeResult.description` starts with the incident line
  (`src/tools/describe/index.ts:26-31`); the four describe tests only assert the
  `incidentLine` field on the platform data (`test/open-server-describe-incident.test.ts:78-108`).
- **A1-L3** — the Result reports "gesture-pinch −24.5 (P4 PASS)"; the artifact's
  `scoreboard.md:90` says "P4 … Δ -22 ≤ floor 5, CI [-32.5, -17]" (the gate uses min(OFF),
  the Result appears to use the OFF mean). P2/P3/P5/P6 verdicts match the artifact verbatim.
- **A1-L4** — every throw inside the verified path is recorded as `code:"timeout"`
  (`gesture-tap/index.ts:209-213`, `gesture-swipe/index.ts:224-229`), including
  "tap was dropped by the input dispatcher" (`open-server-input.ts:457`) and registry
  resolution failures; the agent then reads "the device did not answer, retry".
- **A1-L5** — "LIVE tree" means version-clock-keyed, not forced-fresh: `QueryHandler`
  calls `TreeStore.ensure()`, which serves a cached snapshot while the armed clock's
  `version` is unchanged (`TreeStore.kt:196-215`). `query` has no `flush` option (unlike
  `getState`). That is the same read the screen-graph harness uses, so parity holds, but the
  ticket's "never a cached describe" is satisfied only in the sense of "no host-side cache".
- **A1-L6** — the "19 tokens at ×1, 24 worst case" figure is a `console.log`
  (`test/open-server-incident.test.ts:157`); only `≤ 30` is asserted. Fine, but the number in
  the Result is not test-enforced.
- **A1-L7** — the ticket's `fingerprints:true` on the verify `query` is unimplementable as
  written: `query`'s options are `{limit?, fields?}` only
  (`src/blueprints/android-open-server.ts:506-509`). `QueryHandler.kt:21-22` arms the clock
  unconditionally, so the intent is met; the Result says this correctly.

## Default-path proof

Independent of the agent's summary:

1. **No new RPC.** `test/open-server-verify-tap.test.ts:100-128` drives the real
   `createGestureTapTool` / `createGestureSwipeTool` against a mock `OpenDeviceServerApi`
   and asserts `api.query` was never called, `api.tap` called once, and the argument tuple is
   exactly `(500, 300, { clickCount: 1, holdMs: 50, inject: "input-manager" })` — i.e. the
   pre-A1 payload, byte for byte. I re-ran it: green.
2. **No new await or branch cost on the default path.** The only additions reachable with
   `verify` absent are the short-circuit `params.verify` test in the `else if`
   (`gesture-tap/index.ts:192`, `gesture-swipe/index.ts:204`) and three synchronous
   `clearIncident(device.id)` calls (`gesture-tap:273,283`; `gesture-swipe:296,309`), which
   are a `Map.delete` on host memory. **Strictly, "byte-identical" is false at source level**
   — a `Map.delete` per successful gesture is new work — but it is not an await, not an RPC,
   and not measurable at the ms resolution of the bench. The honest claim is "no new RPC and
   no new await"; the Result should be softened to that.
3. **Describe is untouched unless an incident exists.** `incidentLine` is set only in the
   `source:"open-device-server"` return of `describeAndroid`
   (`platforms/android/index.ts:169-177`) and only prepended when defined
   (`describe/index.ts:28-31`). No code path outside `gesture-tap`/`gesture-swipe` with
   `verify` ever calls `recordIncident` (grep over `src`: 4 call sites, all in those two
   tools' verify branches), and both plain gesture paths call `clearIncident` on success.
   So a bench or screen-graph run that never passes `verify` can never see the line —
   describe tokens/step measurements are unaffected.
4. **Artifact floors.** Downloaded `bench-block-*.json` of run 34935973523 give OFF-1/OFF-2
   drifts of 0 (describe 52/52), 0 (gesture-tap 53/53), 0 (gesture-swipe 296/296),
   5 (gesture-pinch 344/349), 2 (await-screen-idle 497/499), 0 (await-ui-element 76/76),
   1 (tap+describe 421/420) — and 168 for `paste` (A1-M7). The verb table of the reference
   run 34904658366 is not in-repo, so a cell-by-cell diff remains impossible under the
   one-download budget; the in-repo narrative of that run
   (`docs/open-server/2026-09-14-open-server-phase3n3-post-merge-fixes.md:176,199-200`:
   OFF-1 describe p50 52; "im tap 54 / swipe 269 / pinch 316 vs OFF ~52-53 / ~299 / ~352")
   is consistent with this run's OFF floors and ON-input-manager numbers within a few ms.
   Gate verdicts P2–P6 in the artifact's `scoreboard.md:88-92` match the Result.

## Conflict surface with A2 (`feat/open-server-a2-sequence-index`)

The A2 ticket tells that agent not to touch the A1 files, but A2's own deliverables land in
them anyway:

- `gesture-tap`'s zod schema and `Result` interface: A1 adds `verify` + 7 result fields,
  A2 adds `target:{index,version}` + `stale_index`. Textual conflict in the same two hunks,
  and a semantic one — the branch order in `gesture-tap/index.ts:177-192` has to be extended
  to define what happens when both `verify` and `target` are passed.
- `describe/platforms/android/index.ts`: A1 adds the incident read at `:169-177`, A2 wires a
  new `tier: index` module into the same return. Plus a semantic hazard: A2's index tier
  renders `[i] label (role)` lines, and A1 prepends one line _above_ the tree
  (`describe/index.ts:30`) — any consumer that keys off line offsets must count the header.
- A1's incident line adds 19–24 tokens to a describe output; A2's "measure tokens first"
  table must be taken with no incident active or the per-tier numbers shift.

Recommended merge order: A1 first (smaller, self-contained), then A2 rebased on it, with A2
owning the `verify`/`target` precedence rule.

## Post-merge steps

1. Fix **A1-H1** before the feature is announced: either accept a lone server match when the
   projection is empty, or narrow `verifyParamSchema` + both docs pages to the resolvable
   subset. Add a test per dropped field (`class`, `regex`, `containsDescendant`, `visible`,
   `index`, `id:{contains}`) asserting the chosen behaviour.
2. Fix **A1-H2**: `completedMsg: ({ result }) => …` on `gesture-tap` and `gesture-swipe`, or
   route refusals through `failureSignal`, so the narrated line never claims a tap that did
   not happen.
3. Decide **A1-H3**: make `x`/`y` optional under `verify` (preferred — it is what makes the
   feature useful), or document the coordinate as a mandatory cross-check and drop the
   "stale coordinate" claim from `features/open-device-server.mdx`.
4. Clamp the incident `label` (A1-M2) and add a `limit` to the verify `query` (A1-M3).
5. Decide the incident clear/expiry policy (A1-M1) and correct the sentence "The next
   success clears the line" in `features/open-device-server.mdx` to say _gesture_.
6. Correct the Result doc: unit counts 18/10/10/4 = 42 (A1-L1), P4 Δ −22 per the artifact
   (A1-L3), add the `paste` row with its 168 ms OFF↔OFF drift and the reason it is out of
   scope (A1-M7), and replace "byte-identical" with "no new RPC and no new await"
   (Default-path proof §2).
7. In the MAIN checkout after merge, run `npx docusaurus build` in `packages/docs/` and
   `npm run format` from the repo root — the Result states neither was run in the worktree
   (the Docs-build CI check on `aa4bb319` was green, run 34936814912).
8. Follow-ups that need a device run, batch them with the next bench: a tool-level device
   case that calls `createGestureTapTool` with `verify` and asserts no injection on refusal
   (A1-M4), and a screen-graph observation on the verified tap path (A1-M8).
