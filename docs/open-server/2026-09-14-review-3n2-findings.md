# Adversarial review — phase 3n.2 (scrcpy removal + residual-gate repair + scoreboard rewrite), CI run 34888577404

Review of branch `feat/open-server-3n2-remove-scrcpy` @ `354ecc38` before merge into
`open/main`. Read-only on code; nothing in the branch or the worktree was modified.

## Reviewed + evidence

- Subject: 7 commits `9c09bc31`…`354ecc38` on `open/main` @ `775ae6fc`, worktree
  `/Users/heicg/Desktop/projects/argent-fork-wt-3n2`.
- Ticket + `## Result (3n.2)`:
  `docs/open-server/2026-09-14-open-server-phase3n2-remove-scrcpy.md` (worktree copy).
  Prior verdict / allowed wording / conditions:
  `docs/open-server/2026-09-14-review-3n1-findings.md:426-530` (main checkout).
- Run metadata (one `gh run view --json jobs`): run **34888577404**, attempt **1**, head
  **`377c0197`**, `workflow_dispatch`, conclusion **`success`**. Latency job 19:43:07 →
  20:20:35Z, all 19 steps success (step 19 `Enforce device-test result` present and green).
  Screen-graph job 19:43:08 → 21:30:11Z, all 15 steps success.
- Artifacts: the worktree has **no** `.bench-results/`, so `bench-latency` and
  `bench-screen-graph` were each downloaded once.
- Recompute: every p50 and every measured floor recomputed from
  `bench-block-*.json` `latencySamples`; every bootstrap CI recomputed independently in
  Python (10 000 draws, percentile method, own seed) against pooled-OFF, max(OFF) and
  min(OFF) separately; the screen-graph per-config success / tokens / nav split recomputed
  from `bench-sg-2026-09-14T19-51-14-817Z.json` `aggregates`.
- Local checks in the worktree: `node --test .github/bench-ci/gates.test.js` **15/15 pass**;
  `npx vitest run --maxWorkers=2 open-server-inject-strategy.test.ts
bench-gesture-parity.test.ts android-open-server-blueprint.test.ts` **25/25 pass**.
- Merge check: `git merge-tree --write-tree open/main feat/open-server-3n2-remove-scrcpy`
  → tree `bb8888ca…`, exit 0, **0 conflicts** (`open/main` @ `ada26126` added only three
  iOS docs since `775ae6fc`).

### Numbers that reproduce exactly

The whole 3n.2 verb table reproduces from the block JSONs: im tap **55**, swipe **267**,
pinch **318**, headline **279**, idle **297**, await-ui **36**; control 81 / 293 / 348 /
363 / 298 / 33; OFF-1 53 / 298 / 343 / 256 / 496 / 72 and OFF-2 53 / 297 / 342 / 280 /
497 / 75. Every measured floor reproduces (tap **0**, swipe **1**, pinch **1**, headline
**24**, idle 1, await-ui 3, describe 1, paste 233). Every CI in the Result reproduces:
tap vs max(OFF) Δ +2 CI **[1, 2.5]**, pooled **[1, 2]**; swipe pooled Δ −30.5 CI
**[−36.5, −25]**, min(OFF) Δ −30 CI **[−37, −21]**; pinch pooled Δ −24.5 CI
**[−30, −19]**, min(OFF) Δ −24 CI **[−31, −18.5]**. P5's three ratios reproduce
(1.090 / 0.996 / 1.041). The screen-graph row reproduces exactly from this run's JSON
(B1 100 · B2 100 · O1 **99** · O2 100 · O3 100 · O4 100 · O5 100; tokens 657 · 651 · 138 ·
54 · 627 · 21 · 21; navRouted **60/60**, hash-mismatch **0**, `skippedNoIdHash` **1**,
settingsGraph **10 nodes / 9 edges**). Device log: **Tests 21 passed (21)**, residual
after-tap median **1 ms**, idle **0 ms**, P9 on tap **and** swipe **and** gesture.

## VERDICT

**MERGE WITH FIXES.** The removal itself is clean, complete and safe: no `@yume-chan`
import survives anywhere in `packages/`, the fast-inject seam is gone from the host RPC
path, the P0 `default`/`uia` sentinel, the `uia-async` fallback and the
`_forceInjectUnavailable` seam are all kept and all exercised on-device, and every number
in the Result reproduces from the artifacts at the run's own floors. Part A is genuinely
done: the residual gate is repaired for the right reason (the two missing stages were
_measured_, not hidden — `otherMs` is deliberately NOT summed into `sumStages`, so the gate
is not tautological), the clocks are unified, `niGate` now grades the pre-registered point
inequality and prints `FAIL by <ms>` honestly, and the 3n.1 Result carries the corrections
the prior review demanded.

Three things must be fixed before or at merge, and one claim must be withdrawn:

1. **The renamed zero-fallback CI gate is now unfalsifiable** (3N2-H1). The scrcpy
   `fastInjectFallbacks` gate was renamed to `strategyFallbacks` but still reads a
   host-side log counter that 3n.2 made structurally zero. After this merge **no CI gate
   can fail on an `input-manager` → `uia-async` degradation** — the only remaining safety
   net after scrcpy is removed is reported in a note string and gated nowhere.
2. **`unit-tests.yml` will fail** (3N2-H2). It still runs `npm ci`, and the committed
   lockfile no longer matches `packages/tool-server/package.json`. The bench workflow was
   switched to `npm install` permanently to dodge this, with no revert planned.
3. **"the code paths are byte-identical" is false** (3N2-H3) for exactly the rows that are
   out of band. The gesture path _is_ comment-only-identical to the reference run — I
   verified it — but `StateHandler.kt` (the describe/state capture path, i.e. the headline
   and `describe` rows) changed substantively on this branch. The conclusion survives on
   better evidence than the Result gives; the justification must be rewritten.

