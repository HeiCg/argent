# Ticket: screen-graph phase D.4 — symmetric locate resolver for B1 and open configs; unique navTarget

Repo: ARGENT FORK, branches `feat/screen-graph-d` (from bfce58c19) / `feat/bench-ci-d`,
worktrees `argent-c3` / `argent-c3-ci`. NO local emulator/adb; CI only; one
`gh run view` per 10 minutes in the same foreground Bash call (`sleep 540`).

## Why
D.3 (run 33976442407) made the two-level task real, and B1 fell 98 → 94 with all five
failures on `settings-network-internet`. But B1's locate resolver was relaxed to
exact-first-then-first-contains while the open configs keep unique-or-refuse
(`pickUniqueNode`). An asymmetric resolver makes B1's drop a harness property, not a
proprietary capability claim; the scoreboard must not carry it as one.

## Work
1. **One resolver, two renderings.** B1 locates from the proprietary describe TEXT (the
   agent-facing rendering); open configs locate from the open describe/query. Both must
   use the same resolution policy: exact whole-field label match → exact
   contentDescription → contains only when exactly one candidate → otherwise refuse
   (exclusion "locate ambiguous", counted). Implement `parseDescribeLocate` on top of
   `pickUniqueNode` with identical precedence; a unit test feeds the same screen in both
   renderings (captured from the artifact: proprietary describe text and open nested
   tree of the Network & internet screen) and asserts the same node is chosen or both
   refuse.
2. **Investigate B1's rendering** for the "Internet" row: if the proprietary describe
   collapses the row into a combined string (toolbar + row) or omits bounds, document
   it as a rendering property with the exact describe excerpt; if the row is a clean
   label, B1 must resolve it under the symmetric policy. Report B1's per-task result
   for the two-level task with the excerpt either way.
3. **Unique navTarget** for `settings-network` (a label present only on the Network &
   internet screen, e.g. "Airplane mode", justified from the capture pass) so O5 routes
   instead of falling back (5 no-routes in D.3).
4. One matrix run; regenerate the doc from JSON (D.3 to superseded with reasons);
   report per-config success with intervals, O5 split, B1's two-level task outcome with
   the rendering excerpt, invariants gate line, H1–H4. Push; no device-farm commits.

## Acceptance
Same resolver policy in both paths (test proves it); B1's two-level outcome explained by
a quoted rendering, not by a relaxed resolver; O5 no-route on `settings-network` = 0;
run green with the invariants gate.
