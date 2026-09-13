# Review findings — phase 3i (host/transport cost of idle describe)

Reviewer: read-only researcher agent, 2026-09-03. Branch `feat/android-open-server-p3i`
(4ecbe71e at review time), CI run 33768547622 (sha 97e708e6, ubuntu-latest x86_64 KVM,
N=20). Rules of evidence: `2026-09-03-review-3h-3i-c3.md`.

## Verdict: REJECT (attribution and A/B), numbers accepted as measurements

The headline target (ON idle describe ≤ OFF + 10 ms) is missed: ON 120 vs OFF 76 p50
(+44). The causal story for the residual is unmeasured, the cross-run A/B is confounded,
and the run carries a masked on-device test failure.

## Findings

1. CRITICAL — "93 ms transport" is a residual (describe p50 − captureP50 − host stages),
   nothing times write→dispatch (`android-open-server-client.ts:169` → `:221`). Fix: timestamp
   both, report `rttMs` beside `wireBytes`. Reviewer's later correction: a bare `getState`
   RPC in the same run (device test, `android-open-server.device.test.ts:482-484`, N=1)
   shows 153 ms host-observed vs captureMs 78 → ~72 ms host+transport for a tree-sized
   reply, while small replies cost 2–10 ms on the same socket. So a large payload IS
   expensive on this emulator; what is unknown is server write vs wire vs host read.
2. CRITICAL — `describe/index.ts:140` calls `isAndroidTv()` on every describe →
   `getAndroidRuntimeKind` (`adb.ts:440`) always runs `adb devices` (`adb.ts:167`) and two
   concurrent `adb shell getprop` (`adb.ts:337-344`); the memo at `adb.ts:397` caches only
   the verdict. Three adb spawns inside the timed window, OFF and ON alike (cancels in the
   gap). Steady-state estimate ≈20 ms, unmeasured.
3. HIGH — no per-describe `am instrument` exists (registry caches service by URN
   `registry.ts:289`; socket reused `client:183`). That half of the attribution is wrong.
4. HIGH (withdrawn in part) — 353 KB/s implausibility argument withdrawn after the
   getState measurement in (1). Transport half of the attribution is supported by one sample.
5. HIGH — stage numbers come from a different sample than the p50 latency: latency loop
   N=20 (`bench-open-vs-proprietary.ts:791`), stages from `Math.min(N,10)` (`:813`) with an
   untimed `ensureSettings` each iteration (`describeSplitIdle.n=10` vs `latency.n=20`).
   Subtracting them is not a decomposition.
6. CRITICAL — cross-run A/B 33743850196 → 33768547622 spans six commits: d13cbec7 (3g-b,
   server capture path), d008e89d (metadata plumbing), 19e02f77 (TCP_NODELAY), b5eaa119
   (flag cache), 35bfee24 (micro-bench + open-server-tree refactor), 4ecbe71e (bench row +
   ping). captureP50 fell 33 → 25 ms; 3g-b is the plausible cause, not the two cuts.
7. HIGH — neither cut has a before number by the same method (ping added in 4ecbe71e;
   no isFlagEnabled measurement exists).
8. HIGH — flag cache never observes cross-process writes (`flags.ts:184-189`, epoch bumped
   only at `:232`/`:243`); `argent-cli/src/flags.ts:117` writes from another process, so a
   CLI toggle now needs a tool-server restart, and `flags-cache.test.ts` case 4 pins the
   stale read as intended. Fix: stat mtime+size before serving.
9. CRITICAL — on-device test failed 4/17 in run 33768547622, masked by
   `continue-on-error` (`bench-open-vs-proprietary.yml:241`); evidence
   `bench-latency/logs/device-test.log`. (3h's fail-at-end design must land in every CI branch.)
10. HIGH — block failure guard is dead code: `set -e` without pipefail while `run_block`
    pipes to tee (`yml:259`, `:266`).
11. MEDIUM — micro-bench fixture is synthetic, 69% of wire size (21829 B / 126 nodes vs
    31788 B), self-described "NOT a device capture".
12. MEDIUM — 0.307 of the 0.439 ms micro-bench total is o200k tokenization, which the
    describe path never runs (`describe/index.ts:26`); honest host figure 0.149 ms.
13. VERIFIED — two-pass lowering 0.090 ms; goldens byte-identical (extract-function
    refactor, could not differ). Golden + micro-bench + flag-cache tests: 20 passed.
14. LOW — "wire bytes unchanged 31788" is two ON blocks of one run, not before/after.
15. MEDIUM — regressions vs 33743850196 (p50 ms): tap+describe settle:true ON-uia 540 →
    825 (destination rate 12/20 → 9/20); tap+describe settle:false ON-scrcpy 636 → 723;
    gesture-tap p95 ON-scrcpy 54 → 88; paste OFF-1/OFF-2 576 → 869 / 636 → 928 (runner
    noise on the proprietary path). Drift floor is per-verb (OFF-1 vs OFF-2: 0 ms on
    describe, 129 ms on tap+describe).
16. MEDIUM — "tool-server suite 4985 passed" has no CI evidence (unit-tests.yml runs only
    on main); reviewer's local run environmental-noisy (15 failed / 7044 passed, timeouts).

## Scoreboard-grade numbers (run 33768547622, sha 97e708e6)

| metric | OFF-1 | ON-uiautomation | ON-scrcpy | OFF-2 |
|---|---|---|---|---|
| describe idle p50/p95 ms, n=20 | 76/80 | 120/145 | 123/158 | 76/76 |
| tokens o200k (1 sample) | 657 | 657 | 657 | 657 |
| ping p50/p95 ms, n=20 | n/a | 3.24/22.58 | 6.72/38.75 | n/a |
| wire bytes p50, n=10 | n/a | 31788 | 31788 | n/a |
| server captureP50 ms, n=10 | n/a | 25 | 25 | n/a |

Fidelity Jaccard 1.0 on 17 keys (OFF-1 vs ON-uia).

Void: the target claim; the 12 ms credited to the two cuts; ON-scrcpy gesture-tap and both
tap+describe rows (see 15 and the 3h oracle finding); ping as a before/after.

## Actions handed to 3i (same branch)

Five-point timestamps per call; stages + timestamps recorded inside the N=20 timed loop;
adb-free describe path (memo runtime kind per serial, unit test: describe spawns no adb);
`rttMs` beside `wireBytes`; flag cache validated by mtime+size stat; micro-bench reports
host figure without tokenization; workflow: pipefail on the block guard and fail-at-end for
the device test; v10 section restated with "unmeasured" where it applies and the six-commit
confound stated.
