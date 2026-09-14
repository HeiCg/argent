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

## Addendum 2026-09-13 — refreshed base, what is already done, how to finish

- Base: `open/main` @ `801b0cfb` (contains `feat/screen-graph-d` @ `68f2d26f`, merged via
  `2026-09-13-merge-screen-graph-d-into-open-main.md`). Branch `feat/screen-graph-d4`
  off `open/main`, worktree `../argent-fork-wt-d4` (never /tmp). Root `node_modules`
  exists; symlink it, never `npm ci` in the worktree. vitest with `--maxWorkers=2`.
- Already done in `68f2d26f` (verify, do not redo): item 1 — `describe-locate.ts` runs
  the same `pickUniqueNode` policy as the open path, refusing ambiguous sets;
  `test/screen-graph-bench-locate.test.ts` covers it (check it feeds the SAME screen in
  both renderings; if it only tests one side, extend it with the captured Network &
  internet proprietary describe text + open tree). Item 3 — `tasks.ts` navTarget for
  `settings-network` is `t("Airplane mode")`.
- Item 4's matrix run ALREADY EXISTS: run **34788497583** (`suite=both`,
  `sg_mode=matrix`, screen-graph job success) ran on the merged tree, which is exactly
  this code. Download its `bench-screen-graph` artifact
  (`gh run download 34788497583 -n bench-screen-graph -R HeiCg/argent -D <worktree>/.bench-results/d4`)
  and generate the D.4 report from that JSON. Trigger a NEW run
  (`gh workflow run bench-open-vs-proprietary.yml --ref feat/screen-graph-d4 -f suite=screen-graph -f sg_mode=matrix`)
  ONLY if the artifact lacks something D.4 needs (e.g. the B1 describe excerpt for
  item 2 is not in the artifact) or the invariants gate is not derivable. One run max;
  polling one `gh run view` per 10 min, foreground, after `sleep 540`; `gh run download`
  counts as one call.
- Item 2 (B1 rendering of the "Internet" row): the proprietary describe text per step
  should be in the artifact (per-config step logs); quote the exact excerpt. If it is
  not captured, that is the one legitimate reason for the new run, after adding the
  capture to the harness first.
- Report file: `docs/open-server/2026-09-13-screen-graph-phase-d4-results-ci.md`
  (per-config success with intervals, O5 split incl. no-route count on
  `settings-network`, B1 two-level outcome + excerpt, invariants gate line, H1–H4,
  D.3 marked superseded with reasons). Every number names statistic, block, N, run id.
  Do NOT edit `2026-09-03-scoreboard.md`; the planner does that after adversarial review.
- Housekeeping in the same branch: move the root shims `run-bench-sg.cjs` and
  `run-preflight.cjs` under `packages/tool-server/scripts/` (or delete them if the
  workflow no longer references them — grep the yml first) and fix references.

## Result (2026-09-13, feat/screen-graph-d4)

Done. Authoritative run **34794414764** (`suite=screen-graph`, `sg_mode=matrix`, job
success), branch `feat/screen-graph-d4` @ `13388c19`, base `open/main` @ `690e66bc`.
Full report: `docs/open-server/2026-09-13-screen-graph-phase-d4-results-ci.md`.

- **Item 1 (verified, already in `68f2d26f`).** `describe-locate.ts` (`parseDescribeLocate`)
  and `locateNorm` both call the one `pickUniqueNode` (exact id → exact text → exact cd →
  unique-contains → refuse). `test/screen-graph-bench-locate.test.ts` feeds the SAME screen
  through both renderings AND a captured-screen test (added this phase); 15/15 green.
- **Item 2.** B1 fails `settings-network-internet` **NNNNN**. Captured excerpt (verbatim,
  run artifact `logs/sg-matrix.log` line 28): `B1 locate FOUND-UNIQUE for {"text":"Internet"}
  on settings-network-internet step 2; describe rows containing "internet": LinearLayout
  "Network & internet / Mobile, Wi‑Fi, hotspot" [clickable]  (0.000, 0.321, 1.000, 0.096)`.
  The proprietary describe collapses the entry into one combined summary; there is no
  discrete "Internet" row, so the SAME policy taps the summary (wrong target). Rendering
  property, not a relaxed resolver. Assertion: B1 matched (none) vs B2 "Add network".
- **Item 3 (verified, `68f2d26f`).** `settings-network` navTarget `t("Airplane mode")`.
  **O5 no-route on `settings-network` = 0** (settings-network YYYYY for O5).
- **Item 4.** One new run (see below); D.4 report regenerated from JSON, D.3 marked
  superseded with reasons. Invariants gate green. Scoreboard left untouched.
- **Harness capture + housekeeping.** `[bench-sg][D4]` diagnostic now fires at rep 0 for
  every B1 tap step (log-only). Root shims `run-bench-sg.cjs` / `run-preflight.cjs` moved
  under `packages/tool-server/scripts/` (workflow never referenced them), `__dirname`-relative;
  `.bench-results/` gitignored.

One new run WAS needed: run 34794414764. The B1 "Internet" describe excerpt was not in the
reference run 34788497583's artifact (the `[D4]` diagnostic was gated to `!found && rep===0`
and the two-level step resolves a unique-but-wrong node at rep 0), the exact case the
addendum names — so the capture was added first, then one run.
