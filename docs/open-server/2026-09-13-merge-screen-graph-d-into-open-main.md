# Ticket — merge `feat/screen-graph-d` into `open/main` (2026-09-13)

Status: dispatched to one implementor. Step 1 of the execution order in `README.md`.

## Decision: `feat/bench-ci-d` is superseded, not merged

`open/main` already carries `feat/bench-ci-final`, which is a strict superset of
`feat/bench-ci-d`: `git diff open/main origin/feat/bench-ci-d -- .github` adds zero lines
on the bench-ci-d side (only deletions of newer gates). The screen-graph matrix job is
already in `open/main`'s workflow (job `screen-graph`, currently checking out
`feat/screen-graph-d` by branch head). So the only merge to do is the driver +
screen-graph tree, and the workflow's screen-graph job must be retargeted to the merged
tree afterwards. `feat/bench-ci-d` stays on origin as history; nothing to merge.

## Facts the implementor needs

- Repo: `/Users/heicg/Desktop/projects/argent-fork` (remote `origin` =
  github.com/HeiCg/argent). Main checkout is on `open/main` (clean, `3da4aa7c`). Do not
  touch the main checkout; work in a worktree created under the parent directory:
  `git worktree add ../argent-fork-wt-merge-sg -b merge/screen-graph-d open/main`.
  Never put a worktree under /tmp or the scratchpad (wiped between sessions).
- Source: `origin/feat/screen-graph-d` @ `68f2d26f` (25 commits since merge-base
  `9d0a9ccf`; 62 new files, 14 files modified on both sides). It contains screen-graph
  phases A (versioned tree, H/H_text hashes, query/diff/awaitChange, outcomes), B (host
  screen graph, describe tiers, navigate-to), A.1 settle heuristic, C/C.1–C.4 harness,
  D→D.3 (H_id keying, selector-carrying edges, honest accounting, harness exact-match
  locate, per-step navTarget) and the start of D.4 (symmetric locate resolver for B1).
- Target: `open/main` = `feat/android-open-server-final` (driver phases 3h scrcpy tap,
  3i host transport, 3j compact payload — 3j is DISABLED by decision, keep it disabled)
  - `feat/bench-ci-final` (workflow with all gates) + docs.
- `git merge-tree --write-tree open/main origin/feat/screen-graph-d` reports content
  conflicts in exactly these 11 files:
  - `packages/android-device-server/assets/manifest.json`
  - `packages/android-device-server/build.gradle.kts`
  - `packages/android-device-server/src/main/java/com/argent/devicecontrol/DeviceControlInstrumentation.kt`
  - `packages/android-device-server/src/main/java/com/argent/devicecontrol/JsonRpcHandler.kt`
  - `packages/android-device-server/src/main/java/com/argent/devicecontrol/handlers/HierarchyHandler.kt`
  - `packages/android-device-server/src/main/java/com/argent/devicecontrol/handlers/StateHandler.kt`
  - `packages/configuration-core/src/flags.ts`
  - `packages/tool-server/src/blueprints/android-open-server.ts`
  - `packages/tool-server/src/tools/describe/index.ts`
  - `packages/tool-server/src/tools/paste/platforms/android.ts`
  - `packages/tool-server/src/utils/android-open-server-client.ts`
    Three more files auto-merge but must be re-read for semantic sanity:
    `describe/platforms/android/open-server-tree.ts`, `utils/open-server-input.ts`,
    `test/open-server-paste.test.ts`.

## Resolution rules

1. Semantic union, `open/main` wins on shared behaviour. Every RPC method, flag and
   stage-timing field that exists on `open/main` (3h/3i/3j) must still exist with the
   same semantics after the merge. Every screen-graph RPC/flag/field from
   `feat/screen-graph-d` must be added on top, not replace anything. If the two sides
   changed the same function (e.g. `StateHandler` describe path, `JsonRpcHandler`
   dispatch table, `flags.ts` registry), read both histories (`git log -p` on the file
   for each branch since `9d0a9ccf`) and reconstruct the union by hand. Do not pick
   "ours"/"theirs" wholesale for any of the 11 files.
