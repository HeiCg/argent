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

## Result

Branch `chore/ci-paydown-lint-tests-knip` off `open/main` @ `144d29f4` (≥ 786feb59),
worktree `../argent-fork-wt-paydown`, root `node_modules` symlinked, no install/build,
pushed over SSH, PR #2 → `open/main`. `@docusaurus/tsconfig` is absent locally, so a
throwaway stub was used for local ESLint; CI installs the real one. No `main` branch was
touched and `open/main` was not fast-forwarded.

### Commits (workflow order)

1. `2732a16b` **fix(lint)** — cover the bench scripts, drop dead code (the 4 parse + 9
   mechanical + 10 more surfaced by linting the two big bench scripts).
2. `0c807cf2` **fix(unit-tests)** — isolate `import.meta` (harness lib split) + refresh 6
   stale RPC assertions.
3. `fd92de21` **fix(knip)** — register bench entries; delete/​un-export dead symbols.
4. `fb99b45b` **fix(lint)** — after the first push OOM'd CI's ESLint, lint the bench
   scripts without type info instead (dedicated `disableTypeChecked` block).

### Per-workflow outcome on the PR (all green; run set on `fb99b45b`)

- **ESLint** (lint.yml) `34927148384` — green.
- **Unit tests** (unit-tests.yml) `34927148346` — green.
- **Knip / Dead Code** (knip.yml) `34927148580` — green.
- **Prettier check** (format.yml) `34927148373` — green.
- **package-lock in sync** (lockfile.yml) `34927148302` — green.
- **Static checks** (repo-hygiene.yml) `34927148441` — green.
- **Tool description quality** `34927148418` — green.
- **Docs build** — did not run (its `pull_request` paths filter is `packages/docs/**`; this
  PR changes nothing there). Nothing to break.

First push (`fd92de21`) had Lint RED `34926284046` — not a lint error but
`FATAL ERROR: JavaScript heap out of memory` (exit 134): adding
`packages/*/scripts/tsconfig.json` to `parserOptions.project` made the type-aware parser
build a second full TS program over the two ~115 KB bench scripts + their whole src import
graph. Fixed by commit 4 (type-info-free scripts block). Unit tests / Knip were already
green on that first push.

### Lint — the config change and the fixes

- **Config**: reverted the `parserOptions.project` addition; added a dedicated block for
  `packages/*/scripts/**/*.ts` extending `tseslint.configs.disableTypeChecked` (parses
  without a per-file TS program, so no OOM and no "file not found in any project"). Non-type
  rules (`no-unused-vars`, `no-useless-assignment`, `prefer-const`) still run there; only the
  type-aware rules (e.g. `no-base-to-string`, already off for tests) do not. Also widened
  `packages/tool-server/scripts/tsconfig.json` `include` to `["*.ts"]` (was a stale 4-file
  list omitting bench-preflight / bench-screen-graph) so `typecheck:bench-scripts` covers
  every bench script. No rule was disabled to pass.
- **The 9 mechanical originals**:
  - `no-unused-vars`: `IosOpenServerClient` import — `src/blueprints/ios-open-server.ts:11`;
    `ScreenGraphStore` type import — `src/tools/describe/platforms/android/tiered.ts:28`;
    `beforeEach` — `test/ios-open-server-client.test.ts:2`; `planToSelector` —
    `test/screen-graph-edge-selector.test.ts:4`; `nestedLabelHash` /
    `pollFingerprintChanged` — `test/blueprints/android-open-server.device.test.ts` (deleted
    with their now-dead helper chain `labelHash` + `flattenNestedLabels`, all module-local,
    plus the orphaned `OpenServerNestedElement` import).
  - `no-useless-assignment` (dead-store init → bare `let x: T`): `redirOk` —
    `src/blueprints/android-open-server.ts:854`; `tree` — `.device.test.ts:270`;
    `evidence` — `.device.test.ts:563`.
- **10 surfaced by linting the bench scripts** (all mechanical, behaviour preserved):
  `scripts/bench-open-vs-proprietary.ts` — `no-useless-assignment` `ports:1367`, `out:1605`,
  `out:1765`; `prefer-const` `m:1774`; unused arg `config→_config:1976`; `no-base-to-string`
  `selector:2581` (guarded with `typeof … === "string"`).
  `scripts/bench-screen-graph.ts` — deleted dead `adbShell`; `no-base-to-string` at
  `1596` (err) and `2072` (runId / jobStartedAt), guarded with `typeof` instead of
  stringifying an `unknown`.

### Unit tests — the import.meta isolation and the stale assertions

