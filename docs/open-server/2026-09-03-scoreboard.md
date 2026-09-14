# Scoreboard — open driver vs argent proprietary

## Goal status

Owner's goal — "our driver beats theirs" — on the consolidated base with **`input-manager`
the shipped default injector** (phase 3n.1 flip; scrcpy removed in 3n.2). Reference run for
latency / landing / availability / screen-graph / process is **34870686468**
(`feat/open-server-3n-kotlin-injector` @ `bb3fbddf`, ubuntu-latest KVM, Android 14 / SDK 34,
N=20 per verb per block, judged at the within-run OFF-1↔OFF-2 drift floor); the scrcpy
removal was confirmed on the fully-green run **34888577404**
(`feat/open-server-3n2-remove-scrcpy` @ `377c0197`). On the reference run open **WINS**
gesture-swipe (`input-manager` −40…−41 ms vs proprietary, CI clear of the floor),
gesture-pinch (−35), await-screen-idle (−193…−194), await-ui-element (−35), and
tokens/agent-step (3–30× fewer at 100/100 task success across the screen-graph configs).
**PARITY**: gesture-tap — `input-manager` is **+1 ms** vs the proprietary driver on a
measured floor of 0; the pre-registered P2 inequality fails by 1 ms and was accepted by the
planner as parity in practice (the current UiAutomation default reads +32 ms slower). The
headline **tap+describe(settle:false)** ratio is ≤ 1.15 (gate PASS) but is a within-run
ratio, **not** a capability claim — its OFF comparator drifts run-to-run (3N1-H4). **No
durable "beats the proprietary driver" wording**: one image, one emulator; the swipe/pinch
wins enter as this run's numbers with CIs. **Fling stays OPEN** (pinned to run
34813849446): the metric does not reproduce itself and its repair is ticket 3o; the scrcpy
arm that used to carry the fling row is gone.

## FINAL (2026-09-14) — reference run 34870686468 (`input-manager` default) + 3n.2 removal-confirmation run 34888577404

Reference for **latency, landing, availability, screen-graph and process** on the
consolidated base with `input-manager` the shipped default (phase 3n.1 flip). Source:
`2026-09-14-open-server-phase3n-kotlin-injector-replaces-scrcpy.md` "Result (3n.1) — run 2"
and its adversarial review `2026-09-14-review-3n1-findings.md` (accept the run + promotion;
P2 corrected to a 1 ms miss, fling arms void). `system-images;android-34;google_apis;
x86_64`, ubuntu-latest KVM, head `bb3fbddf`, attempt 1, N = 20 per verb per block, five
blocks `OFF-1 / ON-uiautomation / ON-input-manager / ON-scrcpy / OFF-2`. **Fling is
excluded from this reference by name** (its arms were mislabelled, 3N1-H1) — the fling
status row stays pinned to 34813849446. Each row supersedes the same-named 34813849446 row
below.

### Latency verbs (run 34870686468, N=20, p50/p95 ms)

| verb | OFF-1 | ON-uiautomation | ON-input-manager | ON-scrcpy | OFF-2 | measured OFF↔OFF floor |
|---|---|---|---|---|---|---|
| describe | 51/? | 48/? | 51/? | ? | 52/? | 0 |
| gesture-tap | 53/60 | 86/134 | **54/55** | 52/53 | 53/60 | **0** |
| gesture-swipe | 305/322 | 306/345 | **263/285** | 258/259 | 303/315 | **2** |
| gesture-pinch | 353/364 | 346/404 | **318/357** | 307/312 | 354/367 | **1** |
| await-screen-idle | 499/505 | 304/307 | 305/310 | 304/308 | 498/506 | 1 |
| await-ui-element | 76/84 | 41/46 | 41/43 | 42/47 | 76/80 | 0 |
| paste | — | — | 370 | — | — | 89 |
| tap+describe(settle:false) | — | 480/831 | **372/616** | 349/655 | — | **78** |

- **gesture-tap vs proprietary** — `input-manager` **54** vs proprietary 53/53 at a measured
  floor of **0**: Δ +1 ms, bootstrap 95 % CI on the p50 difference **[0, +1]** vs pooled OFF.
  Parity in practice; the pre-registered P2 inequality (`≤ max(OFF) + floor`) fails by 1 ms
  and was accepted by the planner. The current UiAutomation default reads **86** on the same
  run.
