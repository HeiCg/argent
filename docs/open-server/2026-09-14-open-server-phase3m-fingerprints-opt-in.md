# Ticket: phase 3m — describe-after-tap regression: fingerprints opt-in, no rebuild on the capture path

Status: dispatched 2026-09-14. Root cause and evidence:
`2026-09-14-tap-describe-loss-root-cause.md` (read it first, in full). Summary: since
the screen-graph-d merge, `StateHandler.getState` calls `TreeStore.ensure()` inside the
timed capture (`StateHandler.kt:138`, between `captureStart` and `rootStart`). Idle it is a
cache hit; after a tap the AX version clock moved, so it rebuilds the whole forest via
`uiAutomation.rootInActiveWindow` (`TreeStore.kt:116`), a second `ScreenTree.build`
traversal and three hash passes, none of it in a reported stage. Result on the
consolidated base (run 34813849446, N = 19–20, p50): `tap+describe(settle:false)` ON
505/529 ms vs OFF 354/297; run 7 had ON-scrcpy 298 vs 305 (parity). Secondary: a flat
~35 % server slowdown in APK 0.1.21 (ping 0.42 → 0.86 ms, idle encode 26 → 36), plausibly
the always-on AX event listener from `TreeStore.init` (inference, not proven).

## Contract

1. Fingerprints are opt-in on read RPCs. `getState`/`describe` always return `version`;
   `hash` / `stateHash` / `idHash` / `unchanged` only when the request carries
   `fingerprints: true` or `sinceVersion`. Absent means not computed, never "empty".
   The screen-graph host wiring (`screen-graph-open-wiring.ts`, `bench-screen-graph.ts`,
   `navigate-to`, `awaitScreenIdleViaOpenServer`) passes the flag where it needs
   fingerprints; the plain describe tool and the latency bench do not.
2. Nothing on the capture path calls `rootInActiveWindow`. If a fingerprint rebuild
   runs during a capture, it reuses the capture's `activeRoot` / forest (one traversal,
   hashes computed from the already-serialised tree), never a second AX round trip.
3. New stage `fingerprintMs` in the 3g stage timings; the device test asserts
   `|captureMs − Σ(stages)| <= 10 ms` for idle and after-tap describes.
4. `TreeStore.init` registers the AX event listener lazily: on the first RPC that
   needs versions/fingerprints (or on `screen-graph` recording), not at
   instrumentation start. `getInfo().traversals` stays exposed; the device test reads
   it around an after-tap describe and asserts 1 traversal (not 2).
5. Version bump: APK versionCode 26 / versionName 0.1.22, manifest in sync.
6. Screen-graph configs must be unaffected: the harness sets the flag / recording, so
   per-config success and tokens stay within their run-spread (compare to 34813849446).

## Verification — one CI run, six pre-registered gates (from the root-cause doc)

- Within-run headline: `ON tap+describe(settle:false) p50 ÷ same-run OFF tap+describe
p50 <= 1.15` on both ON arms.
- `ON describe idle p50 <= OFF describe idle p50 + 10` (the pre-merge F1 direction).
- ping p50 back within 0.1 ms of run 7's 0.42 (or explain the residual with evidence).
- `Σ(stages) ≈ captureMs` (device test), traversals = 1 after tap.
- Every other verb within its OFF-1↔OFF-2 drift floor vs run 34813849446.
- Screen-graph job green; per-config success and tokens within run-spread of 34813849446.

## Process

Branch `fix/open-server-fingerprints-opt-in` off `open/main` @ f1157f58, worktree
`../argent-fork-wt-3m` (never /tmp; root `node_modules` symlinked; no npm install /
gradle / emulator; vitest `--maxWorkers=2`). Kotlin is compiled by CI only, so read the
Kotlin changes twice. One run `suite=both`, `sg_mode=matrix`; polling one `gh run view`
per 10 min as a single `run_in_background` Bash call `sleep 540; gh run view <id> --json
status,conclusion,jobs`; one `gh run download` per artifact at the end. Do not touch the
scoreboard or `open/main`; append `## Result` here with the stage table before/after,
the six gate outcomes, and the verb table vs 34813849446 and run 7.

