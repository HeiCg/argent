# Adversarial review — Artemis A2 (`gesture-sequence` + index describe tier + `target:{index,version}`)

Subject: `feat/open-server-a2-sequence-index` @ `180d4a52` (PR #6 → `open/main`), worktree
`/Users/heicg/Desktop/projects/argent-fork-wt-a2` (read-only here). Ticket + Result:
`docs/open-server/2026-09-15-android-artemis-a2-gesture-sequence-index-tier.md`. Conventions
from `2026-09-15-review-a1-findings.md`; rules from `docs/open-server/README.md`.

## Reviewed + evidence

- **Diff**: 17 files, +1775/−33 (`gh pr view 6 --json files`; `git diff --stat` off merge-base
  `4f601624`). No workflow, no `scripts/`, no iOS, no AndroidWorld file touched — **no scope
  creep**.
- **Kotlin batch**: `packages/android-device-server/src/main/java/com/argent/devicecontrol/JsonRpcHandler.kt:281-385`
  (per-action `delayMs`, `wait` pseudo-method at `:315-319`, stop-on-first-failure `:341-380`,
  per-step `ms` `:337-374`).
- **Host burst**: `packages/tool-server/src/utils/open-server-input.ts:947-1092`
  (`buildSequenceActions`, `mapSequenceResults`, `openServerSequence`), tool
  `packages/tool-server/src/tools/gesture-sequence/index.ts:1-176`, API
  `packages/tool-server/src/blueprints/android-open-server.ts:286-316,486-493,1095-1102`.
- **Index tier**: `packages/tool-server/src/tools/describe/platforms/android/index-tier.ts:39-124`,
  resolution `packages/tool-server/src/utils/open-server-input.ts:810-864,866-892`, wiring
  `packages/tool-server/src/tools/describe/index.ts:174-186`, tap branch
  `packages/tool-server/src/tools/gesture-tap/index.ts:246-253`.
- **Token generator**: `packages/tool-server/src/screen-graph/bench/index-tier-tokens.ts:1-181`,
  fixture table `packages/tool-server/test/index-tier-tokens.test.ts:101-183`. Table
  **reproduced verbatim** in the worktree (`npx vitest run test/index-tier-tokens.test.ts
--maxWorkers=2 --disableConsoleIntercept`) and independently recomputed (below).
- **Tests re-run in the worktree** (`--maxWorkers=2`, all green): A2 `gesture-sequence` +
  `describe-index-tier` (16), `index-tier-tokens` (6), **A1's** `open-server-verify*` /
  `open-server-incident*` (61 across 5 files), catalog guards `interaction-messages` +
  `tool-input-schema-contract` (88). `EXPECTED_TOOL_COUNT` 78 (`git show
4f601624:…/test/helpers/catalog.ts:6`) → 79 (`test/helpers/catalog.ts:6`) confirmed.
  `npx prettier --check` clean on the changed docs/MDX/TS I touched.
- **Artifacts**: one `gh run download 34939934318 -n bench-latency` (no `.bench-results/` in the
  worktree). Verb p50s recomputed from `bench-block-*.json`; device log
  `logs/device-test.log:127-171`.
- Batch callers: repo-wide grep (`'"batch"'`, `.batch(`, excluding `node_modules`) finds **no
  in-tree caller besides A2** — the screen-graph harness and `navigate-to` do **not** use it.

## VERDICT

**MERGE WITH FIXES.** The feature is additive and the default path is genuinely untouched
(proof below); Kotlin, host and docs are coherent and well commented; the verb table matches
the artifact cell for cell. Three things should land before the merge commit: the
`verify`+`target` precedence rule (A2-H1), the flow-verdict registration (A2-H3), and the
Result's ship-rule wording (A2-H2) — the savings half of the rule survives review, the locate
half does not. The `index` tier should **stay opt-in**; it is not ready to be a default
anywhere (A2-M7, A2-M9).

### Default-path / behaviour-change proof (independent)

1. **No existing `batch` caller changes behaviour.** The only `batch` call sites in the repo are
   `open-server-input.ts:1087` (new) and the two A2 device cases; the iOS runner has its own
   `batch` (`packages/tool-server/src/utils/ios-open-server-client.ts:39`,
   `packages/ios-device-server/ArgentRunner/ArgentRunnerUITests/RunnerSerializerTests.swift:69`)
   that A2 does not touch. So stop-on-failure + `ms` + `delayMs` break nothing in tree; the
   semantics are nonetheless a **contract change** for any out-of-tree caller (a batch of
   independent actions now aborts at the first `success:false`/`dropped`/error) and Android's
   `batch` now diverges from the iOS one.
2. **`gesture-tap`**: with `target` absent the added cost is one `!== undefined` test
   (`gesture-tap/index.ts:246`). **`describe`**: one `params.tier === "index"` test
   (`describe/index.ts:174`). Registration adds one tool (`setup-registry.ts:145`).
3. **Injection strategy inside a burst** is the shipped default, per step: the host threads
   `injectOpt()` (= `resolveInjectStrategy()`, `open-server-input.ts:76-79`) into every
   `tap`/`swipe` action (`:966-995`), and Kotlin recurses through the full `handle()`
   (`JsonRpcHandler.kt:329-336`), so each step takes the same path as a single `tap`. Run
   artifact: `injectStrategyCounts {"input-manager":161}`, `161/161`, `degradedReasons []`,
   0 fallbacks/errors in every block.
4. **A dropped tap inside a batch is reported**: `TapHandler.kt:49-50` sets
   `success:!dropped` + `dropped:true`; batch preserves both keys, marks the burst failed
   (`JsonRpcHandler.kt:347-348`) and `mapSequenceResults` surfaces `{success:false,
dropped:true}` (`open-server-input.ts:1030-1036`; unit test `gesture-sequence.test.ts:135`).
5. **Verb table vs the artifact** (p50 ms, N=20, recomputed from `bench-block-*.json` of run
   34939934318): describe 38/38/48/48, gesture-tap 78/54/52/52, swipe 282/263/298/299, pinch
   336/314/349/347, await-screen-idle 293/295/491/486, await-ui-element 32/33/71/71, paste
   362/284/475/505 — **identical to the Result's table**; Δ(im−OFFmean) = tap +2, swipe −35.5,
   pinch −34, idle −193.5 (Result says −193), ui-element −38. OFF↔OFF drift: 0 on describe,
   tap, ui-element; 1 swipe; 2 pinch; 5 idle; **30 paste**; 50 `tap+describe`. The ticket's
   named floor run (34904658366) has no in-repo verb table (same limitation A1's review hit),
   so the Result substitutes 34870686468; the in-repo narrative of 34904658366
   (`2026-09-14-open-server-phase3n3-post-merge-fixes.md:176,199-200`) is consistent with these
   numbers within a few ms. Caveat in A2-M4: the benched SHA is not the merge head.
6. **Thread-safety**: `executeBatch` keeps no state beyond locals; results stay 1:1 with
   `actions`; the only shared map (`prevServerTiming`) is a `ConcurrentHashMap`
   (`JsonRpcHandler.kt:85`). The burst blocks its connection thread for the whole run
   (`Thread.sleep`), and the host holds the device mutex around it
   (`open-server-input.ts:1060`), so the tool-server cannot self-contend; a second concurrent
   client could (see A2-L5).

## HIGH

### A2-H1 — `gesture-tap { verify, target }` silently drops `verify`

`gesture-tap/index.ts:246-253` returns from the `target` branch **before** the A1 verify branch
at `:282`, so a call carrying both taps by index with **no** selector cross-check and returns
`{tapped:true}` with no `verified` field. A1-M5 established the opposite rule in the same file
(`:235-242`: an explicit safety request must never downgrade — it refuses with
`verify_unsupported`), and A1's review explicitly assigned this precedence to A2
(`2026-09-15-review-a1-findings.md:259-276`). The Result mentions the merged `refine` but
states no precedence rule; no unit test covers the combination. Decide and encode one of:
refuse the combination at the schema, or resolve `target` → coordinates and then run the
verify path over them (the useful semantics: "tap index 7 and confirm it is still labelled X").

### A2-H2 — the ship rule's locate half is vacuous; recomputed like-for-like, index locate is parity, not better

`summarizeTierTable` clears "default-eligible" on `medianSavings >= 20 && locate.indexAddressable

> = locate.uniqueByLabel` (`index-tier-tokens.ts:172`). `indexAddressable` counts targets whose
label **appears** in the index rows (`:114`), while `uniqueByLabel`counts targets **uniquely
resolvable** by`pickUniqueNode` (`:112`). Both sets come from the same lines, so
`indexAddressable ⊇ uniqueByLabel` **always** — the inequality cannot fail, on any input. My
recompute over the same 24 captures: targets whose label is **unique among the index rows** =
**608**, exactly compact's 608/676. The 68-target "win" is precisely the duplicate labels, and
the shipped rendering (`[i] label (role)`, no frames, no ids —
`index-tier.ts:82-96`) gives the agent nothing to break those ties with. Honest claim:
> _"index preserves compact's per-element locate (608/676) at 71 % fewer tokens"_ — not "index
> locate ≥ compact". The savings half of the rule clears on its own, so the **opt-in ship
> decision stands**; the sentence "index is eligible to be a default" does not.

### A2-H3 — an aborted burst passes as a flow step (the #606 class, reintroduced)

`flows/flow-nested-outcome.ts:23-24,98-128` reads nested verdicts by **tool id** and knows only
`flow-execute` and `run-sequence`; the header comment records exactly this bug ("a sequence that
stopped on its first tool counted as a pass (#606)"). `gesture-sequence` returns the same shape
(`{completed,total,steps[{…,error?,skipped?}]}`, `open-server-input.ts:1044-1051`) but is not in
the dispatch list, so a flow step whose burst aborted at step 0 with two `skipped` steps is
reported as a **pass**. Fix is ~10 lines (a `gestureSequenceOutcome` keyed on a step `error` or
any `skipped:true`, plus a test), and it should ship with the tool, not after it.

## MEDIUM

### A2-M1 — the token table measures a reconstruction, never the shipped renderer

The `index` column is `renderIndexFromDescribe(node.compact)` — one row per **framed line of the
stored describe text** (`index-tier-tokens.ts:33-58,99`). The shipped tier renders
`buildIndexElements(state.tree)` — the **raw flat `getState` list** filtered by
`clickable || scrollable || label` (`index-tier.ts:52-74,117-118`). Different source, different
filter, different role strings (`deriveUiAutomatorRole(className)` vs the raw class token). The
code's claim that the reconstruction is "conservative, never-smaller-than-real"
(`index-tier-tokens.ts:29-31`) is asserted, not tested: on the Settings root the stored
`compact` has 70 framed lines including unlabelled `FrameLayout`/`LinearLayout` scaffolding
(which the shipped filter drops, so the reconstruction is bigger there), but the raw tree the
shipped tier reads has ~133 nodes for that same screen
(`test/fixtures/screen-graph-settings-root-tree.json`, 133 entries), so the direction is not
fixed by construction. Cheapest settle: in the next device run, print `tier:"index"` and
`tier:"compact"` token counts for the same on-device screen and put the pair in the Result.

### A2-M2 — "24 screens" is 14 distinct screens of one app, and the `full` column is not measured

The fixtures are two CI captures of the **same Settings crawl**
(`index-tier-tokens.test.ts:103-106`): 13 + 11 nodes = 24 rows, but only **14 distinct screen
hashes / 15 distinct compact texts** (`Settings: Network & internet` appears 3× in one run,
`Network & internet: Internet` twice). The ticket asked for "the screen-graph matrix's 20 task
screens"; these are not that set, and the Result's "24 committed Settings capture screens" does
not say the rows are duplicated. `full` is assigned `compactTokens`
(`index-tier-tokens.ts:120-123`) — a hardcoded copy, not a measurement; the Result explains the
reason but still prints it as a table row. Dedup barely moves the headline (recompute below),
so this is honesty, not arithmetic.

### A2-M3 — the device suite bypasses every shipped host path (repeat of A1-M4)

The three A2 device cases drive `api.batch` directly and call `buildIndexElements` /
`resolveIndexTarget` as pure functions (`test/blueprints/android-open-server.device.test.ts:1340,1374,1403-1417,1432-1450`).
Not exercised on a device at all: the `gesture-sequence` tool, `openServerSequence` /
`buildSequenceActions` (normalized→pixel conversion, `injectOpt()` threading, budget),
`openServerTapAtIndex`, `describe tier:"index"` end to end, and the **`wait` pseudo-method**
(the burst test uses `delayMs` on real methods; nothing sends `{method:"wait"}`). The Result's
"the three core A2 cases passed" reads as tool-level coverage; it is RPC-level coverage.

### A2-M4 — the benched SHA predates both the flag guard and the A1 merge

Run 34939934318 benched `4fb1916b` (Result §"Device test outcomes"), i.e. before `2a0ffb5d`
(index-tier flag guard) and before `f3f81e68` (merge of A1). The merge head `180d4a52` — the
thing being merged, carrying A1's verify/incident **and** A2 in one tree — has never run the
device suite or the latency blocks. Plus the self-declared gap: the A2 stale-index case failed
in that run (`logs/device-test.log:152-162`, `expected 184 not to be 184`), was fixed by test
ordering in `e2688918`, and is unverified on a device. The 24/25 and the verb table are real;
the merged tree's green is an inference.

### A2-M5 — index targets in later burst steps resolve against the pre-burst tree

`openServerSequence` reads state **once**, before the burst, and resolves _every_ index target
against it (`open-server-input.ts:1069-1084`). A burst like `[tap target:{3}, wait, tap
target:{9}]` therefore resolves step 2's index on the screen that existed **before** step 0
navigated away — stale coordinates, and the version check cannot fire because it was done
pre-burst. `tools.mdx:113-116` says "Argent refuses the tap with `stale_index` when the screen
moved since the `describe`, so a stale index never taps the wrong element", which is false for
any index target after the first acting step. Either refuse >1 index target per burst, or
document the rule loudly in the tool description and docs.

### A2-M6 — the stale-index check fails open when the device reports no `version`

`resolveIndexTarget` skips the version comparison when `liveVersion === undefined`
(`open-server-input.ts:848`), and a unit test codifies it ("still resolves when the live version
is unknown (no fingerprints)", `gesture-sequence.test.ts:195`). Both live callers request
`fingerprints:true`, so this should not trigger today — but the failure mode is a **silent
unverified tap** on exactly the safety feature the tier is sold on, and `renderIndexTier`
already has a no-version header variant (`index-tier.ts:86`). Prefer refusing (a new code, e.g.
`version_unavailable`) over tapping.

### A2-M7 — the index tier sees the active window only, capped at 200 nodes, with no truncation signal

`describeAndroidIndexTier` calls `server.getState(...)` (`index-tier.ts:117`), which the host
defaults to `maxElements: 200` (`blueprints/android-open-server.ts:1128`) and the device
serializes from `NestedWindowSerializer.activeRoot` — the **active window only**, flagged
`truncated` when the flat list hits the cap (`handlers/StateHandler.kt:182-211`). The normal
describe instead uses `getNestedState` (active + IME + dialogs, cap ≥ 3000) and surfaces a
truncation hint (`describe/platforms/android/index.ts:122,164`). So on a screen with a dialog or
the IME up, index rows can omit elements the compact describe shows, and on a dense screen the
list is silently cut — with `index_out_of_range` as the only symptom. This alone disqualifies
`index` as a default tier today.

### A2-M8 — `alwaysLoad` puts 918 tokens of an Android-open-only tool in every session

`gesture-sequence/index.ts:155` sets `alwaysLoad: true` (15 tools do). Measured with the repo's
own o200k counter: description **329** + JSON schema **589** = **918 tokens** carried in every
session on every platform, for a tool that refuses unless the device is Android **and** the
`open-device-server` flag is on (`:161-169`). That is 2.5 index-tier describes of savings spent
up front, in a project whose headline metric is tokens/step. `run-sequence` is also
`alwaysLoad`, so the choice is consistent — but consider dropping it (the `searchHint` is
already there) or trimming the per-field `describe()` strings.

### A2-M9 — the index tier skips `settle`, the A1 incident line, and the screen-graph observation

`describe tier:"index"` returns straight from its own module (`describe/index.ts:174-186`),
bypassing `withDescription` — so A1's execution-incident line (`describe/index.ts:26-31`) never
appears in index mode — ignores `params.settle` entirely (the normal path threads it,
`describe/index.ts:195`), and records no screen-graph observation (the `summary`/`compact` tiers
do, via `screen-graph-open-wiring`). The first two are shared with the existing tiers, so this
is not a regression — but all three are blockers for "make `index` the default", and the second
matters to AW-2 (an index-tier agent never sees incident feedback).

### A2-M10 — `target` off the open path throws a bare `Error`; the success result names no element

`gesture-tap/index.ts:247-251` throws a plain `Error` where A1 returns a structured
`verify_unsupported` result and `gesture-sequence` throws `UnsupportedOperationError`
(`gesture-sequence/index.ts:164-168`) — three surfaces for the same class of refusal. And the
index tap returns `{tapped:true, timestampMs}`: no index, label or resolved coordinate, so
neither the agent nor a log can tell **what** was tapped, and `IndexTargetError.code`
(`stale_index` / `index_out_of_range`) reaches the caller only as a thrown message string.

## LOW

- **A2-L1** — a `wait` step's own `delayMs` is silently dropped: `toSequenceStep` keeps both
  fields (`gesture-sequence/index.ts:126-130`) but `buildSequenceActions` emits
  `{method:"wait", delayMs: step.waitMs}` only (`open-server-input.ts:1010-1011`), while the RPC
  budget adds **both** (`:964,1010`). Harmless, but the schema promises a pause that never runs.
- **A2-L2** — the `wait` result reports the **requested** sleep as `ms`
  (`JsonRpcHandler.kt:317`), not a measured elapsed time like every other step.
- **A2-L3** — batched sub-requests recurse through `handle()`, so they overwrite
  `prevServerTiming[method]` (`JsonRpcHandler.kt:85,193-201`): the next standalone `tap`'s
  `timings.prevServer*` describes a batched tap. Measurement-only, but it can confuse a 3i-style
  investigation.
- **A2-L4** — `r.put("ms", elapsedMs)` mutates the sub-result in place
  (`JsonRpcHandler.kt:343`); no handler emits `ms` today, so nothing is clobbered yet.
- **A2-L5** — a burst holds its connection thread for the whole run (`Thread.sleep`), and the
  server accepts concurrent connections on a cached pool (`TCPServer.kt:47-59`) whose contract
  is "the caller serialises requests" (`JsonRpcHandler.kt:30-31`). Nothing caps the summed
  on-device delay server-side; the host budget is `15_000 + Σ delays`
  (`open-server-input.ts:944,964,1010`).
- **A2-L6** — docs inaccuracies: "Argent resolves the index **on the device**"
  (`packages/docs/docs/reference/tools.mdx:114`; it resolves on the host from a fresh
  `getState`), the "never taps the wrong element" overclaim (A2-M5), and
  `index_out_of_range` is documented nowhere. Same "on the device" wording in the Result and the
  ticket.
- **A2-L7** — `isIndexable` ignores `enabled` and bounds sanity (`index-tier.ts:52-54`), so a
  disabled row or a zero-area/off-screen labelled node gets an index and a centre tap that
  reports success.
- **A2-L8** — for AW-2: the index tier returns **text only** (`{description, source}`,
  `index-tier.ts:119-123`); the `version` the caller must echo in `target` exists only inside
  the header string, so a harness has to regex `[i] label (role)` lines and the header.
  AW-1's `driver_env.py` is specified to build its **own** index↔node table
  (`2026-09-15-androidworld-aw1.md:26-27`, "`index` does not exist yet — AW-2"), so the two
  index spaces will not line up unless AW-2 consumes this tier. Returning the `IndexElement[]`
  and `version` as result metadata (the way describe already passes `waitedMs`/`timings`) would
  remove the screen-scrape.

## Token table recompute

Reproduced the committed table byte for byte in the worktree, then recomputed independently
from the same two fixtures with my own script (dedup by `compact` text; like-for-like locate):

- **Tokens** — committed: median full 1294 / summary 25.5 / compact 1294 / index 367.5, totals
  35249 / 753 / 35249 / 10253, median savings 71.2 %. **Deduplicated to the 15 distinct compact
  texts (14 distinct screen hashes) the 24 rows actually contain**: median compact **1333**,
  median index **373**, median per-screen savings **71.0 %**, totals compact **23352** / index
  **6845**. The savings headline is robust to the duplication; `full` is a hardcoded copy of
  `compact` (`index-tier-tokens.ts:120-123`), and both are the stored _screen-graph_ `compact`
  rendering, so "71 % below compact" is 71 % below **these captures' stored describe**, not
  below a rendering the shipped `index` tier was ever compared against on a device (A2-M1).
- **Locate** — committed: compact 608/676 unique by label, index 676/676 "addressable". Counting
  the index side the same way as the compact side (target label **unique among the index rows**)
  gives **608/676 — identical**. So the honest line is _parity at 71 % fewer tokens_, and the
  `locate.indexAddressable >= locate.uniqueByLabel` gate is an identity, not a test (A2-H2).

## Post-merge steps

1. **Before the merge commit**: A2-H1 (define and test `verify` + `target` precedence),
   A2-H3 (register `gesture-sequence` in `flow-nested-outcome` + test), and the Result edits for
   A2-H2/A2-M2 ("parity at 71 % fewer tokens"; say the 24 rows are 14 distinct Settings screens
   from 2 runs, not the 20-screen matrix; mark `full` as "not measured — equals `compact` by
   construction").
2. Docs pass with the same merge: drop "on the device" (A2-L6), document `index_out_of_range`,
   state the one-index-target-per-burst rule (A2-M5) in both `tools.mdx` and the tool
   description, and say the index tier lists the **active window** only (A2-M7).
3. In the MAIN checkout after merge: `npx docusaurus build` in `packages/docs/` and
   `npm run format` from the repo root — the Result states neither was run in the worktree.
4. Batch into the **next** device/bench run (one run, pre-registered): the fixed A2 stale-index
   case; tool-level cases that drive `gesture-sequence` and `gesture-tap {target}` and
   `describe tier:"index"` through the registry rather than `api.batch` (A2-M3, and A1-M4's
   open item); a `{method:"wait"}` step; and one on-device `tier:"index"` vs `tier:"compact"`
   token pair on the same screen to retire A2-M1. Verify the merged head, not a pre-merge SHA
   (A2-M4), and diff the full verb table against 34939934318 at the OFF↔OFF floors (paste's
   30 ms drift is the widest here).
5. **Default tier: no, not yet.** `index` stays opt-in until A2-M7 (active-window-only + silent
   200-node cap), A2-M9 (no `settle`, no incident line, no graph observation) and A2-M5 are
   resolved, and until the on-device token pair from step 4 exists. Flipping it would also
   silently retire A1's incident feedback for any agent that adopts it.
6. **AW-2 needs from this tier**, in this order: structured `IndexElement[]` + `version` on the
   describe result (A2-L8) so `driver_env.py` stops maintaining a second index space; the
   active-window/truncation fix (A2-M7) so `click{index}` cannot address a list the harness
   cannot see; and a decision on duplicate-label tie-breaking (A2-H2) — AndroidWorld's
   `click{index}` grammar is exactly where the 68 ambiguous targets bite.
7. Housekeeping: `git worktree remove ../argent-fork-wt-a2` + `git worktree prune` at merge
   (resource policy §3); scoreboard entry only after the merged-head run in step 4.
