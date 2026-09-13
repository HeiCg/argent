# Scoreboard — open driver vs argent proprietary

## FINAL (2026-09-05) — consolidated CI run 33975063607, adversarially reviewed

Source: `2026-09-03-open-vs-proprietary-results-final-ci.md` (run 7,
`feat/bench-ci-final` @ f76f5d245, code `feat/android-open-server-final`),
review `2026-09-03-review-final-findings.md` (ACCEPT-WITH-CAVEATS). Environment:
GitHub Actions ubuntu-latest, KVM, x86_64, Android 14 API 34, animations off,
N=20 per verb per block, blocks OFF-1 → ON-uiautomation → ON-scrcpy → OFF-2.
Only OFF vs ON within this run is like-for-like. Gates in force: device tests
17/17 enforced (fail-at-end), per-block oracle self-test, first-attempt landing
≥ 95 % symmetric, redir transport required on ON, no degraded block, zero
fast-inject fallbacks, timeline parity (2-frame tap, hold 50 ms, no MOVE).
Effect oracle = resumed activity (backend-independent), polled ≤ 3 s outside
the timed window; per-iteration untimed locate through the block's own backend
describe (`uiautomator dump` unusable on this emulator; OFF's locate is the
slower one, so the asymmetry works against ON). Compact payload (3j) DISABLED
(not output-preserving, review-3j). Transport on ON blocks: `redir` decided on
device via `ro.kernel.qemu`.

| verb, p50/p95 ms | OFF-1 | ON-uiautomation | ON-scrcpy | OFF-2 | drift floor (OFF-1 vs OFF-2 p50) | verdict |
|---|---|---|---|---|---|---|
| describe (idle) | 52/53 | 39/56 | 36/53 | 52/56 | 0 | open never slower in 3 same-code runs (run 5: 32/33 vs 52; run 6: 53/50 vs 52; run 7: 39/36 vs 52); 13–19 ms faster in 2 of 3; **magnitude not reproducible**; 3i target ON ≤ OFF+10 met in all three |
| gesture-tap (tap RPC only) | 52/54 | 77/91 | 51/52 | 52/53 | 0 | scrcpy **at parity** (−1 ms does not clear the floor); UiAutomation +25 slower. Row not like-for-like across ON variants: the flushInput drain is inline on UiAutomation/proprietary, deferred on scrcpy |
| tap+describe (headline like-for-like tap; ON settle:false) | 305/817 | 455/673 | 298/810 (n=19) | 313/958 | 8 | scrcpy at parity (−7…−15, at the floor); UiAutomation +142…+150 slower |
| gesture-swipe (250 ms) | 290/308 | 296/359 | 257/262 | 294/303 | 4 | **open wins (scrcpy −33…−37)**; UiAutomation equal |
| gesture-pinch | 338/349 | 337/358 | 307/309 | 344/362 | 6 | **open wins (scrcpy −31…−37)**; UiAutomation equal |
| await-screen-idle | 498/504 | 463/472 | 461/474 | 497/541 | 1 | **open wins (−35)** both ON variants |
| await-ui-element | 72/76 | 32/38 | 31/36 | 73/77 | 1 | **open wins (−41)**, strongest ON win |
| paste | 463/1217 | 327/892 | 289/867 | 573/1104 | 110 | directional only (−174…−284 clears a 110 ms floor barely) |
| first-attempt tap landing (landed/checked) | 40/40 | 60/60 | 59/60 (98.3 %) | 40/40 | — | real scrcpy async drop ≈1.7 % (1/60 in runs 6 and 7); undiagnosed per iteration (no per-miss log yet) |
| tokens (describe, o200k) | 657 | 657 | 657 | 657 | — | identical; fidelity Jaccard 1.0 |
| fling fidelity (scroll distance ratio vs proprietary, 400 ms cells) | ref | ~1.0 | 0.64–0.66 (400/0.3), 0.57–0.58 (400/0.5) | ref | stable across runs 5 and 7 | **open loses**: scrcpy under-scrolls 35–42 % at long durations (inferred: host paces one injectTouch per frame, 26 frames at 400 ms). Fling parity gate red — the only red in run 7. Ticket 3k |

Superseded within the same code line: run 5 (33963464784, fling single-sample)
and run 6 (33969204089, strict landing gate) — per-block tables in the results
doc. Void in run 7: `destinationVisible` probe read 0/20 in all four blocks
(stale coordinate), so phase-3d staleness is unsupported here; the screen-graph
job was skipped in this run (its numbers come from the run below).