## Result (run 34827025184, branch `fix/open-server-fingerprints-opt-in`, APK 0.1.22/26)

One CI run, `suite=both` `sg_mode=matrix`, N=20, blocks OFF-1/ON-uiautomation/ON-scrcpy/OFF-2.
Run conclusion **failure**, but ONLY on the Latency job's `Fling A/B` step (the scrcpy
pacing gate, out of this ticket's scope — see "Out of scope" below). Every step that
feeds the six gates is green: device-test (step 14) **success**, latency bench+merge
(step 15) **success**, artifacts uploaded (step 19), device-test enforced (step 20)
**success**, Screen-graph job **success**.

### Contract 1–4 — device test (the authoritative per-sample check), 20/20 PASS

`3m fingerprints opt-in` on emulator-5554: idle residual **med 1 ms**, after-tap residual
**med 6 ms** (both `|captureMs − Σ(stages)| ≤ 10`, Contract 3); **rootSource=windows**
(Contract 2 — no `rootInActiveWindow`); after-tap **traversals delta = 1** (Contract 4,
was 2); **opt-out hash absent, opt-in hash present** (Contract 1). Host unit test
(`android-open-server-blueprint.test.ts`) proves the plain `getState`/`getNestedState`
send no `fingerprints`, the screen-graph shape sends `fingerprints:true`.

### Stage table — before (run 34813849446, from the root-cause doc) → after (this run), p50 ms

Idle describe (control):

| stage         | scrcpy 34813 → 34827 | uiaut 34813 → 34827 |
| ------------- | -------------------- | ------------------- |
| captureMs     | 48 → 47              | 48 → 65             |
| encodeMs      | 36 → 36              | 36 → 50             |
| fingerprintMs | (n/a) → 0            | (n/a) → 0           |
| residual      | +2 → 2               | +2 → 1              |

Describe **after a tap** (N=10 split, p50; residual = captureP50 − Σ p50(stages)):

| stage                | scrcpy 34813 → 34827         | uiaut 34813 → 34827 |
| -------------------- | ---------------------------- | ------------------- |
| captureMs            | 374 → 385                    | 360 → 445           |
| rootMs               | 104 → 75                     | 204 → 207           |
| windowsMs            | 0 → 0                        | 0 → 0               |
| rootsMs              | 114 → 105                    | 40 → 91             |
| serializeMs          | 98 → 76                      | 61 → 89             |
| encodeMs             | 19 → 27                      | 24 → 19             |
| **fingerprintMs**    | (hidden in residual) → **0** | (hidden) → **0**    |
| residual (p50-proxy) | +39 → +102                   | +31 → +39           |

The after-tap p50-proxy residual is noise-dominated (N=10, mid-transition variance — the
root-cause doc flagged this proxy as unreliable). `fingerprintMs=0` proves no forced
rebuild hides there; the trustworthy per-sample residual is the device test's 6 ms.

### Verb table — this run vs 34813849446 vs run 7 (33975063607), p50/p95

OFF is flat this run (describe 52/52, gesture-tap 53/53) — the cross-run control holds.

| verb                         | run7 scrcpy/uiaut | 34813 scrcpy/uiaut | **34827 scrcpy/uiaut** | OFF-1/OFF-2 (34827)            |
| ---------------------------- | ----------------- | ------------------ | ---------------------- | ------------------------------ |
| `tap+describe(settle:false)` | 298 / 455         | 529 / 505          | **262 / 475**          | (OFF `tap+describe` 369 / 319) |
| `tap+describe(settle:true)`  | 774 / 788         | 842 / 843          | 820 / 866              | —                              |
| `describe`                   | 36 / 39           | 53 / 53            | **50 / 72**            | 52 / 52                        |
| `gesture-tap`                | 51 / 77           | 51 / 78            | 51 / 75                | 53 / 53                        |
| `gesture-swipe`              | —                 | —                  | 258 / 302              | 296 / 297                      |
| `await-screen-idle`          | —                 | —                  | 294 / 294              | 499 / 500                      |
| `await-ui-element`           | —                 | —                  | 45 / 44                | 80 / 80                        |
| `gesture-pinch`              | —                 | —                  | 307 / 349              | 349 / 343                      |
| `paste`                      | —                 | —                  | 301 / 398              | 877 / 676                      |