- **gesture-swipe vs proprietary** — `input-manager` **263** vs proprietary 305/303, floor
  ±2: Δ **−41** ms, CI **[−45, −34]** — **win**, CI clear of the floor. Control
  `ON-uiautomation` 306 (parity with proprietary).
- **gesture-pinch vs proprietary** — `input-manager` **318** vs proprietary 353/354, floor
  ±1: Δ **−35.5** ms, CI **[−43.5, −34]** — **win**, CI clear of the floor. Control
  `ON-uiautomation` 346.
- **Headline `tap+describe(settle:false)`** — `input-manager` **372** ÷ OFF `tap+describe` =
  0.91 (OFF-1 408) / 0.77 (OFF-2 486) / 0.83 (pooled 447) — all ≤ 1.15, gate P5 PASS.
  **Within-run OFF↔OFF drift on this row is 78 ms**, and the OFF comparator moved 325 → 447
  pooled since 34813849446 while `ON-scrcpy` moved 529 → 349 with no scrcpy change; this is a
  within-run ratio, **not** a claim that the open stack got faster on the headline.
- **No-regression vs the current default (P6)** — `input-manager` is faster than the
  `ON-uiautomation` control on every gated verb in the same run: tap −32, swipe −43, pinch
  −28, headline −108 ms.

### Landing / availability / device / screen-graph / process (run 34870686468)

- **First-attempt landing** — OFF-1 40/40, ON-uiautomation 60/60, ON-input-manager 60/60,
  ON-scrcpy 60/60, OFF-2 40/40 — **100 % on every block**; oracle self-test passed on every
  block; first-attempt no-effect 0 everywhere. No "more reliable than scrcpy" wording —
  scrcpy did not miss a tap this run.
- **Strategy echo / fallbacks** — `ON-input-manager` reported `input-manager: 161/161` and
  `ON-uiautomation` reported `default: 161/161` from the on-device per-RPC counter
  (`InjectStrategyCounter`, one record per `inject`/`injectTaps` call); **0** `unavailable`
  fallbacks. 161 is the process-wide injection count for the block (measured RPCs + warmups +
  oracle + restore taps), identical across the two ON blocks. `ON-scrcpy` recorded 0 Kotlin
  injections, confirming it ran entirely on the scrcpy channel.
- **`input-manager` availability** — the reflective `InputManager.injectInputEvent(InputEvent,
  int)` with `INJECT_INPUT_EVENT_MODE_ASYNC` resolved and ran on the image with **no**
  `hidden_api_policy` change and no `-e disable-hidden-api-checks`. On this image
  `InputManagerGlobal.getInstance()` is **denied** by hiddenapi policy; the pipe resolves
  through the legacy `InputManager.getInstance()` holder. Availability is a property of this
  image and this holder, not of Android devices in general.
- **Forced-fallback (P9)** — `input-manager` forced unavailable on-device: `strategy ==
  "unavailable"`, `fellBackTo == "uia-async"`, tap still navigated (+/−42 labels), next
  request resolved back to `input-manager`. Exercised on the `tap` RPC only (extended to
  swipe/gesture in run 34888577404 — see the 3n.2 row).
- **Device-test outcome** — all six 3n strategy cases PASS with `ranAs` == requested; the
  3n.1 P9 case PASSES. **The 3m.1 stage-accounting gate `|captureMs − Σ(stages)| ≤ 10` FAILED
  at an after-tap 20-sample median of 11 ms** (idle passed); diagnosed as unaccounted work
  inside `captureMs` (second window enumeration in `isKeyboardVisible`, `DisplayReader.read`,
  forest `recycle`), not a 3n regression. **(Repaired in 3n.2 — see the 3n.2 row.)**
- **Screen-graph** — success 100/100 on all seven configs (B1/B2/O1/O2/O3/O4/O5); tokens
  o200k p50 B1 657 · B2 651 · O1 179 · O2 54 · O3 627 · O4 22 · O5 22; H1 0.275× PASS, H2 0
  FAIL / same-screen n=50 = 1 PASS, H3 0.035× PASS, H4 every Δ +0 pp [0, 0] vs both
  baselines; O5 one-step routed **60/60**, hash-mismatch 0; store invariants OK (0 duplicate
  screens, 0 multi-destination edges), `com.android.settings` **10 nodes / 9 edges**, three
  stores; **`skippedNoIdHash` 0** (34813849446: 0; 34853156073: 2; 34840929610: still
  unrecorded). Back at the reference. **Run with `input-manager` as the injector** — the open
  configs inject through the flipped default.
