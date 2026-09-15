# Ticket: screen-graph phase D.4.1 — fix the D.4 REJECT findings, one symmetric re-run

Status: dispatched 2026-09-13. Supersedes the D.4 `## Result` and the D.4 report
(`2026-09-13-screen-graph-phase-d4-results-ci.md`) until this ticket closes.
Read first, in this order: `2026-09-13-review-d4-findings.md` (the verdict you are
fixing — every D4-H*, D4-M*, D4-L\* item is a work item here),
`2026-09-05-screen-graph-phase-d4-symmetric-locate.md` (header + addendum + Result),
`docs/open-server/README.md` "Rules that paid for themselves".

Base: `feat/screen-graph-d4` @ `4cd928de` (on `open/main` @ 690e66bc). Continue on the
SAME branch in the SAME worktree `/Users/heicg/Desktop/projects/argent-fork-wt-d4`
(root `node_modules` is symlinked; never `npm ci`/gradle there; vitest
`--maxWorkers=2`; no emulator/adb). Artifacts already on disk: `.bench-results/d4`
(run 34788497583) and `.bench-results/d4-new` (run 34794414764).

## Work (harness + test, then ONE matrix run, then the report)

1. **D4-H1 — symmetric settle before every describe, all configs.** In
   `packages/tool-server/scripts/bench-screen-graph.ts` the B1/B2 (proprietary) path
   issues the step describe with no post-tap settle (`currentHash`/`traversals` return
   without a device call for non-open configs, lines ~536-556; describe at ~1164-1169),
   so B1's step-2 describe read the source screen (657 tokens, root row bounds, all 5
   reps). Make the settle policy identical for every config: the same wait (settle
   heuristic or fixed idle wait) that the open configs get through the tap RPC's
   settled `getState`, applied before B1/B2's describe. Record the settle wait per step
   in the JSON (`settleMs`) for all configs so the report can show symmetry. Do NOT
   count the settle inside the observation RTT of either arm.
2. **D4-H3 — parser symmetry.** `describeLinesToNodes` in
   `src/screen-graph/bench/describe-locate.ts` leaves `cd` undefined for the
   proprietary collapsed row (`"Display / Dark theme, font size, brightness"`), so the
   EXACT text/cd tiers of `pickUniqueNode` are unreachable for B1 while the open path
   gets title/summary as separate nodes. Split the collapsed label on `" / "` into
   `text` (before) and `cd` (after), mirroring the open title/summary split; if a row
   has no `" / "`, leave as is. Unit-test the split on the REAL describe lines from
   `logs/sg-matrix.log` (root screen rows are in evidence there).
3. **D4-H2 — no fabricated fixtures.** In `test/screen-graph-bench-locate.test.ts`
   delete the "CAPTURED Network & internet screen (run 34794414764)" block. Replace
   with: (a) the root Settings screen in both renderings, both taken verbatim from the
   artifacts (`preflight-launch-screens.json` `settingsRoot` for the open tree;
   `logs/sg-matrix.log` step-1 describe rows for the proprietary text), asserting the
   same node for `t("Network & internet")` and the same refusal/selection for
   `t("Display")` after item 2; (b) a destination-screen case ONLY if the new run's
   artifact carries the proprietary describe of that screen (add the capture in item
   4 so it does). Name every fixture by its source file and run id; a hand-built
   fixture must say "hand-built".
4. **Capture for item 2 of D.4.** Extend the `[D4]` excerpt capture so it logs the
   proprietary describe rows of the DESTINATION screen after the symmetric settle
   (all B1 tap steps, rep 0), plus the token count, so the report can quote the real
   rendering of "Internet" on the Network & internet screen.
5. **D4-H4 — delete "O5-pure".** No outcome-selected subsets anywhere in the report.
6. **D4-H5 — same-code reproducibility paragraph.** Report BOTH runs on the same code
   side by side (34788497583 and 34794414764: per-config success, B1 two-level task
   string, `settings-battery-then-back`, O5 nav split) and the new run as a third
   column. Run-to-run spread is the noise floor; say so per row.
7. **D4-M1..M7, D4-L1..L5** — apply each "Fix:" as written in the findings file:
   split B1 locate-fails into rendering vs degenerate-describe; attribute O5's 3
   `settings-display` failures to its own navigate-to divergences (not "config-neutral
   flakiness"); strike `same-display-slider` from the divergence attribution; add `T`
   (taskError) to the legend and render it distinctly; relabel H1 "all non-launch
   steps" and add the unchanged-steps value; publish the bootstrap seed and fix it in
   the harness; cite the graph-store evidence for "Airplane mode" uniqueness; state
   token/RTT denominators ("launch-step observation excluded"); rename the fail
   column; give each N its own cell; H2 with both n's; narrow the "reproduced" claim.
8. **One matrix run** on the branch:
   `gh workflow run bench-open-vs-proprietary.yml --ref feat/screen-graph-d4 -f suite=screen-graph -f sg_mode=matrix`.
   Polling: one `gh run view <id>` per 10 minutes as a single `run_in_background`
   Bash call `sleep 540; gh run view <id> --json status,conclusion,jobs`, waiting for
   its notification each time; never loop, never `gh run watch`; `gh run download`
   counts as one call. Budget: this one run. If a harness defect surfaces, fix it and
   ask the planner before a second run.
9. **Report**: overwrite `2026-09-13-screen-graph-phase-d4-results-ci.md` from the
   new JSON with the structure the findings file allows (its "Scoreboard rows
   allowed" section is the whitelist of claims). Every number names statistic, block,
   N and run id. Append `## Result (D.4.1)` to the D.4 ticket with run id, and a
   finding-by-finding "how addressed" table (D4-H1…D4-L5).

## Acceptance

- Same settle policy and same parser tiers reachable in both renderings, proven by
  tests on verbatim artifact rows (no invented rows).
- B1's two-level task outcome explained by the destination screen's quoted
  proprietary rendering after settle, or reported as a B1 loss with no rendering
  claim.
- Report carries both same-code reference runs; no outcome-selected subset; seed
  published; every M/L fix applied.
- Run green with the invariants gate. Scoreboard untouched; `open/main` not
  fast-forwarded (planner re-reviews first).