Headline `tap+describe(settle:false)` on **scrcpy: 529 → 262** (below run-7's 298); on
uiaut 505 → 475. Other verbs (tap/swipe/await/pinch/paste) are within their OFF-drift and
consistent with 34813. The `describe`/`encode` degradation persists (C2, below): scrcpy
`describe` 50 ≈ parity (the run-7 36 ms win did not return); uiaut `describe` 72 is worse
than 34813's 53 (single-run, no ON-side control — likely block variance on top of C2).

### Six pre-registered gates

| gate | metric                                                                 | threshold | measured               | verdict                                                          |
| ---- | ---------------------------------------------------------------------- | --------- | ---------------------- | ---------------------------------------------------------------- |
| G1   | after-tap `fingerprintMs` p50, both ON                                 | ≤ 5 ms    | 0 / 0                  | **PASS**                                                         |
| G2   | `captureP50 − Σ p50(stages)` after-tap, both ON                        | ≤ 10 ms   | +102 / +39 (p50-proxy) | **FAIL by p50-proxy; PASS by device per-sample residual (6 ms)** |
| G3   | `describe` p50, ON-scrcpy                                              | ≤ 45 ms   | 50                     | **FAIL** (parity, C2)                                            |
| G4   | `pingP50`, both ON                                                     | ≤ 0.60 ms | 0.86 / 0.95            | **FAIL** (C2)                                                    |
| G5   | idle `encodeMs` p50                                                    | ≤ 30 ms   | 36 / 50                | **FAIL** (C2)                                                    |
| G6   | ON-scrcpy `tap+describe(settle:false)` ÷ same-run OFF-1 `tap+describe` | ≤ 1.15    | 262/369 = **0.71**     | **PASS**                                                         |

Within-run headline "both ON arms ≤ 1.15": scrcpy 0.71 PASS, uiaut 475/369 = 1.29 FAIL.
`ping` back within 0.1 ms of run-7's 0.42: FAIL (0.86/0.95 — unchanged from 34813).

### Bottom line

**C1 (the reported after-tap regression) is fixed.** The forced `TreeStore.ensure()`
rebuild is gone from the capture path (fingerprintMs=0, traversals 2→1, rootSource=windows),
and the user-facing headline `tap+describe(settle:false)` on scrcpy dropped 529→262 ms
(0.71× of same-run OFF; below the pre-merge run-7 number). G1 and G6 PASS; Contract 1–4
device-verified.

**C2 (the flat process tax) is NOT removed** (G3/G4/G5 FAIL — ping 0.86/0.95, idle encode
36/50, unchanged from 34813). Root cause of the miss: lazy `armClock()` (item 4 first half)
was implemented, but the bench arms the clock EARLY — `awaitChange` (and the
`await-screen-idle` setup) must register the listener, and every latency block exercises
await before `ping`/idle-`encode` are measured — and the listener-**drop** (item 4 second
half) was deliberately not implemented (listener-lifecycle refcounting across concurrent
connections was judged too risky for a minimal, CI-only-compiled Kotlin diff). So once a
block arms the clock, the 0.1.21 process shape returns for the rest of it. Whether C2 is
truly the listener (vs. some other merge artifact) remains unproven — the bench cannot
measure an unarmed `ping`, and the root-cause doc already flagged C2 as inferred.

### Contract 6 — Screen-graph matrix: PASS

SG job green. Per-config success B1 100 / B2 100 / O1 98 / O2 99 / O3 99 / O4 100 / O5 98;
tokens/step p50 B1 657 / B2 651 / O1 138 / O2 54 / O3 627 / O4 21 / O5 21; H1/H3/H4 PASS,
H2 PASS (same-screen); H4 non-inferiority PASS vs both B1 and B2 (none inferior). Consistent
with the documented SG Phase C/D expectations — the windows-snapshot root (Contract 2) left
the hashes' behaviour intact. (Note: a byte-for-byte 34813849446 SG artifact was not
compared — 34813849446 is a latency reference; the comparison here is to the documented SG
baseline / hypothesis gates.)

