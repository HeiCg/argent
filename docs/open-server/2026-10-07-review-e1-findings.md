# 2026-10-07 — adversarial review of E-1 (PR #22, run 4 = 37584222236)

Verdict: do NOT publish run 4 as "E-1 result (reviewed)". G1/G2/G4
(storage growth) hold. G3, G5 and the arrival check do not support the
claim as written. Merge behind the flag is acceptable once finding 8's flag
check lands; publication waits for E-1.1 (below).

## Findings

1. MAJOR — G5 is labelled DESCRIPTIVE in code (`churn.ts:649-652`, `pass:
null` since b63c43e4) while the doc pre-registers a pass condition (store
   ~11n/10e, O1 tokens 138-179, O4 20-22). Run 4: store 10n/9e, O1 136,
   `skippedNoIdHash` 2. Literally a FAIL, on the cheap side, probably noise.
   Fix: grade G5 in code against the pre-registered bar; publish the miss.
2. MAJOR — G3 measures a scroll-and-exact-text search, not the template
   edge: the harness passes `"Story ${target}"` straight to
   `executeTemplateStep` (`churn.ts:502-506`); the plan only picks the arrival
   node. The OFF arm makes no navigation attempts (its per-item edges cover
   Story 0-7 only). A graph-free search would score the same 40/40; the
   D.4.1 O5 59/60 comparator is a different task. Fix: add a no-graph arm
   running the same search; describe G3 as "search reliability of the
   template step".
3. MAJOR — arrival accepts any detail page of the right layout: Jaccard
   ≥ 0.9 on resource ids vs a node titled `*` (`churn.ts:507-511`); the
   exact-match query spans the whole screen, not the template's container
   (`navigate-to/index.ts:548-552`); the scrolled container is "the largest
   scrollable" (`:425`); `planToTemplate` picks the nearest template node of
   any container (`plan.ts:186`). Fix: verify the detail headline
   (`Headline <seed>-<i>`), match only inside the template's container, route
   by the requested item.
4. MAJOR — the "momentum-free" scroll still flings on CI: 90 gaps over 204
   swipes (44 %), 37/40 attempts with ≥ 1 gap, `swept` false 40/40 (an
   absent item would always run to the 30-scroll cap). No per-attempt wall
   time; inferred 1-2 s per swipe, 30-60 s worst case. Fix: log wall time;
   fix the fling on the device side (MotionInjector hold collapsing under
   load is the suspect).
5. MINOR — "present-only" G3 is inert (`targetInFeed` = `0 ≤ t < 50`); fine
   now, risky for E-2 (presence from the app model, not observed). Fix:
   observe presence (full sweep) before E-2.
6. MINOR — churn app covers recycling + summary/detail churn only; no
   insert/delete/reorder, duplicate titles, late loads, fresh titles per
   session (E-0 asked for them). No eviction ever ran (3 nodes vs 300 cap).
7. MINOR — G6 tokens are cap-bound (topN=6); "p50" is a mean of per-session
   p50s (`churn.ts:655-661`). 203 KB vs 23 KB is fair (same sessions, no
   pruning on either side).
8. MINOR — `navigate-to` takes the template route without checking
   `ARGENT_SG_TEMPLATES` (`:744`, `:779`); every flush serialises the whole
   store to check the byte bound; template nodes pinned forever (`:468`);
   `lastItemTexts` persists item text (R5); `results-ci.md` prints
   `[object Object]` for churn/settingsGraph; `store.ts` contains NUL bytes
   so its diff renders as binary.
9. MINOR — tests pin implementation numbers (`scrolls[39] === 7`, `22`) that
   CI contradicts; missing: exact match outside the container, carousel item
   routed to the list template.

Bars were not moved (gate table unchanged since 5131ae50).

## E-1.1 (follow-up run that would strengthen it most)

Same job with: a no-graph scroll-search arm on the same targets; arrival
checked against the detail headline and container-scoped matching; per-attempt
wall time; 4 deliberately absent targets; G5 graded in code; flag check in
navigate-to; the fling fixed or measured on device.
