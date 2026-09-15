# Ticket: E-0 — research/design: screen graph under dynamic content (Netflix-like feeds)

README "Execution order" step 4 (owner's open design item from 2026-09-05): apps with
dynamic content (feeds, carousels, infinite lists) would bloat the graph with content
edges. Design phase E: template edges per scrollable container, TTL/pruning, and a churn
experiment on a real app runnable on the CI emulator. Read-only research + design; no
code, no builds, no CI. Output: `## Findings` + `## Design` + `## E-1 ticket proposal`
appended to this file (prettier-clean).

## Questions

1. Current store semantics: read `packages/tool-server/src/screen-graph/{types,store,
canonical,plan,navigate,recorder,label}.ts`, `src/utils/screen-hash.ts`, the Kotlin
   `ScreenHash.kt` / `ScreenSelector.kt`: how a screen identity (`idHash`) is computed
   (which fields, what is quantized), how edges are keyed (selector-carrying edges), what
   happens today when the same screen renders different list items (does `idHash` change?
   does `stateHash`?), how many nodes/edges the Settings matrix store has (11/10) and what
   the invariants gate checks. Where would a feed explode: nodes (one per content state),
   edges (one per item tapped), or both? Give a worked example on a synthetic 50-item list.
2. Template edges: a design where a scrollable container's children are folded into ONE
   template node/edge (`container#id → item[*]`) keyed by the container's identity + item
   template (role/class + id-hash of the item's structural shape, not its text), with the
   concrete item resolved at navigate time by selector on the live tree. What identity
   keeps the container stable across scroll positions and refreshes? How does
   `navigate-to` plan through a template edge? What does `describe` `summary` tier show for
   it (count + template, not items)? Token impact estimate.
3. TTL / pruning: rules that keep the store bounded — per-app node cap, LRU on last-seen,
   edge confidence decay when a replay fails, and a "volatile" flag on nodes whose
   `stateHash` churns while `idHash` holds. What the invariants gate must add (no
   duplicate screens still, plus bounded size) and what the harness must record.
4. Churn experiment on the CI emulator (x86_64 `google_apis` image, no Play): which
   installable app has a genuinely dynamic feed? Candidates: Chrome on a news site
   (network-dependent), the AndroidWorld apps AW-1 installs (Retro Music, VLC, Markor
   with many notes, Simple Gallery), or a synthetic test app we control (a small APK with
   a RecyclerView of N randomized items — the most reproducible; cost to build). Pick one
   with a rationale. Define the experiment: K sessions × M scrolls/taps, measure store
   growth (nodes/edges per session) with and without template edges, describe tokens per
   step per tier, navigate-to success to a target item, invariants. Pre-registered
   pass/fail: store growth sublinear in content states; navigate success ≥ the static
   Settings baseline within its interval.
5. Related work: what the screen-graph design doc and related-work survey
   (`2026-09-02-screen-graph-architecture.md`, `2026-09-02-screen-graph-related-work.md`)
   already say about dynamic content; anything in Artemis/AndroidWorld/other agents
   (e.g. "semantic vs episodic memory") to reuse. Cite.
6. E-1 proposal: the smallest ticket that ships template edges behind the `screen-graph`
   flag + the churn experiment on the chosen app, one CI run, gates, risks.

## Process

Researcher, read-only, single agent. Append with a Bash python heredoc; `npx prettier
--write` the file; every claim with a path:line or URL. If your definition forbids
writing files, return the sections in the reply.

## Findings

Read-only pass over the store, the two hashes, the D.4.1 results, the CI recipe and the AW
harness. Every claim below carries a `path:line`. Where I model a number rather than read it,
the line says INFERENCE.

### F1 — Screen identity today: content does not move `idHash` (Q1)

- The graph keys nodes by `H_id`, not by the structural hash `H`
  (`packages/tool-server/src/screen-graph/types.ts:79-93`;
  `packages/tool-server/src/utils/screen-graph-open-wiring.ts:252-262` skips and counts a
  record with no `idHash`).
- `H_id` folds exactly three things: the package name, the texts of identity nodes
  (collapsing-toolbar / action-bar / dialog titles, volatile text dropped), and the resource-id
  MULTISET of NON-scrollable subtrees, plus one `SC:<class>#<resourceId>` token per scrolling
  container (`packages/tool-server/src/utils/screen-hash.ts:198-239`, Kotlin twin
  `packages/android-device-server/src/main/java/com/argent/devicecontrol/accessibility/ScreenHash.kt:189-225`).
- The decisive line for feeds: `scanRids` sets `insideScroll = true` under a scrolling container
  and then never contributes those resource-ids
  (`packages/tool-server/src/utils/screen-hash.ts:212-221`; `ScreenHash.kt:203-213`). So the
  items of a list are structurally invisible to the identity hash.
- `isScrollingContainer` fires on `scrollable`, on `RecyclerView | ListView | ScrollView |
HorizontalScrollView`, and on any `ViewPager*`
  (`packages/tool-server/src/utils/screen-hash.ts:64-69,128-132`; `ScreenHash.kt:45-47,85-88`).
- `H` (structural) applies the recycler rule: a scrolling container contributes itself plus the
  CLASS SEQUENCE of its first child subtree only
  (`packages/tool-server/src/utils/screen-hash.ts:169-180`; `ScreenHash.kt:108-122`) — the
  architecture's own mitigation, already shipped
  (`docs/open-server/2026-09-02-screen-graph-architecture.md:218-220`).
- `H_text` (`stateHash`) has no recycler rule and no text exclusion: every node, with text, cd
  and quantized bounds (`packages/tool-server/src/utils/screen-hash.ts:242-268`;
  `ScreenHash.kt:125-140`). It moves on every scroll tick and every content refresh.

**Answer to "does `idHash` change / does `stateHash` change" when the same screen renders
different list items: `idHash` does NOT, `stateHash` does.** A feed screen is already ONE node.

### F2 — Where a feed actually explodes: item DETAIL screens and item TAPS

- **Nodes.** The feed screen itself is one node. The explosion is on the other side of the tap,
  and it has two opposite regimes, both consequences of `H_id`'s title rule
  (`packages/tool-server/src/utils/screen-hash.ts:102-115`; `ScreenHash.kt:160-167`):
  - detail screen whose toolbar / collapsing-toolbar title is the ITEM title → one distinct
    `H_id` per item → N nodes (explosion);
  - detail screen whose title lives in the body inside a scroll container (excluded by
    `insideScroll`) and whose toolbar title is constant → ALL items collapse onto ONE node whose
    `compact` / `stateHash` / `index` are overwritten on each visit
    (`packages/tool-server/src/screen-graph/store.ts:186-191`) → a silent FALSE MERGE that can
    serve one item's cached text for another when `stateHash` happens to match
    (`packages/tool-server/src/screen-graph/describe-tiers.ts:123-125`).
- **Edges.** `actionSignature` keys on `id`, else `text`, else the 1/16 bucket
  (`packages/tool-server/src/screen-graph/types.ts:216-224`). Phase D.1 Fix A picks `via` by
  UNIQUENESS on the source tree, and every list row shares one resource-id (the Settings case is
  documented verbatim at `packages/tool-server/src/screen-graph/types.ts:66-76`), so a list-row
  tap is recorded `via: "text"` and the item's own title becomes the edge key
  (`packages/tool-server/src/utils/screen-graph-open-wiring.ts:312-327`). **One edge per item
  tapped.** Each detail screen then contributes a `back` edge (`canonical.ts:88-95`,
  `types.ts:216-224`) — distinct `from`, so one per detail node.
- **Scrolling adds nothing to the store.** A swipe canonicalizes to a single
  `swipe dir=up` signature (`packages/tool-server/src/screen-graph/canonical.ts:81-82`), and the
  wiring drops the resulting self-edge because `afterId === beforeId` while the outcome reported
  a state change (`packages/tool-server/src/utils/screen-graph-open-wiring.ts:292-295`) —
  returning BEFORE any store write. Scroll churn costs describe tokens, not graph size.
- **The feed node's `index` is replaced, not merged**, on every upsert
  (`packages/tool-server/src/screen-graph/store.ts:190`). A RecyclerView only materializes the
  visible window in the a11y tree, so the index holds ~8 of 50 item selectors — whichever were
  on screen at the last upsert. `planToSelector` / `planToSelectorStable` target nodes by that
  index (`packages/tool-server/src/screen-graph/plan.ts:147-161,285-307`), so a route to an item
  exists only if that item happened to be in the last-seen window. This is a correctness defect
  today, independent of size.

### F3 — Nothing bounds the store (Q1/Q3 premise)

`store.ts` has upsert, observe, hydrate, serialize, persist — **no cap, no TTL, no eviction, no
decay** (`packages/tool-server/src/screen-graph/store.ts:67-356`). Every write re-serializes the
whole document (`store.ts:279-305`) and every load re-parses it (`store.ts:332-355`). The only
pruning rule anywhere is a design-doc sentence that was never implemented: "edges carry success
ratios; prune below threshold" (`docs/open-server/2026-09-02-screen-graph-architecture.md:228-229`).

### F4 — The invariants gate, and why churn turns it red

- Gate = `duplicateScreens()` (≥2 node hashes with byte-identical `compact` + `resourceIds` +
  `stateHash`, `store.ts:129-141`) and `duplicateEdgeTargets()` (one `(from, actionSignature)`
  must have exactly ONE destination, `store.ts:150-161`), run over every persisted store after
  the matrix and failing the job when non-empty
  (`packages/tool-server/scripts/bench-screen-graph.ts:272-300`, called at `:2814`).
- D.4.1 reference: `com.android.settings` **11 nodes / 10 edges**, max out-degree 9, mean 0.91;
  `com.android.chrome` 1/1; `com.google.android.settings.intelligence` 2/1; gate green, 0/0,
  `skippedNoIdHash` 0 (`docs/open-server/2026-09-13-screen-graph-phase-d4-results-ci.md:85,87,242-245`).
- **A churning feed breaks `duplicateEdgeTargets` by construction.** As soon as the same item
  text (or the same 1/16 grid bucket for a coordinate tap) leads to a different detail screen in
  a later session, one `(from, actionSignature)` has two destinations. This is not a bug to fix
  in the experiment — it is the predicted outcome of the no-template arm and must be
  pre-registered as such, and the gate must be scoped per arm or the control arm kills the job
  (`bench-screen-graph.ts:2814`).

### F5 — Worked example: a synthetic 50-item list

Setup (the shape the churn app will implement): feed screen `F` = Toolbar(title "Feed") +
`RecyclerView#list` with 50 items; each row = `LinearLayout#row > TextView#title + TextView#summary`;
~8 rows materialized at a time. Detail screen per item, toolbar title = the item title. One pass =
10 scrolls + 50 item taps + 50 backs.

Sizes are measured from the two committed store artifacts, not guessed:
`packages/tool-server/test/fixtures/screen-graph-run-33958064084-settings.json` (11 nodes / 20
edges / 137 265 B) and `...-33947160117-settings.json` (13 / 18 / 170 861 B) — **median persisted
node 6.6 KB** (min 4.6 KB, max 12.7 KB; of which `compact` alone is 3 623 B on the sampled node),
**median edge ~0.3 KB**.

| quantity (one pass, 50 items)       | today                                                          | with template edges (design below) |
| ----------------------------------- | -------------------------------------------------------------- | ---------------------------------- |
| feed nodes                          | 1 (identity is content-free, F1)                               | 1                                  |
| detail nodes                        | 50 (toolbar-title regime) or 1 (merge)                         | 1 template node                    |
| tap edges from `F`                  | 50 (one per item text, F2)                                     | 1 (`#list -> item[*]`)             |
| `back` edges                        | 50                                                             | 1                                  |
| swipe edges                         | 0 (self-edge dropped, F2)                                      | 0                                  |
| **total**                           | **51 nodes / 100 edges**                                       | **2 nodes / 2 edges**              |
| persisted bytes (6.6 KB / 0.3 KB)   | **~367 KB** (INFERENCE from the fixture medians)               | **~14 KB**                         |
| vs the whole 20-task Settings store | 2.7x its bytes, 4.6x its nodes, 10x its edges, from ONE screen | 0.1x                               |

Across sessions with refreshed content (new titles), the today column adds +50 nodes / +100
edges per session with nothing to stop it (F3): at K=5 sessions that is 251 nodes ~ **1.7 MB**,
re-serialized in full on every debounced write (`store.ts:279-305`). The template column adds 0
per session — the whole point of the gate in §Design.

Token side of the same example, to keep the claim honest:

- The `summary` tier caps affordances at `topN = 6` (`describe-tiers.ts:41,55-62`), so 50
  outgoing edges still render ~21 tok p50 / 114 tok p95 (`d4-results-ci.md:132` O4/O5 row). The
  damage from the 50 edges is **fidelity** — six arbitrary item titles ranked by `count` — not
  tokens.
- The real per-step token cost of churn is that the `compact` tier can never hit cache:
  `resolveCompactTier` serves the cache only when `stateHash` matches
  (`describe-tiers.ts:118-130`), and `stateHash` moves on every scroll (F1). So a scrolling agent
  pays a full refresh each step — 598-747 tok on Settings-sized screens vs the warm 21
  (`d4-results-ci.md:128-132,142-144`).

**Conclusion for Q1: both, but not where the ticket's phrasing suggests.** Nodes explode one per
item DETAIL screen (or silently merge, which is worse), edges explode one per item TAPPED; the
feed node and the scrolling are already bounded by the recycler rule and the self-edge drop.

### F6 — Related work already in the repo (Q5)

- `docs/open-server/2026-09-02-screen-graph-architecture.md:218-220` — "Fingerprint stability
  across dynamic lists (feeds): `H` must exclude list-item count — hash recyclers by container id
  - first item class... Evaluate false merges/splits." Shipped as the recycler rule (F1); the
    **false merge/split evaluation was never done** — F2's two regimes are exactly it.
- `...architecture.md:221-222` — "treat `H` unchanged + `H_text` changed as 'same screen, live
  content'". That sentence IS the volatile flag of Q3; it has no implementation.
- `...architecture.md:228-229` — the only pruning rule ever written (success-ratio threshold).
- `docs/open-server/2026-09-02-screen-graph-related-work.md:56-63` — APE (ICSE 2019) refines the
  state abstraction at RUNTIME, and Fastbot2 reuses a transition model across runs; the same file
  lists "Fastbot2's state key/hash exclusions" as still **unresolved** (`:117`). A template node
  is a runtime coarsening of the abstraction — cite APE for the mechanism class, and read the
  Fastbot2 PDF before claiming novelty on bounded reusable models.
- `...related-work.md:67-72` — Baek & Bae (ASE 2016) lattice of GUI comparison criteria; `H` /
  `H_text` are two points on it. A template node is a THIRD, coarser point (container identity
  without item content) — the cleanest way to present it in the paper.
- `...related-work.md:23-32,74` — EAM (offline DFS UTG), AppAgentX (online chain memory with
  shortcut nodes), MAGNET (online stationary + procedural memory). Shortcut nodes are the nearest
  prior to a template edge; they are chain-level, not container-level.
- `docs/open-server/README.md:119-126` — the Artemis note already names the split to reuse:
  "compressed (not truncated) episode history (complementary to the screen graph: **episodic vs
  semantic memory**)". That is the right framing for phase E: **per-item content is episodic and
  does not belong in the graph; the container plus its item template is semantic and does.**

### F7 — Host-side blocker for any template design

The host never sees a hierarchy. The device serializes a FLAT, DFS pre-order list whose only
positional field is a 1-based counter
(`packages/android-device-server/src/main/java/com/argent/devicecontrol/accessibility/ScreenTree.kt:118-154`),
and the host renders every element as a direct child of a synthetic `Screen` root
(`packages/tool-server/src/tools/describe/platforms/android/open-server-tree.ts:36-44`, and the
same caveat is already documented at `packages/tool-server/src/utils/screen-hash.ts:11-15`).
`EdgeSelector.indexInParent` is a name trap: it is assigned the flat list index
(`packages/tool-server/src/utils/open-server-input.ts:121`), not an index within a parent. So
"which container is this item in" must be either recovered geometrically host-side or emitted by
the device. The compressor keeps every scrollable node (`TreeCompressor.kt:27-33`), so the
container element is present in the flat list; the containment relation is what is missing.

### F8 — CI recipe and app availability (Q4 inputs)

- Screen-graph job: `ubuntu-latest`, KVM, `system-images;android-34;google_apis;x86_64`, device
  `pixel_6`, 4 GB / 2 vCPU, headless swiftshader, `timeout-minutes: 180`
  (`.github/workflows/bench-open-vs-proprietary.yml:449,494-506,511-519`). It already builds an
  Android app from source in-job (`:536` `npm run build:android-device-server`, wrapping the
  committed Gradle wrapper, `packages/android-device-server/scripts/build.sh:1-20`,
  `packages/android-device-server/build.gradle.kts:1-20`).
- The job has network: the Chrome tasks load `https://example.com` through a real intent
  (`packages/tool-server/scripts/bench-screen-graph.ts:429-436`), with a one-time first-run
  dismissal (`:450-514`).
- AndroidWorld's app set (Markor, Retro Music, VLC, Simple Gallery, ...) is 24 APKs installed by
  AW's own `--perform_emulator_setup` on a SEPARATE api-33 workflow
  (`docs/open-server/2026-09-15-androidworld-research.md:95-101,171-179`;
  `.github/workflows/bench-androidworld.yml:106-125`; `bench/androidworld/README.md:1-22`;
  `bench/androidworld/requirements.txt:9`). Setup there is estimated at ~15 min on top of
  SDK/AVD/boot (`...androidworld-research.md:296`).

## Design

Everything here is host-side and behind the existing `screen-graph` flag
(`packages/configuration-core/src/flags.ts:82`), with the new behaviour additionally gated so the
D.4.1 numbers can be reproduced unchanged in the same job.

### D1 — Template edges (Q2)

**Container identity (stable across scroll and refresh).** Reuse the token that `H_id` already
uses for scrolling containers (`screen-hash.ts:214`; `ScreenHash.kt:205`):

```
containerKey = fnv1a( hostIdHash + US + "SC:" + class + "#" + resourceId + US + ordinal )
```

`ordinal` = rank among containers sharing the same `class#resourceId` on that screen, in DFS
order. No bounds, no children, no text, no item count, so it is invariant under scroll position,
item count and content refresh — by the same argument that makes `H_id` invariant (F1). It
changes only when the screen's identity changes, which is correct.

**Item template.** For an item subtree, text-free and bounds-free:

```
itemTemplate = fnv1a( classSeq(item subtree) + US + sorted resource-id multiset(item subtree) )
```

`classSeq` is the construction already used by the recycler rule
(`screen-hash.ts:177-180`; `ScreenHash.kt:119-122`). The rid multiset must be added because
inside-scroll ids are deliberately absent from `H_id` (F1), so `classSeq` alone would merge a
content row with an ad row. Two item shapes therefore give two templates and two template edges.

**Resolving containment (F7).** Two options; E-1 takes B.

- (A) Device-side: compute `containerKey` / `itemTemplate` in Kotlin where the real tree exists
  and add them as additive fields in `serializeFlat` (`ScreenTree.kt:130-149`). Correct, but it
  bumps the server `versionCode` (`build.gradle.kts:16-18`) and touches the shipped wire shape,
  which drags the latency reference run into a re-measure. **Not in E-1.**
- (B) Host-side geometric containment: an element belongs to the SMALLEST scrollable element
  whose bounds contain it; ties broken by flat index. Zero device change, zero effect on the
  D.4.1 arms when the feature is off. Known failure mode: a horizontal carousel nested in a
  vertical list (exactly the Netflix shape) — smallest-containing-scrollable resolves it
  correctly in principle, and the churn app must include one such row so the run MEASURES the
  misattribution rate instead of assuming it.

**Edge shape.** Keep `CanonicalAction` as is and add one namespace to `actionSignature`
(`types.ts:216-224`): when the acted element resolved inside a known container and the feature is
on, the signature becomes `tap US tpl=<containerKey>#<itemTemplate>`. Consequences that fall out
for free: all item taps in one container dedupe onto ONE edge; `duplicateEdgeTargets`
(`store.ts:150-161`) is satisfied because that edge has exactly one destination; legacy graphs and
the feature-off path are untouched. `Edge` gains
`template?: { containerKey, itemTemplate, instances, lastItemTexts? }` — `instances` is the count
of distinct concrete destinations folded in, and is the number `describe` reports.

**Destination = a template node**, not a real screen:

```
templateNodeHash = fnv1a( "TPL" + US + containerKey + US + itemTemplate + US + destinationShape )
destinationShape = H_id of the destination with the identity-title component replaced by "*"
```

This covers both F2 regimes with one mechanism: when detail titles differ (explosion) the shapes
coincide and 50 nodes become 1; when titles are constant (false merge) there was already 1 node,
and the template node makes the merge EXPLICIT instead of silent. The node carries
`template: true`, `instances`, an `exemplar` rendering, and — load-bearing — **no `stateHash`**,
which makes `resolveCompactTier` structurally unable to return `cache` or `patch` for it, since
both paths require `node.stateHash !== undefined`
(`describe-tiers.ts:123-128`). No new code is needed for that safety property.

**`navigate-to` through a template edge.**

1. Dijkstra is unchanged — a template edge is an ordinary edge with the ordinary weight
   (`plan.ts:50-53,71-115`).
2. The final step is flagged `template`; the executor resolves the CONCRETE item on the live tree
   with `query({ text: <wanted>, visible: true })`, requiring exactly one match — the same
   uniqueness discipline as D.1 Fix A (`ScreenSelector.kt:22-38,50-60`; `types.ts:66-76`).
3. Not present: swipe inside the container's bounds, up to `S` times (pre-registered, 8),
   re-querying after each. Those swipes cost nothing in the graph (F2, self-edge drop).
4. Arrival check: `runNavigation`'s `matches` hook already accepts a tolerant check
   (`navigate.ts:22-34`), and the tolerant check is a resource-id multiset Jaccard
   (`plan.ts:180-262`). A template node stores the exemplar's rid multiset with inside-scroll ids
   removed, so every instance should clear the 0.9 threshold (`plan.ts:13`) — INFERENCE, and it is
   one of the things the run measures rather than asserts.
5. Failure: record `observe(..., { success: false })` on the template edge; the weight already
   degrades through `successes` (`store.ts:220-253`, `plan.ts:50-53`).

**What `describe` `summary` shows.** One line per (container, template) instead of up to six
arbitrary items (`describe-tiers.ts:55-62,73-85`):

```
screen: Feed  visits: 7
affordances:
- tap item[*] in #list (tpl 3f2a, 50 seen, 12 instances) -> Detail:* (12)
- tap "Search" -> Search (3)
volatile: 1 container, content changes every visit
```

**Token impact, stated honestly.** The summary tier is already capped at 6 affordances, so a feed
summary today is ~21 tok p50 / 114 tok p95 (`d4-results-ci.md:132`). Folding 6 item lines into 1
saves roughly 5 lines of `- tap "<title>" -> <hash8> (n)`, i.e. **~50-70 tok at p95 and ~0-15 tok
at p50** (INFERENCE, from the rendered line shape in `describe-tiers.ts:77`). **Template edges
must not be sold as a token result.** Their measurable win is store size (367 KB -> 14 KB in the
worked example, F5), the elimination of unbounded cross-session growth, and route correctness for
items that are not currently on screen (F2's index-replacement defect).

### D2 — TTL, pruning and volatility (Q3)

All of these live in `store.ts`, which already has the right choke point: `flush()` is the single
place a document is written (`store.ts:269-277`).

- **R1 caps per `(packageName, versionCode)`**: `MAX_NODES` 300, `MAX_EDGES` 600, `MAX_BYTES`
  2 MB. Checked on flush.
- **R2 LRU on `lastSeen` with pins.** Never evict: a node with `visits >= 5`, a node that is an
  endpoint of an edge with `successes >= 3`, or a template node. Evicting a node MUST evict its
  incident edges — a dangling edge degrades quietly today (`plan.ts:104-112` will route to it,
  `describe-tiers.ts:60` falls back to `hash8`), so this needs its own invariant (G-I4).
- **R3 edge decay.** Drop an edge when `successes / count < 0.2 && count >= 5`, or when
  `now - lastSeen > 30 days`. Both constants align with what `edgeWeight` already encodes
  (`plan.ts:50-53`) and with the design doc's one pruning sentence
  (`architecture.md:228-229`).
- **R4 volatile flag.** Add `volatility?: { samples, distinctStates }`, maintained in
  `upsertNode` (`store.ts:172-205`) by comparing the incoming `stateHash` to the stored one.
  `volatile = samples >= 4 && distinctStates / samples >= 0.75`. Effects: (a) **do not persist
  `compact` for a volatile node** — on the sampled fixture node `compact` is 3 623 of 6 590 bytes,
  so this alone cuts a churny node to ~2-3 KB; (b) `summary` prints `volatile` alongside
  `changedSince` (`tiered.ts:105-117`); (c) the compact tier automatically stops serving cache
  because `stateHash` is absent (`describe-tiers.ts:123-128`).
- **R5 stop indexing ephemeral item text.** An index entry whose element resolved inside a
  scrollable container goes to a separate, capped `itemIndex` (default cap 0 = not indexed), so
  `planToSelector` stops targeting items that were visible once
  (`plan.ts:147-161,285-307`). Routing to an item goes through the template edge + live query
  (D1), which is the only path that can be correct for a list that scrolls.

**Invariants the gate must add** (`bench-screen-graph.ts:272-300`):

| id   | invariant                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| G-I1 | existing: `duplicateScreens() == []`                                                                       |
| G-I2 | existing: `duplicateEdgeTargets() == []` — enforced on the template arm, RECORDED on the control arm (F4)  |
| G-I3 | bounded: `nodes <= MAX_NODES`, `edges <= MAX_EDGES`, file bytes `<= MAX_BYTES`                             |
| G-I4 | referential integrity: every `edge.from` / `edge.to` exists in `nodes` (new failure mode created by R2)    |
| G-I5 | template hygiene: every `template: true` node has no `stateHash`; every template edge has exactly one `to` |
| G-I6 | redaction unchanged: no `compact` persisted for a node holding a secret (`store.ts:58-65,196-200,279-296`) |

**What the harness must record, per session and per arm**: nodes, edges, bytes, delta vs the
previous session, evictions, pinned count, volatile nodes, template edges and `instances` per
template, container-misattribution count, compact-tier mode counts (`cache` / `patch` / `refresh`
from `describe-tiers.ts:87-92`), describe tokens per tier (o200k, `screen-graph/bench/tokens.ts`),
`navigate-to` outcomes in the D.4.1 taxonomy (one-step routed / diverged / mis-landed / no-route,
`d4-results-ci.md:217-233`), `skippedNoIdHash`
(`screen-graph-open-wiring.ts:72-78`).

### D3 — The churn app and the experiment (Q4)

**Choice: a synthetic APK we control, `bench/churn-app`.** Rationale, in the order that decides
it:

1. The pre-registered gate is "store growth sublinear in content states". The x-axis must be a
   COUNTED number of distinct content states. On Chrome-over-a-news-site or on an AW app, content
   states are neither controlled nor countable, so the gate is unfalsifiable. The synthetic app
   makes them an input (`--ei items 50 --ei seed S --ei churn 100`).
2. It is the only candidate where both F2 regimes can be built ON PURPOSE (a detail activity with
   the item title in the toolbar = explosion; a second one with the title in the body = false
   merge) plus a nested horizontal carousel to exercise D1's containment failure mode. Without
   that, the run cannot show that the template node covers both.
3. Cost is bounded and already precedented: the same job builds an Android app from source
   (`.github/workflows/bench-open-vs-proprietary.yml:536`;
   `packages/android-device-server/scripts/build.sh`). A second minimal Gradle project (~200
   lines of Kotlin: `FeedActivity` with a `RecyclerView`, two detail activities, a seeded
   generator) adds one build step (cold AGP resolve + assemble, ~2-4 min INFERENCE) and one
   `adb install`, inside a 180-minute job (`:449`). No network, no Play, same
   `android-34;google_apis;x86_64` / `pixel_6` AVD (`:505-506`).

**Rejected, with reasons.** Chrome on a news site: network-dependent and unpinnable; the existing
Chrome tasks already depend on the live `example.com` (`bench-screen-graph.ts:429-436`) and that
is a known fragility, not a model to extend. AndroidWorld apps (Markor, Retro Music, VLC, Simple
Gallery): they live behind AW's own api-33 workflow and `--perform_emulator_setup`
(`bench/androidworld/README.md:1-22`; `.github/workflows/bench-androidworld.yml:106-125`;
`...androidworld-research.md:95-101,171-179,296`), and to get CHURN we would have to regenerate
their content ourselves anyway (push N markdown files into Markor) — so they are not more "real"
than the synthetic app for this mechanism, while costing a second image and ~15 min of setup.
Keep them for E-2 as external validity, once the mechanism is proven.

**Optional arm B (zero extra build, external validity).** Chrome pointed at a host-served page
`http://10.0.2.2:<port>/feed?n=50&seed=S` — same launch pattern as the existing Chrome tasks
(`bench-screen-graph.ts:429-436`), first-run flow already handled (`:450-514`), fully offline over
the emulator's host alias. **Caveat, UNVERIFIED in this pass:** the mechanism needs a node with
`scrollable = true` or a `SCROLLING_CONTAINERS` class (`screen-hash.ts:64-69,128-132`); whether
Chrome's web-content node reports `scrollable` through our flat tree is not established here. Arm
B must therefore be conditional on a pre-flight probe (the repo already has that pattern,
`bench-preflight.ts`, wired at `.github/workflows/bench-open-vs-proprietary.yml:569-576`) and must
never be a gate.

**Experiment definition.**

- Independent variable: template edges ON vs OFF, both in ONE job on the same device — a same-run
  control arm, per the house rule (`docs/open-server/README.md:116`). `screen-graph` stays the
  outer flag; templates behind `ARGENT_SG_TEMPLATES=1`.
- Held fixed: app build and seed schedule, AVD, item count N = 50, scroll count, tap set and
  order, model-free scripted policy (the existing harness is scripted, `bench/tasks.ts:1-12`).
- Sessions: K = 5, each M = 10 scrolls + 8 item taps + 8 backs, plus one `navigate-to` attempt per
  session to item #37 (off-screen, needs >= 3 scrolls). Two churn conditions: `churn=100` (fresh
  titles per session, so sessions 1..K present 50k distinct content states) and `churn=0` (same
  seed every session) to separate content churn from plain revisit.
- Statistics: store size / counts are deterministic, so report point values per session, no
  bootstrap. Tokens: o200k p50 over non-launch steps, n stated. `navigate-to`: x/n with Wilson.
  Every number names run id, arm, session, condition (house rule,
  `docs/open-server/README.md:108-110`).

**Pre-registered pass/fail (written before the run grades anything).**

| gate  | statistic                                                            | pass condition                                                                                                                                                                                          |
| ----- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1-G1 | ON arm, `churn=100`: nodes(session k) - nodes(session k-1), k = 2..5 | <= 2 nodes and <= 4 edges per session (growth constant in content states); OFF arm reported beside it, expected ~ +50 / +100                                                                            |
| E1-G2 | ON arm store bytes at K = 5                                          | <= 64 KB; OFF arm recorded (expected ~1.7 MB, F5)                                                                                                                                                       |
| E1-G3 | ON arm `navigate-to` to item #37, n = 40 (8 x 5)                     | >= 38/40 (non-inferiority margin 5 pp against the D.4.1 O5 coverage 59/60 = 98.3 %, `d4-results-ci.md:88`); at n = 40 this detects gross failure only, and the report must say so                       |
| E1-G4 | invariants G-I1..G-I6 on the ON arm                                  | all green; the OFF arm's `duplicateEdgeTargets` is RECORDED, not gated (F4)                                                                                                                             |
| E1-G5 | regression: the existing Settings/Chrome matrix with templates OFF   | store shape within the published variance (11 nodes / 10 edges, `d4-results-ci.md:87,358`) and tokens/step p50 inside the published run-to-run floor (O1 138-179, O4 20-22, `d4-results-ci.md:294-299`) |
| E1-G6 | summary tokens/step on the feed screen, ON vs OFF                    | DESCRIPTIVE ONLY, never pass/fail — the `topN = 6` cap already bounds it (`describe-tiers.ts:41`)                                                                                                       |

**Risks.**

- Containment misattribution with a nested horizontal carousel (D1 option B). Mitigated by
  building one into the app and MEASURING the rate; if it is non-zero, option A (device-side) is
  the E-2 fix.
- The control arm turns `duplicateEdgeTargets` red and `bench-screen-graph.ts:2814` fails the job
  on it. The gate must be scoped per store/arm before the run, or the run dies on the arm whose
  failure is the point.
- A template edge that swallows two genuinely different destinations (same layout, different
  screens). Mitigated by the `destinationShape` component of the template node hash and by R3's
  success-ratio decay.
- Pruning adds work on every flush; keep it amortized (only when over cap) so recording latency
  (`takeRecordMs`, `screen-graph-open-wiring.ts:86-91`) does not regress.
- No capability claim: one synthetic app, one image, one emulator.

## E-1 ticket proposal

**Title.** E-1 — template edges per scrollable container + bounded store, with a churn experiment
on a synthetic feed app (one CI run).

**Goal.** Make the graph's size independent of content states, and prove it on an app whose
content states are counted. Behind the `screen-graph` flag
(`packages/configuration-core/src/flags.ts:82`) plus `ARGENT_SG_TEMPLATES=1`, so every D.4.1 arm
can run unchanged in the same job.

**Scope (files).**

| file                                                                                                     | change                                                                                                                    |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/tool-server/src/screen-graph/template.ts` (new)                                                | `containerKey`, `itemTemplate`, `templateNodeHash`, `destinationShape`, flat-list containment resolver (D1 option B)      |
| `packages/tool-server/src/screen-graph/types.ts`                                                         | `Edge.template?`, `ScreenNode.template?` / `volatility?`, template branch in `actionSignature` (`:216-224`)               |
| `packages/tool-server/src/screen-graph/store.ts`                                                         | caps + LRU + pins + edge decay + volatility maintenance + referential integrity, all on `flush()` (`:269-277`)            |
| `packages/tool-server/src/utils/screen-graph-open-wiring.ts`                                             | resolve container/template at record time; write the template edge instead of the per-item edge when enabled (`:308-340`) |
| `packages/tool-server/src/screen-graph/describe-tiers.ts` + `tools/describe/platforms/android/tiered.ts` | template affordance line, `volatile` marker                                                                               |
| `packages/tool-server/src/tools/navigate-to/index.ts`                                                    | template step: live `query` resolution + bounded in-container scroll + tolerant arrival                                   |
| `packages/tool-server/scripts/bench-screen-graph.ts`                                                     | churn task family, per-session store metrics, G-I3..G-I6, per-arm scoping of G-I2 (`:272-300`, `:2814`)                   |
| `bench/churn-app/**` (new)                                                                               | minimal Gradle app: seeded feed, nested carousel, two detail activities                                                   |
| `.github/workflows/bench-open-vs-proprietary.yml`                                                        | build + install the churn app in the screen-graph job; `BENCH_CHURN=1`                                                    |

**Tests (unit, the existing `packages/tool-server/test/screen-graph-*.test.ts` pattern).**
container identity stable across a scrolled fixture and across regenerated content; two item
shapes produce two templates; template node has no `stateHash` and therefore never serves cache;
LRU evicts unpinned and keeps pinned; eviction removes incident edges (G-I4); edge decay drops a
flaky edge; volatility flag flips at the threshold and drops `compact`; template-step navigation
resolves, scrolls, and fails closed on an ambiguous live query.

**CI.** One run: `bench-open-vs-proprietary.yml`, `suite=screen-graph`, `sg_mode=matrix`,
`BENCH_CHURN=1`. Both arms in the one job.

**Gates.** E1-G1..E1-G6 above, plus the standing house rules: gate rules pre-registered before the
run, every number naming statistic / arm / session / run id, no blending with run 34801849653
(`docs/open-server/README.md:108-117`).

**Out of scope for E-1.** Device-side container/template emission (option A, needs a server
`versionCode` bump and a latency re-measure); AW-app external validity (E-2); the `index` describe
tier; episodic per-item memory; any claim that template edges reduce tokens/step.

**Estimate.** One implementer, one worktree. Host code ~400-600 lines plus tests; churn app ~200
lines Kotlin; one CI run of ~90-150 min inside the existing 180-minute job.

### Open, not answered in this pass

- Whether Chrome's web-content node reports `scrollable = true` through our flat tree (decides
  optional arm B). Needs a device probe; not inferrable from the repo.
- The true persisted-byte cost of a feed node on a real feed — F5's 6.6 KB median is a Settings
  node (`test/fixtures/screen-graph-run-*.json`), used as a stand-in.
- Whether the rid-multiset Jaccard at threshold 0.9 (`plan.ts:13`) actually accepts every instance
  of a template destination. Designed for, measured by E1-G3, not proven here.
- Fastbot2's own state-key exclusions, which are the closest prior art for a bounded reusable
  model, remain unread (`docs/open-server/2026-09-02-screen-graph-related-work.md:117`).
