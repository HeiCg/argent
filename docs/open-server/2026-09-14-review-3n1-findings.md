# Adversarial review — phase 3n.1 (promote `input-manager`) and CI run 34870686468

Promotion of `input-manager` to the default injector, and the candidacy of run
**34870686468** as the new single scoreboard reference. Read-only review; nothing in the
branch or the worktree was modified.

## Reviewed + evidence

- Subject: `feat/open-server-3n-kotlin-injector` @ `f6f8835f` (3n.1 commits
  `b953a95c`…`f6f8835f` on top of run-1 state `a61c47d5` + merge `88740db2` of `open/main`
  @ `2905f0d5`), worktree `/Users/heicg/Desktop/projects/argent-fork-wt-3n`.
- Tickets: `docs/open-server/2026-09-14-open-server-phase3n1-promote-input-manager.md`
  (main checkout); pre-registration + `## Result (3n.1)` on
  `docs/open-server/2026-09-14-open-server-phase3n-kotlin-injector-replaces-scrcpy.md:380-536`
  (worktree copy). Prior verdict + gate text:
  `docs/open-server/2026-09-14-review-3n-run1-findings.md`.
- Run metadata (one `gh run view --json jobs`): `attempt` **1**, head **`bb3fbddf`**,
  created 2026-09-14T16:46:31Z, conclusion `failure`. Latency job: steps 1–19 success,
  **step 20 `Enforce device-test result` FAILED** (step 14 `Open-server on-device test`
  reports success). Screen-graph job: **success**, all 15 steps.
- Artifacts: worktree `.bench-results/` was **empty**, so both artifacts were downloaded
  once each — `bench-latency` (id 10361814745) and `bench-screen-graph` (id 10362079173).
- Recompute: every p50/p95 recomputed from `bench-block-*.json` `latencySamples`; every
  bootstrap CI recomputed independently in Python (10 000 draws, percentile, own seed);
  every fling median/IQR/n and every ratio recomputed from `fling-block-*.json`; fling
  p-values are two-sided permutation tests on the medians (B = 20 000, seed 7).
- Local checks in the worktree: `node --test .github/bench-ci/gates.test.js` **26/26 pass**;
  `npx vitest run --maxWorkers=2 packages/tool-server/test/open-server-inject-strategy.test.ts`
  **9/9 pass**.
- Reference context: `2026-09-03-scoreboard.md:5-52,116-133`, `README.md:19,31`,
  `2026-09-14-review-3k1-findings.md`.

### Numbers that reproduce exactly

The whole verb table in the Result reproduces from the block JSON (tap 53/86/54/52/53,
swipe 305/306/263/258/303, pinch 353/346/318/307/354, headline −/480/372/349/−,
await-ui-element 76/41/41/42/76, await-screen-idle 499/304/305/304/498). All four measured
floors reproduce (tap **0**, swipe **2**, pinch **1**, headline **78**). P5's three ratios
reproduce (0.9118 / 0.7654 / 0.8322). The fling instrument grid reproduces exactly
(abDev 0 / 0 / 0.014 / 0 / 0.044 / **0.41**). The screen-graph rows reproduce
(`results-ci.md:17,29-35`, `sg-matrix.log:188-197`). `injectStrategyReported` reproduces
(`input-manager: 161/161 [counts {"input-manager":161}]`, control `default: 161/161`).

### Pre-registered text vs the review's verbatim gates

Diffed literally. **P0–P10 are byte-identical** to
`2026-09-14-review-3n-run1-findings.md:459-511`. The **only** deviation is that the
six-line _preamble_ above P0 was not copied (see 3N1-M4) — the lines carrying "Every gate
below is graded against the PROPRIETARY blocks, never against ON-scrcpy" and "every Δ is
reported with a 10 000-sample bootstrap 95 % CI".

## VERDICT

**The run is sound, the latency measurement is the best this programme has produced, and
`input-manager` is genuinely at-or-better than the proprietary driver on every gesture verb
— but the Result overstates its own gate compliance in three specific places, and one of
them is a real measurement defect that invalidates the fling section's arm labels.**

Substantively: with the `ON-uiautomation` control finally present, the within-run
comparison 3N-H4 asked for exists and is decisive — the current default UiAutomation tap is
**86 ms**, `input-manager` is **54 ms**, the proprietary driver is **53 ms**. Swipe −40 and
pinch −35 vs proprietary, both with bootstrap CIs clear of the measured floor. Landing
100 % on every block, 0 fallbacks, 161/161 injections through the reflective pipe, the
forced-fallback path exercised on-device, screen-graph back at the reference (100/100 on
all seven configs, `skippedNoIdHash` **0**, Settings store 10/9). That is a real result and
it justifies the flip.

Where the Result is not honest enough:

1. **P8's two "identical-code UiAutomation" control arms did not run UiAutomation.**
   `bench-fling-fidelity.ts:339-340` deletes `ARGENT_OPEN_INJECT_STRATEGY` for the uia
   groups, and after the 3n.1 flip an unset env resolves to `input-manager`
   (`open-server-input.ts:40-52`). Proven from the run, not only from code: the fling
   logcat records the hidden-method resolution **nine** times — 3 rounds × 3 open arms —
   and each occurrence lands 2–3 s before an `ON-uia-A` / `ON-uia-B` / `ON-input-manager`
   visit begins. Run 2 therefore contains **no UiAutomation fling arm at all**; the P8
   "instrument control" is a triplicate of `input-manager` under three labels.
2. **P2 passes only under a rule that is neither the pre-registered inequality nor a
   correct non-inferiority test.** Pre-registered: `im p50 ≤ max(OFF) + floor`, i.e.
   `54 ≤ 53 + 0` → **FAIL by 1 ms**. Implemented: `CI lower bound ≤ floor`
   (`scoreboard.js:264`) → PASS. A proper non-inferiority test (CI **upper** bound ≤ margin)
   also fails (hi = +1 > 0). The Result prints P2 as a clean PASS and never says the
   literal gate does not hold.
