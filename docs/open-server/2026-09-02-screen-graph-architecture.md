# Screen-as-Database, App-as-Graph: an architecture for token- and latency-efficient LLM device agents

Status: design (2026-09-02). Owner: device-farm / @device-stream. Target venues
if it becomes a paper: ICSE/ASE (tool track), MobiSys/MobiCom (systems), or an
arXiv preprint tied to the argent RFC.

## Abstract

Every LLM device agent we measured — argent's tool-per-call loop, our own DSL
loop, and every published mobile agent we know of — re-reads the whole screen
after every action. On Android Settings that is ~660 tokens (o200k) and ~15 ms
of device serialization per step, before the model has even decided anything;
both backends now emit the identical trimmed tree (657 = 657 tokens, Jaccard
1.000), so pruning is exhausted as a lever. We propose to stop dumping. The device-side server keeps a **versioned
accessibility tree** and answers **queries** (selectors, deltas, hashes) instead
of returning the tree; the host keeps a persistent **screen graph** — screens
fingerprinted by structure, edges labelled by the action that caused the
transition — so a revisited screen costs a hash check and a graph lookup, not a
re-description. Actions return their own **outcome** (before/after fingerprint,
delta, known-screen id) so the tap→wait→describe triple collapses into one
round-trip. The expected effect is that per-step tokens scale with the size of
the *answer* rather than the size of the *screen*, and that warm runs (second
visit of a screen) cost an order of magnitude less than cold runs. We describe
the components, the formalization, and an evaluation protocol on our existing
benchmark harness against the argent baseline.

## 1. Problem, with our numbers

Historical baseline, v1 run of 2026-09-02
(`2026-09-02-open-vs-proprietary-results.md`); these figures are SUPERSEDED
and kept only to show the starting point. Current like-for-like numbers are in
`2026-09-02-open-vs-proprietary-results-v4.md` (v4/v6): describe token parity
657 = 657 (o200k), 14 = 14 elements, Jaccard 1.000; tap 61 ms open vs 53 ms
proprietary (+8 ms).

| per step (v1, superseded) | argent proprietary | our open server |
|---|---|---|
| describe (Settings root) | 473 tok (chars/4) / 14 el / 73 ms | 1077 tok (chars/4) / 59 el / 74 ms — trim landed in v2, now 657 / 14 |
| tap | 53 ms | 146 ms — injector fixes landed in v2/v3, now 61 ms |
| auto-capture after each tool (argent MCP) | +screenshot +tree ≈ 800 tok/step | same policy when routed |

Two structural facts drive the cost, independent of backend:
1. **Full re-serialization per step.** The tree is rebuilt on-device, JSON-encoded,
   shipped, re-rendered to text, and tokenized — even when 0 nodes changed.
2. **No memory across steps or runs.** Screen N revisited is as expensive as
   screen N first seen. The agent re-localizes itself from scratch every step.

Micro-optimizations (pruning, Nagle, injector pacing — phase 3, in flight)
shrink the constant; they do not change the O(screen) per step.

## 2. Architecture

Three layers, each independently valuable, composable.

### 2.1 Device layer — the tree as a versioned store with a query API

On-device server (our Kotlin `android-server`; iOS via WDA `/source` polling
on the host as a fallback with the same interface).

- **Versioned tree.** Server keeps the last serialized tree `T_v` and a
  monotonically increasing version `v`. It subscribes to
  `AccessibilityEvent` (`TYPE_WINDOW_CONTENT_CHANGED`, `WINDOW_STATE_CHANGED`,
  `VIEW_SCROLLED`) and bumps `v` on any event. Reading the tree when nothing
  happened is a cache hit: **no UiAutomation traversal**.
- **Structural hash.** `H(T)` = hash over (class, resource-id, bounds bucket,
  actionability flags) per node in DFS order, *excluding* text. A second
  `H_text(T)` includes text/content-desc. `H` identifies a *screen*;
  `H_text` identifies its *state*. Computing `H` over an already-built tree is
  ~O(n) integer ops, sub-millisecond for n≈500.
- **Query RPCs** (replace `getAccessibilityTree` as the default agent path):
  - `query(selector, {limit, fields})` → matching nodes only. Selector grammar
    = the DSL's (`id`, `text{contains,regex}`, `class`, `containsDescendant`,
    `index`, `visible`). Match server-side.
  - `diff(sinceVersion)` → `{v, H, H_text, added[], removed[], changed[]}` as
    node paths + compact node records; empty when `v` unchanged.
  - `state({includeTree:'none'|'compact'|'full', sinceVersion})` → `{v, H,
    H_text, idle, screen:{w,h,pkg,activity}, tree?}`. Our existing `getState`
    grows the hash+version fields and the `sinceVersion` short-circuit.
  - `awaitChange({fromVersion, timeoutMs, until?:selector})` → resolves on the
    first AX event after `fromVersion` (or when `until` matches); no polling
    from the host. Replaces host-side 250 ms poll loops.