## FINAL — screen-graph (tokens per agent step), run 33964414774 on `feat/screen-graph-d`, reviewed

Source: `2026-09-03-screen-graph-results-ci.md` (D.2), reviews `…review-d1…`,
`…review-d2-findings.md` (ACCEPT-WITH-CAVEATS). 7 configs × 20 tasks × 5 reps,
one oracle for every config, exclusions caused by a config's own action count as
failures, launch step excluded from tokens (n=155 steps/config), o200k p50.

| config | success (N=100) | cluster-bootstrap 95 % (n=20 tasks) | tokens/step p50 | RTT/step |
|---|---|---|---|---|
| B1 proprietary describe + tap | 98 | [94,100] | 657 | 2 |
| B2 open full describe | 99 | [97,100] | 627 | 2 |
| O1 open + query/diff | 99 | [97,100] | 179 (mean-ratio 0.220×; p50 bimodal) | 2 |
| O2 open + compact tier | 100 | [97,100] | 54 | 2 |
| O3 open + graph, graph-blind | 100 | [97,100] | 598 | 2 |
| O4 open + graph, warm | 99 | [95,100] | 22 (tracks graph out-degree; ≤6-affordance summary) | 1 |
| O5 open + navigate-to | 99 | [97,100] | 28 | measured ≥ 7 RPCs per routed tap (lower bound) |

H1 PASS (O1/B2 0.285× p50, 0.220× mean); H2 PASS on same-screen steps (1 RTT
removed), FAIL over all steps; H3 PASS (0.037×, graph-density dependent); H4:
no open config inferior to B1 or B2 (paired cluster bootstrap, CIs contain 0);
O5 routing real: 55 one-step routes + 5 zero-step no-ops of 60, 0 mis-land, 0
fallback — labelled low-power for routing (half the tasks have no known-target
tap). Device H_id stability: UNVERIFIED (host twin only).

D.3 (run 33976442407, `feat/screen-graph-d` @ bfce58c19, NOT yet reviewed; the
table above stays on D.2): exact-match locate for open configs, per-step
navTarget (0 zero-step routes), store invariants (duplicate screens / multi-
destination edges) gated in CI, `settings-network-internet` now genuinely
reaches the Internet screen (needle "Add network" from a capture pass). Per
config: B1 94, B2 99, O1 99, O2 99, O3 99, O4 100, O5 97; O5 54/60 one-step
routes, 0 mis-lands; H1 0.212×, H3 0.034×, H4 non-inferior. Caveat: B1's five
failures are all the two-level task, and B1's locate resolver was relaxed
(exact-then-contains) while open configs use unique-or-refuse — an asymmetric
harness resolver, so B1's drop is not a proprietary capability claim; H4 is
meaningful vs B2. Follow-up D.4: symmetric resolvers on both renderings, a
Network-&-internet-unique navTarget for `settings-network`.

## Goal verdict (owner's goal: "our driver beats theirs")

Wins (review-accepted, same run): swipe, pinch, await-screen-idle,
await-ui-element (scrcpy or both ON variants); describe idle never slower and
faster in 2 of 3 runs; tokens per agent step 3–30× lower with equal task
success. Parity: tap RPC, tap+describe (scrcpy). Loss: scrcpy fling momentum at
long durations (reproducible), UiAutomation tap +25 ms. Not measured on this
line: physical devices; local arm64 numbers (older sections below) predate the
gates and are not comparable.

## Retractions added 2026-09-05
- 3h "DOWN-MOVE-UP fixes the scrcpy tap" — the bench oracle was the bug; MOVE reverted and now forbidden by the parity gate.
- "open describe faster, 36/53 vs 52/56" as a magnitude — not reproducible across runs 5/6/7 (direction only).
- "ON-scrcpy beats OFF on tap" — at parity (0 ms drift floor).
- "fling failure is measurement noise" — refuted; stable 400 ms deficit vs the proprietary reference.
- 3j "compact payload byte-identical" — three counterexamples (scroll clip, systemui subtree, `[password]` label); disabled.
- C.3 B1 93.3 % (precomputed coordinates) and C.4 "O5 99 %" (13 own-action exclusions) — superseded by D.2 accounting.

---

# History — 2026-09-03 scoreboard (pre-consolidation; kept for provenance)

