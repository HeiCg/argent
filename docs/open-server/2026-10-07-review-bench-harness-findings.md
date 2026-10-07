# 2026-10-07 — adversarial review of the Android latency bench harness (post-merge)

Scope: `.github/workflows/bench-open-vs-proprietary.yml`, `.github/bench-ci/*`,
`packages/tool-server/scripts/bench-open-vs-proprietary.ts`, graded against run
37223823613 (pinned emulator 36.4.10, proprietary 0.27.0). Regenerates the
2026-10-04 review whose findings 2-11 were lost; finding 1 (OFF-legacy order,
commit 7315f68e) stays fixed.

Verdict: run 37223823613 is NOT a like-for-like comparison. What survives is
weak: gesture-tap is a 1 ms loss (P2 fails), tap+describe(settle:false) is
+38.5 ms with CI [-152, 128.5] (no power either way), and the await-\* rows
compare host algorithms, not drivers.

## Findings

1. BLOCKER — the candidate arm runs first. `run-bench.js:40-89` starts the
   strategy arms on the first `run_block`, which is OFF-1 (`yml:501`); the
   comment at `:509-511` assumes ON-uiautomation. Lock file: "claimed 18:27:31
   by BENCH_ONLY=OFF-1". Actual starts: ON-im 18:27:41, OFF-1 18:35, ON-uia
   18:44, OFF-legacy 18:51, OFF-2 19:01. ON-im sits outside the OFF-1/OFF-2
   drift window, and a failing ON-im child kills OFF-1's process (reported as
   an OFF-1 failure). Fix: explicit `run_block ON-input-manager` between
   ON-uiautomation and OFF-2; `merge-blocks.js` asserts OFF-1 started before
   every ON block and OFF-2 after.
2. BLOCKER — swipe/pinch wins come from async finger-up. With input-manager
   every event is async and the final UP stays queued (`InjectStrategy.kt:22-27`,
   `MotionInjector.kt:191-202`); default swipe waits for its UP. The bench
   times swipe/pinch with no read afterwards (`bench...ts:2366-2384, 2475-2507`),
   so the queued UP is never paid for. Overhead above the authored 250/300 ms:
   ON-im +17/+19, ON-uia +43/+39, OFF +50/+55; the honest comparator ON-uia is
   only -7/-16 ms vs OFF. Fix: time swipe/pinch plus a draining read in every
   arm; check delivered gesture duration inside the bench.
3. MAJOR — ON fallback to the proprietary path is invisible. gesture-tap/
   swipe/pinch and await-screen-idle fall back with a `console.debug` line;
   the bench counts only `[open-server-fast-inject]` lines (`bench...ts:141-145`),
   so the count is always 0. ON blocks get the 0.27.0 binaries via
   `ARGENT_SIMULATOR_SERVER_DIR` (`yml:380`), so a fallback succeeds silently.
   Q4 checks total > 0 and unavailable == 0, not count == expected
   (`merge-blocks.js:318-331`). Fix: fail an ON block on any "falling back"
   line, unset the proprietary dirs for ON blocks, match the on-device counter
   against the expected number of injections.
4. MAJOR — the noise floor is an estimator artifact. Floor is one difference
   of two block medians (`scoreboard.js:168-172`); `Date.now()` whole ms;
   p50 is the lower-middle value (`bench...ts:151-155`) while the bootstrap uses
   the true median (`scoreboard.js:133-138`). Floor 0 for describe, tap,
   await-ui-element; tap+describe floor 29 (382 vs 411) is 0.5 on true
   medians (416.5 vs 416); samples bimodal. One block per ON arm, no
   block-level variance, no multiple-comparison correction, p95 ungated. Fix:
   `performance.now`, one median definition, >= 3 interleaved blocks per arm,
   CI and margin from block-level variance with Holm correction.
5. MAJOR — gate logic inconsistent. min(OFF)+floor == max(OFF), so P3/P4
   mean "<= max(OFF)" while P2 means "<= min(OFF) + 2\*floor"
   (`scoreboard.js:379-400`). Table "reading" uses CI vs pooled OFF
   (`:250-257`), P lines use a point rule with a different CI (tap: table
   [1,3], P2 [-1,3]). P5 passes a 1.14x slower headline. P6 applies the OFF
   floor to ON-vs-ON. Fix: one rule, one comparator; wide CI = "inconclusive".
6. MAJOR — a failed block still yields a valid-looking scoreboard. Scoreboard
   step runs `if: always()` and ignores `OFF_FAILED`, `LEGACY_FAILED`, device
   test failure (`yml:546-570`); only `partial` is flagged
   (`scoreboard.js:36-44`). A degraded OFF-legacy throws the whole merge
   (`merge-blocks.js:206-274`); an unstamped legacy file merges as "unknown"
   provenance (`:143`). Fix: keep `LEGACY_FAILED -> exit 1`; write per-block
   validity (exit code, stamped, gates) that merge and scoreboard read; INVALID
   banner; legacy failures mark only the legacy section.
7. MAJOR — the "blocking" ready-gate does not block OFF blocks or ON-im.
   `run_block` is called inside `if` (`yml:501, 513, 533`), disabling `set -e`;
   `rc` captures only node (`:481`); `run-bench.js:64-76` ignores the gate for
   ON-im. Fix: explicit `|| return` after the ready-gate.
8. MAJOR — ON blocks get extra warm-up load before tap/swipe: ping, 2xN
   state/full-res screenshot calls, nested-reply capture (`bench...ts:2075-2153`),
   23 extra settle:true iterations (`:2313-2316`). OFF gets nothing equivalent.
   Fix: move diagnostics after the latency verbs.
9. MAJOR — OFF is "our JS + their binaries". OFF await-screen-idle polls from
   the host every 200 ms with a 250 ms stable window; ON waits on device
   events (`await-screen-idle/index.ts:27-29, 179-221`). The 504 vs 309 ms gap
   is poll quantization. Fix: label await-\* as host-algorithm differences.
10. MINOR — parity gates self-fulfilling: "injected" tap timeline built from
    a constant (`bench...ts:2516-2519`, `bench-gesture-parity.ts:53-67`); gesture
    params too (`merge-blocks.js:157-160`).
11. MINOR — provenance one-sided: ON arm records no git SHA, open APK sha256,
    Node version; OFF hashes the tarball, not the installed APK
    (`proprietary-provenance.js:100-113`); js-tiktoken 1.0.21 not recorded.
12. MINOR — silent drops: failed iterations shrink n with no gate
    (`bench...ts:468-479, 594-609`); no-effect taps dropped from timings; cold
    start n=3 ungated; tap+describe never checks the destination screen;
    Jaccard 1 compares 17 keys on the idle Settings root only.

Not verified: whether ON fallbacks happened in run 37223823613; whether
0.27.0's own JS matches the fork's OFF path; the proprietary binary's swipe
sync behaviour; screen-graph INVALID enforcement (`bench-screen-graph.ts:517,
3117`, looks fixed, not run).

## Next run

After fixes 1, 2, 3, 6, 7 (and 8), one dispatch on pinned emulator build
15004761: order OFF-1, ON-uia, ON-im, OFF-2, OFF-legacy (ABBA with OFF-3 if
budget allows); swipe/pinch timed with the drain; fallback counters saved and
gated; proprietary dirs unset for ON; N >= 40.
