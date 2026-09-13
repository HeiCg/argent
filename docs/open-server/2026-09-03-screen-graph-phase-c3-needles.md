# Ticket: screen-graph phase C.3 — land destination-unique needles, make pre-flight block the matrix, explain O5 locateFailed, measure H4

Repo: ARGENT FORK (`HeiCg/argent`). Two worktrees, both new, both yours only:

- `/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-c3`
  on branch `feat/screen-graph-c3` from `feat/screen-graph` (5b1e6e98).
  Bench scripts live here: `packages/tool-server/scripts/bench-preflight.ts`,
  `packages/tool-server/scripts/bench-screen-graph.ts`, test
  `packages/tool-server/test/screen-graph-bench-preflight.test.ts`.
- `/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-c3-ci`
  on branch `feat/bench-ci-c3` from `feat/bench-ci` (be362dbd). Workflow lives
  here: `.github/workflows/bench-open-vs-proprietary.yml` (job `screen-graph`,
  starts ~line 355).

Never edit `argent-sg`, `argent-ci`, `argent-p3*`, `argent-fork`. NO local
emulator, NO adb against local devices (host memory-exhausted; physical device
ZF524RZBHD is off-limits). Verify on CI only:
`gh workflow run bench-open-vs-proprietary.yml --repo HeiCg/argent --ref feat/bench-ci-c3 -f suite=screen-graph`,
then `gh run watch` / `gh run download <id> --repo HeiCg/argent -n bench-screen-graph -D <scratch>`.
The proprietary package is downloaded at run time from npm (never commit it;
its LICENSE forbids redistribution and reverse-engineering).

## Evidence

Run 33742435496 (screen-graph matrix, `feat/bench-ci` @ 94fef5d0):

- Pre-flight printed `PROBLEM needles: 14` (identical to run 33737161298)
  and the matrix ran anyway. Success 0.63–0.68 for every config, so no
  discrimination between configs; H4 (task success vs B1) is unmeasured.
- O5: `locateFailed` 30/60. B2: 2 fallbacks.
- Oracle-independent numbers that must be preserved (tokens/step, RTT 1):
  B1 473, B2 447, O1 67, O2 32, O4 63. H1 0.182× PASS, H3 0.129× PASS,
  H2 PASS over the 30 same-screen steps, FAIL over all steps.

Root causes, confirmed offline 2026-09-03:

1. The `screen-graph` job checks out `feat/screen-graph` at the PINNED SHA
   `5b1e6e98eb307354581d0f5ce24cd397d3bb86e1` (workflow "Checkout
   feat/screen-graph @ 5b1e6e98"). The bench scripts exist only on that
   branch. `feat/screen-graph` local and remote heads are still 5b1e6e98, so
   no needle change was ever committed anywhere the job reads. Whatever
   "needle fix" C.2 believed it made did not exist.
2. The pre-flight step is
   `node -e '…bench-preflight.ts' 2>&1 | tee "$RUNNER_TEMP/sg-preflight.log"`
   with no `set -o pipefail`, so a non-zero exit from the script is masked by
   `tee`. Also verify whether `bench-preflight.ts` sets a non-zero exit at all
   when `PROBLEM needles > 0` (it prints the count near line 160).

## Work

1. **Pre-flight gate (pure + tested).** Extract `preflightVerdict(needleEval)
   -> { ok: boolean; problems: string[] }` (BAD or MISSING ⇒ not ok) and make
   `bench-preflight.ts` exit 1 when `!ok`. Unit-test the function in
   `screen-graph-bench-preflight.test.ts` (ok / BAD / MISSING / mixed).
   Workflow: prefix the pre-flight and matrix `run:` blocks with
   `set -euo pipefail`; the matrix step must not run if pre-flight failed (it
   is a later step in the same job, so a failing pre-flight step is enough
   once pipefail is on — confirm there is no `continue-on-error` on it).
2. **Destination-unique needles for the 14 PROBLEM tasks.** A needle is
   valid when it is present on the task's DESTINATION screen and absent on
   its LAUNCH screen (the existing pre-flight check). Source of truth for
   what is on each screen, in order of preference:
   a. artifacts of run 33742435496 (`sg-preflight.log`, matrix results JSON,
      `results-ci.md`) — the oracle readouts carry visible node text;
   b. if destination text is not recoverable from (a), add
      `BENCH_CAPTURE=1` to `bench-preflight.ts`: for every task, execute the
      task's steps once through the plain B1 path (describe + tap) and dump
      launch-screen and destination-screen visible texts/ids to
      `.bench-results/screen-graph/capture.json`; add a workflow input
      `sg_mode` (`capture` | `matrix`, default `matrix`) that runs only
      pre-flight in capture mode; run capture once, pick needles from the
      dump, commit them, then run the matrix.
   Never pick a needle by guessing; every needle must be justified by a line
   in the capture/oracle output, and the pre-flight run in the final CI run
   must print `PROBLEM needles: 0`.
3. **O5 locateFailed 30/60.** Read the config table in
   `bench-screen-graph.ts` to see what O5 does, then read the O5 rows in the
   matrix log/JSON from run 33742435496: which steps fail to locate, first
   step of a task or later ones, what the locate query was, what the graph
   held at that moment. Likely candidates: O5 locates through the host graph
   before the graph has observed the screen (cold-graph bucket), or it locates
   by an id/text that the compact describe tier strips. Fix the harness if
   the failure is a harness artifact; if it is a genuine cost of the O5
   strategy, keep it and report it as O5's cost (no exclusions, no silent
   fallback to another config). Either way, report the count after the change
   with the per-step reason.
4. **Re-run the matrix and measure H4.** Push both branches, re-pin the
   workflow's screen-graph checkout to the head of `feat/screen-graph-c3`,
   run `-f suite=screen-graph`, download artifacts. Compute per config:
   success rate (with exclusions accounted, not dropped), fallbacks,
   tokens/step, RTT/step, H1–H4 with the statistic named. H4 = each config's
   success vs B1, and B1 itself must be valid (tap targets located, not
   centre taps). Write
   `/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-03-screen-graph-results-ci.md`
   (create) with those tables, the `PROBLEM needles: 0` line quoted from the
   log, the O5 explanation, and the run URL(s). Never blend numbers from
   different runs in one table; label every number with its run id.

## Acceptance

- Unit tests green for `preflightVerdict`; `set -euo pipefail` on both steps.
- Final CI run: pre-flight prints `PROBLEM needles: 0`; matrix job green;
  results doc has H4 as a number per config (or a documented reason it is
  still invalid, with the exact log line).
- O5 `locateFailed` count reported with cause; if fixed, the diff is in
  `feat/screen-graph-c3`.
- Branches `feat/screen-graph-c3` and `feat/bench-ci-c3` pushed; report the
  run URL(s), the per-config table, and the H1–H4 verdicts in your final
  message.