- **Process** — run 34870686468, attempt **1**, head `bb3fbddf`, `workflow_dispatch`,
  `suite=both`, `sg_mode=matrix`. Conclusion `failure`: the sole failing step is **#20
  `Enforce device-test result`** (the 3m.1 residual gate); step #14 reports success despite
  one failed test, so a device-test failure is only visible through step 20. Screen-graph job
  success. Five latency blocks, three self-orchestrated by `run-bench.js` (no `workflow` OAuth
  scope); per-block logs staged for every arm. `gates.test.js` 26/26.

### 3n.2 removal-confirmation row (run 34888577404, head `377c0197`, Q1–Q7)

> **Scrcpy removed; four blocks `OFF-1 / ON-uiautomation / ON-input-manager / OFF-2`, no
> scrcpy arm, fling not run. Run conclusion `success` — the FIRST fully green run on this
> base (the 3m.1 residual gate, red at 11 ms on 34870686468, is repaired to 1 ms).**
> **Q3** vs proprietary: swipe **−30.5** CI [−37,−25] WIN, pinch **−24.5** CI [−30,−19] WIN,
> headline P5 PASS (1.09/1.00/1.04), P6 PASS; tap **FAIL by 2** (Δ +2, CI [1, 2.5]) — parity
> in practice, planner-accepted. **Q4** landing 100 % every block, oracle passed, **0**
> `unavailable` fallbacks, echo `input-manager: 161/161` / control `default: 161/161` (measured
> gated RPCs a subset of the 161 process-wide). **Q5** device suite green: all 22 cases PASS,
> 3n cases `ranAs==requested`, **residual gate `|captureMs − Σ(stages)|` after-tap median 1 ms
> / idle 0 ms** with new stages infoMs 2 / recycleMs 0 / otherMs 1 and the 20 residuals
> printed, **P9 forced-fallback on tap, swipe AND gesture** (each uia-async). **Q6**
> screen-graph green: 100/100 on six configs, O1 **99/100**, tokens B1 657·B2 651·O1 138·O2
> 54·O3 627·O4 21·O5 21, H1 0.212× / H2 0 FAIL,same-screen 1 / H3 0.033× / H4 non-inferior,
> O5 60/60, settings 10/9, invariants OK, **`skippedNoIdHash` 1** (vs 0/0 on the reference
> runs). **Q7** no scrcpy: four blocks (no ON-scrcpy), CI `npm install` regenerated the
> lockfile with `@yume-chan/*` dropped, grep returns only historical/removal notes. **Q1/Q2**
> (reproduction of 34870686468 within the measured band): pinch reproduces (318 = 318); tap
> (55 vs 54), swipe (267 vs 263) and the headline (279 vs 372, faster) exceed a near-zero band
> by cross-run emulator variance, NOT a behaviour change — the ON-input-manager and
> ON-uiautomation paths never used the scrcpy seam and are byte-identical. Planner reviews
> before merge; `open/main` not fast-forwarded.

### Fling status row — pinned to run 34813849446, status OPEN (no new numbers)

> **Fling stays OPEN, pinned to run 34813849446** (its "open loses fling" numbers below).
> Runs 34870686468 and 34888577404 add **no** fling numbers: on 34870686468 a pre-registered
> same-code A/B instrument control was run; it did not reproduce itself within ±0.15 on one of
> four informative cells (0.509 vs 0.361 at 400 ms/0.5, permutation p = 0.19), so no arm was
> graded — and the control arms were subsequently found to be mislabelled (they ran
> `input-manager`, 3N1-H1). On 34888577404 the fling job was removed with scrcpy. Metric
> repair is ticket 3o.

## Superseded — consolidated CI run 34813849446 (scrcpy; latency/landing/screen-graph/process superseded by 34870686468; fling still referenced here), adversarially reviewed

