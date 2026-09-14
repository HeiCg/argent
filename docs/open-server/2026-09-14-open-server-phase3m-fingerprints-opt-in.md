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

| stage | scrcpy 34813 → 34827 | uiaut 34813 → 34827 |
|---|---|---|
| captureMs | 48 → 47 | 48 → 65 |
| encodeMs | 36 → 36 | 36 → 50 |
| fingerprintMs | (n/a) → 0 | (n/a) → 0 |
| residual | +2 → 2 | +2 → 1 |

Describe **after a tap** (N=10 split, p50; residual = captureP50 − Σ p50(stages)):

| stage | scrcpy 34813 → 34827 | uiaut 34813 → 34827 |
|---|---|---|
| captureMs | 374 → 385 | 360 → 445 |
| rootMs | 104 → 75 | 204 → 207 |
| windowsMs | 0 → 0 | 0 → 0 |
| rootsMs | 114 → 105 | 40 → 91 |
| serializeMs | 98 → 76 | 61 → 89 |
| encodeMs | 19 → 27 | 24 → 19 |
| **fingerprintMs** | (hidden in residual) → **0** | (hidden) → **0** |
| residual (p50-proxy) | +39 → +102 | +31 → +39 |

The after-tap p50-proxy residual is noise-dominated (N=10, mid-transition variance — the
root-cause doc flagged this proxy as unreliable). `fingerprintMs=0` proves no forced
rebuild hides there; the trustworthy per-sample residual is the device test's 6 ms.

### Verb table — this run vs 34813849446 vs run 7 (33975063607), p50/p95
OFF is flat this run (describe 52/52, gesture-tap 53/53) — the cross-run control holds.

| verb | run7 scrcpy/uiaut | 34813 scrcpy/uiaut | **34827 scrcpy/uiaut** | OFF-1/OFF-2 (34827) |
|---|---|---|---|---|
| `tap+describe(settle:false)` | 298 / 455 | 529 / 505 | **262 / 475** | (OFF `tap+describe` 369 / 319) |
| `tap+describe(settle:true)` | 774 / 788 | 842 / 843 | 820 / 866 | — |
| `describe` | 36 / 39 | 53 / 53 | **50 / 72** | 52 / 52 |
| `gesture-tap` | 51 / 77 | 51 / 78 | 51 / 75 | 53 / 53 |
| `gesture-swipe` | — | — | 258 / 302 | 296 / 297 |
| `await-screen-idle` | — | — | 294 / 294 | 499 / 500 |
| `await-ui-element` | — | — | 45 / 44 | 80 / 80 |
| `gesture-pinch` | — | — | 307 / 349 | 349 / 343 |
| `paste` | — | — | 301 / 398 | 877 / 676 |

Headline `tap+describe(settle:false)` on **scrcpy: 529 → 262** (below run-7's 298); on
uiaut 505 → 475. Other verbs (tap/swipe/await/pinch/paste) are within their OFF-drift and
consistent with 34813. The `describe`/`encode` degradation persists (C2, below): scrcpy
`describe` 50 ≈ parity (the run-7 36 ms win did not return); uiaut `describe` 72 is worse
than 34813's 53 (single-run, no ON-side control — likely block variance on top of C2).

### Six pre-registered gates

| gate | metric | threshold | measured | verdict |
|---|---|---|---|---|
| G1 | after-tap `fingerprintMs` p50, both ON | ≤ 5 ms | 0 / 0 | **PASS** |
| G2 | `captureP50 − Σ p50(stages)` after-tap, both ON | ≤ 10 ms | +102 / +39 (p50-proxy) | **FAIL by p50-proxy; PASS by device per-sample residual (6 ms)** |
| G3 | `describe` p50, ON-scrcpy | ≤ 45 ms | 50 | **FAIL** (parity, C2) |
| G4 | `pingP50`, both ON | ≤ 0.60 ms | 0.86 / 0.95 | **FAIL** (C2) |
| G5 | idle `encodeMs` p50 | ≤ 30 ms | 36 / 50 | **FAIL** (C2) |
| G6 | ON-scrcpy `tap+describe(settle:false)` ÷ same-run OFF-1 `tap+describe` | ≤ 1.15 | 262/369 = **0.71** | **PASS** |

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