Also: run 34888577404's `bench-screen-graph` artifact is contaminated with a foreign
execution's outputs (3N2-H4). The Result's Q6 numbers are nevertheless correct — they come
from this run's JSON — but "store invariants OK" is attested only by the foreign log.

Nothing here invalidates the removal, the run, or the promotion. Q3–Q7 hold on substance.

## Part A status

| item                                         | status                               | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1 — 3N1-H1 env-unset leak**                | **fixed by deletion + durable test** | `bench-fling-fidelity.ts` (the leaking harness) was deleted wholesale (`git diff 775ae6fc..354ecc38 --stat`: −554). `open-server-inject-strategy.test.ts:52-68` adds "strategy-arm contract": `default` → `undefined`, `input-manager` → `"input-manager"`. **Sentinel proven sent on-device**: `bench-log-ON-uiautomation.txt:6` `=== block ON-uiautomation (ON, inject=default) ===`; `bench-open-vs-proprietary.ts:1880` sets (not deletes) the env when `injectStrategy` is truthy; `bench-block-ON-uiautomation.json` `injectStrategy:"default"` and `injectStrategyReported: "default: 161/161 [counts {\"default\":161}]"` — the Kotlin DEFAULT branch counted every injection, so no `inject` key reached the wire.                                                          |
| **2 — 3N1-H2 / M1 / M4 gate honesty**        | **fixed, M1 only partially**         | Preamble restored verbatim (`…phase3n-…md` diff, "Every gate below is graded against the PROPRIETARY blocks…"). P2 row rewritten to "FAIL by 1 ms … planner-accepted". `scoreboard.js:240-268` now grades the point inequality and prints `FAIL by <ms> (Δ … > floor …, CI …)`; the retired `CI lo ≤ floor` rule is documented in the comment; P6 (`scoreboard.js:298-305`) also moved to the point inequality. **M1 is not finished** — see 3N2-M1.                                                                                                                                                                                                                                                                                                                                 |
| **3 — 3N1-H3 / M2 / M3 / M6 / M9**           | **fixed**                            | Screen-graph attribution inverted ("the O1–O5 open configs injected through `input-manager`… the earlier 'inert' claim is withdrawn"); 161 described as process-wide with the subset stated; P10 now carries per-config tokens `657/651/179/54/627/22/22`, H1 0.275× / H2 / H3 0.035×, H4 `+0 pp [0,0]`, O5 60/60; the M6 control regression (78→86 / 292→306 / 294→304) is stated in the Result; "reproduces run 1" now exempts the headline (400→372 on a 78 ms floor).                                                                                                                                                                                                                                                                                                            |
| **4 — residual gate (3m.2)**                 | **fixed, and honestly**              | `StateHandler.kt:196-200` (`recycleMs`), `:237-255` (`infoMs` over `DisplayReader.read` + `isKeyboardVisible`'s second window enumeration), `:279-289` (`otherMs = captureMs − Σ(named)`); every clock moved to `SystemClock.uptimeMillis()` (`:132-145`, closing 3N1-L2). The **second enumeration was NOT removed** — the comment says so explicitly ("accounts for the cost rather than removing it, so `captureMs` is unchanged"), which is why `captureMs` did not drop. `android-open-server.device.test.ts:1064-1092` keeps `otherMs` **out** of `sumStages`, so the residual is still a real leftover, not an identity. Run evidence (`logs/device-test.log:73-78`): idle residuals all 0/1, after-tap `[1,4,0,0,0,0,1,34,0,0,0,2,0,0,2,1,1,0,2,50]`, med 1, `infoMs` med 2. |
| **5 — 3N1-M5 wording + P9 on swipe/gesture** | **fixed**                            | `InputManagerInjector.kt:123-138` names the image, the denial of `InputManagerGlobal.getInstance()`, the legacy holder and why the fallback is kept. `JsonRpcHandler.kt:122-141` wraps `tap`, `swipe` **and** `gesture` in `withForcedInjectUnavail`; run proof in `device-test.log` (`tap … swipe … gesture strategy=unavailable fellBackTo=uia-async; reset → input-manager`).                                                                                                                                                                                                                                                                                                                                                                                                     |
| **6 — 3N1-M8 device-test step**              | **fixed**                            | `bench-open-vs-proprietary.yml`: `continue-on-error: true` removed from the device-test step; the bench step gained `if: ${{ !cancelled() }}` so diagnostics still upload; the `Enforce device-test result` step is retained (step 19, green this run).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Are the 3n.1 Result corrections honest?** Yes, with one residue. P2 "FAIL by 1 ms
(54 ≤ 53 + 0)" is exactly right and matches my recompute. The CIs are now named by
comparator for P2 ("[0, +1] vs pooled OFF", "vs the max(OFF) comparator: [−1, +1]") — both
reproduce. The screen-graph-ran-with-input-manager correction is correct. The residue is
P3/P4 (3N2-M1).

## Removal audit

`git diff 775ae6fc..354ecc38 --stat`: 45 files, +819 / −5524.

**Complete and safe.**

- **No `@yume-chan` import survives**: `grep -rn "yume-chan" packages --include=*.ts
--include=*.json` → nothing outside `package-lock.json`. `packages/tool-server/package.json`
  drops all six deps **and** `"postinstall": "fetch-scrcpy-server 3.3.1"`.
- **No live fast-inject seam**: `git diff -U0 bb3fbddf 377c0197 -- android-open-server.ts`
  shows the whole `if (fastInject === "scrcpy")` block (the `api.tap`/`api.swipe`/
  `api.gesture` monkey-patching, `fastInjectPending`, `fastInjectFallbacks`,
  `ScrcpyInjectBackend` import, `FastInjectBackend` type) deleted. The seam was gated on a
  flag that was off by default, so OFF / ON-uiautomation / ON-input-manager never entered it
  — that part of the Q1/Q2 defence is sound.
- **Flag removed outright**, not kept as a deprecated no-op (`flags.ts:73-83` deleted).
  Safe: `flags.ts:6-8` documents that "dropping a registry entry never errors on a
  flags.json that still contains it"; a stale user flag becomes silently inert. The Result
  never states which option was taken or why (3N2-M3).
- **`fastInjectFallbacks` renamed** to `strategyFallbacks` in `merge-blocks.js:191-206,250,282`
  — but in name only (3N2-H1).
- **Kept, as the review required**: the `default`/`uia` sentinel
  (`open-server-input.ts:43-51`), the `uia-async` fallback and its `strategy`/`fellBackTo`/
  `injectError` reporting, the `_forceInjectUnavailable` seam (now on three RPCs), and the
  `ON-uiautomation` control block (ran, `default: 161/161`, so P0 is satisfied and the run
  is not void).
- **`device-orientation.ts:34` is a comment, not a dependency.** It documents how the
  _proprietary_ `simulator-server` (Rust) rotates frames from "the scrcpy header's
  `display_orientation`" in its own `src/device_controller/android_device/video.rs`. That
  file imports only `./adb` and `./adb-server`; its consumers are
  `rotation-aware-capture.ts:9`, `android-devtools-rotation-peek.ts:3`,
  `screenshot-diff/index.ts:22`. Correctly left alone.
- **`bench-gesture-parity.ts` is still correct after stripping.** The removed
  `buildTapTimeline` import is replaced by an inlined `TouchAction = {Down:0, Up:1, Move:2}`
  (`:13-16`). Those values are the Android `MotionEvent.ACTION_*` codes and were also
  scrcpy's wire codes, so the relabelling in the comment is accurate and the emitted
  timelines are unchanged. Proven by the run: `bench-merged-…json` `tapTimelines` gives all
  four blocks `frameCount 2`, frames `[{0,0},{1,50}]`, `hasMoveFrame false`, and
  `assertTapTimelineParity` passed in the merge.

**Tests deleted — all scrcpy-specific, with two exceptions worth deciding on.**

- Device suite 23 → 17 `it()` blocks (vitest 27 → 21 tests). The six deleted cases are
  `fast-inject tap navigates (scrcpy DOWN/UP + flushInput)`, `fast-inject tap→describe lands
20/20`, `fast-inject pinch zooms (scrcpy multi-pointer)`, `fast-inject momentum-free
swipe`, `3k pacing — scrcpy delivered swipe duration (drift vs legacy)`, `fast-inject
coexists with the Kotlin instrumentation channel`. None covered non-scrcpy behaviour.
- Blueprint suite lost exactly two cases: **"folds the flush into the next read (no
  per-action flushInput RPC)"** and "falls back to the Kotlin channel on a scrcpy error and
  counts it". The first was the only coverage of **flush semantics**, and the host `flush`
  plumbing is _kept_ (`android-open-server.ts:955,962,997,1070`, `flushInput():` at `:463`)
  while `:319` now says "nothing on the host sets it" → see 3N2-M7. The second was the only
  coverage of host-side **input-drop / fallback reporting** → see 3N2-H1.