Source: `2026-09-05-open-server-phase3k-fling-pacing-and-gates.md` "Result (3k.1)" and
`2026-09-13-open-server-3k-results-ci.md`, review `2026-09-14-review-3k1-findings.md`
(ACCEPT-WITH-CAVEATS), screen-graph whitelist `2026-09-14-review-d4-1-findings.md`. This is
the **single reference** for latency, fling and screen-graph — the only run on the
consolidated base (3k Part B + outcome-regression fix + D.4.1), `suite=both`,
`sg_mode=matrix`. Environment: GitHub Actions ubuntu-latest, KVM, x86_64, Android 14 API
34, 1080x2400 @ 420dpi, animations off. Latency: **N=20 per verb per block**, blocks
OFF-1 → ON-uiautomation → ON-scrcpy → OFF-2, verdicts at the within-run OFF-1↔OFF-2 p50
drift floor. Fling: **n=12 per cell-arm** (one uia cell n=11), interleaved over 3 rotated
rounds. Screen-graph: 7 configs × 20 tasks × 5 reps, **n=155 non-launch steps/config**,
o200k_base, bootstrap B=10000 seed `0x5eedc0de`. Each row supersedes the run-7
(33975063607) / D.2 (33964414774) row of the same name; both run ids are named. ON-scrcpy
ran the **shipped default** pacing (`legacy`).

### Latency verbs (run 34813849446, N=20, p50/p95 ms)

| verb | OFF-1 | ON-uia | ON-scrcpy | OFF-2 | drift floor | verdict (vs run 7 = 33975063607) |
|---|---|---|---|---|---|---|
| describe (idle) — **win → parity/loss** | 52/56 | 53/74 | 53/73 | 52/59 | 0 (p50) / 3 (p95) | **parity at p50 (+1 ms), 14–18 ms SLOWER at p95.** The run-7 ON describe advantage (39/36 vs 52) does not reproduce; 34806342684 reads the same (ON-uia 55/74). "Open never slower in 3 same-code runs" RETIRED |
| gesture-tap (tap RPC only) | 53/60 | 78/116 | 51/53 | 54/56 | 1 | scrcpy **at parity** (−2…−3; harness judges ±2 ms); UiAutomation **+25 ms slower** (same +25 as run 7). Not like-for-like across ON variants (scrcpy defers the input drain) |
| tap+describe (headline; ON settle:false) — **parity → loss** | 354/831 | 505/728 (n=19) | 529/1029 (n=19) | 297/654 | **57** | **Open LOSES: +150…+230 ms** on both ON variants. Run 7 had ON-scrcpy at parity (298/810 vs OFF 305/313); present in 34806342684 (ON-scrcpy 548) → screen-graph-d base, not 3k/3k.1 — cause not established |
| gesture-swipe (250 ms) | 300/312 | 292/309 | 259/261 | 296/305 | 4 | **Open wins (scrcpy −37…−41)**; UiAutomation at parity. Reproduces run 7 (257) and 34806342684 (258) |
| gesture-pinch | 358/373 | 346/372 | 307/311 | 346/365 | 12 | **Open wins (scrcpy −39…−51)**; UiAutomation at parity. scrcpy 307 in all three runs |
| await-screen-idle — **magnitude changes** | 501/507 | 294/297 | 294/308 | 501/511 | 0 | **Open wins −207 ms** (vs −35 in run 7, ON 463/461): the base changed with the screen-graph-d tree (34806342684 reads 292/293), not with 3k.1; cause not established |
| await-ui-element | 80/84 | 45/51 | 47/53 | 80/81 | 0 | **Open wins −33…−35 ms** (run 7: −41 on a 72 ms OFF baseline; both OFF and ON moved on this base, 34806342684 reads 43/43) |
| paste | 804/1122 | 291/1086 | 385/990 | 662/1057 | **142** | Directional only: −277…−371 ms clears the floor; p95 does not separate |
| first-attempt tap landing (landed/checked) | 40/40 | **59/59** | **59/59** | 40/40 | — | = 100 % on every block (each ON denominator is 59, not 60: one `uiautomator dump` parse error per ON block). No scrcpy async drop this run; run 7's 1/60 not reproduced |
| tokens (describe, o200k) | 657 | 657 | 657 | 657 | — | identical; fidelity Jaccard **0.889** this run (live text churn: OFF "Storage / 36 % used - 5.08 GB free" vs ON "37 % used - 5.01 GB"), not the 1.0 of run 7 |

Footnote (latency block): *ON-scrcpy ran the shipped default pacing (`legacy`); run
34800933407's ON-scrcpy verbs ran `drift`, which was then the default.*

### Fling status row (run 34813849446) — supersedes the run-7 "open loses" fling row; status stays OPEN