Source of truth: `2026-09-02-open-vs-proprietary-results-v4.md` (v4, v5, v6,
v7 sections), `2026-09-02-open-vs-proprietary-results-v3.md` (fling
fidelity), `2026-09-02-screen-graph-results.md` (Phase C pass 1). Latency
numbers are like-for-like (same AVD bench-api35 API 35, same hold/duration,
N=20 per verb, OFF→ON→OFF blocks, 0 errors / 0 masked fallbacks). Numbers
from the v6 run carry the host-swap caveat (16 GB used per the report) and
OFF-1/OFF-2 drift. The screen-graph section does NOT share that methodology:
15 tasks × 3 reps (n=45 steps/config), no OFF/ON blocking, O3 success
97.8 %, one aborted re-run attempt (see its "Method & provenance").

## Per-verb latency, p50 ms

| verb | proprietary (OFF) | open (ON) | status | source |
|---|---|---|---|---|
| gesture-pinch (300 ms) | 355 | 329 | open faster (0.93×) | v4 |
| gesture-swipe (250 ms) | 298 | 278 | open faster | v4 |
| await-screen-idle | 515 | 478 | open faster at p50 (p95 524 vs 526, equal) | v4 |
| await-ui-element | 76 | 76 | equal | v4 |
| describe (idle) | 77 (v4) / 77–78 (v6) | 80 (v4) / 77 (v6) | equal; tokens identical 657/657 (o200k) | v4/v6 |
| paste | 78–101 | 63 | open faster (clipboard-unsupported cache) | v6 |
| gesture-tap | 53 | 61 | open +8 ms (UiAutomation inject; scrcpy path pending) | v6 |
| tap+describe, immediate read | ~138 (v5: 129/148) → 247/802 (v6, bimodal) | 286 (v5) → 185 (v6) | v5 measured 2.07× slower; v6 open is faster than both OFF readings but OFF is bimodal so no ratio is claimed; cause of 286→185 unattributed | v5/v6 |
| tap+describe, settled read | proprietary has no settled mode | 684 → 833 (regressed, unexplained) | open-only feature | v5/v6 |

## Correctness / footprint

| dimension | proprietary | open |
|---|---|---|
| freshness of describe right after a navigating tap | 15–25 % (v5), 45–55 % (v6) | immediate 0 %; settled 95–100 % |
| fling fidelity vs proprietary | — | 0.925 / 0.902 / 0.889 (±15 % pass; 3 of 6 cells reliable, 3 at the survivor-median floor) — v3 |
| host process per device | ~62 MB simulator-server | none (server on device) |
| closed binaries required | yes (`bin/simulator-server`, ADT apk, dylibs — LICENSE "proprietary binary components") | no |
| physical Android input | Android Studio's Apache-2.0 screen-sharing-agent (per 3f ticket; not benched) | UiAutomation today; scrcpy backend built, unbenched (v7) |

## Structural (screen-graph, Phase C pass 1 — tokens per agent step)

| config | tokens/step p50 | RTT/step |
|---|---|---|
| open, full describe (B2) | 629 | 2 |
| open + query/diff (O1) | 67 (0.107×) | 2 |
| open + screen graph, cold (O3) | 629 | 2 |
| open + screen graph, warm (O4) | 40 (0.064×) | 1 |

H1 PASS, H3 PASS, H2 FAIL on navigation-only tasks (re-stated over
same-screen steps in C.1), H4 NOT MEASURED (baseline oracle invalid; C.1).
No proprietary equivalent of O1/O4 was benched (B1/B2 are the only proprietary-path configs, and B1 is invalid).

## Retractions so far
- v2 "open wins tap/pinch" — hold/duration artifacts (retracted in v3).
- v6 "R2 window prune explains tap+describe gain" — prune never fired.
- CI run 4 "scrcpy tap 51 vs 52 beats proprietary" — tap never landed (0/20 effect); retracted 2026-09-03.
- Phase C "H4 PASS vs B1 33 %" — harness artifact (retracted).

## CI (GitHub Actions ubuntu-latest, KVM, x86_64, Android 14 API 34, swiftshader, animations off, N=20, p50/p95 ms) — run 33736918373

NOT comparable to the local arm64/HVF numbers above; only OFF vs ON within
this run is like-for-like. Single run. Adversarial review (2026-09-03)
findings applied below.