- **Actions return outcomes.** `tap/swipe/gesture/typeText` return
  `{before:{v,H}, after:{v,H,H_text}, changed, idleMs}` after a bounded idle
  wait (default 300 ms, cancellable). One RTT gives the agent: did anything
  change, is it a new screen (H differs) or same screen new state (only
  H_text differs).

### 2.2 Host layer — the screen graph ("app memory")

In the tool-server / MCP host (TS), persisted per `(package, versionCode)` as
JSON under `~/.device-farm/screen-graph/` (or argent's config dir).

- **Node** = screen fingerprint `H` with: first/last seen, visit count, the
  compact rendering of the tree at first visit, a *selector index*
  (`resource-id | text → bounds, actionability`) and an optional
  human/LLM-assigned label (e.g. "Settings > Network & internet"), plus a
  thumbnail.
- **Edge** = `(H_from, action, H_to)` where `action` is canonical
  (`tap #id`, `tap "text"`, `swipe up`, `back`, `typeText #id`). Weighted by
  observed count and success ratio; time-stamped for staleness.
- **Localization.** After any action, the host receives `after.H`. If `H` is
  known: return `{screen: label|id, seen: n, affordances: [known outgoing
  edges], delta_vs_last_visit}` — typically 30–80 tokens. If unknown: fall
  back to compact describe (cold path) and insert the node.
- **Route planning.** `plan(targetSelector | targetScreen)` → shortest known
  action path from the current `H` (Dijkstra over edge weights). Exposed to
  the agent as a tool, and to our DSL as `ds.navigateTo(...)` which executes
  the path with per-step verification by `H` and falls back to the model on
  divergence.
- **Precomputed state cache.** `describe` is served from the node's stored
  compact rendering when `H_text` matches; when only text differs, the host
  applies the device `diff` to the cached rendering (cheap patch) instead of
  re-rendering. Cache validity is guaranteed by the device hash, not by time.

### 2.3 Agent-facing layer — what the model sees

- A step is `act(action) → outcome` where `outcome` is: `{changed, screen,
  known, summary}`; the model asks for `describe` only when `known=false` or
  when it explicitly needs detail. In our typed-script DSL this is the
  default return of `tap()/fill()` and the wait verbs.
- `describe` has three tiers: `summary` (label + affordances, ≤100 tok),
  `compact` (pruned tree, current 470-tok class), `full` (debug).
- The graph is *advisory*: the agent may deviate; every deviation is a new
  edge. Exploration is a by-product of use, not a separate phase.

## 3. Formalization (for the paper; also the contract for tests)

- Tree `T` = ordered rooted tree of nodes `n = (class, id, text, cd, bounds,
  flags)`. Screen hash `H(T) = h(seq_DFS((class, id, quant(bounds), flags)))`
  with `quant` bucketing bounds to 1/32 of screen dims to tolerate small
  layout jitter. State hash `H_text` adds `(text, cd)`.
- Delta `Δ(T_a, T_b)`: computed by keyed tree diff on `(class, id, index in
  parent)`; output `added/removed/changed` node paths. Property: `T_b =
  patch(T_a, Δ)`; `|Δ| = 0 ⇔ H_text(T_a) = H_text(T_b)`.
- Screen graph `G = (V, E)`, `V ⊆ image(H)`, `E ⊆ V × A × V`, `A` canonical
  actions. Localization = lookup `H(T_now) ∈ V`. Planning = shortest path in
  `G` under weight `w(e) = 1/(successes+1) + staleness`.
- Cost model. Per step: tokens `= c_outcome + [known ? c_summary :
  c_compact]`, RTT `= 1` (action+outcome) `+ [known ? 0 : 1]`. Baseline:
  tokens `= c_tree(+c_screenshot)`, RTT `= 2–3` (action, idle, describe).

## 4. Evaluation protocol

Harness: `device-stream/benchmarks/token-bench/` (adapters exist for argent
and DSL; extend with a "graph-warm" adapter). Device: AVD bench-api35; apps:
Settings (system), a React Native sample (for argent parity), one third-party
app with deep navigation (e.g. an open-source news/notes app from F-Droid).

Configurations: (B1) argent stock MCP; (B2) argent + open server; (O1) query
API only; (O2) O1 + outcomes; (O3) O2 + screen graph cold (empty memory);
(O4) O3 warm (second run, same app version); (O5) O4 with `navigateTo` plans.

Metrics per task: tokens in/out (tiktoken o200k), wall time, RTTs, device
serialization time, success (assertion on final screen), steps. Report
cold/warm ratio and tokens-per-step distributions. Tasks: 15 navigation/
form flows we already have as Maestro YAML + 5 exploration tasks ("find the
setting that…").

Hypotheses: H1 O1 ≤ 0.5× tokens/step vs B2 on unchanged/near-unchanged
steps. H2 O2 removes ≥1 RTT/step. H3 O4 ≤ 0.2× tokens/step vs O3 on
revisited screens. H4 success rate non-inferior (±2 pp) to B1.

Status after Phase C pass 1 (2026-09-03, `2026-09-02-screen-graph-results.md`):
H1 PASS (0.107×: 67 vs 629 tokens/step), H3 PASS (0.064×: 40 vs 629, RTT
2→1 on warm), H2 FAIL, H4 not measured (baseline oracle invalid, being
fixed in Phase C.1). H2's failure is structural, not a bug: on
navigation-only tasks every action changes the screen, so the outcome
never reports "unchanged" and B2 already folds idle+tree into one RPC.
H2 must be re-stated over steps where the screen legitimately does not
change — form filling, toggles, same-screen text entry, failed/no-op taps —
and the task set extended with such steps before it can be tested; the
navigation-heavy pass 1 could not exercise it. The task suite's needles
must also be validated against the origin screen (Phase C.1): pass 1's
100 % across all open configs may be partly a permissive oracle (query returned a
non-empty set for a word absent from the page), not evidence.

## 5. Related work and positioning (verified survey: `2026-09-02-screen-graph-related-work.md`)

Headline claim, and the only one with no prior found: **the observation is a
diff, answered by the device.** Every observation-reduction work (UIFormer,
D2Snap, FocusAgent, the 2026 "Revisiting Observation Reduction" studies)
compresses *after* a full dump crosses the wire; DMI (arXiv:2510.04607) moves
work into the environment but has no versioning, hashing or diffs; Agent-E
reports DOM mutations as prose, not as a structural fingerprint. Chrome's
`AXTreeSerializer`/`AXTreeUpdate` (renderer→browser, dirty nodes only) is the
engineering precedent we apply across the device→host boundary.

Claims we present as *incremental*, with the residue we defend:
- Screen graph / app memory: Fastbot2 reuses a transition model across runs;
  AutoDroid and Executable Agentic Memory (arXiv:2605.12294) build UTG-backed
  memory (offline exploration); AppAgentX and MAGNET evolve memory online.
  Residue: nodes keyed by a device-computed structural hash that doubles as
  cache-validity token; no exploration phase; the graph caches the
  *observation*, not only action plans (Stagehand caches plans by DOM hash).
- Actions return outcomes: Agent-E's change observation has the same loop
  shape. Residue: fingerprint-carrying outcome lets the host skip `describe`
  entirely; the RTT saving is NOT yet demonstrated (H2 FAIL, 0 RTT removed on
  the navigation-only pass 1 — see §4).
- `H`/`H_text`: two points on Baek & Bae's multi-level GUI comparison
  criteria lattice (ASE 2016) — cite as the definition; APE (ICSE 2019)
  refines the abstraction at runtime. We claim the placement (on-device,
  sub-ms, cache token), not the abstraction.
- Tokens/step and latency as first-class metrics: already reported by
  AppAgentX, EAM (8.3K tok/step, 2.8 s/step), UIFormer (48–56% cut),
  Revisiting… (2.2–3.1× latency). We adopt the standard; benchmarks
  (AndroidWorld, AndroidLab, MobileAgentBench, LlamaTouch, WebArena) still
  headline success only.

Risk from the literature: "Read More, Think More" (arXiv:2604.01535) finds
strong models do better with richer observations. §4 must pre-register a
per-model-tier analysis and keep the `compact` tier available on demand so
the summary tier is never the only observation.

## 6. Risks / open questions

- Fingerprint stability across dynamic lists (feeds): `H` must exclude
  list-item count — hash recyclers by container id + first item class, not
  by item count. Evaluate false merges/splits.
- AX event storms (animations) → version churn; debounce 50 ms, and treat
  `H` unchanged + `H_text` changed as "same screen, live content".
- iOS: no AX event stream through WDA; version by polling `/source` hash
  (we already do for idle) — weaker but same interface. XCTest-based
  server later.
- Privacy: the graph stores screen text; must respect the secrets policy
  (never store text of password fields; honour `secretsUsed`).
- Graph poisoning by flaky actions: edges carry success ratios; prune below
  threshold.

## 7. Delivery plan (device-farm first — our driver; port to argent after)

- **Phase A (device):** versioned tree + `H/H_text` + `query` + `diff` +
  `state(sinceVersion)` + `awaitChange` + action outcomes, in
  `device-stream/native-servers/android-device-server` and the DSL
  `AndroidDriver`/`Session` (`tap()` returns outcome; `awaitUntil` uses
  `awaitChange`). Tests: hash stability, diff/patch property, no traversal on
  cache hit (assert via a server-side counter exposed in `getInfo`).
- **Phase B (host):** screen graph store + localization + `describe` tiers +
  `navigateTo` in `@device-stream/dsl` and `dsl_*` MCP tools; persistence
  under `~/.device-farm/screen-graph/<pkg>/<versionCode>.json`.
- **Phase C (eval):** token-bench adapters O1–O5, report generator, warm/cold.
- **Phase D (argent port):** same RPCs into `feat/android-open-server`'s
  Kotlin server + `describe`/`await-*`/gesture tools consume outcomes and
  graph; this is the RFC deliverable.