> **Fling parity (n=12 per cell-arm, interleaved over 3 rotated rounds, median normalized
> scroll):** the scrcpy under-scroll vs the proprietary reference is **real and significant
> in 3 of 4 informative cells** — `scrcpy(drift)/off` 0.515 at 150 ms/0.3 (permutation
> p = 0.009), **0.699** at 400 ms/0.3 (p = 0.001), 0.717 at 400 ms/0.5 (p = 0.001);
> 250 ms/0.3 passes (0.899). The pre-3k `legacy` arm shows the same deficit (0.549 / 0.808
> / 0.542, p = 0.031 / 0.014 / 0.002), and the same-run paired legacy→drift test is **not
> significant in any cell** (Δ −0.020 / −0.053 / −0.266 / −0.038 / +0.115, permutation
> p = 1.00 / 0.63 / 0.13 / 0.31 / 0.33, 20 000 draws). The deficit is **larger** than in run
> 34800933407 (400/0.3 scrcpy/off 0.699 vs 0.886); run-to-run variance on this two-level
> metric is of the order of the effect. **Status: OPEN.** Host pacing is not the cause:
> `drift` ≈ `legacy` and the host dispatch span equals the requested duration on the drift
> arm (n=72 swipes, median worst-frame drift 2.1 ms, max 7.9 ms); the device saw a stretched
> tail on both scrcpy arms (452/439 ms for a 416 ms request, final MOVE→UP gap 46/35 ms vs
> uia 17 ms, N=1 per arm). Mechanism unresolved — the **8-frame schedule alone is ruled
> out** (the UiAutomation arm sends the identical 8 frames and reads `uia/off` 1.037 at
> 400 ms/0.3). Floor rate (samples at the 0.175 metric floor out of 12, measurement-only):
> 150 ms/0.3 — off 1, uia 3, scrcpy drift 4, scrcpy legacy 6; 400 ms/0.5 — off 0, uia 2,
> drift 2, legacy 5.

### Gate / process row (run 34813849446, no measurement)

> **Fling parity gate (phase 3k.1):** pre-registered before the run in
> `2026-09-14-open-server-phase3k1-fling-status-open.md` — per-cell **two-sided**
> `|scrcpy/uia − 1| ≤ 0.15` AND `|scrcpy/off − 1| ≤ 0.15`, **blocking, no whitelist**,
> reference-bimodality exclusion keyed on the **reference arms only** (`q25(uia|off) ≤
> 0.175 + eps`, never on scrcpy), power floor **n ≥ 10 on every arm**. Verdict on this run:
> `FAIL (per-cell ±0.15 on scrcpy/uia AND scrcpy/off, NO whitelist, over 4 informative
> cell(s); 2 of 6 non-informative at the metric floor)` — offenders 150/0.3 (0.644/0.515),
> 400/0.3 (0.675/0.699), 400/0.5 (0.813/0.717). **22 gate unit tests**
> (`.github/bench-ci/gates.test.js`, `unit-tests.yml`; 21 in the reference run, +1 after
> Part 1), of which the two fling regression tests run on **byte-identical copies of the
> real artifacts** of run 33975063607 (stays RED, 3 informative cells all red) and
> 34800933407 (3 PASS / 3 non-informative). The two named holes: (a) the gate grades the
> **opt-in `drift`** arm while the shipped default is `legacy` — **NOT closed in Part 1**
> (a docs disclosure; the default `legacy` arm is red too — 3 offenders — and both arms are
> graded in the tables); (b) a verdict of `INCONCLUSIVE` (zero informative cells) exited 0 —
> **CLOSED in Part 1** (`merge-fling.js` now exits non-zero, the orchestrator rethrows
> arm-round failures, +1 firing gate test).

### Bench-honesty row (run 34813849446)

> F5 locate split per block: **dump 0 / describe 40, 60, 60, 40** — `locateVia = describe`
> 100 % in every block; F6 dump short-circuit logged and surfaced, **not gated**; F7
> first-attempt no-effect **0/40, 0/59, 0/59, 0/40**, oracle self-test pass in all four
> blocks, transport `redir` on both ON blocks, 0 degraded blocks, **0 fast-inject
> fallbacks**; F12 per-block ready gate blocking; F13 an executable OFF baseline failure
> fails the run; F19 `destinationVisible` probe removed. Device suite **17 enforced + 2
> measurement-only** (19 passed). Disclosure: **three ON-side `uiautomator dump` parse
> failures** this run (one per ON block on `tap+describe(settle:false)`, so those cells are
> n = 19, and one fling sample dropped with its reason recorded).