3. **The headline "win" is mostly the proprietary baseline moving.** OFF `tap+describe`
   pooled p50 went 325 (ref 34813849446) → 496 (run 1) → 447 (run 2), while
   `ON-uiautomation` went 505 → 480 and `ON-scrcpy` went 529 → 349 with no scrcpy change.
   P5 is a legitimate within-run ratio gate and it passes; but the row is not evidence that
   the open stack got faster on the headline.

Also: the Result's "the screen-graph job runs with no strategy env, so 3n's code is inert
on it" is now **false** — post-flip the O1–O5 configs inject through `input-manager`
(`bench-screen-graph.ts:1169` → `gesture-tap` tool → `openServerTap` → `injectOpt()`).
That is good news for the flip (the graph is green _with_ input-manager) and bad news for
the sentence.

Code review is otherwise clean. The default flip and the `default`/`uia` sentinel are
correct and proven both at the wire level (`injectOpt()` returns `{}`) and on-device (the
control block's counter reads `default: 161/161`). `InjectStrategyCounter` records **once
per `inject`/`injectTaps` call** (`MotionInjector.kt:203,320`) — per RPC, not per frame, as
claimed. The `forceUnavailableForTest` seam is genuinely unreachable in production
(`JsonRpcHandler.kt:118` gates it on the `-e benchDebug true` start arg and clears it in a
`finally`).

The red step is **not** 3n-related and **not** estimator bias: it is real unaccounted work
inside `captureMs`, on the DEFAULT path, in stages 3m.1 never added.

Overall: **accept the run; accept the promotion on the latency/landing/availability
evidence; correct P2's bookkeeping honestly rather than re-stating it as PASS; treat the
entire fling section of run 2 as void for arm labelling (the instrument verdict survives,
the arm names do not); and do not let run 34870686468 become the reference until the
uia-arm leak is fixed or the fling rows are explicitly excluded.**

## Gate status (P0–P10, recomputed)

| gate                              | Result says                                    | recomputed                                     | note                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ | ------- | ------------ | ------- | --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| **P0** control present            | PASS                                           | **PASS**                                       | 5 blocks in `bench-merged-1789407736358.json`; control ran the pre-3n.1 wire (no `inject` key) — proven by `resolveInjectStrategy()` returning `undefined` for `default` and by the on-device counter `default: 161/161`                                                                                                                                                |
| **P1** measured floor             | PASS                                           | **PASS**                                       | tap `                                                                                                                                                                                                                                                                                                                                                                   | 53−53 | `=0, swipe ` | 305−303 | `=2, pinch ` | 353−354 | `=1, headline ` | 408−486 | `=78. `measuredFloor()`returns`null`→`**N/A**` when a comparator is missing (`scoreboard.js:115-118`); covered by a test |
| **P2** tap vs proprietary         | PASS                                           | **FAIL by 1 ms as written**                    | 54 ≤ 53+0 is false. Pooled CI **[0, 1]** (mine [0,1]); vs max(OFF)=OFF-1 CI **[−1, +1]**. PASS only under the implemented `CI lo ≤ floor` rule                                                                                                                                                                                                                          |
| **P3** swipe                      | PASS                                           | **PASS (win)**                                 | 263 ≤ 303+2. Δ vs pooled −41, CI **[−45, −34]**; vs min(OFF) Δ −40, CI [−45.5, −30]                                                                                                                                                                                                                                                                                     |
| **P4** pinch                      | PASS                                           | **PASS (win)**                                 | 318 ≤ 353+1. Δ vs pooled −35.5, CI **[−43.5, −34]**; vs min(OFF) Δ −35, CI [−45, −33.5]                                                                                                                                                                                                                                                                                 |
| **P5** headline ≤ 1.15            | PASS                                           | **PASS**                                       | 372/408 = 0.912, 372/486 = 0.765, 372/447 = 0.832. (Control also passes: 480/447 = 1.074)                                                                                                                                                                                                                                                                               |
| **P6** no regression vs control   | PASS                                           | **PASS**                                       | im −32 / −43 / −28 / −108 vs `ON-uiautomation`. Note the rule is vacuous on the headline row (CI [−266, −14], floor 78)                                                                                                                                                                                                                                                 |
| **P7** landing + fallbacks + echo | PASS                                           | **PASS on substance, denominator mislabelled** | landing 40/40, 60/60, 60/60, 60/60, 40/40, oracle pass on every block; 0 `unavailable`. `161/161` is the **process-wide** injection count, not the 100 measured gesture RPCs (3N1-M2)                                                                                                                                                                                   |
| **P8** instrument-first           | INSTRUMENT-UNRESOLVED, non-gating, step exit 0 | **verdict correct, arms mislabelled**          | abDev 0.41 at 400/0.5 fires the rule; `arms: []` in `fling-ab-1789409881273.json`; `gating:false`; step 16 success. But A and B are input-manager (3N1-H1), and the 0.41 divergence is itself not significant (permutation p = **0.19**)                                                                                                                                |
| **P9** availability + fallback    | PASS                                           | **PASS, with a portability correction**        | no `hidden_api_policy` write anywhere in the tree (comments only); device case `3n.1 P9 forced-fallback`: `strategy=unavailable fellBackTo=uia-async; tap still navigated (+/-42 labels); reset → input-manager`; host test `open-server-inject-strategy.test.ts:126`. **But** the API-34 holder is _denied_ on this image; the legacy holder is what resolves (3N1-M5) |
| **P10** screen-graph              | PASS                                           | **PASS on substance, incomplete as reported**  | 100/100 × 7, `skippedNoIdHash` **0**, invariants OK, Settings store 10 nodes / 9 edges, three stores. Missing from the Result: per-config tokens (only O2), the H4 paired-cluster intervals, and 34840929610's counter, all of which P10 asked for                                                                                                                      |

**Promotion acceptance (P0–P7 + P9 + P10)**: met on substance; **P2 is met only under the
implemented CI rule, not under its own pre-registered inequality.**

## HIGH

**3N1-H1 — The P8 control arms `ON-uia-A` / `ON-uia-B` ran `input-manager`; run 2 has no
UiAutomation fling arm.** `bench-fling-fidelity.ts:337-341` (and the single-config path at
`:249-250`) does `delete process.env.ARGENT_OPEN_INJECT_STRATEGY` for every non-scrcpy,
non-off arm with the comment "the plain uia arm clears the strategy so it runs the DEFAULT
UiAutomation path". After the 3n.1 flip that is exactly backwards: `resolveInjectStrategy()`
returns `"input-manager"` when the env is unset (`open-server-input.ts:40-52`; asserted by
`open-server-inject-strategy.test.ts:36-43`). Run evidence, not inference —
`logcat-fling-ON-uiautomation.txt` contains **9** occurrences of
`Accessing hidden method Landroid/hardware/input/InputManager;->injectInputEvent`, at
17:42:24, 17:44:45, 17:46:58, 17:54:03, 17:56:14, 18:03:34, 18:05:49, 18:13:15, 18:15:34.
The arm-visit windows from `fling-interleave-evidence.json` (t0 = 17:42:20.229) are
uia-A 17:42:26, uia-B 17:44:48, im 17:47:01, uia-B 17:54:05, im 17:56:16, uia-A 18:03:36,
im 18:05:52, uia-A 18:13:18, uia-B 18:15:36 — a 1:1 match, every open non-scrcpy arm
probed the reflective pipe. The first one is immediately preceded by
`JsonRpcHandler: method=swipe id=8` on the uia-A visit. Consequences: (a) the fling section
is a 3-arm replicate of `input-manager` plus scrcpy plus proprietary; (b) "the current
default fails fling too" cannot be re-checked on this run; (c) any future `arm/uia` column
computed from these files is meaningless. The instrument verdict itself survives — two (in
fact three) same-code arms diverging **is** the instrument test — but the labels do not.
This is the same class of bug as 3N1-H3: the flip changed the meaning of "env unset" and
two harnesses still assume the old meaning.

**3N1-H2 — P2 is graded by a rule that is neither the pre-registered one nor a valid
non-inferiority test, and it is outcome-determinative.** `scoreboard.js:258-266`:
`niGate` passes when `ci[0] <= floor`, i.e. when the **lower** bound of the bootstrap CI is
within the margin. Pre-registered P2 is a point inequality: `im p50 ≤ max(OFF-1,OFF-2) +
floor` = `54 ≤ 53` → false. A correct non-inferiority test is `ci[1] ≤ floor` → `1 ≤ 0` →
also false. Only the implemented rule passes. Provenance matters and is in the ticket's
favour: the deviation was pre-registered, in the dispatch ticket's Work 5 ("tests on the
run-34853156073 artifact must reproduce the review's per-verb table: **tap +2 parity**",
`2026-09-14-open-server-phase3n1-promote-input-manager.md:43`) and is baked into
`gates.test.js` ("3n.1 gates reproduce the review's per-verb table"), written before the
run. So this is **not** post-hoc gate shopping — it is an internal contradiction between
two halves of the same pre-registration, resolved silently in favour of the looser half.
Two further defects of the implemented rule, independent of the outcome: it is the wrong
tail (an arm with Δ +292 and CI [−50, +400] would PASS), and applied to P6's headline row
(CI [−266, −14], floor 78) it can never fail. The honest line for the Result and the
scoreboard is: _tap is +1 ms vs proprietary on a measured floor of 0; the pre-registered
inequality fails by 1 ms; the difference is not material and the planner accepted it_ —
not "PASS".

