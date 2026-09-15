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