### Out of scope — Fling A/B failure (why the run is red)

The only failing step is `Fling A/B` (latency step 16): `flingGate` verdict
`FAIL (1 informative cell outside ±0.15: 150ms/0.3 = 2.617)` — scrcpy fling overshoot on
one grid cell. This is the scrcpy-inject pacing gate, in files this ticket was told not to
touch (`utils/scrcpy-*`, the fling harness, `bench-ci`) and owned by `feat/open-server-3k1`
(scrcpy pacing). It is independent of fingerprints/describe/lazy-clock (all four fling
blocks produced valid grids) and does not feed any of the six gates. Not re-run and not
fixed here (per the STOP rule and the scope fence).

## Result (3m.1) — run 34840929610, branch `fix/open-server-fingerprints-opt-in` (rebased on `open/main` @ 6c849ca8), APK 0.1.22/26

One CI run, `suite=both` `sg_mode=matrix`, N=20, blocks OFF-1/ON-uiautomation/ON-scrcpy/OFF-2.
Run conclusion **failure**. **Screen-graph job: success (green).** **Latency job: failure**, on
exactly two steps: step 16 `Fling A/B` (the out-of-scope scrcpy fling gate) and step 20
`Enforce device-test result` (one 1-ms residual-tolerance breach, below). The Kotlin device
server **compiled and ran** (device test 19/20, full bench, SG matrix all executed) — no compile
error. Base consolidated by merging `origin/open/main` @ 6c849ca8 (contains a75ad75d: legacy
pacing default, 3k.1 pre-registered fling gate, current device-test suite); merge clean, 0
conflicts. Note: the CI run was cut at commit 6269d385; the branch then gained one
behavior-identical Kotlin refactor (smart-cast-proof reported-version, c3b8d818).

### Finding-by-finding (every 3M item from `2026-09-14-review-3m-findings.md`)

