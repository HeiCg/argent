# Adversarial review — phase 3m (fingerprints opt-in / no rebuild on the capture path) and CI run 34827025184

Reviewed 2026-09-14 (read-only on code; this file is the only write).

## Reviewed + evidence

- Branch `fix/open-server-fingerprints-opt-in` (bd7c5776, bbd97b65, 684a0ed1) on top of
  `open/main` @ aff6f45a, worktree `/Users/heicg/Desktop/projects/argent-fork-wt-3m`.
  Ticket + `## Result`: `docs/open-server/2026-09-14-open-server-phase3m-fingerprints-opt-in.md`
  (in the worktree); root cause `2026-09-14-tap-describe-loss-root-cause.md`.
- Kotlin read twice: `TreeStore.kt`, `StateHandler.kt`, `HierarchyHandler.kt`,
  `JsonRpcHandler.kt`, `QueryHandler.kt`, `DiffHandler.kt`, `AwaitChangeHandler.kt`,
  `accessibility/ScreenTree.kt`, `accessibility/AxRecords.kt`.
- Host: every caller of `getState` / `getNestedState` / `getAccessibilityTree` grepped
  (`packages/tool-server/src`, `packages/tool-server/scripts`) and each hash/version
  consumer traced.
- Artifacts recomputed from JSON/logs: run **34827025184** (`bench-latency`,
  `bench-screen-graph`) and reference run **34813849446** (`bench-latency`), downloaded to
  a scratch dir. Per-verb p50/p95/n/min/max, ping, describe stage splits, fling grid and
  gate, screen-graph store and `sg-matrix.log` all recomputed; nothing below is quoted
  from the `## Result` without an independent recompute.
- `npx vitest run --maxWorkers=2 test/android-open-server-blueprint.test.ts` in the
  worktree: **9 passed**, including the new opt-in wire-shape test.
- Merge check: `git merge-tree --write-tree open/main fix/open-server-fingerprints-opt-in`
  → tree `71985a0f`, exit 0, **no conflicts** (the one file both sides touch,
  `packages/tool-server/test/blueprints/android-open-server.device.test.ts`, merges clean).

## VERDICT

**REJECT for closure as written; the code change is directionally right but the run does
not prove it and one regression is real.**

Contracts 1, 3, 4 (server-side), 5 are met and device-verified. Contract 2 is met in the
literal sense (no `rootInActiveWindow` on the capture path) but its side effect broke
Contract 6: run 34827025184's screen-graph store **failed the phase-D.3 invariant** with a
multi-destination edge whose second destination is a node minted from an **empty tree**
(`structuralHash == stateHash == cbf29ce484222325`, the documented `EMPTY_TREE_HASH`).
That is the first invariant failure in the documented record and the `## Result`'s
"Contract 6 — Screen-graph matrix: PASS / SG job green" is contradicted by the run's own
artifacts.

The headline is also not established. The −267 ms `tap+describe(settle:false)` move
appears **only on the scrcpy arm**; the uiautomation arm moved −30 ms, inside its own
57 ms drift floor. A server-side fix must move both arms. The one thing that differs
between the arms is the tap injection path — and this branch predates the 3k.1 merge, so
its scrcpy pacing default is `drift` while the reference run 34813849446 ran `legacy`.
The comparison is not like-for-like.

Fix the SG regression, rebase onto `open/main` @ a75ad75d (so pacing default, fling gate
and device-test suite match the reference base), re-run, and re-review.

## Contract status

