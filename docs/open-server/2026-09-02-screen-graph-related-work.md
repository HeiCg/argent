# Related work — verified survey for the screen-graph architecture (2026-09-02)

Companion to `2026-09-02-screen-graph-architecture.md`. Verification level:
2025–2026 arXiv items had abstract pages fetched; classic testing/agent papers
are listing-verified (DBLP/ACM/arXiv), PDF bodies not read. Items marked
(unverified) need the PDF before citing a specific number.

## Tier 1 — directly contests one of our claims

- **Agent-E** — Abuelsaad, Sadhukhan, Kokku et al., arXiv:2407.13032 (2024).
  https://arxiv.org/abs/2407.13032. Hierarchical web agent; DOM distillation
  and *change observation*: each action skill reports the resulting DOM change
  (MutationObserver) back to the LLM as text. 73.2% WebVoyager, ~25 LLM
  calls/task. **Closest prior to "actions return outcomes".** Differs: the
  outcome is prose, not a structural fingerprint; cannot identify the screen or
  skip the next observation.
- **From Imperative to Declarative: LLM-friendly OS Interfaces (DMI)** — Wang,
  Li, Chen, arXiv:2510.04607 (2025/26). https://arxiv.org/abs/2510.04607.
  Declarative primitives access/state/observation; environment handles
  navigation. +67% success, 43.5% fewer steps on MS Office. **Closest prior to
  "stop dumping, expose an interface".** Differs: no versioning, hashing,
  diffs, cache validity; evaluated on success/steps, not tokens.
- **Executable Agentic Memory for GUI Agents** — arXiv:2605.12294 (2026).
  https://arxiv.org/html/2605.12294v1. GUI Logic Knowledge Graph (screens,
  actions, transitions) built by *offline DFS exploration*, MCTS path
  extraction online. Reports 8.3K tokens/step, 2.8 s/step (6× cheaper than a
  GPT-4o baseline). Differs: offline phase; nodes are LLM-identified, not
  device-hashed; full observation per step.
- **AppAgentX** — Westlake AGI Lab, arXiv:2503.02268 (2025).
  https://arxiv.org/abs/2503.02268. Chain memory built *online* from task
  history; shortcut nodes. Steps 9.1→5.7, tokens/task 9.26K→4.94K. Differs:
  memory over action chains, not screen identity; observation unchanged.

## Tier 2 — observation cost (all host-side, all full-dump)

- **UIFormer** — Ran, Gong, Guo et al., arXiv:2512.13438 (2025).
  https://arxiv.org/abs/2512.13438. UI representations are >80% of agent
  token usage; DSL-synthesized transformations cut tokens 48.7–55.8%. **Best
  citation for our §1.**
- **D2Snap** — Schiepanski & Piël, arXiv:2508.04412 (2025).
  https://arxiv.org/abs/2508.04412. DOM downsampling; 42% of raw DOMs exceed
  128K; explicitly no diff mechanism.
- **Revisiting Observation Reduction for Web Agents** — Enomoto, Obara, Zhang,
  Oyamada, arXiv:2605.29397 (2026). https://arxiv.org/abs/2605.29397. 11
  reduction methods; 2.2–3.1× per-step latency gains at 84–89% of success.
  None incremental. Our O1 baseline family.
- **Read More, Think More** — arXiv:2604.01535 (2026).
  https://arxiv.org/html/2604.01535. Strong models do *better* with richer
  observations. **Risk to H1/H4**: lossy summary tier may cost success on
  strong models — pre-register per-model-tier analysis.
- FocusAgent arXiv:2510.03204; LLM-Explorer arXiv:2505.10593 (>148× lower
  exploration cost — strongest mobile "cost, not coverage" precedent).

## Tier 3 — UI transition graphs / model-based testing (listing-verified)

