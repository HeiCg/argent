# Ticket: CI paydown — lint, unit-tests and knip green on `open/main`

Owner wants a clean CI. After `2026-09-15-ci-hygiene-open-main.md` (merged 786feb59) the
hygiene workflows fire on `open/main`; three are red with pre-existing debt (read that
ticket's `## Result` for run ids and the exact error lists):

- **Lint** (run 34922260198): 9 mechanical errors (`no-unused-vars`,
  `no-useless-assignment`) + 4 `Parsing error: file not found in project` because
  `packages/tool-server/scripts/*.ts` are covered by `scripts/tsconfig.json`, which is
  not in eslint's `parserOptions.project`.
- **Unit Tests** (run 34922260124): `typecheck:tests` TS1343 — `test/bench-describe-host.test.ts`
  imports `scripts/bench-describe-host.ts` (uses `import.meta`) into the
  `tsconfig.test.json` compile whose `module` rejects it.
- **Dead Code / knip** (run 34922260092): red on upstream `main` too (pass 1: `ts-node`
  and `vitest` unlisted, unresolved bench entry imports; `knip.jsonc` byte-identical on
  main). On `open/main` pass 1 = 8 untraceable bench entry files + `ts-node` + 2 `vitest`
  binaries; pass 2 = ~71 unused exports/types in screen-graph / iOS / bench source.

## Work (one branch, green on all three before merge)

1. **Lint**: add `packages/tool-server/scripts/tsconfig.json` to the eslint
   `parserOptions.project` list (or the `projectService` allowDefaultProject list, whichever
   the repo's `eslint.config.*` uses); fix the 9 mechanical errors by removing the unused
   variables / useless assignments (never by disabling rules).
2. **Unit tests**: make `bench-describe-host.ts` importable from the test compile
   without `import.meta` in a CommonJS module context — extract the pure functions the
   test needs into a module without `import.meta` (e.g. `scripts/bench-describe-host-lib.ts`)
   and keep the CLI entry (`import.meta.url` main-check) in the script; or move the test
   to the scripts tsconfig. Then run the full `unit-tests.yml` job set locally where
   possible (vitest `--maxWorkers=2` per package; `typecheck:tests` needs the workspace
   `dist` — it is built in the MAIN checkout already, symlinked `node_modules` resolves it).
   Any other failing test: fix if ours, prove pre-existing on `main` @ e25c851b if not.
3. **knip**: pass 1 — list `ts-node` / `vitest` where they are actually used (or add the
   bench entry files under `entry` in `knip.jsonc` with a comment), resolve the 8
   untraceable bench entries (`.github/bench-ci/run-*.js` load scripts by path: register
   them as entries). Pass 2 — for each of the ~71 unused exports: delete dead code when
   nothing imports it (prefer this), un-export when only used in-file, and only for
   genuine cross-workspace / `argent-private` consumers (the `knip.jsonc` warning) add an
   `ignoreExportsUsedInFile` / `ignore` entry with a one-line reason. Keep behaviour:
   vitest `--maxWorkers=2` on tool-server, bench gates `node --test`, `tsc --noEmit`.
   Since `main` is red on knip too, the acceptance is green on `open/main`; document
   which config deltas would also green `main` (do not touch `main`).
4. Verify on the branch by pushing (the three workflows fire on `pull_request` to
   `open/main` — open a PR) and reading each failing log fully between pushes; budget 6
   pushes; at most one `gh run list -L 15` per 10 minutes (single background
   `sleep 540; gh run list …` call, never loop) and one `gh run view --log-failed` per
   red run.

## Process

Branch `chore/ci-paydown-lint-tests-knip` off `open/main` @ 786feb59, worktree
`../argent-fork-wt-paydown` (never /tmp; root `node_modules` symlinked; no npm install /
gradle / Xcode; vitest `--maxWorkers=2`). Another agent works on
`feat/ios-open-server-2-bench` (`packages/ios-sim-input/**`, `bench-ios-*`,
`ios-sim-input-service*`, `merge-blocks-ios/scoreboard-ios/run-bench-ios.js`,
`bench-ios-open-vs-proprietary.yml`, the two iOS-2 docs) — do not touch those; if knip
flags exports in files that exist only on that branch, they are not on `open/main` and
are out of scope. Append `## Result` here: commits, per-workflow run ids green, the
knip decisions table (deleted / un-exported / ignored-with-reason), the `main`-greening
config deltas, and anything left. Do not fast-forward `open/main`.