### Pacing default row (run 34813849446, process)

> scrcpy host pacing default is **`legacy`** — verified **character-identical** to
> `690e66bc`'s `injectTimeline` loop (18 lines, whitespace-normalized diff empty; the
> legacy catch path is the pre-3k one; no instrumentation on the default path).
> `ARGENT_SCRCPY_PACING=drift` is opt-in, read per gesture, any other value falls back to
> legacy (7 unit tests, `open-server-fast-inject-pacing.test.ts` — 8 after Part 1's 3K-L4
> test). No default change until a same-run paired effect clears p < 0.05 with the
> pre-registered gate green.

### Screen-graph rows (run 34813849446; supersede the D.2 run-33964414774 table and restate the D.4.1 run-34801849653 table, naming all three run ids)

| row | value |
|---|---|
| success, Wilson (n=100) + paired task-cluster bootstrap (n=20 tasks, B=10000, seed `0x5eedc0de`) | B1 100/100 [96,100] · B2 100/100 · O1 100/100 · O2 100/100 · O3 100/100 · O4 100/100 · O5 100/100 — **success is at parity across all seven configs; the differentiator is tokens, not success.** Replication: run 34801849653, same code, 99/100 on O2 and 100/100 elsewhere |
| B1 caveat (D41-H2, sourced to its own runs) | B1 100/100 holds under a harness that performs an explicit post-action settle for every config and splits B1's collapsed `"<title> / <summary>"` describe labels into text/cd before resolution. The same B1 code without those two was 81/100 (run 34788497583) and 82/100 (run 34794414764); the D.4 82 % is not a capability gap |
| tokens/agent-step, o200k p50, n=155 non-launch steps each | B1 657 · B2 651 · O1 179 · **O2 54** · O3 627 · O4 21 · O5 21. Launch-step observation excluded; each config observes its own sequence. Same-code run-to-run spread (D.4.1 runs): O1 138–179, O2 **54–68**, O3 598–627 |
| RTT count/step, p50, same n | B1 2 · B2 2 · O1 2 · O2 2 · O3 2 · O4 1 · O5 1. Not a latency column; modelled as action + observation, excludes the settle RPC |
| H1 tokens ratio | O1/B2 o200k p50 over all non-launch steps = 179/651 = **0.275×** (target ≤ 0.5×), PASS — identical to run 34801849653 |
| H2 | p50 over all non-launch steps: B2 − O2 = 0, **FAIL (structural)**. Same-screen steps (n=50 per arm): p50 2 − 1 = 1, PASS; means B2 2.00 vs O2 **1.20** (34801849653: 1.22) |
| H3 warm/cold | O4/O3 o200k p50 = 21/627 = **0.033×** (target ≤ 0.2×), PASS |
| H4 non-inferiority, paired task-cluster bootstrap, B=10000, seed `0x5eedc0de`, n=100 | vs B1 (100/100) and vs B2 (100/100): none inferior — O1/O2/O3/O4/O5 all +0 [0,0]. Every arm is 100/100 here, so this is unremarkable by construction; the informative version is run 34801849653 (O2 −1 [−3,0]) |
| invariants gate | Store invariants OK: 0 duplicate screens, 0 multi-destination edges (`sg-matrix.log:197`); `skippedNoIdHash` 0; three stores — `com.android.settings` **10 nodes / 9 edges, max out-degree 8, mean 0.9**, `com.android.chrome` 1/1, `com.google.android.settings.intelligence` 2/1. (Run 34801849653 built 11/10/9 for settings — the store shape is not run-stable) |
| O5 routing coverage, n=60 known-target taps | **60/60 one-step routed** · 0 zero-step no-op · 0 mis-landed · **0 diverged** · 0 no-route · 0 nav fallbacks (run 34801849653: 59/60 with one hash-mismatch divergence) |
| O5 measured RPCs per one-step routed tap, n=60 | min 7 / p50 7 / max 7 — a LOWER bound |