| # | Contract | Status | Evidence |
|---|---|---|---|
| 1 | Fingerprints opt-in on read RPCs; `version` always; absent ≠ empty | **MET (server), PARTIAL (host)** | `StateHandler.kt:100-104,266-277`, `HierarchyHandler.kt:33-35,112-120`; device test `logs/device-test.log:75` ("opt-out hash absent, opt-in hash present"); unit test `test/android-open-server-blueprint.test.ts` (9 passed locally). Partial: `unchanged`/`version` semantics changed (3M-H4); `HierarchyHandler` refuses fingerprints for `nested` while `StateHandler` allows them (3M-L2) |
| 2 | Nothing on the capture path calls `rootInActiveWindow`; fingerprint rebuild reuses the capture root | **MET, with a harmful side effect** | `TreeStore.kt:171-186` (`ownsRoot` guard, no recycle of `providedRoot`); `StateHandler.kt:193-197`; device test `rootSource=windows`. Side effect: the identity hash now comes from the windows-snapshot root, which can be an empty/transient frame → 3M-H1 |
| 3 | New `fingerprintMs` stage; device test asserts `|captureMs − Σ(stages)| ≤ 10` idle and after-tap | **MET** | `StateHandler.kt:251-252`, `HierarchyHandler.kt` timings; device test: idle residual med **1 ms**, after-tap med **6 ms** (`logs/device-test.log:75`). The bench p50-proxy (+102/+39) is not a residual — see 3M-M5 |
| 4 | Lazy `armClock()`; `getInfo().traversals` exposed; 1 traversal after tap | **MET on device, weak as evidence** | `TreeStore.kt:109-125` (correct double-checked locking), arm sites `StateHandler.kt:104`, `HierarchyHandler.kt:35`, `QueryHandler.kt:22`, `DiffHandler.kt:18`, `AwaitChangeHandler.kt:34`, `JsonRpcHandler.kt:213`; device test traversals delta 1. "was 2" was never measured (3M-L1); the lazy arm introduces a lost-wakeup window (3M-H5) |
| 5 | versionCode 26 / versionName 0.1.22, manifest in sync | **MET** | `packages/android-device-server/build.gradle.kts` and `assets/manifest.json` both 26 / 0.1.22 |
| 6 | Screen-graph configs unaffected; success and tokens within run-spread | **NOT MET** | Store invariant FAILURE, `bench-screen-graph/logs/sg-matrix.log:199-200`; empty-tree node in `graph-store/com.android.settings/34.json`; `skippedNoIdHash` 1 (every documented prior run: 0). Tokens/success themselves ARE within spread (3M-L7) |

## HIGH

### 3M-H1 — the screen-graph store invariant FAILED, and an empty tree was minted as a screen

Run 34827025184, `bench-screen-graph/logs/sg-matrix.log:199-200`:

```
[bench-sg] STORE INVARIANT FAILURE (phase D.3):
  com.android.settings/34: edge "284ef0302b28c5de taptext=Internet" has 2 destinations: af75c426f98239d2, b2fbe9151b60b485
```

Inspecting the store (`.bench-results/screen-graph/graph-store/com.android.settings/34.json`),
the second destination `b2fbe9151b60b485` has `index: {}`, `visits: 1`,
`structuralHash: "cbf29ce484222325"` and `stateHash: "cbf29ce484222325"` — that value is
`TreeStore.EMPTY_TREE_HASH` (`TreeStore.kt:24-30`, the bare FNV-1a offset basis for a
zero-node forest). The graph recorded a **transient empty frame as a destination screen**
for the `taptext=Internet` edge, which is exactly the D.1 "ambiguous target" failure mode
the H_id keying was introduced to kill.

Every documented prior run has `skippedNoIdHash` 0 and "store invariants OK: 0 duplicate
screens, 0 multi-destination edges" — `2026-09-03-scoreboard.md:128`,
`2026-09-14-review-3k1-findings.md:272,462`, `2026-09-13-screen-graph-phase-d4-results-ci.md:87,245`,
`2026-09-14-review-d4-1-findings.md:274`. This run also reports `skippedNoIdHash` **1**
(`results-ci.md`, Environment table) — also a first.

Mechanism (fact up to the arrow, inference after it): pre-3m the settled read's hashes came
from `TreeStore.ensure()` with no provided root, i.e. from `uiAutomation.rootInActiveWindow`
— the call the phase-3g doc describes as *blocking ~170-210 ms mid-transition*, i.e. it
waits and returns a settled root. Post-3m the hashes come from the capture's
interactive-windows root (`StateHandler.kt:193-197`, `TreeStore.kt:175-186`), which returns
immediately and can hand back a transient or empty active window. → the settled
`getState({fingerprints:true})` at `src/utils/screen-graph-open-wiring.ts:249` can now
return an identity computed over zero nodes. There is **no empty-tree guard on the host
settled-read path**: `screen-graph-open-wiring.ts:250-254` only rejects a *missing*
`afterId`, and `EMPTY_TREE_HASH` is a perfectly truthy string. The device-side
`awaitNonEmptyTree` guard exists only on the `tapWithOutcome` path
(`JsonRpcHandler.kt:228-231`), which still uses the root-less `ensure()`.