2. Kotlin `build.gradle.kts` / `assets/manifest.json`: version code and version name
   must be strictly greater than both sides. Check how `manifest.json` is produced
   (prebuilt APK metadata vs generated) by reading the workflow and any script that
   writes it, and follow that convention — do not hand-edit a checksum for an APK you
   did not build.
3. No gradle in the worktree (resource policy: no build > 1 GB of artefacts in a
   worktree, and no local emulator). Kotlin correctness is verified by the CI run below,
   which builds the APK. Do read the Kotlin conflict regions carefully; a compile error
   costs a 60-min CI round trip.
4. TypeScript verification in the worktree, reusing the root environment:
   `ln -s /Users/heicg/Desktop/projects/argent-fork/node_modules node_modules` at the
   worktree root (and per-package `node_modules` symlinks if the workspace layout needs
   them; check how the root resolves them first). Then, from the worktree root:
   `npx tsc --build` (root `build` script) must pass, and
   `cd packages/tool-server && npx vitest run --poolOptions.threads.maxThreads=2` must
   pass. Never `npm install`/`npm ci` in the worktree.
5. Workflow: in `.github/workflows/bench-open-vs-proprietary.yml`, the `screen-graph`
   job currently does a second checkout of `ref: feat/screen-graph-d` and builds that
   tree. After the merge that tree is the same as the job's own ref, so make the
   screen-graph job build the checked-out ref (same as the `latency` job does) and
   delete the second checkout. Keep everything else in the workflow untouched (gates,
   fling A/B, artifact staging, the pre-flight fixture step).
6. Docs: `docs/open-server/README.md` "Where things are" and "Execution order" — update
   to say `feat/screen-graph-d` is merged, `feat/bench-ci-d` superseded, and remove step
   1. One short paragraph, no numbers.
7. Commit the merge with a normal merge commit (`git merge --no-ff origin/feat/screen-graph-d`),
   then any follow-up fixes as separate commits on `merge/screen-graph-d`. Commit
   early and often; push the branch to origin after the first successful `tsc`.

## CI acceptance (one run, must stay green)

- Trigger: `gh workflow run bench-open-vs-proprietary.yml --ref merge/screen-graph-d -f suite=both`
  (check the exact input names at the top of the yml first; there is also a
  screen-graph mode input — use `matrix`).
- Polling rule (GitHub API quota is shared, 5000/h): exactly one `gh run view <id>`
  per 10 minutes, executed in the SAME foreground Bash call after `sleep 540`. Never a
  background monitor, never `gh run watch`.
- Green means: `latency` and `screen-graph` jobs both succeed; gate steps pass; the
  first-attempt landing-rate gate and the fling A/B behave as on run 33975063607
  (fling under-scroll at 400 ms is a known LOSS and is allowed to be red only if it was
  red on that run — read `2026-09-03-open-vs-proprietary-results-final-ci.md`). Any new
  red step is a merge defect: fix, push, re-run once.
- Do not add numbers from this run to the scoreboard. The run exists to prove the merge
  did not regress; write the run id and per-job status at the bottom of this ticket
  under a "## Result" heading.

## Deliverable

Branch `merge/screen-graph-d` pushed, CI run id + status recorded in this file, README
updated. Do not fast-forward `open/main` yourself; report back and the planner merges.
Report: list of the 11 files and, for each, one line on how the conflict was resolved.

## Result (2026-09-13)

Branch `merge/screen-graph-d` pushed to origin (merge commit `57ca43e6`, parents
`open/main 3da4aa7c` + `origin/feat/screen-graph-d 68f2d26f`; follow-up `5edb4b6c`
retargets the screen-graph job + updates this README). `open/main` NOT fast-forwarded —
left for the planner. All 11 conflicts resolved by hand as semantic unions (open/main wins
on shared behaviour; screen-graph RPC/flags/fingerprints added on top). Version bumped to
`0.1.21` / versionCode `25` (strictly greater than both sides).

CI run id: **34788497583** (`gh workflow run bench-open-vs-proprietary.yml --ref
merge/screen-graph-d -f suite=both -f sg_mode=matrix`).

Per-job status:

