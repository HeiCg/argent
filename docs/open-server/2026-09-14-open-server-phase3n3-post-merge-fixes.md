# Ticket: phase 3n.3 — post-merge fixes from the 3n.2 review

Status: dispatched 2026-09-14. `open/main` @ 86fe554b has 3n.2 merged; the planner
regenerated `package-lock.json` at the root (next commit: only the `@yume-chan/*` +
fetch-scrcpy-server download subtree dropped; a few entries flipped to `"dev": true` by
dedup). Read first: `2026-09-14-review-3n2-findings.md` in full (every 3N2-H*/M*/L\* is a
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

Append `## Result (3n.3)` here: commits, finding-by-finding (3N2-H1…L\*), run id, the two
workflows' outcomes, the stamped-artifact evidence, the invariants line with run id, and
anything not done. Do not fast-forward `open/main`; the planner merges after a short
check (no full re-review unless a number changes).

## Result (3n.3)

Branch `fix/open-server-3n3-post-merge` off `open/main` @ `00c10536`, worktree
`../argent-fork-wt-3n3` (root `node_modules` symlinked; no install/gradle/emulator in the
worktree). `open/main` NOT fast-forwarded.

### Commits (in order)

1. `78cbb79a` **Work 1 / 3N2-H1** — real fallback gate: `merge-blocks.js` reads on-device
   `injectStrategyCounts["unavailable"]` + a missing/zero denominator; `bench-open-vs-proprietary.ts`
   carries the raw counts, total and `measuredInjectRpcs`; `scoreboard.js` prints Q4 as numbers.
2. `5f5fce24` **Work 2 / 3N2-H2** — both bench jobs reverted `npm install` → `npm ci`.
3. `63f013d9` **Work 3 / 3N2-H4** — screen-graph fresh-store + run-id stamping (report/store/invariants); stage from empty dir.
4. `20332642` **Work 4 code / 3N2-M5+M7** — `open-server-input.ts` header comment fixed; flush wire test restored.
5. `8740e197` **Work 3 fix** — define `BENCH_OUT` in the matrix step (the mis-dispatch cause; see below).
6. `348c353c` **Work 4 / 3N2-L4+L5** — drop vestigial `fastInject` param; pin the screen-graph inject strategy.
7. `0c8279cc` **Work 4 docs** — scoreboard four verbatim edits + L1/L2, 3n.2 Result H3/M1/M2/M3/M6/M9, README M8.
8. `95e08ed0` **Work 3 followup 2** — sg-matrix.log first-line stamp + job-start fallback (not CI-re-verified).

### Run of record — 34904658366 (head `8740e197`, `workflow_dispatch`, `suite=both`, `sg_mode=matrix`, blocks OFF-1/ON-uiautomation/ON-input-manager/OFF-2, N=20)

**Conclusion `success` — BOTH jobs green:** Latency bench (device suite + 4-block bench +
merge + scoreboard + Enforce) **success**; Screen-graph matrix **success**. A first
dispatch (34903589838) was **VOID** — my own `set -u` bug (`$BENCH_OUT` unset in the matrix
step) aborted step 13 before any measurement; `npm ci` (step 10) had already passed there,
confirming the lockfile is in sync. It was cancelled and re-dispatched once after the
one-line fix (`8740e197`). So exactly one run of record.

- **unit-tests.yml:** did NOT trigger on the branch push — it fires only on push/PR to
  `main`, and this branch is off `open/main`. It is unchanged and already on `npm ci`; it
  will run when 3n.3 reaches `main`. The bench jobs' green `npm ci` (both) is the
  lockfile-integrity proof for now (3N2-H2). `gates.test.js` **17/17** locally.

### Finding-by-finding

- **3N2-H1 (fallback gate)** — `merge-blocks.js:194-231` now gates ON-input-manager on
  `im.injectStrategyCounts["unavailable"] > 0` **and** a zero/absent total; carries
  `strategyUnavailable`/`strategyTotal`/`measuredInjectRpcs` into the merged JSON
  (`:247-256`). Counts come from `getInfo` via `bench-open-vs-proprietary.ts:2420-2475`
  (raw `injectStrategyCounts` + `injectStrategyTotal` + `measuredInjectRpcs` added to the
  block). `scoreboard.js:314-330` prints Q4 as numbers. Kotlin unchanged — `InfoHandler.kt:42-46`
  already exposes `injectStrategyCounts` from `InjectStrategyCounter.snapshot()`, so no Kotlin
  change was needed. **Tests** (`gates.test.js`): `fallback gate FIRES on on-device
injectStrategyCounts.unavailable (3n.3)` ({input-manager:150, unavailable:11} → fail);
  `fallback gate does NOT fire on host verb.fallbacks (the dead counter, 3n.3)`; `fallback
gate FIRES on a missing/zero on-device inject denominator (3n.3)`. **Run evidence:** merged
  JSON `strategyUnavailable 0 / strategyTotal 158 / measuredInjectRpcs 100`; block
  `injectStrategyCounts {"input-manager":158}` — the gate READ the on-device count and the
  green run proves it fires on real data.
- **3N2-H2 (lockfile + npm ci)** — `bench-open-vs-proprietary.yml:~208` and `~532`: both
  `npm install` → `npm ci`, comments rewritten. `unit-tests.yml:26` was already `npm ci`.
  **Proof:** both bench jobs ran `npm ci` green on the regenerated lock (`open/main` @
  d9df0f34).
- **3N2-H3 (byte-identical withdrawn)** — scoreboard 3n.2 row (edit 1) and the 3n.2 Result
  Q1 cell + acceptance paragraph rewritten: gesture verbs are code-identical (Kotlin
  injectors + host gesture path unchanged from `bb3fbddf`), but `StateHandler.kt` (+59/−15,
  stage clocks → `uptimeMillis`, `infoMs`/`recycleMs`/`otherMs`) changed, so the
  headline/`describe` rows are NOT code-identical; the decisive evidence is the untouched OFF
  comparator moving 408→256 / 486→280.
- **3N2-H4 (artifact hygiene)** — `bench-screen-graph.ts`: `BENCH_FRESH_STORE` empties
  `OUT_DIR` + the persisted graph store at start (`:2582-2591`); run id + job start stamped
  into the report header (`:2072-2078`), `graph-store/_run-meta.json` (`:2775-2782`) and the
  "store invariants OK" line (`:2800-2808`). Workflow: `rm -rf "$BENCH_OUT"`, `BENCH_OUT`
  defined, stage step `rm -rf "$STAGE"`. **Run evidence (34904658366 artifact):** exactly ONE
  `bench-sg-2026-09-14T22-40-21-541Z.json` (no foreign JSON — the contamination is gone);
  `results-ci.md:3` `Generated … · run 34904658366 · job started .`; `_run-meta.json`
  `{"runId":"34904658366", …, "benchStartedAt":"2026-09-14T22:40:21.541Z"}`; sg-matrix.log
  `store invariants OK … (run 34904658366, job started )`. **Two gaps** fixed for future runs
  in `95e08ed0` (not CI-re-verified): the run-id echo now tees into sg-matrix.log's FIRST
  line, and `github.run_started_at` (empty for workflow_dispatch) falls back to the step UTC
  clock. The run id — the anti-contamination essential — is verified in all three files.
- **3N2-H4 diagnosis of run 34888577404 (Work 3)** — from the job LOG (one
  `gh run view 34888577404 --log`): `[bench-sg] wrote …/bench-sg-2026-09-14T19-51-14-817Z.json`
  (21:30:05.939Z, THIS run's fresh JSON), immediately followed by `[bench-sg] store
invariants OK: 0 duplicate screens, 0 multi-destination edges` (21:30:05.947Z). **So run
  34888577404's OWN store invariants WERE OK** — the uploaded `results-ci.md`/`graph-store`
  were a foreign 14:11 execution's, but the live job proved this run's invariants clean.
- **3N2-M1 (comparator)** — 3n.2 Result Q3 row + verb table: swipe/pinch labelled **vs
  pooled OFF** with Δ (−30.5 / −24.5) AND CI ([−37,−25] / [−30,−19]) from the same
  comparator, plus the min(OFF) pair (Δ −30 CI [−37,−21] / Δ −24 CI [−31,−18]) — recomputed
  from the 34888577404 artifacts, nearest-rank p50, 10 000-draw bootstrap, seed 0x5eedc0de.
- **3N2-M2 (Q1/Q2 CIs)** — computed from both runs' per-sample arrays (nearest-rank p50, 10
  000 draws, seed 0x5eedc0de; reported, no gate change). **Q1 (ON-input-manager, 34870686468
  → 34888577404):** tap Δ+1 **[0,+1]**, swipe Δ+4 **[−1,+9]**, headline Δ−93 **[−147,+17]** —
  every CI contains 0. **Q2 (ON-uiautomation control):** tap Δ−5 [−11,+9], swipe Δ−13
  [−20,+12], pinch Δ+2 [−9,+9], headline Δ−117 [−269,+61] — all contain 0; **only**
  await-screen-idle Δ−6 **[−8,−3]** clears 0, on the untouched control path → an environment
  shift, not a removal effect. Written into the 3n.2 Result + scoreboard.
- **3N2-M3 (missing Result sections)** — added to the 3n.2 Result: Part A finding-by-finding,
  removed/kept inventory, the flag decision (removed outright; registry entries advisory,
  `flags.ts:6-8`), the deliberate fling-stack deletion (M4), and the docs statement.
- **3N2-M4 (fling stack)** — recorded in the 3n.2 Result: `bench-fling-fidelity.ts`,
  `merge-fling.js`, `run-fling.js`, the 12 `merge-fling:*` gate tests and 7 fixtures were
  deleted with scrcpy on purpose; **3o rebuilds the instrument from `775ae6fc` in git
  history**. Fling stays OPEN, pinned to 34813849446.
- **3N2-M5 (comment)** — `open-server-input.ts:31-41` header rewritten: unset/unknown →
  `input-manager` (shipped default); `default`/`uia` → undefined (Kotlin DEFAULT path). Now
  matches the body at `:43-52`.
- **3N2-M6 (denominator)** — `measuredInjectRpcs` is a number on the block + merged JSON
  (**100** this run: 5 inject verbs × N=20); Q4 states `100 of 158 process-wide (+ warmups +
oracle + describe-split + locate/restore)`.
- **3N2-M7 (flush seam) — DECISION: KEEP + restore test.** The host `flush`/`flushInput`
  seam is retained (the Kotlin FlushInputHandler is live — `HierarchyHandler`/`StateHandler`
  call it — and an out-of-process injector can request the inline drain). The deleted wire
  coverage is restored: `android-open-server-blueprint.test.ts` — "threads `flush:true` onto
  the read RPCs only when opted in, and flushInput() issues the RPC" (blueprint+inject+gesture
  **26/26**). Not removed.
- **3N2-M8 (README)** — Execution order lists **iOS-1** (in flight, `feat/ios-open-server-1`)
  between 3n.2/3n.3 and 3o, and 3o with the fling-stack note; renumbered. Where-things-are
  updated to `00c10536`, 3n.2 merged (86fe554b / lockfile d9df0f34), 3n.3 under review, iOS
  docs named, the `npm ci` revert named.
- **3N2-M9 (headline ratio)** — scoreboard 3n.2 row (edit 2) + 3n.2 Result P5: the ratio
  moved 0.91/0.77/0.83 → 1.09/1.00/1.04, so the open stack **lost ground** on the headline
  relative to proprietary despite the 93 ms absolute improvement; P5 is a non-inferiority
  band, not a win.
- **3N2-L1** — describe p95 placeholders filled from 34870686468's artifacts (52/166, 48/66,
  51/68, 47/72, 52/52); OFF-1 p50 corrected 51→52 (sourced to `bench-block-OFF-1.json`, a
  1 ms recompute — a number change, flagged here).
- **3N2-L2** — device-row wording: "21 vitest cases / 22 reported checks".
- **3N2-L4** — vestigial `fastInject?: boolean` dropped from `assertTapTimelineParity`.
- **3N2-L5** — `bench-screen-graph.ts` pins `ARGENT_OPEN_INJECT_STRATEGY` to `input-manager`
  explicitly (was "env unset ⇒ default") and records it in the run env block.
- **3N2-L3, L6 — NOT done (out of scope / won't-fix):** L3 (a `max`/p95 residual line in the
  device-test printout, not a gate) is deferred — it needs the on-device test's residual
  printout and adds no gate; noted for a future pass. L6 (the process-global
  `forceUnavailableForTest`) is unreachable in production (`benchDebug` start arg) and the
  review itself marked "the part that mattered" (P9 on three RPCs) done; left as-is.

### The four scoreboard edits (verbatim, one adaptation)

Applied verbatim to the 3n.2 row: (1) Q1/Q2 byte-identical replacement, (2) headline ratio
note, (3) Q4 counts wording, (4) Q6 invariants-from-log qualifier. **One adaptation:** the
Q1/Q2 edit's trailing "no cross-run CI was computed" is replaced by the computed CIs (Work 4
requires the CIs). Also filled describe p95 (L1) and the 21/22 device wording (L2).

### Screen-graph Q6 (run 34904658366, green)

B1 100/100 (o200k 657) · B2 100/100 (651) · O1 **98/100** (138) · O2 100/100 (54) · O3
99/100 (627) · O4 100/100 (21) · O5 100/100 (21); store invariants OK (run 34904658366),
`com.android.settings` **11 nodes / 11 edges** (store shape is not run-stable — 34888577404
was 10/9). Latency: im tap 54 / swipe 269 / pinch 316 vs OFF ~52-53 / ~299 / ~352 —
swipe/pinch win, tap parity; both ON headlines lower this run. Job green ⇒ P0–P6 + residual
gate + the new fallback gate all passed.

### Docs site (Work 6)

`packages/docs/` is unchanged by 3n.2 and 3n.3 — no page under `packages/docs/` mentions
scrcpy, `@yume-chan`, `open-device-server-fast-inject` or any sub-flag (verified by grep). No
docs-site content change needed; `npx docusaurus build` / `npm run format` were not run in
the worktree (they run in the main checkout only, per project `CLAUDE.md`).

### GitHub API usage

One bench run of record (34904658366) + one void mis-dispatch (34903589838, cancelled); two
`gh run list` (one per dispatch, to capture each run id) plus the list that also confirmed
unit-tests.yml did not trigger; one `gh run view 34888577404 --log` (H4 diagnosis); polling
via `sleep 540; gh run view --json …` (one per 10 min, background); one targeted
`gh run view --json jobs` + `--log-failed` to diagnose the void dispatch; `gh run download`
per artifact: 34870686468 (latency, for Q1/Q2 CIs), 34888577404 (latency for CIs +
screen-graph for the H4 diagnosis), 34904658366 (latency + screen-graph). `gh run cancel`
once on the void dispatch.

### Not verified / open

- unit-tests.yml green: not run (branch off `open/main`, not `main`). The bench jobs' green
  `npm ci` is the lockfile proof; unit-tests.yml runs at PR/merge to `main`.
- The `95e08ed0` log-first-line + job-start-time fix is not CI-re-verified (single run spent);
  the run-id stamping it builds on IS verified green.
- Pre-existing (not 3n.3): `typecheck:tests` reports 2 errors in `scripts/bench-describe-host.ts`
  (`import.meta` under the project module setting), pulled in by `test/bench-describe-host.test.ts`
  — unrelated to this ticket, my src/test edits add zero new errors (confirmed by stashing).