**3N1-H3 — "The screen-graph job runs with no strategy env, so 3n's code is inert on it" is
false after the flip.** `bench-screen-graph.ts:1169` invokes the `gesture-tap` tool, which
routes through `openServerTap` → `injectOpt()` for every open config; `bench-screen-graph.ts`
contains no `ARGENT_OPEN_INJECT_STRATEGY` assignment (verified by grep over the repo: the
only writers are `bench-open-vs-proprietary.ts:1886` and `bench-fling-fidelity.ts`). So
O1–O5 in run 2 injected through `input-manager`. This _strengthens_ P10 as evidence (the
graph is 100/100 **with** the new default, vs run 1's 97–100 on the old one) and it is the
only place in the run where input-manager is exercised across 500 open task-runs — but the
Result's attribution sentence must be inverted, and the claim "nothing here is attributable
to 3n" withdrawn.

**3N1-H4 — The headline reversal is a baseline movement, not an input-manager property.**
OFF `tap+describe` p50 across runs: **354/297** (reference 34813849446,
`2026-09-03-scoreboard.md:39`) → **445/548** (run 1) → **408/486** (run 2). Pooled:
325 → 496 → 447. Over the same span `ON-uiautomation` moved 505 → 480 (−5 %) and
`ON-scrcpy` moved 529 → 349 (−34 %) **with no change to the scrcpy path**. P5's pass is
therefore driven by (a) the proprietary comparator getting ~37 % slower and (b) a
base-level improvement that predates 3n.1 (it is already in run 1, whose base is 3m.1).
The within-run gate is valid; the _claim_ "open now beats proprietary on the headline" is
not supported by this run, and the within-run OFF↔OFF drift on that row is still **78 ms**
on a 372 ms measurement.

## MEDIUM

**3N1-M1 — The Result's CIs are blended across two comparators, and one of them appears in
no artifact.** The Result's P2 row reads "Δ 1, **CI [−1,0]**". `scoreboard.md` prints two
different intervals for that verb: the table's `Δ(im−pooledOFF)` CI **[0, 1]** and the P2
bullet's `CI lo **−1**` (vs `max(OFF)` = OFF-1). Both reproduce in my independent bootstrap
([0,1] and [−1,+1]). **[−1, 0] is neither** — it pairs the bullet's lower bound with a
hand-made upper bound. The same blend runs through P3 ("Δ −40" is vs `min(OFF)`, "CI
[−45,−34]" is vs pooled; the min-bound CI is [−45.5,−30]) and P4 ("Δ −35" vs min(OFF),
CI [−43.5,−34] vs pooled; the min-bound CI is [−45,−33.5]). Every gate row should carry the
Δ and the CI of the **same** comparator.

**3N1-M2 — `161/161` is the process-wide injection count, not the measured-RPC count P7
asked for.** `InfoHandler.kt:42` snapshots `InjectStrategyCounter` for the whole
instrumentation process; `bench-open-vs-proprietary.ts:2455-2468` renders it as
`<expected>: n/total` where `total` is the sum over all strategies. The 100 measured
gesture RPCs (5 verbs × 20) are a subset; the remaining 61 are warmups, oracle self-test,
locate/restore navigations and the `tap+describe` setup taps. Two consequences: (a) the
denominator is self-referential — `161/161` says "every injection this process made was
input-manager", which is _stronger_ than P7's ask but not checkable against any published
denominator; (b) P7's literal requirement that "the `strategy` echo is recorded on **every**
measured tap/swipe/gesture reply" is not verified anywhere — the bench reads the aggregate
from `getInfo`, never the per-reply field. The strongest available reading of the evidence
is the one the control gives for free: both ON blocks report **exactly 161**, so the two
workloads are identical and the split is clean.

**3N1-M3 — P10 is reported more thinly than it was pre-registered.** P10 asked for
"per-config success **and tokens** reported with the H4 paired-cluster intervals" and
`skippedNoIdHash` "alongside 34813849446 (0) **and 34840929610**". The Result gives
success collapsed to "100/100 all", tokens for O2 only, no H4 intervals, and no
34840929610 counter (still unrecorded anywhere, as in run 1). Available and unreported from
`results-ci.md:29-60`: tokens B1 657 · B2 651 · O1 **179** · O2 54 · O3 627 · O4 22 · O5 22;
H1 **0.275×** PASS (run 1: 0.214×), H2 0 FAIL / same-screen 1 PASS, H3 **0.035×** PASS;
H4 all Δ +0 pp [0, 0] vs both baselines; O5 one-step routed **60/60**, hash-mismatch 0.

**3N1-M4 — The verbatim quote drops the preamble that carries two of the gate package's
constraints.** `2026-09-14-review-3n-run1-findings.md:453-458` is not in the ticket's
quoted block. The two lost sentences are "Every gate below is graded against the
PROPRIETARY blocks, never against ON-scrcpy" and "Every verb emits its per-sample latency
array; every Δ is reported with a 10 000-sample bootstrap 95 % CI on the p50 difference".
Both were in fact implemented, so nothing was evaded — but the pre-registered block a
future reader diffs against is now missing the statement that turns the CI from a report
into a requirement, which is precisely the ambiguity 3N1-H2 exploits.

**3N1-M5 — The API-34 holder is BLOCKED on this image; the pipe that works is the legacy
one.** `logcat-fling-ON-uiautomation.txt:833-835` (and every other probe site):
`InputManagerGlobal;->getInstance()` → **"(blocked, reflection, denied)"**, then
`InputManager;->getInstance()` → "(unsupported, reflection, allowed)", then
`InputManager;->injectInputEvent(InputEvent,I)` → allowed. So `resolveInstance()`
(`InputManagerInjector.kt:121-140`) always falls through its first candidate on
`system-images;android-34;google_apis;x86_64`, and the availability claim rests entirely on
the **deprecated `InputManager.getInstance()` holder**, which AOSP removed the guts of at
API 34 and which greylist policy can drop at any release. This inverts review 3N-L3 ("the
≤33 branch was never exercised"): the ≤33 branch is the _only_ one that has ever run. Any
"input-manager is available" scoreboard row must name the holder, not just the image. The
fallback is correct and exercised, so the risk is degradation to `uia-async`, not breakage.

**3N1-M6 — The default UiAutomation control regressed vs the reference run and the Result
does not say so.** `ON-uiautomation` vs `ON-uia` on 34813849446 at that run's floors:
gesture-tap **78 → 86** (+8, floor 1) **OUT**, gesture-swipe **292 → 306** (+14, floor 4)
**OUT**, await-screen-idle **294 → 304** (+10, floor 0) **OUT**; faster: describe 53 → 48,
await-ui-element 45 → 41. Pinch unchanged (346). Run 1's uia arms read the same
(uia-sync 84 / uia-async 86 tap, 311/291 swipe), so this is a property of the 3m/3m.1 base,
not of 3n.1 — but it is the control arm of the promotion run and it moved outside its own
reference floors on three verbs. It also inflates the P6 margin.

**3N1-M7 — P8's trigger is a divergence that is not itself significant, while a much larger
same-code divergence goes unreported.** At 400/0.5 uia-A 0.509 (n=12) vs uia-B 0.360 (n=12):
ratio 1.412, two-sided permutation **p = 0.186** — the pre-registered ±0.15 rule fires
correctly, but the data do not _demonstrate_ non-reproducibility, they demonstrate
insufficient precision at n = 12. Meanwhile, because all three open non-scrcpy arms are the
same code (3N1-H1), the run contains a **2.64× spread between identical arms** at 150/0.3
(uia-A 0.175, uia-B 0.175, im 0.462, off 0.464; p = 0.41 — bimodal, 3N-H3's censoring at
work) which is never mentioned. Recomputed full grid (median (n) [q25,q75]):

| cell    | OFF        | uia-A      | uia-B      | input-manager | scrcpy     |
| ------- | ---------- | ---------- | ---------- | ------------- | ---------- |
| 150/0.3 | 0.464 (12) | 0.175 (12) | 0.175 (12) | 0.462 (12)    | 0.417 (12) |
| 150/0.5 | 0.175 (11) | 0.175 (11) | 0.175 (12) | 0.175 (12)    | 0.175 (12) |
| 250/0.3 | 0.478 (11) | 0.441 (12) | 0.435 (12) | 0.427 (12)    | 0.365 (12) |
| 250/0.5 | 0.175 (11) | 0.175 (12) | 0.175 (12) | 0.175 (12)    | 0.316 (12) |
| 400/0.3 | 0.364 (12) | 0.309 (11) | 0.296 (12) | 0.303 (12)    | 0.314 (12) |
| 400/0.5 | 0.657 (11) | 0.509 (12) | 0.360 (12) | 0.575 (12)    | 0.486 (12) |

Ratios vs OFF with permutation p: 150/0.3 A 0.377 (0.093) · B 0.377 (0.027) · im 0.996
(0.40) · scr 0.900 (0.28); 250/0.3 A 0.922 (0.022) · B 0.910 (0.020) · im 0.894 (0.023) ·
scr 0.764 (0.008); 400/0.3 A 0.848 (0.014) · B 0.811 (0.009) · im 0.831 (0.008) ·
scr 0.861 (0.032); 400/0.5 A 0.775 (0.022) · B 0.549 (0.007) · im 0.874 (0.089) ·
scr 0.739 (0.011). **INSTRUMENT-UNRESOLVED is the right call, and it is the right call on
the whole section, not only at 400/0.5** — under the literal rule 400/0.5 is the sole
breach, but once the third same-code replicate is admitted 150/0.3 breaches by 164 %.
No per-arm number in the Result is printed as if graded (I checked: it prints only
uia-A 0.509 / uia-B 0.361 and "no arm verdict"), and step 16 exiting 0 is correct under
`gating:false` in `fling-ab-1789409881273.json`.

**3N1-M8 — "the only failing step is the … residual gate" understates a masking pattern.**
The failing step is **#20 `Enforce device-test result`**; step **#14**, which actually runs
the device suite, reports **success** while its own output says `Tests 1 failed | 26
passed (27)` and emits a `::error` annotation (`logs/device-test.log:189,201,220`). A
device-test failure is therefore invisible in the step list and depends entirely on step 20
existing. Worth stating in the process row rather than in the ticket's prose.

**3N1-M9 — "Values reproduce run 34853156073 within a few ms" is wrong on the headline.**
im run 1 → run 2: tap 55 → 54, swipe 268 → 263, pinch 323 → 318, await-ui 47 → 41,
await-idle 312 → 305 — all within 7 ms; **`tap+describe(settle:false)` 400 → 372 is 28 ms**,
on a row whose within-run floor is 78. The sentence should exempt the headline row.

## LOW

**3N1-L1 — the forced-fallback seam is process-global and `tap`-only.**
`JsonRpcHandler.kt:122-134` sets `InputManagerInjector.forceUnavailableForTest(...)` around
the `tap` branch only and clears it in a `finally`; `swipe`/`gesture` have no equivalent, so
P9's "unchanged outcome" is proven for taps only. The override is a `@Volatile` field on a
process-global object while the server listens on two sockets
(`DeviceControlInstrumentation.kt:111` builds a second handler), so a concurrent connection
injecting during the forced tap would also be forced. Not reachable in production
(`benchDebug` start arg), not exercised concurrently in this run.

**3N1-L2 — the stage clocks are mixed.** `captureMs`, `rootMs`, `encodeMs`, `idleMs` use
`System.currentTimeMillis()` (`StateHandler.kt:138,173,242,262`) while `windowsMs`,
`rootsMs`, `serializeMs` use `SystemClock.uptimeMillis()`
(`NestedWindowSerializer.kt:113,121,139,141,149`). Two different clocks on both sides of a
1 ms-resolution residual subtraction adds avoidable noise to the gate in the next section.

**3N1-L3 — the scrcpy block's echo label is misleading.** `ON-scrcpy` reports
`default: 0/0 [counts {}]` and the note "inject-strategy control block ran default 0/0
on-device" (`scoreboard.md`, ON-scrcpy notes), because `expected = injectStrategy ?? "default"`.
It is actually excellent negative evidence — zero Kotlin injections proves the block ran
entirely on the scrcpy channel — but it reads as if a control ran.

**3N1-L4 — 3N-L2 is unfixed.** `InputManagerInjector.injectAsync` still catches `Throwable`
and returns `false` (`InputManagerInjector.kt:78-86`), so a per-call `SecurityException`
_after_ a successful probe surfaces as `dropped=true`, never as `strategy:"unavailable"`.
Errors and fallbacks are 0 on every verb of every block this run, so it did not bite.

**3N1-L5 — `scoreboard.md` still renders an empty fling table** ("OFF reference present:
yes · scrcpy gate arm pacing: **drift** · legacy arm present: no", header row, zero data
rows) because the 3n.1 instrument mode writes `arms: []`. Harmless, but a reader diffing
scoreboards will see a table that lost its rows rather than a section that declined to
grade.

**3N1-L6 — four verbs carry no gate and are unreported.** `describe` (im 51 vs OFF 52/52,
floor 0 — note OFF-1 p95 **166** vs OFF-2 **52**, so describe p95 is uninterpretable this
run), `paste` (im 370 vs OFF 827/738, floor **89** → −368, clears the floor; control 325,
scrcpy 371), `tap+describe(settle:true)` (im **859**, control 858, scrcpy 832 — **no OFF
counterpart, so N/A under P1**, and the Result omits the row entirely), and
`await-screen-idle` / `await-ui-element` (im 305 vs 499/498 floor 1 → −193; 41 vs 76/76
floor 0 → −35, both wins). Nothing here is outside expectation; the point is that the
Result's verb table silently drops three rows the scoreboard prints.

## Residual gate diagnosis

**Real unaccounted stages inside `captureMs`, on the DEFAULT injection path, not estimator
bias and not 3n-related.**

Facts. The failure is `afterResidualMed = 11` vs `≤ 10`
(`android-open-server.device.test.ts:1117`, `logs/device-test.log:201-220`), median of
`|captureMs − Σ(stages)|` over **20** samples; the idle loop (same estimator, 20 samples,
`:1080`) passed. `sumStages` (`:1040-1053`) = `rootMs + windowsMs + Σ rootsMs +
serializeMs + encodeMs + fingerprintMs`.

Not 3n. The loop calls `await api.tap(c.x, c.y)` with **no** `opts`
(`android-open-server.ts:413-430`), so no `inject` reaches the wire and the Kotlin DEFAULT
path runs — the same path 3m.1 measured. And the input-manager hypothesis is ruled out by
construction: the async-UP drain happens in **step 0** of `StateHandler.execute`
(`StateHandler.kt:119-128`), **before** `captureStart` (`:138`), so `drainAsyncUp` /
`flushInput` can never enter `captureMs` for any strategy.

What _is_ inside `captureMs` and in no stage, in order of suspicion:

1. **A second full accessibility-window enumeration.** `isKeyboardVisible()`
   (`StateHandler.kt:306-312`) calls `uiAutomation.windows` — a separate IPC round-trip
   from the serializer's own enumeration (which is `windowsMs`,
   `NestedWindowSerializer.kt:113-121`) — and it sits in the untimed `info` block at
   `StateHandler.kt:226-233`. _(Inference, not measured:)_ on an idle screen the window set
   is stable and this is ~0–1 ms; on the after-tap `waitTimeoutMs: 0` capture the window set
   is mid-churn, which is exactly where accessibility window queries cost several ms. That
   asymmetry matches the observed idle-pass / after-tap-fail split.
2. **`DisplayReader.read(context)`** — same untimed block, constant few ms.
3. **`rootNode.recycle()`** of the whole forest in the `finally` at `StateHandler.kt:213`,
   after `serializeMs` has already been closed — scales with tree size, and the after-tap
   tree is the larger one.
4. **Untimed work inside the serializer loop**: the window `sortedWith`, the per-window
   `getBoundsInScreen` + `shouldSerializeWindow` for _skipped_ windows, and
   `active.getBoundsInScreen` (`NestedWindowSerializer.kt:114-137`) — none of it is in
   `windowsMs`, `rootsMs` or `serializeMs`.
5. Clock mixing (3N1-L2) adds ±1 ms of pure bookkeeping noise on top.

Stability. On this estimator family the row reads **1 ms over** (34840929610, 5 samples),
**5 ms under** (34853156073, 20 samples), **1 ms over** (34870686468, 20 samples). Going
from 5 to 20 samples did not stabilise it, because the problem is not the median's variance
— it is that ~10 ms of genuine work is systematically outside the accounting and its size
tracks how busy the window manager is during the capture.

**Recommendation: keep the 10 ms threshold; add the missing stages; do not loosen, do not
widen the sample count again.** Concretely, for the 3m.1 fix ticket: emit `infoMs`
(covering `DisplayReader.read` + `isKeyboardVisible`), `recycleMs`, and a server-computed
`otherMs = captureMs − Σ(named stages)` so the residual is decomposed on-device rather than
inferred host-side; put every stage on `SystemClock.uptimeMillis()`; and have the device
test print the 20 per-sample residuals (and the new stage medians) on failure so a 1 ms miss
is interpretable instead of a bare assertion. If `isKeyboardVisible` turns out to dominate,
the real fix is to derive it from the window list the serializer already enumerated instead
of asking for a second one — which removes the cost rather than accounting for it.

## Reference run recommendation

**Not yet as a full replacement. Run 34870686468 should supersede 34813849446 for
latency, landing, availability, process and screen-graph — but its fling section must be
excluded by name, not merely marked OPEN.**

Reasons to promote it: it is the only run on the current base that carries all five blocks
including the `ON-uiautomation` control (P0), per-sample latency arrays with bootstrap CIs
(3N-H5 closed), measured floors with no constants (3N-H1 closed), per-block strategy counts
(3N-M1 closed), per-arm logs for every arm (3N-M5 closed), a 100 % landing sweep on every
block, and a screen-graph matrix that is back at the reference (100/100 × 7,
`skippedNoIdHash` 0, store 10/9) — and it is the run on which the shipped default changes.
`34813849446` cannot stay the reference for latency once the default is `input-manager`,
because it contains no input-manager arm at all.

Reasons not to promote it wholesale: (a) the fling arms are mislabelled (3N1-H1), so the
fling half of the "single reference" would be wrong on its face; (b) the run conclusion is
`failure`, and a reference run whose device suite is red needs that stated in the row, not
in a footnote; (c) the headline row's comparator moved 37 % (3N1-H4), so it cannot carry a
capability claim.

Practical shape: promote it as the reference for **latency + landing + screen-graph +
process**, keep the **fling status row pinned to 34813849446 with status OPEN and no new
numbers**, and re-point the fling reference at the first run whose uia arm is actually uia.

## Scoreboard rows allowed

Exact wording; anything not listed here does not enter.

**May enter now (run 34870686468, head `bb3fbddf`, attempt 1, `system-images;android-34;
google_apis;x86_64`, ubuntu-latest KVM x86_64, N = 20 per verb per block):**

| row                                                                                              | statistic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | N                                                |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Latency verb table, five blocks `OFF-1 / ON-uiautomation / ON-input-manager / ON-scrcpy / OFF-2` | p50/p95 ms with the measured OFF↔OFF drift floors stated per verb: describe 0, gesture-tap **0**, gesture-swipe **2**, gesture-pinch **1**, await-screen-idle 1, await-ui-element 0, paste 89, `tap+describe` **78**                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 20 per verb per block                            |
| gesture-tap vs proprietary                                                                       | "`input-manager` **54** vs proprietary 53/53 at a measured floor of **0**: Δ +1 ms, bootstrap 95 % CI on the p50 difference **[0, +1]** vs pooled OFF. Parity in practice; the pre-registered P2 inequality (`≤ max(OFF) + floor`) fails by 1 ms and was accepted by the planner. The current UiAutomation default reads **86** on the same run."                                                                                                                                                                                                                                                                                                                                          | 20                                               |
| gesture-swipe vs proprietary                                                                     | "`input-manager` **263** vs proprietary 305/303, floor ±2: Δ **−41** ms, CI **[−45, −34]** — **win**, CI clear of the floor. Control `ON-uiautomation` 306 (parity with proprietary)."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 20                                               |
| gesture-pinch vs proprietary                                                                     | "`input-manager` **318** vs proprietary 353/354, floor ±1: Δ **−35.5** ms, CI **[−43.5, −34]** — **win**, CI clear of the floor. Control `ON-uiautomation` 346."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 20                                               |
| Headline `tap+describe(settle:false)`                                                            | "`input-manager` **372** ÷ OFF `tap+describe` = 0.91 (OFF-1 408) / 0.77 (OFF-2 486) / 0.83 (pooled 447) — all ≤ 1.15, gate P5 PASS. **Within-run OFF↔OFF drift on this row is 78 ms** and the OFF comparator moved 325 → 447 pooled since 34813849446 while `ON-scrcpy` moved 529 → 349 with no scrcpy change; this is a within-run ratio, **not** a claim that the open stack got faster on the headline."                                                                                                                                                                                                                                                                                | 20                                               |
| No-regression vs the current default                                                             | "`input-manager` is faster than the `ON-uiautomation` control on every gated verb in the same run: tap −32, swipe −43, pinch −28, headline −108 ms (P6)."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 20 per verb                                      |
| First-attempt landing                                                                            | "OFF-1 40/40, ON-uiautomation 60/60, ON-input-manager 60/60, ON-scrcpy 60/60, OFF-2 40/40 — **100 % on every block**; oracle self-test passed on every block; first-attempt no-effect 0 everywhere. No 'more reliable than scrcpy' wording — scrcpy did not miss a tap this run."                                                                                                                                                                                                                                                                                                                                                                                                          | 40–60 per block                                  |
| Strategy echo / fallbacks                                                                        | "`ON-input-manager` reported `input-manager: 161/161` and `ON-uiautomation` reported `default: 161/161` from the on-device per-RPC counter (`InjectStrategyCounter`, one record per `inject`/`injectTaps` call); **0** `unavailable` fallbacks. 161 is the process-wide injection count for the block (measured RPCs + warmups + oracle + restore taps), identical across the two ON blocks. `ON-scrcpy` recorded 0 Kotlin injections, confirming it ran entirely on the scrcpy channel."                                                                                                                                                                                                  | 161 per ON block                                 |
| `input-manager` availability                                                                     | "The reflective `InputManager.injectInputEvent(InputEvent, int)` with `INJECT_INPUT_EVENT_MODE_ASYNC` resolved and ran on `system-images;android-34;google_apis;x86_64` with **no** `hidden_api_policy` change and no `-e disable-hidden-api-checks`. On this image `InputManagerGlobal.getInstance()` is **denied** by hiddenapi policy; the pipe resolves through the legacy `InputManager.getInstance()` holder. Availability is a property of this image and this holder, not of Android devices in general."                                                                                                                                                                          | 161 injections + 6 device cases                  |
| Forced-fallback (P9)                                                                             | "`input-manager` forced unavailable on-device: `strategy == \"unavailable\"`, `fellBackTo == \"uia-async\"`, tap still navigated (+/−42 labels), next request resolved back to `input-manager`. Exercised on the `tap` RPC only."                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 1 device case + 1 host test                      |
| Device-test outcome row                                                                          | "All six 3n strategy cases PASS with `ranAs` == requested; the 3n.1 P9 case PASSES. \*\*The 3m.1 stage-accounting gate `                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | captureMs − Σ(stages)                            | ≤ 10`FAILED at an after-tap 20-sample median of 11 ms** (idle passed); diagnosed as unaccounted work inside`captureMs`(second window enumeration in`isKeyboardVisible`, `DisplayReader.read`, forest `recycle`), not a 3n regression." | 20 samples per phase |
| Screen-graph row                                                                                 | "Success 100/100 on all seven configs (B1/B2/O1/O2/O3/O4/O5), exclusions-as-failures; tokens o200k p50 B1 657 · B2 651 · O1 179 · O2 54 · O3 627 · O4 22 · O5 22; H1 0.275× PASS, H2 0 FAIL / same-screen n=50 = 1 PASS, H3 0.035× PASS, H4 every Δ +0 pp [0, 0] vs both baselines; O5 one-step routed **60/60**, hash-mismatch 0; store invariants OK (0 duplicate screens, 0 multi-destination edges), `com.android.settings` **10 nodes / 9 edges**, three stores; **`skippedNoIdHash` 0** (34813849446: 0; 34853156073: 2; 34840929610: still unrecorded). Back at the reference. **Run with `input-manager` as the injector** — the open configs inject through the flipped default." | n = 155 steps/config, 100 runs, 20 task clusters |
| Process row                                                                                      | "Run 34870686468, attempt **1**, head `bb3fbddf`, `workflow_dispatch`, `suite=both`, `sg_mode=matrix`. Conclusion `failure`: the sole failing step is **#20 `Enforce device-test result`** (the 3m.1 residual gate); step #14 reports success despite one failed test, so a device-test failure is only visible through step 20. Screen-graph job success. Five latency blocks, three self-orchestrated by `run-bench.js` (no `workflow` OAuth scope); per-block logs staged for every arm. `gates.test.js` 26/26."                                                                                                                                                                        | —                                                |

**Must wait / must not enter:**

- **Any fling ratio, verdict or arm label from this run**, including `ON-uia-A` / `ON-uia-B`.
  The two "UiAutomation" control arms ran `input-manager` (3N1-H1). The fling status row
  stays pinned to **34813849446**, status **OPEN**, no new numbers. The only sentence this
  run may add: _"a pre-registered same-code A/B instrument control was run; it did not
  reproduce itself within ±0.15 on one of four informative cells (0.509 vs 0.361 at
  400 ms/0.5, permutation p = 0.19), so no arm was graded — and the control arms were
  subsequently found to be mislabelled."_
- Any "`input-manager` beats proprietary on the headline / `tap+describe`" claim (3N1-H4).
- Any durable-capability wording ("`input-manager` is faster than the proprietary driver")
  — one run, one image, one emulator. The swipe/pinch wins may enter as **this run's**
  numbers with CIs, as above.
- Any "scrcpy removed" row — no removal has shipped.
- Any `skippedNoIdHash` trend line that names 34840929610 — its value is still not recorded
  anywhere.
- Any statement that the screen-graph job is unaffected by 3n (3N1-H3).

## Conditions for 3n.2 (scrcpy removal)

**Blocking, before the removal PR is written:**

1. **Fix the default-flip leak in the fling harness** — `bench-fling-fidelity.ts:249-250`
   and `:337-341` must set `ARGENT_OPEN_INJECT_STRATEGY = "default"` for the uia arms, not
   delete it. Add a unit test that asserts the uia arm's resolved strategy is `undefined`
   (no `inject` on the wire) and the input-manager arm's is `"input-manager"`, so the next
   flip cannot silently re-break it. The same audit must cover **every** caller that
   assumes "env unset = old default": `bench-screen-graph.ts` (currently unset → now
   input-manager, 3N1-H3) and any tool-server entry point.
2. **Correct the 3n.1 Result's P2 row** to state the 1 ms miss against the pre-registered
   inequality and the planner's acceptance, and correct the CI labels (3N1-M1) and the
   screen-graph attribution sentence (3N1-H3). Docs-only; no re-run.
3. **Decide the `niGate` rule explicitly** (`scoreboard.js:258-266`): either the
   pre-registered point inequality, or a correct non-inferiority test on the CI **upper**
   bound, written down before 3n.2's run. Not the current lower-bound rule.

**What the removal PR must KEEP:**

- **The `default` / `uia` sentinel and the whole Kotlin `DEFAULT` path.** It is the P0
  control arm, it is what `uia-async` fallback degrades toward, and it is the only way to
  measure "did the flip change anything" in future runs. Removing scrcpy must not remove
  the ability to run `ON-uiautomation`.
- **The `uia-async` automatic fallback and its reporting** (`strategy:"unavailable"`,
  `fellBackTo`, `injectError`, the `unavailable` counter and its denominator split).
  `input-manager` availability is proven on one image and, per 3N1-M5, only through the
  **legacy** `InputManager.getInstance()` holder — the fallback is the portability story.
- **The `_forceInjectUnavailable` benchDebug seam and its device case**, extended to
  `swipe`/`gesture` (3N1-L1), since after removal the fallback is the only remaining safety
  net.
- **A control arm in the run.** `ON-uiautomation` stays; only `ON-scrcpy` goes.
- Removal scope otherwise as the 3n ticket lists it (`@yume-chan/*`, the postinstall,
  `scrcpy-inject-backend.ts`, `scrcpy-inject-timeline.ts` + tests, the fast-inject flag,
  the workflow's fetch/pump steps, `fastInjectFallbacks`), plus the docs pages the project
  CLAUDE.md requires, plus `npx docusaurus build` in `packages/docs/` and `npm run format`
  at the root.

**Pre-registered gates 3n.2's run should carry (and only these):**

> **Phase 3n.2 — pre-registered acceptance. Base: `open/main` @ \<sha\> with 3n.1 merged.
> Blocks: `OFF-1, ON-uiautomation, ON-input-manager, OFF-2` (no scrcpy arm). N = 20 per
> verb per block. Every gate is graded against the PROPRIETARY blocks at the measured
> `|OFF-1 − OFF-2|` floor, with a 10 000-draw bootstrap 95 % CI on the p50 difference
> reported for every Δ. The decision rule is the point inequality; the CI is reported, not
> substituted for it.**
>
> **Q1 — nothing changed vs 34870686468.** For `gesture-tap`, `gesture-swipe`,
> `gesture-pinch` and `tap+describe(settle:false)`, `ON-input-manager`'s p50 is within
> `max(this run's measured floor, 34870686468's measured floor)` of its 34870686468 value.
> A verb outside that band is reported with its CI and blocks the removal.
> **Q2 — control unchanged.** `ON-uiautomation` present (else void) and within the same
> band of its 34870686468 values (86 / 306 / 346 / 480).
> **Q3 — vs proprietary.** `ON-input-manager` still at-or-better than the OFF blocks on
> swipe and pinch with the CI clear of the floor, and within 2 ms on tap.
> **Q4 — landing, fallbacks, echo.** First-attempt landing ≥ 95 % with the effect oracle on
> every block, oracle self-test passed, **0** `unavailable`, and the per-RPC counter reports
> `input-manager: n/n` on the input-manager block and `default: n/n` on the control, with
> the measured-RPC denominator stated alongside the process-wide one.
> **Q5 — device suite green, including the 3m.1 residual gate.** All 3n cases, the P9
> forced-fallback case (now on tap **and** swipe/gesture), and
> `|captureMs − Σ(stages)| ≤ 10` on both phases at 20 samples, with the new `infoMs` /
> `recycleMs` / `otherMs` stages emitted and the 20 per-sample residuals printed.
> **Q6 — screen-graph green.** Job green, store invariants OK, success and tokens reported
> per config with the H4 paired-cluster intervals, `skippedNoIdHash` reported alongside
> 34813849446 (0) and 34870686468 (0).
> **Q7 — nothing scrcpy remains.** No `@yume-chan/*` in any `package.json` or lockfile, no
> `scrcpy` postinstall, no scrcpy source/test file, no scrcpy step or block name in the
> workflow, and the bench refuses a `blocks` input naming a scrcpy arm.
> **Q8 — fling is NOT run and NOT gated.** The fling job is skipped or reported with the
> uia-arm fix landed; either way it issues no verdict. Fling status stays OPEN pending
> ticket 3o (metric repair).
>
> **Acceptance is Q1–Q7 all green.** A Q1/Q2 miss means the removal changed behaviour and
> must be explained before merge.
