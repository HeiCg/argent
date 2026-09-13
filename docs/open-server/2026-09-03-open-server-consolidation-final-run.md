# Ticket: consolidate 3h + 3i + 3j into `feat/android-open-server`, one CI branch, one scoreboard run

Repo: ARGENT FORK. Preconditions (do not start before all three are true):
- `feat/bench-ci-3h` has a GREEN run with device tests enforced (3h finish).
- `feat/bench-ci-3j` has the redir-by-default-on-emulator run reported (3j item 3d).
- `feat/bench-ci-c4` matrix run reported (C.4) — screen-graph is a separate job,
  consolidate its CI changes too but its code stays on `feat/screen-graph-c4`.

Worktree: `argent-fork` (main fork worktree) or a new `argent-final` under the
scratchpad; never the per-phase worktrees. NO local emulator/adb; CI only.

## Work
1. Code: fast-forward/merge `feat/android-open-server-p3h` and
   `feat/android-open-server-p3j` (which contains p3i) into `feat/android-open-server`.
   Resolve conflicts preferring the tested behaviour of each phase; rerun the
   full unit suite (tool-server, configuration-core, android-device-server
   unit tests) and the goldens; APK versionCode bumped once.
2. CI: merge `feat/bench-ci-3h`, `feat/bench-ci-3j`, `feat/bench-ci-c4` into
   `feat/bench-ci`. The workflow must keep: readiness gate before device tests
   and before every block; `set -o pipefail` on every piped step; device-test
   step `id: devtest` + `continue-on-error: true` + final `if: always()` gate
   that fails the job on `steps.devtest.outcome == 'failure'`; pre-flight
   needle gate over the full tree; screen-graph checkout pinned to the
   `feat/screen-graph-c4` head; `BENCH_REPS=5`; redir transport enabled for
   ON blocks; async effect oracle; all four blocks always run; merge fails at
   the end on any ON-block gate. Diff the merged yml against each source and
   list what each contributed.
3. One run of `-f suite=both` on `feat/bench-ci`. It must be GREEN (device tests
   enforced and passing). If red, fix the cause on the consolidated branches and
   rerun; never loosen a gate.
4. Report, from that single run id: the full latency table (every verb, all four
   blocks, p50/p95, N), effectZero/originLost per block, fallbacks per block,
   transport per block, tokens, fidelity, cold start, host RSS, OFF-1 vs OFF-2
   drift per verb, fling A/B gate, 3g stage table, same-sample describe
   decomposition; and the screen-graph per-config table with Wilson intervals,
   O5-pure/O5-mixed, H1–H4. Write it to
   `/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-03-open-vs-proprietary-results-final-ci.md`
   (working tree only; do not commit in device-farm). Push the fork branches.

## Mandatory fixes before the final run (from reviews A, B and the 3i/3j findings)
Sources: `2026-09-03-review-3h-findings.md`, `2026-09-03-review-3i-findings.md`.
a. **Arm the effect check on OFF blocks** (review A1–A3, blocking): derive the nav
   target from a source independent of the backend under test — an untimed
   `adb shell uiautomator dump /dev/tty` parse of the NAV_CANDIDATES to normalized
   centres (replaces the describes at bench-open-vs-proprietary.ts:664/:694); use
   the same source for `fingerprint()` (:930, :801) so OFF and ON have identical
   sensitivity; retry the derive 3× with `ensureSettings` between; the timed tap
   still goes through the proprietary gesture-tap. A disarm must be loud:
   merge-blocks.js fails when a block ran tap verbs with `effectCheckedTotal === 0`;
   scoreboard.js prints `zero/checked`, never the numerator alone.
b. **Degraded OFF arm detection**: fail the block when `await-screen-idle` /
   `await-ui-element` hit the 4000 ms cap on every iteration or when `paste` cannot
   locate the search field (review A1); print the reason.
c. **flushInput asymmetry** (review A(2)): only the scrcpy branch defers the input
   drain to the next read; the UiAutomation tap RPC drains inline. Report the
   tap-RPC row with that label and make `tap+describe settle:false` the headline
   like-for-like tap row (it includes the drain in every block). Do not change the
   fold itself in this ticket.
d. **Bare catches**: `timeTapEffect` (:475-479) and `timeCalls` (:390-392) must
   record the error message and count it (the ON-scrcpy 0/59 iteration was
   unexplained).
e. **Device-test assertions weakened in 3h** (review A(6)): restore the quick-read
   ordering assertion (`quickHits === 20` on `getNestedState({waitTimeoutMs:300})`
   after the tap) — it is the only on-device check of the flushInput ordering;
   revert 3k to `< 50 ms` unless a failure is observed (max observed 45 ms; if kept
   at 200, rename the test title and record the rationale); pinch: assert `ready`
   or fail, never record PASS conditionally; swipe anchor-off-screen substitution
   (:1017) must count as "unmeasured", not as maximal displacement;
   `foregroundFocus` (:107-112) must match `mCurrentFocus` only.
f. **Fling gate** (review A(5)): per-cell ±0.15 on informative cells, blocking, not
   aggregate-only; cells outside tolerance listed (250 ms/0.5 → 1.577, 400 ms/0.5 →
   0.614 in run 33812265077) and explained or the gate fails.
g. **3i/3j workflow gate**: keep `set -o pipefail` on the device-test step (the 3i
   run 33792592764 stayed green with 4/17 failures because `vitest | tee` masked the
   exit); confirm the final `if: always()` gate fires on a forced failure once (a
   deliberate `exit 1` dry run on a throwaway branch is acceptable evidence).
h. **Transport**: redir-by-default on emulators (3j item 3d) must be in the merged
   code; `transport` printed per block; physical devices remain loopback +
   adb forward.

## Merge order
3h and 3i/3j code are on independent branches; merge p3h first, then p3j (contains
p3i). If `feat/android-open-server-p3j` has not yet received the 3d commit when you
start, do everything else first and merge p3j last (check `git ls-remote origin
feat/android-open-server-p3j feat/bench-ci-3j` for movement past 36be9724 /
8ecc9f46, or wait for the team-lead message).

## Acceptance
Green run URL; every number labelled with statistic/block/N/run id; no blended
runs; a list of gates active in the workflow with the yml line for each.