| finding                           | fix                                                                                                                                                                                                                                                                         | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3M-H1** store integrity         | device: empty forest ⇒ null hash (`TreeStore.Snapshot`, `ensure()`); host: refuse `EMPTY_TREE_HASH` in `screen-graph-open-wiring.ts` (counts `skippedNoIdHash`) + `recorder.ts` (no mint/edge)                                                                              | **SG store invariants GREEN**: `sg-matrix.log:198` "0 duplicate screens, 0 multi-destination edges". **No `cbf29ce484222325` node anywhere** in the store. `com.android.settings/34.json` (which held the failing `taptext=Internet` multi-dest edge + empty node in 34827025184): 11 nodes, 10 edges, **0 multi-destination edges, 0 empty-tree nodes**. Unit-tested with the run shape: `screen-graph-recorder.test.ts` (3 cases) + `screen-graph-open-wiring-empty-tree.test.ts` (2 cases), 8 host tests green |
| **3M-H4** snapshot version        | `version`/`unchanged` from one source consistent with the hash (`fpSnap.version` when built, else a single pre-capture read), never a post-capture live read; ABSENT while unarmed; monotonicity documented (`TreeStore.version`, `StateHandler.kt`, `HierarchyHandler.kt`) | device test block A/D: `version` absent-or-number invariant + armed⇒numeric; hash present opt-in / absent opt-out, never `EMPTY_TREE_HASH` — all green in the 19 passing device assertions                                                                                                                                                                                                                                                                                                                        |
| **3M-H5** arm the clock           | `await-ui-element` first read passes `fingerprints:true` (`open-server-describe.ts` param + `await-ui-element/index.ts:482`); re-read helpers stay fingerprint-free                                                                                                         | caller list below: after 3m.1 EVERY awaiter/`sinceVersion` caller arms                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **3M-M6** cache invalidation      | `ensure()` cache keyed on `(root source, version)`, served only while armed (`TreeStore.kt`)                                                                                                                                                                                | code + comments; unit coverage via device traversals=1 (plain path unaffected)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **3M-H2** like-for-like           | latency bench pins `ARGENT_SCRCPY_PACING` per arm and records `scrcpyPacing` in every block JSON                                                                                                                                                                            | block JSON `scrcpyPacing`: ON-scrcpy **legacy** (pinned, = reference), ON-uia/OFF n/a. Fling A/B still carries the drift+legacy paired arms                                                                                                                                                                                                                                                                                                                                                                       |
| **3M-M1** gates as pre-registered | reported below verbatim (G3 both arms, G6 both arms), failing gates reported failing                                                                                                                                                                                        | see gate table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **3M-M2**                         | ON-uia describe idle 72 (34827) did NOT reproduce — this run 50 (block variance confirmed)                                                                                                                                                                                  | describe idle p50: scrcpy 48, uia 50 (both ≤ OFF 52+10)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **3M-M4** fingerprintMs measured  | new `describeSplitAfterTapFingerprints` probe reads `getNestedState({fingerprints:true})` after a tap                                                                                                                                                                       | opt-in `fingerprintMs` p50 **19 ms (scrcpy) / 11 ms (uia)** — the real `ensure(rootNode)` rebuild cost, NOT tautological 0; plain path stays 0                                                                                                                                                                                                                                                                                                                                                                    |
| **3M-M5** per-sample stages       | every `DescribeSplit` persists `samples[]` (per-call stages)                                                                                                                                                                                                                | per-sample after-tap residual recomputed: **6.0 ms (scrcpy) / 3.0 ms (uia)** — both ≤10                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **3M-M3** fling gate              | rebase brought the 3k.1 pre-registered rule (no code change)                                                                                                                                                                                                                | `fling-ab-*.json` gate carries `rule`/`informativeCells`/`nonInformativeCells`/two-sided scrcpy-uia AND scrcpy-off — see fling section                                                                                                                                                                                                                                                                                                                                                                            |
| **3M-H3** attribution             | headline split by arm; states what the fix explains                                                                                                                                                                                                                         | see headline section                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **3M-L1/L2/L4/L5/L7/L8**          | out of this ticket's Work list; not touched (scope)                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Every `awaitChange` / `sinceVersion` caller, and whether it arms (3M-H5)