Two secondary consequences of the same change, both new:
- `idHash` is now **absent** when `rootNode == null` (`StateHandler.kt:177-204`: `fpSnap`
  stays null, the `fpSnap?.let` at :271 emits nothing). Pre-3m `ensure()` ran unconditionally
  before the hierarchy block and always produced a hash. That is a plausible source of the
  `skippedNoIdHash` 1.
- `ensure()`'s cache (`TreeStore.kt:167-170`) is keyed on version alone, so a snapshot built
  from a windows-snapshot root is now served to `query` / `diff` / the outcome path at the
  same version, which pre-3m always built from `rootInActiveWindow` (see 3M-M6).

Also: `bench-screen-graph.ts:2781-2786` sets `process.exitCode = 1` on a violation, and the
workflow step runs the harness under `set -euo pipefail` with `| tee`
(`.github/workflows/bench-open-vs-proprietary.yml:631-633`), so the **Screen-graph matrix
step must have gone red**. The `## Result`'s "Screen-graph job **success**" and "Contract 6
— Screen-graph matrix: PASS" are inconsistent with the branch's own harness. One
`gh run view 34827025184 --json jobs` settles the job conclusion; the artifact evidence
above does not depend on it.

### 3M-H2 — the headline is not like-for-like: this branch's scrcpy pacing default is `drift`, the reference ran `legacy`

`packages/tool-server/src/utils/scrcpy-inject-backend.ts:135` on this branch:

```kotlin
return process.env.ARGENT_SCRCPY_PACING === "legacy" ? "legacy" : "drift";
```

On `open/main` @ a75ad75d the same function reads
`=== "drift" ? "drift" : "legacy"` — the 3k.1 decision flipped the shipped default to
`legacy`. The latency bench never sets `ARGENT_SCRCPY_PACING` (only
`bench-fling-fidelity.ts:193-198` does, and only for fling blocks), so the ON-scrcpy
**latency** block inherits the process default. Reference run 34813849446 is explicitly
documented as "ON-scrcpy ran the **shipped default** pacing (`legacy`)"
(`2026-09-03-scoreboard.md:30-31`); run 34827025184, being cut before the 3k.1 merge, ran
`drift`.

So `tap+describe(settle:false)` ON-scrcpy 529 → 262 mixes two changes: the fingerprints
fix and a different tap-injection pacing. `legacy` awaits each frame's *consume* before
returning; `drift` initiates the write without awaiting it, which changes exactly the thing
that decides whether the following describe lands mid-transition (the R1 UP-ordering
interaction at `StateHandler.kt:106-110`). The branch must be rebased onto `open/main` and
re-run before this number is attributable to 3m.

### 3M-H3 — the improvement appears on one ON arm only, and the pre-fix residual is too small to explain it

Recomputed from `bench-block-*.json`, p50 ms, within-run OFF-1↔OFF-2 floor:

| verb | 34813 ON-scrcpy | 34827 ON-scrcpy | Δ | 34813 ON-uia | 34827 ON-uia | Δ | floor |
|---|---|---|---|---|---|---|---|
| `tap+describe(settle:false)` | 529 (n=19) | 262 (n=20) | **−267 OUTSIDE** | 505 (n=19) | 475 (n=20) | **−30 INSIDE** | 57 |

The forced `TreeStore.ensure()` rebuild lives in the Kotlin server and is identical for
both ON arms. If removing it were the cause, both arms would move. Only scrcpy did.

Second, internal inconsistency in the root-cause story: the root-cause doc attributes
~170-210 ms of hidden `rootInActiveWindow` plus a second `ScreenTree.build` plus three hash
passes to the rebuild, "none of it in a reported stage" — i.e. it should all land in the
after-tap residual. Recomputed from the reference run, the after-tap residual
(`captureP50 − Σ p50 stages`) was **+39 ms (scrcpy) / +31 ms (uia)**. Either the residual
proxy is meaningless (in which case it also cannot be used as G2 in either direction, see
3M-M5) or the hidden rebuild cost at most ~40 ms at p50 and cannot explain a 267 ms move.

