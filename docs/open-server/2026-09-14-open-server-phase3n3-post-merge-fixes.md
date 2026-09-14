# Ticket: phase 3n.3 — post-merge fixes from the 3n.2 review

Status: dispatched 2026-09-14. `open/main` @ 86fe554b has 3n.2 merged; the planner
regenerated `package-lock.json` at the root (next commit: only the `@yume-chan/*` +
fetch-scrcpy-server download subtree dropped; a few entries flipped to `"dev": true` by
dedup). Read first: `2026-09-14-review-3n2-findings.md` in full (every 3N2-H*/M*/L* is a
work item; "Scoreboard/README corrections" gives exact wording; "Post-merge steps" is the
checklist), then the 3n.2 ticket + Result.

Branch `fix/open-server-3n3-post-merge` off `open/main` (HEAD after the lockfile
commit), worktree `../argent-fork-wt-3n3` (never /tmp; root `node_modules` symlinked; no
npm install / gradle / emulator; vitest `--maxWorkers=2`; `node --test
.github/bench-ci/gates.test.js`).

## Work
1. **3N2-H1 — a real fallback gate.** `merge-blocks.js` gates on the on-device
   `injectStrategyCounts["unavailable"]` (and any `fellBackTo`) reported per block via
   `getInfo`, not on the dead host counter; the block JSON carries the counts; Q4's
   measured-RPC denominator is a number (3N2-M6). `gates.test.js`: a block with one
   `unavailable` fails; zero passes.
2. **3N2-H2 — lockfile + `npm ci`.** Revert both `npm install` → `npm ci` in
   `bench-open-vs-proprietary.yml`; confirm `unit-tests.yml` uses `npm ci` and passes on
   the regenerated lock (the run proves it).
3. **3N2-H4 — artifact hygiene.** The screen-graph job's staging dir carried a previous
   execution's `results-ci.md`, `sg-matrix.log` and `graph-store`. Make the stage step
   start from an empty dir (`rm -rf "$STAGE" && mkdir -p`), stamp every artifact with
   the run id + job start time inside the files it produces (results header, log first
   line, store meta), and have the invariants line print the run id. Diagnose run
   34888577404's screen-graph job log once (`gh run view 34888577404 --log` filtered to
   the invariants line) and record in the Result whether THIS run's invariants were OK.
4. **3N2-H3 / M9 / M1 / M2 / M3 / M5 / M7 / M8 / L\*.** Docs: replace "byte-identical"
   with the true statement (gesture path comment-only-identical; `StateHandler.kt`
   changed for the residual stages — name the diff); headline sentence carries the
   pooled ratio movement 0.83 → 1.04; P3/P4 Δ label and CI use the SAME comparator;
   Q1/Q2 out-of-band verbs get their CIs computed from the per-sample arrays (report
   them; no gate change); the 3n.2 Result gets its missing sections (Part A
   walkthrough, removed/kept inventory, docs statement + flag decision, and the note that
   the fling harness + 12 gate tests + 7 fixtures were deleted on purpose because ticket
   3o rebuilds the instrument); `open-server-input.ts:31-38` comment fixed ("unset →
   input-manager; `default` → the Kotlin DEFAULT path"); the host `flush`/`flushInput`
   seam either gets a producer + test or is removed (say which); README "Execution
   order" lists iOS-1 (in flight) and 3o; apply the four scoreboard edits verbatim from
   the review.
5. **One CI run** `suite=both`, `sg_mode=matrix`, default blocks, to prove: `npm ci`
   green on both jobs, the new fallback gate wired (PASS with 0 unavailable), artifact
   stamped with its own run id, invariants line for this run. Polling: one `gh run view`
   per 10 min as a single `run_in_background` Bash call `sleep 540; gh run view <id>
   --json status,conclusion,jobs`; never loop; one `gh run download` per artifact. Also
   confirm `unit-tests.yml` ran green on the branch push (one `gh run list` is allowed).
6. Docs site: `packages/docs` unchanged by 3n.2 (verified by the review); say so.

## Result
Append `## Result (3n.3)` here: commits, finding-by-finding (3N2-H1…L*), run id, the two
workflows' outcomes, the stamped-artifact evidence, the invariants line with run id, and
anything not done. Do not fast-forward `open/main`; the planner merges after a short
check (no full re-review unless a number changes).