- `test/bench-describe-host.test.ts` imported `scripts/bench-describe-host.ts`, pulling its
  `import.meta` into the CommonJS `tsconfig.test.json` compile (TS1343). Extracted the pure
  harness into `scripts/bench-describe-host-lib.ts` (no `import.meta`); the CLI keeps
  `DEFAULT_FIXTURE_PATH` + the `import.meta.url` main-check and imports the lib; the test
  imports the lib and resolves the fixture from its own `__dirname` (the pattern every other
  tool-server test uses). `typecheck:tests` / `typecheck:bench-scripts` pass; the test runs 7/7.
- Then `npm test` reached 6 assertions (3 files) that predated the phase 3n.1 flip making
  `inject: "input-manager"` the shipped default (`resolveInjectStrategy`), which every
  tap/swipe/gesture RPC now carries. Proven pre-existing: the same 6 fail on `open/main`
  @ 144d29f4 with the branch changes stashed. Refreshed the expected RPC option bag in
  `open-server-outcome-default-off.test.ts` (tap :104, multi-tap :132, swipe :156),
  `open-server-gesture-outcome.test.ts` (:95, :116), `open-server-swipe-hold.test.ts` (:80).
- Local (`--maxWorkers=2`): full tool-server suite green (5231 pass, 33 skipped),
  android-device-server 6/6, `typecheck:tests --workspaces` + `typecheck:scripts` green,
  `test:scripts` 92/92, bench-CI gates 21/21.

### Knip — decisions table

Pass 1 is config only (no file is actually dead — each is reached by exec-by-path,
`node -e`, or `npx tsx`, which knip cannot trace):

| action                   | count | items                                                                                                                                |
| ------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| entry — `.` workspace    | 2     | `.github/bench-ci/run-fling.js`, `merge-fling.js`                                                                                    |
| entry — tool-server      | 7     | `scripts/bench-{open-vs-proprietary,preflight,screen-graph,fling-fidelity,describe-host}.ts`, `scripts/run-{bench-sg,preflight}.cjs` |
| ignoreDependencies — `.` | 1     | `ts-node` (required by run-bench.js, hoisted from tool-server)                                                                       |
| ignoreBinaries — `.`     | 1     | `vitest` (run in two workflows, per-package devDep)                                                                                  |

Pass 2 — 59 unused exports/types, all tool-server-internal (nothing imports
`@argent/tool-server`, so a local run matches CI):

| action                                         | count | items                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| deleted (nothing references, not even in-file) | 3     | `renderSummaryFor` (describe-tiers), `iosOpenServerLongPress` (ios-open-server-input), `__resetScreenGraphWiringForTests` (screen-graph-open-wiring)                                                                                                                                                                                 |
| un-exported (used only in their own module)    | 56    | screen-graph types/consts (navigate, describe-tiers, plan, store, recorder, canonical, label, bench/_), ios-open-server runner/client internals, open-server-transport / screen-diff / screen-hash / open-server-_-cache helpers, `await-ui-element` + `describe/android` consts, `optical-scroll` + `bench-describe-host-lib` types |
| ignored with reason                            | 0     | none — no cross-workspace / argent-private consumer, so every finding was a real delete or un-export                                                                                                                                                                                                                                 |

### `main`-greening config deltas (main NOT touched)

`main` carries `.github/bench-ci/run-fling.js` + `merge-fling.js` but NOT the tool-server
bench scripts, screen-graph, or ios-open-server source (all fork-only). So on `main`:

- The **main-portable** knip deltas are the `.` workspace ones only: `entry`
  [`run-fling.js`, `merge-fling.js`] + `ignoreDependencies` [`ts-node`] + `ignoreBinaries`
  [`vitest`]. These address main's pass-1 findings (ts-node / vitest / those two unused files).
- The tool-server `entry` block and all pass-2 un-exports/deletes must NOT be applied to
  `main`: those files are absent there, and with `treatConfigHintsAsErrors: true` an `entry`
  matching nothing would itself fail the job. Likewise the Lint scripts-block and the
  `import.meta` split target fork-only files that do not exist on `main`.

Not executed against `main` (per "do not touch `main`"); reasoned from `git cat-file`/tree
inspection + the hygiene ticket's earlier `origin/main` knip run.

### Left / out of scope

- `docs-build` never triggered (no `packages/docs/**` change) — not red, just not run.
- ios-2 files (`packages/ios-sim-input/**`, `bench-ios-*`, `ios-sim-input-service*`,
  `merge-blocks-ios/scoreboard-ios/run-bench-ios.js`, the ios-2 workflow + docs) untouched;
  no knip finding fell in files that exist only on `feat/ios-open-server-2-bench`.
- `packages/tool-server/src/screen-graph/store.ts` is stored as binary by git (pre-existing
  on the base — `file` reports "data" on both); the two un-exports applied correctly and
  `typecheck:tests` parses it.