This does not say the fix is wrong — `fingerprintMs = 0`, `traversals` delta 1 and
`rootSource=windows` are real. It says **the run does not attribute the headline to the
fix**, and the `## Result`'s "the user-facing headline … dropped 529→262" reads as a causal
claim the data does not support.

### 3M-H4 — `version` / `unchanged` semantics changed from "snapshot version" to "live post-capture version"

Before: `StateHandler` took `val snap = TreeStore.ensure()` **before** serializing and
reported `snap.version` and `unchanged = sinceVersion == snap.version`. The reported version
was therefore never newer than the tree in the reply.

Now (`StateHandler.kt:266,276`, `HierarchyHandler.kt:113`):

```kotlin
put("version", TreeStore.version)                  // live volatile read, AFTER the capture
put("unchanged", sinceVersion == TreeStore.version) // same
```

Three consequences:
1. **Lost-update window.** If an AX event lands during the capture, the host receives a
   `version` that is newer than the tree it got. A later `sinceVersion = thatVersion` then
   returns `unchanged: true` and the host never learns about the change it never saw. The
   window is the capture duration — up to ~400 ms after a tap on this very run.
2. **`hash` and `version` can disagree.** `hash`/`stateHash`/`idHash` come from `fpSnap`
   (built at the version current when `ensure()` ran, `StateHandler.kt:195`); `version` is
   re-read at :266. A consumer that caches "hash at version V" can bind a hash to a newer
   version than it was computed at.
3. **Version 0 is now overloaded.** While the clock is unarmed `version` never advances
   (`TreeStore.kt:32-35,109-125`), so every unarmed read returns 0. A host that stores 0 and
   later sends `sinceVersion: 0` gets `unchanged: true` on the first armed call regardless of
   what happened on screen. No current caller does this (`awaitScreenIdleViaOpenServer`
   arms on its first read, `open-server-input.ts:441-447`), but the blueprint's `version`
   doc (`src/blueprints/android-open-server.ts`) does not state the invariant, so the next
   caller can walk into it.

None of this is covered by a test.

### 3M-H5 — the lost-wakeup the author fixed in `awaitScreenIdleViaOpenServer` is still present in `await-ui-element`

`src/utils/open-server-input.ts:441-445` explicitly calls out the hazard and fixes it:

> Phase 3m: request fingerprints so this first read ARMS the device AX clock … an event
> between this read and the first awaitChange could be missed.

The identical shape in `await-ui-element` was not fixed. `src/tools/await-ui-element/index.ts:482`
calls `readAndroidOpenState`, which issues `server.getNestedState()` with **no**
`fingerprints` (`src/utils/open-server-describe.ts:49`) — so the clock is not armed and
`state.version` is 0 (:55). `fromVersion = first.version` (index.ts:487) then feeds
`openServerAwaitChange` at :493, which arms the clock itself (`AwaitChangeHandler.kt:34`).
Any AX event between the read and the `awaitChange` is invisible: the listener did not
exist, so `version` is still 0 and `awaitChange` blocks for the **next** event.

Pre-3m the listener was always on, so such an event bumped the version and `awaitChange`
returned immediately. Post-3m, if the screen goes quiet after that missed event, the wait
blocks to the full `timeoutMs` and only the deadline straddle at index.ts:504 recovers the
verdict. Correctness survives; latency becomes the timeout. The latency bench does not
exercise this (the condition is already true at the first read, index.ts:484 returns), which
is why `await-ui-element` still reads 45/44 ms in this run.

Fix is one word: pass `fingerprints: true` on the `getNestedState` in
`open-server-describe.ts:49`, the same as the other armed readers.

## MEDIUM

### 3M-M1 — G3 and G6 were redefined after the fact

The ticket's pre-registered gates are, verbatim:

- "`ON describe idle p50 <= OFF describe idle p50 + 10` (the pre-merge F1 direction)"
- "Within-run headline: `ON tap+describe(settle:false) p50 ÷ same-run OFF tap+describe p50 <= 1.15` **on both ON arms**"

The `## Result` gate table replaces the first with "`describe` p50, ON-scrcpy ≤ 45 ms" and
the second with an ON-scrcpy-only cell. Recomputed against the pre-registration:

| pre-registered gate | measured | verdict |
|---|---|---|
| ON describe idle ≤ OFF + 10 | scrcpy 50 ≤ 52+10 = 62 | **PASS** |
| ON describe idle ≤ OFF + 10 | uia 72 > 62 | **FAIL** |
| tap+describe ratio ≤ 1.15, both arms | scrcpy 262/369 = **0.710**; uia 475/369 = **1.287** | **FAIL** (uia) |

The substitution runs in both directions (G3 is made harsher, G6 narrower). Neither
version should be published as "the pre-registered gate". Note also that G6's denominator
choice matters: against OFF-2 (319) the ratio is 0.821, and against the pooled OFF mean
(344) it is 0.762. The honest band is **0.71–0.82**, not a single 0.71.

### 3M-M2 — "unchanged from 34813" is false for the ON-uiautomation arm

The `## Result` says the C2 tax is "unchanged from 34813". Recomputed:

| metric | 34813 scrcpy → 34827 | 34813 uia → 34827 |
|---|---|---|
| ping p50 (ms) | 0.862 → 0.858 | 0.817 → **0.950** |
| idle `encodeMs` p50 | 36 → 36 | 36 → **50** |
| idle `captureMs` p50 | 48 → 47 | 48 → **65** |
| `describe` p50/p95 | 53/73 → 50/75 | 53/74 → **72/106** |

The scrcpy arm is identical to the reference; the uiautomation arm got measurably worse on
every one of them, while both OFF blocks are flat (describe 52/52 in both runs, both OFF
arms). "Flat process tax remains" is correct for scrcpy and understated for uiautomation.

On the "outlier or regression?" question for ON-uia `describe` idle 72: it is **not an
outlier**. The whole order statistic shifted — min 49 (ref 41), p50 72 (53), p95 106 (74),
max 114 (75), n=20 with 0 errors and 0 fallbacks — and the shift is concentrated in
`encodeMs` (50/83 vs ref 36/57), a pure-CPU stage. One run cannot separate runner noise
from a real arm-specific regression; the `## Result`'s "likely block variance" is inference
stated as near-fact. The lazy clock itself adds a new source of ON-block variance (the
listener now registers at a nondeterministic point in a block), which is a hypothesis this
run cannot test — the bench never measures an unarmed `ping`, so the listener explanation
for C2 is **still only inference**, exactly as before 3m. 3m therefore left C2 not merely
unfixed but unmeasured.

### 3M-M3 — the fling gate in this run is the PRE-3k.1 gate; its offender would be excluded by the rule now on `open/main`

The branch does not contain 61556ee5 (`git merge-base --is-ancestor` → not an ancestor), so
`.github/bench-ci/merge-fling.js` is the pre-3k.1 version. The two `fling-ab-*.json` gate
objects prove it: 34813's carries `rule`, `nonInformativeCells`, `totalCells` and two-sided
`ratioUia`/`ratioOff` per cell; 34827's carries none of those and a single one-sided
`ratio`. So the fling harness on this branch is *untouched by 3m* but *stale relative to
the reference base* — the pre-registered reference-bimodality exclusion is simply not
running.

Recomputing the reported offender from the grid: 150 ms/0.3, scrcpy median 0.458 ÷ uia
median 0.175 = **2.617** ✔. But that uia reference is `iqr [0.175, 0.175]`, n=10 — pinned
at the 0.175 scroll-metric floor, i.e. `refStraddlesFloor` is true
(`.github/bench-ci/merge-fling.js:56-59,76-92` on `open/main`). Under the rule now on
`open/main` that cell is **non-informative and excluded**. Re-running the 3k.1 rule over
34827's grid by hand gives:

| cell | informative under 3k.1? | scrcpy/uia | scrcpy/off | verdict |
|---|---|---|---|---|
| 150/0.3 | no — q25(uia)=0.175 at the floor | (2.617) | (0.774) | excluded |
| 150/0.5 | no — all arms at the floor | — | — | excluded |
| 250/0.3 | yes | 0.896 | 0.890 | PASS |
| 250/0.5 | no — q25(uia) at the floor, off n=11 | — | — | excluded |
| 400/0.3 | yes | 1.007 | **0.760** | FAIL (off side) |
| 400/0.5 | yes | 0.919 | **0.727** | FAIL (off side) |