| verb | OFF-1 | ON-uiautomation | ON-scrcpy | OFF-2 | status |
|---|---|---|---|---|---|
| gesture-swipe | 306/317 | 288/326 | **258/259** | 297/303 | open wins (scrcpy) |
| gesture-pinch | 346/363 | 345/395 | **307/310** | 348/357 | open wins (scrcpy) |
| paste | 494/1241 | **288/756** | 317/760 | 434/1109 | open wins — open-server property (one typeText RPC vs clipboard + `adb shell input keyevent` spawn); ASCII-only, emoji falls back |
| cold start median (N=3) | 774 | 360 | **386** | 767 | open wins — open-server property (backend restart → first describe; no install either side; scrcpy not included) |
| await-screen-idle | 490/529 | 499/537 | 498/527 | 490/532 | equal |
| await-ui-element | 72/76 | 76/76 | 72/76 | 72/76 | equal |
| describe (idle) | 72/76 | 108/132 | 112/132 | 68/72 | **open loses**; server stages ≈ 22 ms, ~90 ms is host/transport in the open path |
| gesture-tap | 52/53 | 78/148 | 51/52 | 52/53 | **NOT REPORTED**: ON-scrcpy tap failed its on-device effect check in the same run (0/20 navigations, zero-pixel diff; hidden by `continue-on-error`) — timed injections that did not land |
| tap+describe | 568/1006 | 595/661 (settle:false) | 432/810 (settle:false) | 565/1151 | **NOT REPORTED** for ON-scrcpy (same reason); ON-uiautomation 595 vs OFF 565–568 ≈ equal |
| tokens (describe) | 657 | 657 | 657 | 657 | identical |

Review caveats: `fastInjectFallbacks == 0` proves no exception, not
delivery; the gesture-parity gate compares a shared constant (cannot detect
backend timeline drift; the in-script assert is skipped under BENCH_ONLY);
fling A/B scrcpy vs UiAutomation: 2 of 4 informative cells at 0.44× and
0.70× (fling fidelity NOT unchanged); block JSONs missing from this run's
artifact (dot-dir excluded; fixed later).

### 3g-b (run 33738386658, same CI environment, ON-uiautomation only — ON-scrcpy void, tap did not land)

| stage / verb | before (33729614337) | after (3g-b, vc22) | OFF |
|---|---|---|---|
| rootMs after tap p50/p95 | 210/285 | **140/221** | n/a |
| describe idle p50 | 132 | **108** | 72 |
| tap+describe settle:false p50/p95 | — | 662/757 | 515/1155 (no settle variant) |

Residual persists: `AccessibilityWindowInfo.getRoot()` still blocks ~140 ms
mid-transition; idle describe still 36 ms over OFF, of which server stages
are ≈22 ms total → the remaining ~90 ms is host/transport (phase 3i).

### CI run 5 (33743850196, same environment, complete artifacts) — confirms run 4

| verb p50/p95 | OFF-1 | ON-uiautomation | ON-scrcpy | OFF-2 |
|---|---|---|---|---|
| gesture-swipe | 298/314 | 303/353 | **258/260** | 300/310 |
| gesture-pinch | 320/331 | 327/335 | **307/307** | 319/337 |
| paste | 576/950 | **395/807** | 358/806 | 636/1318 |
| describe (idle) | 76/80 | 132/165 | 136/160 | 80/82 |
| gesture-tap | 53/55 | 81/105 | 52/54 (VOID: device test "fast-inject tap navigates" FAILED again) | 53/54 |
| tap+describe settle:false | 720/1116 (as-is) | 690/905 | 636/923 (VOID) | 532/1090 (as-is) |

Screen-graph C.2 CI run (33742435496): the needle fix did NOT land — pre-flight
still lists the same 14 PROBLEM needles and the matrix ran anyway; success
0.60–0.70 for every config (no discrimination), O5 30/60 locateFailed, B2 2
fallbacks. H4 remains NOT MEASURED. Oracle-independent results from the same run
(tokens/step p50 o200k, RTT/step): B1 473/2, B2 447/2, O1 **67**/2, O2
**32**/2, O3 397/2, O4 **63**/1, O5 0/1 (30/60 locateFailed). H1 PASS
(0.182×), H3 PASS (0.129×), **H2 PASS over the 30 same-screen steps (1
RTT/step removed)**, H2 FAIL over all steps. The proprietary path has no
O1/O2/O4 equivalent.

## Pending (blocked on host memory, then AVD queue C.1 → 3f → 3g)
- 3f bench: OFF / ON-uiautomation / ON-scrcpy — tap tail and per-event
  inject cost with the scrcpy backend.
- 3g: stage timings inside describe during transitions; popup/dialog
  window-filter safety; tap ordering fix.
- C.1: valid oracle, B1 baseline, H2 over same-screen steps, H4.