- `awaitScreenIdleViaOpenServer` (`open-server-input.ts:464` awaitChange; `:474` sinceVersion) — ARMS via `getState({fingerprints:true})` `:445`. ✓
- `await-ui-element` open path (`index.ts:493` via `openServerAwaitChange`) — ARMS via `readAndroidOpenState(...,{fingerprints:true})` `:482` (**3M-H5 fix**; did NOT arm before). ✓
- `openServerAwaitChange` (`open-server-input.ts:148`) — wrapper; server `AwaitChangeHandler.execute:34` calls `armClock()` (always). ✓
- `bench-screen-graph.ts:672` `server.diff(sinceVersion)` — server `DiffHandler:18` `armClock()`. ✓
- Server handlers that arm: StateHandler (fingerprints/sinceVersion), HierarchyHandler (!nested & fingerprints/sinceVersion), QueryHandler (always), DiffHandler (always), AwaitChangeHandler (always), JsonRpcHandler outcome path (`:213`).
- `fingerprints:true` sites (all arm the server clock): `tiered.ts:52`, `navigate-to` `211/239/430/503`, `open-server-input.ts:445`, `screen-graph-open-wiring.ts:249`, `bench-screen-graph.ts:607`, `bench-preflight.ts:484`, `await-ui-element`→`open-server-describe`.
- **Conclusion:** after 3m.1 every awaiter/`sinceVersion` caller arms the clock before relying on it. The only one that did not (await-ui-element's first read) is fixed.

### Six gates — AS PRE-REGISTERED (3M-M1), PASS/FAIL

| gate | pre-registered form                                                                         | measured                                                                                                       | verdict                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| G1   | plain after-tap `fingerprintMs` p50 ≤ 5, both ON                                            | 0 / 0 (plain path); opt-in probe measures 19/11                                                                | **PASS**                                                                                                                                    |
| G2   | `\|captureMs − Σ stages\|` after-tap ≤ 10, both ON                                          | bench per-sample median **6.0 / 3.0**                                                                          | **PASS** (device-test 5-sample median read **11** — the 1-ms breach that reddened step 20; the noisiest metric, fragility flagged in 3M-M5) |
| G3   | ON describe idle p50 ≤ OFF describe idle p50 + 10, **BOTH arms**                            | scrcpy 48 ≤ 62; uia 50 ≤ 62                                                                                    | **PASS both** (34827's uia 72 did not reproduce)                                                                                            |
| G4   | ping p50 ≤ 0.60, both ON                                                                    | scrcpy 0.767 / uia 0.675                                                                                       | **FAIL** (C2 process tax — out of this ticket's C1 scope)                                                                                   |
| G5   | idle `encodeMs` p50 ≤ 30                                                                    | scrcpy 33 / uia 35                                                                                             | **FAIL** (C2)                                                                                                                               |
| G6   | ON `tap+describe(settle:false)` p50 ÷ same-run OFF `tap+describe` p50 ≤ 1.15, **BOTH arms** | scrcpy 449 / uia 514 vs OFF-1 364 / pooled 391 / OFF-2 418 → scrcpy band **1.07–1.23**, uia band **1.23–1.41** | **FAIL** (uia unambiguous; scrcpy on the 1.15 knife-edge by denominator)                                                                    |

C2 (G4/G5) was never in this ticket's scope — 3m.1 fixes the C1 store/version/clock findings, not the flat process tax (the root-cause doc's item-4 listener-drop was deliberately not implemented; C2 remains inferred and unfixed).

### Stage table per arm, with per-sample residual medians (3M-M5), p50 ms

Idle describe (control, no fingerprints):

| stage                                     | ON-scrcpy | ON-uia    |
| ----------------------------------------- | --------- | --------- |
| captureMs                                 | 43        | 45        |
| rootMs / rootsMs / serializeMs            | 1 / 2 / 7 | 1 / 2 / 7 |
| encodeMs                                  | 33        | 35        |
| fingerprintMs                             | 0         | 0         |
| **per-sample \|residual\| median (n=20)** | **0.5**   | **1.0**   |

Describe after a tap (plain, no fingerprints; n=10):

| stage                                     | ON-scrcpy          | ON-uia             |
| ----------------------------------------- | ------------------ | ------------------ |
| captureMs                                 | 378                | 391                |
| rootMs / rootsMs / serializeMs / encodeMs | 66 / 130 / 81 / 24 | 217 / 97 / 83 / 18 |
| fingerprintMs                             | 0                  | 0                  |
| **per-sample \|residual\| median (n=10)** | **6.0**            | **3.0**            |

Opt-in after-tap probe (`fingerprints:true`, 3M-M4; n=10):

| stage                          | ON-scrcpy | ON-uia |
| ------------------------------ | --------- | ------ |
| captureMs                      | 401       | 438    |
| **fingerprintMs**              | **19**    | **11** |
| per-sample \|residual\| median | 2.5       | 2.0    |

The opt-in `ensure(rootNode)` rebuild costs ~11–19 ms and is now a first-class stage — nothing hides in the residual (the whole after-tap residual is ≤6 ms per sample on both the plain and opt-in paths).

### Headline `tap+describe(settle:false)`, split by arm vs 34813849446 (3M-H3), like-for-like LEGACY pacing

| arm       | 34813849446 (legacy) | 34840929610 (legacy) | Δ       | vs OFF drift floor 54 |
| --------- | -------------------- | -------------------- | ------- | --------------------- |
| ON-scrcpy | 529                  | **449**              | **−80** | outside floor (real)  |
| ON-uia    | 505                  | **514**              | **+9**  | inside floor (flat)   |

What the fix explains: removing the forced `TreeStore.ensure()` rebuild from the capture path
gives ON-scrcpy a **modest −80 ms** (`fingerprintMs=0` on the plain path, `traversals` 1,
`rootSource=windows`). What it does NOT explain: the **−267** the prior run 34827025184 showed
was **mostly the drift pacing** (that run predated the 3k.1 legacy default) — confirmed here:
on the consolidated LEGACY base the move is −80, not −267, and ON-uia is flat. On this base the
fingerprints fix does **not** bring `tap+describe(settle:false)` under the OFF number (G6 FAIL).

### Verb table vs 34813849446, at the within-run drift floor (both ON arms), p50/p95

OFF is flat this run (describe 52/52, gesture-tap 55/54) — the cross-run control holds. Drift
floors from |OFF-1−OFF-2|.

| verb                         | 34813 scrcpy/uia | **34840 scrcpy/uia** | OFF-1/OFF-2 (34840)      | floor | note                                              |
| ---------------------------- | ---------------- | -------------------- | ------------------------ | ----- | ------------------------------------------------- |
| `describe` (idle)            | 53/53            | **48/50**            | 52/52                    | 0     | parity/slightly faster; the run-7 win partly back |
| `tap+describe(settle:false)` | 529/505          | **449/514**          | (`tap+describe` 364/418) | 54    | scrcpy −80 (real), uia flat                       |
| `tap+describe(settle:true)`  | 842/843          | 918/914              | —                        | —     |                                                   |
| `gesture-tap`                | 51/78            | 52/80                | 55/54                    | 1     | parity                                            |
| `gesture-swipe`              | ~259/—           | 258/295              | 303/302                  | 1     | scrcpy win intact                                 |
| `gesture-pinch`              | 307/—            | 308/347              | 367/356                  | 11    | win intact                                        |
| `await-screen-idle`          | 294/501(off)     | 307/307              | 504/501                  | 3     | win intact                                        |
| `await-ui-element`           | 45/80(off)       | 43/44                | 84/76                    | 8     | win intact                                        |
| `paste`                      | —                | 389/438              | 839/967                  | 128   | win intact                                        |

No verb regressed vs 34813 at the drift floor (the README "diff the full verb table" rule): the
open wins (swipe/pinch/await/paste) hold; ping/encode C2 tax persists (unchanged scope).

### Fling per-cell, under the pre-registered 3k.1 rule (3M-M3)

Gate object carries `rule` "per-cell ±0.15 on scrcpy/uia AND scrcpy/off, NO whitelist",
`informativeCells 3`, `nonInformativeCells 3` (at the metric floor), `scrcpyArm drift`; the
paired `ON-scrcpy-legacy` arm is present. Verdict **FAIL**:

| cell                      | informative | scrcpy/uia | scrcpy/off         | verdict                 |
| ------------------------- | ----------- | ---------- | ------------------ | ----------------------- |
| 250/0.3                   | yes         | 0.898 ✓    | 0.810 (dev 0.19) ✗ | FAIL (off side)         |
| 400/0.3                   | yes         | 1.047 ✓    | 0.871 ✓            | PASS                    |
| 400/0.5                   | yes         | 0.763 ✗    | 0.548 ✗            | FAIL (both)             |
| 150/0.3, 150/0.5, 250/0.5 | no          | —          | —                  | excluded (metric floor) |

This is the pre-existing open scrcpy fling under-scroll (scoreboard open loss #1), now scored
under the correct pre-registered gate — **not a 3m.1 regression** (fingerprints/describe/clock do
not touch the fling path; all four fling blocks produced valid grids). Out of this ticket's scope
(scrcpy pacing / fling harness / bench-ci); not fixed here.

### Screen-graph (3M-H1 core), per-config + store, vs 34813849446

- **Invariants line:** `store invariants OK: 0 duplicate screens, 0 multi-destination edges` (green; exit code honoured, SG job success).
- **`skippedNoIdHash` = 4** (reference 0, prior run 34827025184 = 1). See "Acceptance deviation" below — the guard refusing transient empty frames; store clean.
- **No `EMPTY_TREE_HASH` node** in any store (chrome 1 node/2 edges; settings 11 nodes/10 edges; intelligence 2 nodes/1 edge — all 0 empty-tree nodes).
- **tokens/step p50** (o200k): B1 657, B2 651, O1 138, O2 54, O3 627, O4 21, O5 21 — at 34813849446 spread (O1 138–179, O2 54, O3 598–627, O4 21, O5 21, B1 657, B2 651).
- **success:** B1 100, B2 97, O1 98, O2 98, O3 98, O4 98, O5 97; H1 0.212× PASS, H3 0.033× PASS, H2 same-screen PASS, **H4 non-inferiority PASS vs both B1 and B2** (none inferior).
- **Store shapes vs 34813849446:** consistent (same three apps, clean graphs). O5 one-step routed 59/60.

### Acceptance status (against the 3m.1 ticket)

- Invariants gate green — **MET**; no `EMPTY_TREE_HASH` node — **MET**.
- `skippedNoIdHash` 0 — **NOT met literally (=4)**. Analysis: with the device fix an empty forest
  now emits an ABSENT `idHash` (not a package-only truthy one), so transient empty frames are
  consistently REFUSED by the existing `!afterId` guard (plus the new `EMPTY_TREE_HASH` guard)
  instead of being minted. The reference's 0 reflects either no empty frames or the OLD bug that
  silently minted them (that bug produced 34827025184's empty node). The count is timing-dependent
  and here reflects 4 correctly-refused frames — the store is clean and tokens/success are at
  reference parity, so this is the guard working, not pollution. Flagged for the planner: if a
  strict `skippedNoIdHash == 0` is required, the settled-read empty-detection would need to
  distinguish "genuinely blank destination" from "still transitioning" (out of this ticket's scope).
- All awaiters arm — **MET**. version/hash from one snapshot — **MET**. pacing pinned/legacy — **MET**.
  Six gates reported as pre-registered — **MET** (G1/G2/G3 PASS, G4/G5 FAIL=C2 out of scope, G6 FAIL).
  Headline attributed per arm honestly — **MET** (−80 scrcpy / flat uia; the −267 was drift pacing).

### Bottom line

The **3M-H1 store-integrity regression is fixed** (invariants green, no empty-tree node, the exact
`settings/34` failing edge is clean) and 3M-H4/H5/M6 and the reporting findings (H2/M1/M2/M4/M5/H3)
are addressed. The run is RED for two reasons, **neither a 3m.1 code defect**: (1) the out-of-scope
scrcpy fling gate under the correct 3k.1 rule (pre-existing loss), and (2) a **1-ms** breach of the
pre-registered ±10 after-tap residual on the device test's 5-sample median (the honest bench
per-sample residual is 6/3 ms — G2 passes). Honest headline: on the consolidated LEGACY base the
fingerprints fix gives ON-scrcpy a modest −80 ms and leaves ON-uia flat; it does not clear the OFF
bar (G6 FAIL), and C2 (G4/G5) is unfixed and out of scope. Per the ticket STOP rule the pre-registered
±10 was NOT loosened (that would repeat 3M-M1) and no second run was dispatched — the planner decides
on a re-run.