So: **no fling regression from 3m**, but the run's published fling verdict is not
comparable to the reference, and under the current rule it would still be RED — on the
400 ms cells against the proprietary reference, the same shape the reference run showed
(34813: 400/0.3 scrcpy/off 0.699, 400/0.5 0.717). No fling row from this run may be
published either way.

### 3M-M4 — G1 (`fingerprintMs` p50 = 0) proves the opt-out path, not the opt-in path

The latency bench never requests fingerprints, so `fingerprintMs = 0` on every sample is
tautological: it confirms the plain describe really is opt-out (which is Contract 1, already
proven by the device test) and says nothing about what the screen-graph path now pays. The
cost of `ensure(rootNode)` on the opt-in path — a **second full walk of the same root**
after `NodeSerializer`/`NestedWindowSerializer` already walked it (`StateHandler.kt:179-197`)
— is unmeasured in this run. The SG job is the only place it shows up and its wall-time
table is unchanged, so it is probably small; that is an inference, not a measurement.

### 3M-M5 — the "±10 ms residual" claim rests on one 5-sample median; the bench p50-proxy is not a residual at all

Neither `bench-merged-*.json` nor `bench-block-*.json` stores per-sample stage values — only
`{p50, p95, n}` per stage (`describeSplitIdle` / `describeSplitAfterTap`). **A per-sample
recompute from the bench artifacts is impossible.** What the `## Result` calls the residual
is `captureP50 − Σ p50(stage)`, a sum-of-medians:

| | cap p50 | Σ p50 | "residual" |
|---|---|---|---|
| 34827 scrcpy after-tap | 385 | 283 | +102 |
| 34827 uia after-tap | 445 | 406 | +39 |
| 34813 scrcpy after-tap | 374 | 335 | +39 |
| 34813 uia after-tap | 360 | 329 | +31 |

With n=10 and violently skewed stages (34827 scrcpy `rootMs` p50 75 / p95 300;
`serializeMs` 76/267; `rootsMs` 105/232), the median of each stage need not come from the
same sample, so the sum-of-medians is neither an upper nor a lower bound on the median of
the sums. **The honest number is the device test's per-sample residual: idle median 1 ms,
after-tap median 6 ms** (`bench-latency/logs/device-test.log:75`) — and the `## Result` is
right to prefer it. Two caveats it does not state: the assertion is on the **median of 5
samples** of `|residual|` with no tail bound (`android-open-server.device.test.ts`, block A
and B), so a fat tail passes; and the p50-proxy should be dropped from the gate table
entirely rather than reported as "FAIL by proxy", because it was never a valid estimator —
including in the reference run, where the same proxy read +39/+31 while (per the root-cause
doc) a 170-210 ms rebuild was supposedly hiding in it.

### 3M-M6 — `ensure()`'s cache is now root-source-heterogeneous, and never invalidates while the clock is unarmed

`ensure(providedRoot)` (`TreeStore.kt:163-205`) checks `lastBuiltAtVersion == version`
*before* looking at `providedRoot`, and writes the result to the single `lastSnapshot`. So:

- A snapshot built from the **capture's windows-snapshot root** is served, at the same
  version, to `query` (`QueryHandler.kt:23`), `diff` (`DiffHandler.kt:19`) and the outcome
  path (`JsonRpcHandler.kt:218,228`), all of which pre-3m always built from
  `rootInActiveWindow`. `diff` additionally compares `prevSnapshot` to `lastSnapshot`, which
  can now be two snapshots resolved through **different** root paths — a spurious diff is
  possible. Not observed in this run; flagged as a semantics change with no test.
- While the clock is unarmed `version` is pinned at 0, so `lastBuiltAtVersion == 0 == version`
  holds forever and `ensure()` returns the first snapshot regardless of what is on screen.
  Today every `ensure()` caller arms first (verified: all six call sites above), so this is
  not reachable — but it is an invariant held by convention, not by construction. A future
  `ensure()` caller that forgets `armClock()` gets a permanently stale tree, silently.