DroidBot (ICSE-C 2017), Stoat (FSE 2017), **APE** (ICSE 2019 — runtime
abstraction refinement; closest to a tunable `H`), Humanoid (ASE 2019),
ComboDroid (ICSE 2020), **Fastbot2** (ASE 2022 Industry,
https://dl.acm.org/doi/10.1145/3551349.3559505 — *reuses the transition model
across runs*, deployed at ByteDance). Differs: graphs serve random explorers
for coverage, never queried by an LLM at inference time. **Do not claim prior
work only builds graphs offline** — Fastbot2, AppAgentX, MAGNET build/reuse
online.

## Tier 4 — GUI state abstraction (prior on hashing screens)

- **Baek & Bae, ASE 2016**, "Automated model-based Android GUI testing using
  multi-level GUI comparison criteria".
  https://dl.acm.org/doi/10.1145/2970276.2970313. Lattice of abstraction
  levels over GUI properties for state equality. **Our `H`/`H_text` split is
  two points on this lattice** — cite as the definition; claim only the
  engineering placement (on-device, sub-ms, used as cache token).
- LlamaTouch (UIST 2024, arXiv:2404.16054) — exact+fuzzy UI-state matching for
  evaluation. MAGNET (arXiv:2601.19199) — online stationary+procedural memory.

## Tier 5 — one-citation analogies

- Chrome `AXTreeSerializer` / `AXTreeUpdate`: stateful serializer sends only
  dirty nodes renderer→browser.
  https://chromium.googlesource.com/chromium/src/+/HEAD/docs/accessibility/browser/how_a11y_works_2.md
  **Exact engineering precedent for §2.1** — "we apply the renderer→browser
  serializer contract across the device→host boundary."
- React keyed reconciliation: https://react.dev/learn/preserving-and-resetting-state
- Kleppmann, "Turning the database inside-out" (2015); Debezium as CDC artifact.
- Industry (acknowledge, not peer-reviewed): Playwright ARIA snapshots with
  compact refs (~4× fewer tokens than MCP, https://playwright.dev/docs/aria-snapshots);
  callstack `agent-device` (https://github.com/callstack/agent-device);
  Stagehand caches *action plans* by DOM hash
  (https://www.browserbase.com/blog/stagehand-caching) — hash-keyed caching
  exists, but not of observations.

## Benchmarks
AndroidWorld, AndroidLab, MobileAgentBench, LlamaTouch, Mind2Web, WebArena
(arXiv:2307.13854), SeeAct (ICML 2024), AWM (ICML 2025). All headline success
rate/steps; none reports tokens/step or device serialization latency as
first-class. (WebArena observation modalities: verify from repo before
asserting.)

## Novelty verdict

| Claim | Status | Why |
|---|---|---|
| Device-side versioned tree + query/diff API; cost ∝ answer | **Novel** | All reduction work compresses after a full dump crosses the wire; DMI moves work into the environment but has no versioning/hash/diff. |
| **Diff as the observation** | **Novel — no prior found** | Nearest misses: Agent-E (prose mutation), TSR arXiv:2607.00502 (visual pre/post), AppDeltaWorld arXiv:2608.05891 (predicted delta, not observed). **Lead with this.** |
| Persistent screen graph built online | Incremental | Fastbot2 / AutoDroid / EAM / AppAgentX / MAGNET. Residue: device-hash-keyed nodes used as cache validity; no exploration phase. |
| Actions return outcomes | Incremental | Agent-E. Residue: fingerprint-carrying outcome lets the host skip describe; RTT saving measured (H2). |
| Tokens/step + latency as metrics | Incremental | AppAgentX, EAM, UIFormer, Revisiting… already do it. Frame as adopting a standard. |

**Repositioning:** headline = "the observation is a diff, answered by the
device"; screen graph = mechanism that makes the diff addressable and cacheable.

## Unresolved
Mobile-Agent v1/v2, DroidBot-GPT, CoCo-Agent, OS-Copilot, UI-TARS per-step
cost tables unverified; Fastbot2's state key/hash exclusions (read the ASE'22
PDF https://tingsu.github.io/files/ASE22-industry-Fastbot.pdf); benchmark
appendices for wall-clock per task.