- `gates.test.js` 27 → 15 tests: the 12 removed are all `merge-fling:*` → see 3N2-M4.

**Lockfile.** `package-lock.json` still lists `@yume-chan/*` (50 occurrences) on the branch,
as the Result states. The claim that CI's install "regenerated it … and nothing else
changed" is **not verifiable from the artifacts** — neither artifact contains the install
log or the resolved lockfile, and my GitHub budget was one `gh run view` + the two
downloads. What _is_ verifiable: `package.json` no longer declares the postinstall, so
`fetch-scrcpy-server` cannot have run; and both install steps were green. Note in mitigation
that `npm install` with a lockfile present keeps existing resolutions for still-satisfied
packages, so the regen in the main checkout should be a small diff — but it must be read,
not assumed (see Post-merge steps).

## Gate status Q1–Q7 (recomputed)

| gate                                     | Result says                                   | recomputed                                                         | note                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1** vs 34870686468 (im)               | PARTIAL, explained                            | **PARTIAL, arithmetic correct**                                    | tap 55 vs 54, band max(0,0)=0 → **OUT by 1**; swipe 267 vs 263, band max(1,2)=2 → **OUT by 2**; pinch 318 vs 318, band 1 → **IN**; headline 279 vs 372, band max(24,78)=78 → **OUT by 15, faster**. All four reproduce. The pre-registration required each out-of-band verb to be "reported with its CI" — **no cross-run CI was computed** (3N2-M2).                                                                                                                      |
| **Q2** control unchanged                 | present, within-band FAILs                    | **present; FAILS on 5 of 5 bands**                                 | tap 81 vs 86 (band 0), swipe 293 vs 306 (band 2), **pinch 348 vs 346 (band 1, also out — the Result's prose covers it generically)**, headline 363 vs 480 (band 78), idle 298 vs 304 (band 1). Run is **not void** — `ON-uiautomation` ran (`default: 161/161`).                                                                                                                                                                                                           |
| **Q3** vs proprietary                    | swipe/pinch WIN, headline PASS, tap FAIL by 2 | **reproduces exactly**                                             | P2 **FAIL by 2** (Δ +2 > floor 0, CI vs max(OFF) **[1, 2.5]**, pooled [1, 2]); P3 **PASS/win** (min(OFF) Δ −30 CI [−37,−21]; pooled Δ −30.5 CI [−36.5,−25]); P4 **PASS/win** (min(OFF) Δ −24 CI [−31,−18.5]; pooled −24.5 CI [−30,−19]); P5 **PASS** (1.09/1.00/1.04 — "pooled" here is the mean of the two OFF p50s, 268, consistent with prior runs); P6 **PASS** (im faster on all four gated verbs).                                                                   |
| **Q4** landing / fallbacks / echo        | PASS                                          | **PASS on landing + echo; the "0 fallbacks" half is tautological** | Landing 40/40, 60/60, 60/60, 40/40 = 100 %, oracle pass, `firstTapNoEffect` 0 on every block, `locateVia` describe-only — all reproduce. Echo `input-manager: 161/161 [counts {"input-manager":161}]` and `default: 161/161` reproduce, **with no `unavailable` key in either counts map** — that is the real evidence. `strategyFallbacks: 0` in the merged JSON is not evidence of anything (3N2-H1). Measured-RPC denominator still not published as a number (3N2-M6). |
| **Q5** device suite + residual gate + P9 | PASS                                          | **PASS**                                                           | `Test Files 1 passed`, `Tests 21 passed (21)`, 22 result rows all PASS, `fallback=NO` throughout. Residual after-tap med **1**, idle **0**, stages `infoMs` 2 / `recycleMs` 0 / `otherMs` 1, 20 signed residuals printed. P9 on tap **and** swipe **and** gesture. 3n cases `ranAs == requested` for uia-sync / uia-async / input-manager + all three cadence cases.                                                                                                       |
| **Q6** screen-graph                      | PASS (O1 99/100, skippedNoIdHash 1)           | **PASS; numbers reproduce, one claim unattested**                  | Every figure reproduces from `bench-sg-…19-51-14-817Z.json`. H1 0.212× = 138/651 ✓, H3 0.033× = 21/627 ✓ — both computed from _this_ run, not from the artifact's stale report. **"Store invariants OK" is attested only by the foreign log** (3N2-H4). `skippedNoIdHash` 1 vs 0/0: see below.                                                                                                                                                                             |
| **Q7** nothing scrcpy remains            | PASS                                          | **PASS**                                                           | `blocksRan: [OFF-1, ON-uiautomation, ON-input-manager, OFF-2]`. No `@yume-chan` import, no postinstall, no scrcpy source/test file, no scrcpy workflow step, no `ARGENT_SCRCPY_PACING`. `bench-open-vs-proprietary.ts:2545-2548` throws on a `BENCH_ONLY` matching `/scrcpy/i`. The 16 remaining `scrcpy` hits are all comments/removal notes — verified file by file.                                                                                                     |

**Is "cross-run variance, not a removal effect" defensible?** **Yes on the gesture verbs,
and the Result under-argues it; no as written on the headline/describe rows.**

The mechanism check the Result asserts is half right. `git diff -U0 bb3fbddf 377c0197 --
.../input/ FlushInputHandler.kt HierarchyHandler.kt` yields **zero non-comment changed
lines** — the Kotlin injectors really are functionally identical to the reference run. The
host gesture path is too (the fast-inject wrapper only existed under the flag; the only
non-comment host change is the optional `_forceInjectUnavailable` key). But **StateHandler.kt
changed substantively** in the same diff (all stage clocks to `uptimeMillis`, two new timing
sections) — and that is the capture behind `tap+describe`, `describe`, `await-*`. So
"byte-identical" is false precisely where Q1 is furthest out of band (3N2-H3).

The stronger argument, which the Result does not make, is in the comparators' own movement:

| verb          | im 34870→34888  | ON-uia 34870→34888 | OFF-1 34870→34888 | OFF-2 34870→34888 |
| ------------- | --------------- | ------------------ | ----------------- | ----------------- |
| gesture-tap   | 54 → 55 (+1)    | 86 → 81 (−5)       | 53 → 53 (0)       | 53 → 53 (0)       |
| gesture-swipe | 263 → 267 (+4)  | 306 → 293 (−13)    | 305 → 298 (−7)    | 303 → 297 (−6)    |
| gesture-pinch | 318 → 318 (0)   | 346 → 348 (+2)     | 353 → 343 (−10)   | 354 → 342 (−12)   |
| describe      | 51 → 36 (−15)   | 48 → 34 (−14)      | 51 → 51 (0)       | 52 → 52 (0)       |
| tap+describe  | 372 → 279 (−93) | 480 → 363 (−117)   | 408 → 256 (−152)  | 486 → 280 (−206)  |

The **proprietary** OFF blocks — code we did not touch at all — moved −152 and −206 ms on
the headline row and −6…−12 ms on swipe/pinch. That is the decisive evidence that the
environment moved, and it is far better than "byte-identical". Two honest caveats the
Result should carry: (a) on all three gesture verbs `input-manager` is the only arm that
moved _against_ its comparators (tap +1 while OFF is flat, swipe +4 while OFF −6 and the
control −13, pinch 0 while OFF −11), so the margins eroded ~10 ms across the board — small,
same-signed on three verbs, and worth watching in 3o rather than dismissing; (b) `describe`
improved −15/−14 ms on **both** ON blocks while OFF is flat, which is an ON-side shift, not
symmetric noise (the plausible causes are the dropped fifth block and the StateHandler
change, neither measured).

**Q3 tap "FAIL by 2, CI [1, 2.5] — parity, planner-accepted": honest wording?** Yes. The
gate result printed by the tooling is `FAIL by 2` (I read it in the run's own
`scoreboard.md`), the CI is reproduced correctly, and "planner-accepted parity" is labelled
as an acceptance note rather than a PASS — exactly what 3N1-H2 demanded. One nuance the
scoreboard should not lose: the miss **doubled** (1 ms → 2 ms) between the two runs on a
0 ms floor, and the CI no longer contains 0 ([1, 2.5] vs the reference run's [−1, +1]).
"Parity in practice" is still fair at 2 ms; "unchanged" would not be.

**`skippedNoIdHash` 1 vs 0/0 — spread or regression?** Within spread, and the Result's
framing is right. The counter has read 0 (34813849446), 2 (34853156073), 0 (34870686468),
1 (this run) over four runs of the same harness — it is a per-run count of records whose
structural-hash node was never created, and this run also shows **0** hash-mismatch,
**60/60** one-step routing and clean store invariants in the same JSON, so nothing
downstream degraded. It is a single record. Keep reporting it; do not open a ticket.

## HIGH

**3N2-H1 — The renamed zero-fallback gate is structurally unfalsifiable; after this merge no
CI gate can fail on an `input-manager` → `uia-async` degradation.**
`merge-blocks.js:191-206` sums `verb.fallbacks` over the `ON-input-manager` block and throws
if the total is > 0. `verb.fallbacks` is produced by `fallbackCountSince()`
(`bench-open-vs-proprietary.ts:141-146`), which counts `console.debug` lines matching
`/\[open-server-fast-inject\].*falling back/`. 3n.2 deleted the only emitter of that string
— and the function's own comment now says so: _"the host-side fast-inject backend was
removed, so no `[open-server-fast-inject] … falling back` line is emitted any more and this
reads 0. The AUTHORITATIVE fallback signal is now on-device."_ So the gate's input is
constant 0 by construction; it passes on any run, including one where every injection fell
back. Its unit test (`gates.test.js`, "zero-fallback gate FIRES for ON-input-manager (3n.2
rename)") passes only because the fixture hand-writes `fallbacks: 3`. Meanwhile the
authoritative signal — `counts["unavailable"]` from `getInfo().injectStrategyCounts`,
`bench-open-vs-proprietary.ts:2433-2445` — is rendered into a **note string** and gated
nowhere; `grep -n "unavailable" .github/bench-ci/merge-blocks.js` returns only a comment
(`:197`). Consequence for this run: Q4's "0 `unavailable` fallbacks (`strategyFallbacks` 0)"
is a tautology. The run is still clean — `counts` is literally `{"input-manager":161}` with
no `unavailable` key — but that is the block JSON talking, not a gate. Fix: point the gate
at `injectStrategyCounts["unavailable"]` (and at a missing/zero denominator), and keep a
test that fires on a synthetic `{"input-manager":150,"unavailable":11}`.

**3N2-H2 — `unit-tests.yml` still runs `npm ci` against a lockfile that no longer matches
`package.json`; the bench workflow's escape hatch is permanent.**
`unit-tests.yml:26` is `npm ci`, and it triggers on `push`/`pull_request` to `main`
(`:3-9`). `packages/tool-server/package.json` dropped six `@yume-chan/*` deps and the
postinstall; `package-lock.json` still lists them (50 occurrences). `npm ci` fails its
out-of-sync check on exactly this state — which is why
`bench-open-vs-proprietary.yml:203-210` and `:531-534` were switched to `npm install` with
the comment "`npm ci` would fail its out-of-sync check". Nothing on the branch reverts
that, so the bench workflow permanently loses the lockfile-integrity guarantee, and
`unit-tests.yml` breaks the moment anything targets `main`. It was not exercised on this
branch (only the bench workflow was dispatched), so the breakage is silent today. Fix:
regenerate the lockfile in the main checkout and revert both `npm install` back to `npm ci`
in the same commit.

**3N2-H3 — "the ON-input-manager and ON-uiautomation code paths … are byte-identical" is
false for the describe/state capture path, which is exactly where Q1 is furthest out of
band.** `git diff --stat bb3fbddf 377c0197 -- packages/android-device-server/.../handlers/
.../input/ open-server-input.ts android-open-server.ts` shows `StateHandler.kt` at
**+59 / −15**, and `git diff -U0` confirms those are real code lines, not comments: every
stage clock moved from `System.currentTimeMillis()` to `SystemClock.uptimeMillis()`
(`:132-145, 178-181, 199-203, 217-221, 263-277`), plus two new timing sections and a new
`otherMs` computation. `captureMs` itself is now measured on a different clock than in the
reference run. That is the code behind `tap+describe(settle:false)` (−93 ms, the row the
Result flags as "OUT by 15") and `describe` (−15 ms on both ON blocks). The gesture verbs
_are_ comment-only-identical and the claim holds there. Fix the sentence: keep "the removed
scrcpy seam never ran on these blocks" (true, and verifiable), drop "byte-identical", and
replace it with the comparator-movement table above — the proprietary OFF blocks moving
−152 / −206 ms on the same row is the real proof.

**3N2-H4 — Run 34888577404's `bench-screen-graph` artifact is contaminated with a foreign
execution's outputs; `results-ci.md` and `sg-matrix.log` in it describe a different run.**
The job started **19:43:08Z** and ended **21:30:11Z** (`gh run view --json jobs`). The
artifact contains two bench JSONs: `bench-sg-2026-09-14T19-51-14-817Z.json`
(`finishedAt 21:30:05.917Z`, `skippedNoIdHash 1`, settingsGraph 10/9) — this run — and
`bench-sg-2026-09-14T14-11-46-409Z.json` (`finishedAt 15:51:55.519Z`, `skippedNoIdHash 2`,
settingsGraph **11/10**) — finished nearly four hours _before_ the job began. The staged
`logs/sg-matrix.log` is 203 lines and every one of its 170 timestamps is `14:xx`; it ends
`[bench-sg] wrote … bench-sg-2026-09-14T14-11-46-409Z.json / store invariants OK / wrote
report … results-ci.md`. `results-ci.md` is stamped `Generated 2026-09-14T15:51:55.594Z` and
reports B2 **97/100**, O3 99, O4 98, O5 98, one-step **58/60**, hash-mismatch 2,
`skippedNoIdHash` 2 — i.e. the foreign run's numbers. The staged `graph-store/
com.android.settings/34.json` has **11 nodes / 10 edges**, the foreign value, not the 10/9
the Result publishes (`gh` also errored on a duplicate zip entry for that path, so the zip
carries two copies). Consequences: (a) anyone auditing the published report for this run
gets the wrong screen-graph numbers; (b) Q6's "store invariants OK (0 duplicate screens,
0 multi-destination edges)" is attested **only** by the foreign log — this run's invariant
output is not in the artifact. The Result's quoted figures are nonetheless correct, because
they come from the fresh JSON (I reproduced all of them). The mechanism is not explained by
the workflow as written (`Stage screen-graph artifacts` does `cp -r .bench-results` from the
workspace; there is no cache or artifact-download step, and `.bench-results/` is
gitignored). This is **not** a 3n.2 regression — the staging step is unchanged — but it must
be diagnosed before 34888577404 is cited as an evidence base, and the planner should confirm
"invariants OK" from the run's job log (one `gh run view --log`, outside my budget).

## MEDIUM

**3N2-M1 — 3N1-M1 is only half fixed: P3/P4 still pair one comparator's Δ with another's
CI.** In the 3n.1 Result table, P3 reads "im 263 vs min(OFF) 303 … Δ −40, CI **[−45,−34]**"
and P4 "Δ −35, CI **[−43,−34]**" — but those CIs are the **pooled-OFF** intervals; the
min(OFF) intervals are [−45.5, −30] and [−45, −33.5] (3N1-M1's own numbers, which I
re-derived). The same relapse is in the 3n.2 verb table: "swipe −30.5 vs min(OFF) → WIN, CI
[−37, −25]" and "pinch −24.5 vs min(OFF)". Recomputed for this run: **min(OFF): swipe Δ −30,
CI [−37, −21]; pinch Δ −24, CI [−31, −18.5]. Pooled: swipe Δ −30.5, CI [−36.5, −25]; pinch
Δ −24.5, CI [−30, −19].** The run's own `scoreboard.md` prints the min(OFF) pair correctly
in the P3/P4 bullets; the docs quote the pooled pair under a min(OFF) label. Either label
the comparator "pooled" or quote the min(OFF) CI. (P2 is correct in both documents.)

**3N2-M2 — Q1/Q2's pre-registration required a CI for every out-of-band verb; none was
computed.** The pre-registration says "A verb outside that band is reported with its CI and
blocks the removal." Seven verb/arm combinations are out of band (Q1 tap/swipe/headline, Q2
tap/swipe/pinch/headline/idle) and none carries a cross-run bootstrap CI on the
34870686468 → 34888577404 p50 difference. The per-sample arrays exist in both runs'
artifacts, so this is computable; it is also the only quantitative way to say whether a
+4 ms swipe move is noise. (I could not compute it inside my artifact budget — it needs
34870686468's block JSONs.) Either compute the seven CIs or amend the wording to say the
band test was graded on point estimates only.

**3N2-M3 — The `## Result (3n.2)` does not contain three of the sections the ticket
requires.** The ticket asks for "commits, **Part A finding-by-finding**, **what was removed
and kept**, run id, Q1–Q7 …, **docs touched**, lockfile status". The Result has commits,
Q1–Q7, the verb table, device/SG outcomes and lockfile status; it has **no** per-finding
Part A walkthrough, **no** removed/kept inventory, and **no** docs statement. Specifically
missing and required elsewhere: (a) the ticket's "say which and why" about the
`open-device-server-fast-inject` flag — it was removed outright, not kept as a deprecated
no-op, and the reason (registry entries are advisory; `flags.ts:6-8`) is not written down;
(b) the project `CLAUDE.md` rule "if no docs update is needed, say so" — I verified no page
under `packages/docs/` mentions scrcpy, the fast-inject flag or any sub-flag, so "no docs
change needed" is _true_, but it must be stated, along with "`npx docusaurus build` /
`npm run format` were not run in the worktree".

**3N2-M4 — The whole fling harness was deleted, beyond the ticket's removal list, and the
Result says only "fling not run".** Removed: `bench-fling-fidelity.ts` (−554),
`merge-fling.js` (−484), `run-fling.js` (−62), the fling rendering in `scoreboard.js`, the
**12** `merge-fling:*` cases in `gates.test.js` (27 → 15 tests), and **seven archived fling
block fixtures** for runs `33975063607` and `34800933407` (−1119 lines). Two of the deleted
tests pinned the pre-registered rule against those real runs ("stays RED on run
33975063607", "3 PASS / 3 non-informative on run 34800933407"). The ticket's Part B list
covers "the workflow's scrcpy fetch/pump steps and the `ON-scrcpy` block/arm,
`ARGENT_SCRCPY_PACING` and the `legacy`/`drift` pacing code" — not the OFF/uia arms, the
harness, the fixtures or the rule tests. The call is defensible (the gate rule is
scrcpy-vs-uia by construction and fling is deferred to 3o), but it must be stated in the
Result so ticket 3o knows it starts from `775ae6fc` in git history rather than from a
working harness.

**3N2-M5 — The doc comment that caused 3N1-H1 is still wrong, on the surviving file.**
`open-server-input.ts:31-38` still reads "Unset / unknown → undefined = today's behaviour
(a tap's async UP, a swipe/gesture's blocking UP), and the `inject` param is omitted". The
code 13 lines below (`:51`) returns `"input-manager"` for unset/unknown; only the `default`/
`uia` sentinel returns `undefined` (`:50`). The corrected paragraph at `:43-50` contradicts
the header without deleting it. This is the exact stale-after-flip sentence that produced
3N1-H1, left in the one file every future harness will read.

**3N2-M6 — Q4's measured-RPC denominator is still not a number.** The review and the ticket
both ask for "the measured-RPC denominator stated alongside the process-wide one". The
Result says "the measured gated tap/swipe/gesture RPCs are a subset (20 per gated verb)" and
the scoreboard says "measured gated RPCs a subset of the 161 process-wide" — neither states
the total (3 gated inject verbs × 20 = 60, or 100 across five measured verbs, depending on
what counts). Write the arithmetic once: 161 = N measured + warmups + oracle +
locate/restore, with N spelled out.

**3N2-M7 — The `flush` / `flushInput` host seam is kept with zero producers and zero
tests.** `android-open-server.ts:319` now says "since the scrcpy fast-inject seam was removed
(phase 3n.2) nothing on the host sets it", yet the option is still threaded at `:955, :962,
:997, :1070` and `flushInput()` is still on the API at `:463`, while the only test that
covered the semantics ("folds the flush into the next read (no per-action flushInput RPC)")
was deleted. The Kotlin side is _not_ dead — `HierarchyHandler.kt:51` and
`StateHandler.kt:126` still call `MotionInjector.flushInput` — so the on-device code is
exercised; it is the host option that is now unreachable and unverified. Decide explicitly:
delete the host `flush` option, or restore a unit test asserting `flush:true` produces
`flush` on the wire.

**3N2-M8 — The README's "Execution order" omits iOS-1.** `open/main` @ `ada26126` ships
`2026-09-14-ios-phase1-runner-on-contract.md`, `2026-09-14-ios-open-driver-spec.md` and
`2026-09-14-ios-open-driver-research.md`, but the branch was cut at `775ae6fc` and its
rewritten README lists only 3n.2 → 3o → Artemis → phase E → AndroidWorld → Release.
`git merge-tree` reports **no conflict** (the iOS commits did not touch README.md), so the
omission lands silently and the index will contradict the repo's own tickets.

**3N2-M9 — "headline 93 ms FASTER" omits that the open stack lost ground on that row
relative to proprietary.** The Result and the scoreboard's 3n.2 row present the headline as
an improvement (372 → 279) and as P5 PASS. Both true. But the ratio moved
**0.91 / 0.77 / 0.83 → 1.09 / 1.00 / 1.04**: on 34870686468 `input-manager` was 17 % below
the pooled proprietary comparator on the headline; on 34888577404 it is 4 % above it. The
gate is a ≤ 1.15 non-inferiority band and it passes, so nothing is mis-graded — but a
reader of "93 ms faster" will draw the opposite conclusion from the one the data supports.
One sentence fixes it.

## LOW

**3N2-L1 — The scoreboard publishes `?` placeholders.** The 34870686468 verb table renders
`describe | 51/? | 48/? | 51/? | ? | 52/?`. Those p95s exist in that run's artifact. Either
fill them or drop the p95 column for that row.

**3N2-L2 — "all 22 device cases PASS" vs `Tests 21 passed (21)`.** The result table prints
22 rows (pinch and rotate share one `it()`, `ping` has no own test); vitest counts 21.
Harmless, but the scoreboard's device row should say "21 vitest cases / 22 reported checks".

**3N2-L3 — The repaired residual gate passes at the median while the tail is still
unaccounted.** After-tap signed residuals this run: `[1,4,0,0,0,0,1,34,0,0,0,2,0,0,2,1,1,0,
2,50]` — two samples at 34 ms and 50 ms. The median is 1 and the gate is on the median, so
it passes honestly, but ~10 % of captures still hide tens of milliseconds outside every named
stage. Worth a `max`/p95 line in the printout (not a gate) so the next regression is visible.

**3N2-L4 — Vestigial symbols from the removal.** `bench-gesture-parity.ts:76` still declares
`fastInject?: boolean` on `assertTapTimelineParity`'s parameter type although nothing sets
it; `TouchAction.Move` is now unused in `bench-gesture-parity.ts` and the constant is
duplicated verbatim in `test/bench-gesture-parity.test.ts:5-9`.

**3N2-L5 — `bench-screen-graph.ts` still relies on "env unset ⇒ the default".** It sets no
`ARGENT_OPEN_INJECT_STRATEGY` anywhere (the only writer in the tree is
`bench-open-vs-proprietary.ts:1880`), so O1–O5 inject through whatever the default happens
to be. That is correct today and the 3n.1 Result now says so — but it is the same
assumption that produced 3N1-H1, left unpinned in the one surviving harness. Pin
`"input-manager"` explicitly, or assert the resolved strategy into the run env block.

**3N2-L6 — 3N1-L1's second half is unaddressed.** `InputManagerInjector.forceUnavailableForTest`
is still a process-global `@Volatile` set around the handler call
(`JsonRpcHandler.kt:127-141`) while `DeviceControlInstrumentation` builds a second handler
on a second socket, so a concurrent connection would also be forced. Unreachable in
production (`benchDebug` start arg) and not exercised concurrently; now covered on three
RPCs instead of one, which is the part that mattered.

## Scoreboard / README corrections (exact wording)

Every allowed row from `2026-09-14-review-3n1-findings.md:426-465` is present and
substantively verbatim: the tap / swipe / pinch / headline bullets, No-regression (P6),
First-attempt landing, Strategy echo, availability, Forced-fallback (P9), Device-test
outcome, Screen-graph and Process rows all reproduce the review's sentences, including the
"`34840929610`: still unrecorded" parenthetical and the "No 'more reliable than scrcpy'
wording" clause. The fling row is pinned to **34813849446**, status **OPEN**, no new
numbers, and carries the one permitted sentence. The superseded 34813849446 section is
preserved intact with its own rows. Nothing forbidden entered: no fling ratio or arm label
from 34870686468, no "beats proprietary on the headline", no durable-capability wording, no
"scrcpy removed" row in the _reference_ section, no `skippedNoIdHash` trend line naming 34840929610.

Four edits:

1. In the 3n.2 row, replace
   `**Q1/Q2** … NOT a behaviour change — the ON-input-manager and ON-uiautomation paths
never used the scrcpy seam and are byte-identical.`
   with
   `**Q1/Q2** (reproduction of 34870686468 within the measured band): pinch reproduces
(318 = 318); tap (55 vs 54), swipe (267 vs 263) and the headline (279 vs 372, faster)
exceed a near-zero band. The removed scrcpy seam never ran on these blocks (it was
gated on the fast-inject flag), and the Kotlin injectors and the host gesture path are
unchanged from `bb3fbddf` — but the describe/state capture path (`StateHandler.kt`) DID
change in 3n.2 (stage clocks unified, `infoMs`/`recycleMs`/`otherMs`added), so the
headline and`describe`rows are not code-identical across the two runs. The decisive
evidence is the untouched proprietary comparator: OFF`tap+describe` moved 408→256 and
486→280, and OFF swipe/pinch moved −6…−12 ms, over the same interval. Cross-run
environment movement, not a removal effect; no cross-run CI was computed.`
2. In the same row, after `headline P5 PASS (1.09/1.00/1.04)`, add:
   `— note the ratio moved 0.91/0.77/0.83 (34870686468) → 1.09/1.00/1.04 here, so the
open stack lost ground on the headline relative to proprietary even though its absolute
p50 improved 93 ms; P5 is a non-inferiority band, not a win.`
3. In the same row, replace `**Q4** … **0** `unavailable` fallbacks` with
   `**Q4** landing 100 % every block, oracle passed, on-device `injectStrategyCounts`=`{"input-manager":161}`/`{"default":161}`with **no**`unavailable`key (the CI`strategyFallbacks` counter reads 0 by construction after 3n.2 and is not evidence —
see 3N2-H1)`.
4. In the same row, qualify Q6: after `invariants OK`, add
   `(store-invariant line read from the job log; the uploaded `results-ci.md`/`sg-matrix.log`/`graph-store` in this run's artifact belong to a different execution
— 3N2-H4)`.

README: add iOS-1 to "Execution order" between items 1 and 2 —
`2. **iOS-1 — open iOS server on the Android contract** (`2026-09-14-ios-phase1-runner-on-contract.md`,
spec `2026-09-14-ios-open-driver-spec.md`, research `2026-09-14-ios-open-driver-research.md`);
simulator CI first.` — and renumber. In "Where things are", change `Working branch:
open/main @ 775ae6fc` to the post-merge sha and mention the iOS docs. Everything else in the
README (reference runs, scrcpy gone, fling pinned to 34813849446, 3o / Artemis / phase E)
is correct as written; item 1's post-merge instructions are correct and should additionally
name the `npm install` → `npm ci` revert.

## Post-merge steps

1. **Regenerate the lockfile in the MAIN checkout**: `npm install` at the repo root, commit
   `package-lock.json`. **Read the diff before committing.** Risk of unrelated bumps is
   low but real: with a lockfile present npm keeps existing resolutions for packages whose
   ranges are still satisfied, so the expected diff is the `@yume-chan/*` subtree plus the
   transitive packages unique to it. Anything else that moves must be restored (or the
   regen redone with `--prefer-offline` / from a clean `node_modules`), because the repo's
   `^`-ranged deps would otherwise float silently under cover of this change.
2. **Revert `npm install` → `npm ci`** in `.github/workflows/bench-open-vs-proprietary.yml`
   (both jobs, ~`:210` and ~`:534`) in the **same commit** as the lockfile, and delete the
   two "npm ci would fail its out-of-sync check" comments. Otherwise CI permanently loses
   the lockfile-integrity check (3N2-H2).
3. **Prove `unit-tests.yml` green** on the merged state: `npm ci`, `npx tsc --build`,
   `npm test --workspaces`, `node --test .github/bench-ci/gates.test.js` (expect **15**
   tests). This workflow was never exercised on the branch.
4. **Fix 3N2-H1 before the next bench run**, or the next run's "0 fallbacks" is meaningless:
   gate `merge-blocks.js` on `injectStrategyCounts["unavailable"]` from the block JSON and
   add a `gates.test.js` case that fires on `{"input-manager":150,"unavailable":11}`.
5. **Docs**: `npx docusaurus build` in `packages/docs/` and `npm run format` at the repo
   root (project `CLAUDE.md`). No docs-site page needs content changes — verified: no file
   under `packages/docs/` mentions scrcpy, `@yume-chan`, `open-device-server-fast-inject`
   or any sub-flag. State that explicitly in the PR description.
6. **Apply the four scoreboard edits and the README iOS-1 insertion** above; append the
   missing Result sections (3N2-M3) — Part A finding-by-finding, removed/kept inventory,
   the flag decision and its reason, docs statement.
7. **Diagnose 3N2-H4** with one `gh run view 34888577404 --log` against the screen-graph
   job before anyone cites that artifact again, and confirm this run's own "store
   invariants OK" line.
8. **Remove the worktree**: `git worktree remove ../argent-fork-wt-3n2 [--force]` and
   `git worktree prune` (resource policy §3).