On the specific Kotlin questions asked: `providedRoot` is **not** recycled by `ensure`
(`TreeStore.kt:175,186` `ownsRoot` guard) and the caller recycles it after
(`StateHandler.kt:199-201`), so there is no double-recycle; `AxNode` holds no
`AccessibilityNodeInfo` reference (it is a pure value class, `ScreenTree.kt:14-33`) and
`ScreenTree.build` recycles every child it fetches, so the cached snapshot cannot outlive
into a use-after-recycle. `armClock()` is a textbook double-checked lock
(`@Volatile clockArmed` + `synchronized(armLock)`, `TreeStore.kt:50-52,109-125`): idempotent
and safe across concurrent connections. `version` monotonicity is preserved (it only ever
`++`s at `TreeStore.kt:143`); what late arming breaks is not monotonicity but *fidelity* —
version 0 covers an unbounded amount of real change (3M-H4 point 3).

## LOW

- **3M-L1** — `traversals` changed meaning. `recordCaptureTraversal()` (`TreeStore.kt:139`,
  called at `StateHandler.kt:192` and `HierarchyHandler.kt:78`) makes every capture
  increment it, where it previously counted only `TreeStore` builds. Two effects: the
  screen-graph bench's `traversalsDelta` metric (`bench-screen-graph.ts:1419,1469,1496`)
  silently changes scale between runs (it is recorded, not gated); and the `## Result`'s
  "traversals 2→1" is **counterfactual** — the pre-fix build had no capture counter, so it
  would have reported 1, not 2. What the device test actually proves is the right
  invariant (the capture walked once and `ensure()` did not run), but it was never A/B'd.
- **3M-L2** — `HierarchyHandler.kt:33-34` gates `wantFingerprints` on `!nested`, while
  `StateHandler.kt:101` does not. `getAccessibilityTree({nested:true, fingerprints:true})`
  silently returns no hash. Dead today (no host caller), but an asymmetry between the two
  read RPCs that the blueprint doc does not mention.
- **3M-L3** — the new unit test asserts the wire shape through `api.getState(...)` directly;
  nothing asserts that `navigate-to`, `describeAndroidTiered`, `recordOpenServerObservation`
  or `bench-preflight` actually pass the flag. The four opt-in sites are one-line edits with
  no regression guard (`tiered.ts:52`, `navigate-to/index.ts:211,239,430,503`,
  `screen-graph-open-wiring.ts:249`, `bench-preflight.ts:484`, `bench-screen-graph.ts:607`).
- **3M-L4** — `armClock()` returns silently when `uiAutomation` is null
  (`TreeStore.kt:113`), leaving the clock unarmed with no error. Unreachable in practice
  (`init` runs at server start) but it fails open into "version never advances".
- **3M-L5** — the device-test suite on this branch is the pre-3k.1 one (20 tests, all
  passing, `logs/device-test.log:195`); `open/main` @ a75ad75d grew it by ~142 lines. "20/20"
  is not the same suite the reference base runs.
- **3M-L6** — `results-ci.md`'s "Per-rep ranges across the 3 repetitions" table lists 5 reps.
  Pre-existing harness text, not a 3m regression.
- **3M-L7** — *not* a regression, recorded so it is not used against the branch: the SG token
  and success deltas are inside the documented same-code spread. O1 tokens 138 vs the
  reference's 179 is within this run's own per-rep range (179/179/134/179/138) and inside the
  spread the scoreboard already publishes — "Same-code run-to-run spread (D.4.1 runs): O1
  138–179, O2 54–68, O3 598–627" (`2026-09-03-scoreboard.md:122`). O2 54, O3 627, O4 21,
  O5 21, B1 657, B2 651 all match the reference exactly. Success 98/99/99/100/98 vs 100/100
  is 1–2 task-runs out of 100 per config, with H1/H3/H4 all PASS and H4 non-inferior against
  both baselines. The SG problem is 3M-H1, not tokens.
- **3M-L8** — merge status: **clean**. `git merge-tree --write-tree open/main
  fix/open-server-fingerprints-opt-in` exits 0 with tree `71985a0f` and no conflict section,
  including the one overlapping file (`android-open-server.device.test.ts`). The problem
  with the 24-commit gap is not textual (3M-H2, 3M-M3, 3M-L5).

## Reference run recommendation