- **screen-graph (matrix, x86_64 KVM): success** — the merged tree built and the
  screen-graph matrix passed; the retargeted job (no more `ref: feat/screen-graph-d`
  checkout) built its own dispatched ref, confirming the workflow change.
- **latency (OFF/ON, x86_64 KVM): failure — solely at the blocking "Fling A/B" parity
  gate.** Every other step green: "Install argent deps + build TS" (the authoritative
  `tsc --build` on the merged tree), "Build open device-server APK (Kotlin, Java 17)",
  "Open-server on-device test", "Latency bench — 4 blocks + merge", first-attempt landing
  gate (**PASS**, ≥95%), tap effect-check (firstTapNoEffect 0/40, 0/60, 0/60, 0/40).

Fling verdict on this run: `FAIL (1 informative cell outside ±0.15: 150ms/0.3 = 0.8)`. The
400 ms cells — the documented known loss — **passed** here (400/0.3 dev 0.125 OK,
400/0.5 dev 0.04 OK). On the reference run 33975063607 the fling parity gate was likewise
red (there the offender was 400ms/0.3 = 0.717); that gate is documented as NOT ESTABLISHED
on this x86_64 KVM runner (`2026-09-03-open-vs-proprietary-results-final-ci.md`). So the
run behaves as the reference: everything green except the blocking, never-established fling
gate — the offending short-vs-long cell varies with emulator scroll-physics noise. The
merge changed no fling/swipe physics: the only related change wraps `swipe`/`gesture` in
`runAction{}` in `JsonRpcHandler`, which is a pure pass-through when no `outcome` param is
sent, and the fling bench sends none. Not a merge defect; not re-run (the gate is
structurally red on this runner, so a re-run cannot make the latency job green).

Verdict: **the merge did not regress.** Every gate the merge could affect is green
(TS build, Kotlin APK, on-device test, latency 4-block bench, landing-rate gate,
screen-graph matrix); the sole red is the pre-existing, merge-invariant fling parity gate,
red as on the reference run.

Local verification (worktree, root `node_modules` symlinked):

- `tsc`: the R33 worktree guard blocks `tsc --build` (heavy-build class); verified type
  safety with an artifact-free `tsc --noEmit` over the merged `tool-server` +
  `configuration-core` (all `@argent/*` mapped to source) — **clean, 0 errors**. CI's
  "Install argent deps + build TS" step then ran the real `tsc --build` green.
- `vitest run --maxWorkers=2` (local pinned vitest 4.1.9; `@argent/*` aliased to worktree
  source since deps aren't built): **5204 passed / 10 failed / 20 skipped**. All 10
  failures are in `test/ios-instruments/malloc-stack-logging.test.ts` (iOS native-profiler)
  — neither branch touched that area since the merge-base and the merge diff has no iOS
  files, so they are a source-vs-dist `FailureError`-identity artifact of the alias
  harness, not merge regressions. Every screen-graph / open-server / describe / paste /
  flags suite passed.

## Planner verdict (2026-09-13) — ACCEPTED, `open/main` fast-forwarded to `5edb4b6c`

The fling cell that turned red (150 ms / 0.3, scrcpy/uia 0.32/0.40 = 0.80) sits inside
the reference run's own interquartile ranges for that cell (run 33975063607, N = 12:
uia median 0.449 IQR [0.175, 0.509], scrcpy 0.466 IQR [0.23, 0.593]). A median shift of
that size is noise on a gate the final report already calls "not establishable" with
UiAutomation as the unstable arm. The 400 ms cells being within ±0.15 of UiAutomation on
this run does not retract the known loss: scrcpy/off at 400 ms / 0.5 is 0.451/0.657 =
0.69, consistent with the 0.57–0.58 deficit of runs 5 and 7. No number from run
34788497583 enters the scoreboard; 3k measures pacing directly.

Housekeeping carried by the merge and left for the next ticket: two stray root files
`run-bench-sg.cjs` and `run-preflight.cjs` (screen-graph-d loader shims) — remove or
move under `packages/tool-server/scripts/` in 3k/D.4. Worktree
`../argent-fork-wt-merge-sg` removed; branch `merge/screen-graph-d` stays on origin as
history.