**Screen-graph rows explicitly NOT allowed from this run:** the D41-H1 **post-action-wait
symmetry** row ("equal within 5 %") — on run 34813849446 `actionRttMs + settleMs` p50
spreads **2246 (B1) … 2644 (O5), 17.7 %, with B1 the cheapest** (the opposite shape of run
34801849653's 5.2 %); it is cited only from 34801849653 with that run id, never as a
property of 34813849446. Also not allowed (carried from D.4.1): `settleMs` alone as
symmetry evidence, "B1's 82 % was not a rendering property" unqualified, "O2 same-screen
mean RTT/step 1.74", O5 `fallbacks` from the harness `results-ci.md`, and any token
×-factor without its statistic.

## Superseded (run 33975063607 latency + run 33964414774 screen-graph; kept for provenance)

### Superseded — run 33975063607 latency (was FINAL 2026-09-05; superseded by run 34813849446)

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

### Superseded — screen-graph run 33964414774 (D.2; superseded by run 34813849446 / 34801849653)

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

### Superseded — Goal verdict (run 33975063607, 2026-09-05); replaced by "Goal status" at the top (run 34813849446)

Wins (review-accepted, same run): swipe, pinch, await-screen-idle,
await-ui-element (scrcpy or both ON variants); describe idle never slower and
faster in 2 of 3 runs; tokens per agent step 3–30× lower with equal task
success. Parity: tap RPC, tap+describe (scrcpy). Loss: scrcpy fling momentum at
long durations (reproducible), UiAutomation tap +25 ms. Not measured on this
line: physical devices; local arm64 numbers (older sections below) predate the
gates and are not comparable. **Superseded on run 34813849446:** the run-7
describe win and the tap+describe(scrcpy) parity did NOT reproduce — describe is
parity/loss and tap+describe is an open loss on the consolidated base (see "Goal
status" and the run-34813849446 latency table above).

## Retractions added 2026-09-14 (run 34870686468 / 34888577404, phase 3n.1 flip + 3n.2 scrcpy removal)
- "open wins swipe/pinch **via scrcpy**" — superseded: the shipped default is now
  `input-manager` (Kotlin on-device), and scrcpy was **removed** in 3n.2. The swipe/pinch
  wins are `input-manager`'s: swipe −41 / pinch −35.5 (34870686468), swipe −30.5 / pinch
  −24.5 (34888577404), each CI clear of the floor. Any "scrcpy" latency/fling row is
  historical (see the Superseded section).
- "gesture-tap **at parity** (scrcpy −2…−3)" — superseded: `input-manager` tap is **+1 ms**
  vs the proprietary driver at a 0 floor; the pre-registered P2 inequality **fails by 1 ms**
  and was planner-accepted as parity in practice — NOT a clean gate PASS (3N1-H2). The old
  `CI lo ≤ floor` scoreboard rule was retired for the pre-registered point inequality.
- "the fling is a scrcpy property" / any scrcpy fling row as current — the scrcpy fling arm
  is **removed**; fling stays **OPEN pinned to 34813849446**, no new numbers, metric repair
  is ticket 3o. Run 34870686468's fling arms were mislabelled (ran `input-manager`, 3N1-H1)
  and are excluded from the reference by name.
- "the 3m.1 residual gate is a standing red" — **repaired in 3n.2** (run 34888577404):
  after-tap `|captureMs − Σ(stages)|` median **1 ms** (was 11 ms) once `infoMs` / `recycleMs`
  / `otherMs` are measured and the stage clocks are unified on `SystemClock.uptimeMillis()`.

## Retractions added 2026-09-14 (run 34813849446, review 3k1)
- "open describe idle never slower in 3 same-code runs / faster in 2 of 3" — falsified on run 34813849446: describe is at parity at p50 and **14–18 ms slower at p95**; the run-7 ON win (39/36 vs 52) did not reproduce (34806342684 reads the same). Direction-only claim retired.
- "tap+describe(scrcpy) at parity" — on run 34813849446 the headline `tap+describe(settle:false)` is an **open loss** (ON +150…+230 ms vs OFF at a 57 ms floor); reproduces in 34806342684, so it is the screen-graph-d base, not a 3k/3k.1 regression, cause not established.
- "fling fixed / resolved" (phase 3k) — retracted already; on run 34813849446 the deficit is **real and significant in 3 of 4 informative cells** in BOTH pacing arms, the paired legacy→drift test is null (p ≥ 0.13), and the gate is RED — status OPEN.
- "the 400 ms deficit is not present in run 34800933407" and the 8-frame / VelocityTracker frame-count mechanism as a finding — the deficit WAS present in 34800933407 (p=0.001), and the 8-frame explanation is ruled out (uia sends the same 8 frames, `uia/off` 1.037 at 400/0.3).

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