**No. Run 34827025184 must not replace 34813849446 as the single reference, and no
scoreboard row may be updated from it.** `README.md:44-46` makes the promotion conditional
("the run becomes the new reference if its six gates pass") and
`2026-09-03-scoreboard.md:22-31` requires the single reference to be a `suite=both`
`sg_mode=matrix` run **on the consolidated base**. Neither holds:

1. The six gates did not pass. Under the ticket's own pre-registration the describe-idle
   gate fails on ON-uia (72 > 62), the headline ratio gate fails on ON-uia (1.287 > 1.15),
   and the ping gate fails on both arms (0.86/0.95 vs ≤ 0.52) — 3M-M1.
2. Screen-graph is not green: the phase-D.3 store invariant failed with an empty-tree node
   (3M-H1). A reference run cannot carry a broken store.
3. The run is **not on the consolidated base**. It predates 61556ee5, so its scrcpy pacing
   default is `drift` instead of the shipped `legacy` (3M-H2) and its fling gate is the
   pre-3k.1 one-sided gate without the pre-registered bimodality exclusion (3M-M3). A
   reference must be comparable arm-for-arm with what ships.
4. Adopting it would also *write down* the ON-uiautomation arm: describe 53 → 72, encode
   36 → 50, ping 0.82 → 0.95, with both OFF blocks flat — i.e. the scoreboard would record
   a uiautomation regression this run cannot explain (3M-M2).

**Recommended path.** Keep 34813849446 as the single reference. Fix 3M-H1 (an empty-tree /
`EMPTY_TREE_HASH` guard on the settled screen-graph read, or fall back to
`rootInActiveWindow` for the fingerprint build when the capture root is empty), fix 3M-H5
(one flag), decide 3M-H4 (report `fpSnap.version`, or document version-0 and the
post-capture read in the blueprint), **rebase onto `open/main` @ a75ad75d** so pacing
default, fling gate and device-test suite match the reference base, then one `suite=both`
`sg_mode=matrix` run. That run, if its gates pass and the store invariant holds, is the
promotion candidate.

Keep from this run, as ticket evidence only (not scoreboard): the device-test line
(`logs/device-test.log:75`) and the `fingerprintMs` stage. They establish Contracts 1–5 on
the server; they do not establish the headline.

## Scoreboard rows allowed

**None.** `2026-09-03-scoreboard.md` must not be edited from run 34827025184. In
particular:

- **`tap+describe(settle:false)` verdict — DO NOT CHANGE.** The existing row (ON 505/529 vs
  OFF 354/297, "root cause `TreeStore.ensure()` inside the timed capture, ticket 3m in
  flight") stays as it is. Run 34827025184 shows a −267 ms move on ON-scrcpy only, at a
  changed scrcpy pacing default and with no matching move on ON-uiautomation (−30 ms inside
  a 57 ms floor) — not attributable, not like-for-like (3M-H2, 3M-H3).
- **`describe (idle)` — DO NOT CHANGE.** The current "parity at p50, 14–18 ms slower at p95"
  row stands. This run reads ON-scrcpy 50/75 (parity, unchanged) and ON-uia 72/106 (worse),
  which would make the row *less* favourable on unexplained single-run evidence (3M-M2).
- **fling rows — DO NOT CHANGE.** The gate that ran is the pre-3k.1 one; the reported
  offender (150 ms/0.3 = 2.617) is excluded as non-informative under the rule on
  `open/main`, and re-scoring by that rule still fails on 400/0.3 and 400/0.5 (3M-M3).
- **screen-graph rows (invariants gate, per-config success, tokens/agent-step, O5 routing)
  — DO NOT CHANGE.** The run's store failed the D.3 invariant and its
  `skippedNoIdHash` is 1; the existing rows (`2026-09-03-scoreboard.md:122,128,129`) remain
  the reference (3M-H1).
- **Retired-claims / goal-status prose — DO NOT CHANGE.** No new win, parity or loss may be
  declared from this run.

The one thing that may be recorded outside the scoreboard, in
`README.md`'s "Tickets in flight" line, is a status change for 3m: *server-side contracts
1–5 device-verified on run 34827025184; blocked on a screen-graph store-invariant
regression (empty-tree node) and on a rebase onto the consolidated base before the headline
can be attributed.*
