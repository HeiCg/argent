# tap+describe(settle:false) regression — root cause

Read-only investigation on `open/main` @ `8cbd3902` (consolidated base: screen-graph-D
merge + outcome-default-off fix + 3k part B).

**Question.** ON `tap+describe(settle:false)` reads 505 ms (uiautomation) / 529 ms
(scrcpy) p50 against OFF (proprietary) 354/297 in run `34813849446`, while the
pre-merge run `33975063607` ("run 7") had ON-scrcpy 298 vs OFF 305. Plain
`gesture-tap` and plain `describe` look "back at parity". Where does the time go?

**Answer.** Two additive causes, both introduced by the screen-graph merge
(`3da4aa7c..5edb4b6c`, device server APK 0.1.20 → 0.1.21):

1. `TreeStore.ensure()` now runs inside every `getState` capture. It is a free
   cache hit while the AX version clock is unchanged (idle describe) and a **full
   extra tree capture** when the clock moved — which is exactly "describe right
   after a tap". It re-introduces `uiAutomation.rootInActiveWindow`, the call
   phase 3g removed from the hot path for blocking 170–210 ms mid-transition.
   It is timed by no stage, so it lands in the capture residual: ≈ +40–50 ms p50.
2. A uniform device-side slowdown of the open-server process, same code and same
   payload: idle `encodeMs` 26 → 36 ms, idle `ping` 0.42 → 0.86 ms. This costs
   ≈ +80 ms on the after-tap read (35 % of 258 ms of stage work) and ≈ +15 ms on
   the idle read. It is also why plain `describe` "reads at parity": ON describe
   went from **36 ms (a win over OFF's 52)** to **53 ms (mere parity)**. The
   parity is the regression, not the exoneration.

The bench did **not** change how `tap+describe` is measured.

---

## 1. Evidence — verb level

`tap+describe` p50 / p95 / mean, N as shown. Source: `bench-block-*.json` → `verbs[]`.

| run                      | arm                   | verb                         | p50       | p95         | mean      | N          |
| ------------------------ | --------------------- | ---------------------------- | --------- | ----------- | --------- | ---------- |
| 33975063607 (pre-merge)  | OFF-1 / OFF-2         | `tap+describe`               | 305 / 313 | 817 / 958   | 393 / 406 | 20 / 20    |
| 33975063607              | ON-scrcpy             | `tap+describe(settle:false)` | **298**   | 810         | 351       | 19         |
| 33975063607              | ON-uiautomation       | `tap+describe(settle:false)` | **455**   | 673         | 469       | 20         |
| 34813849446              | OFF-1 / OFF-2         | `tap+describe`               | 354 / 297 | 831 / 654   | 445 / 356 | 20 / 20    |
| 34813849446              | ON-scrcpy             | `tap+describe(settle:false)` | **529**   | 1029        | 518       | 19 (1 err) |
| 34813849446              | ON-uiautomation       | `tap+describe(settle:false)` | **505**   | 728         | 529       | 19 (1 err) |
| 34806342684              | ON-scrcpy / ON-uiaut. | `tap+describe(settle:false)` | 548 / 518 | 719 / 791   | 551 / 554 | 20 / 20    |
| 34788497583 (outcome ON) | ON-scrcpy / ON-uiaut. | `tap+describe(settle:false)` | 971 / 942 | 1236 / 1072 | 951 / 949 | 20 / 20    |

Neighbouring rows, same blocks:

| run         | arm                   | `describe` p50 | `gesture-tap` p50 | `tap+describe(settle:true)` p50 |
| ----------- | --------------------- | -------------- | ----------------- | ------------------------------- |
| 33975063607 | OFF-1 / OFF-2         | 52 / 52        | 52 / 52           | —                               |
| 33975063607 | ON-scrcpy / ON-uiaut. | **36 / 39**    | 51 / 77           | 774 / 788                       |
| 34813849446 | OFF-1 / OFF-2         | 52 / 52        | 53 / 54           | —                               |
| 34813849446 | ON-scrcpy / ON-uiaut. | **53 / 53**    | 51 / 78           | 842 / 843                       |

Three things fall out of this table.

- **OFF is flat across runs** (305/313 → 354/297, `describe` 52 in all four blocks,
  `gesture-tap` 52–54). The runner is not globally slower; the regression is on the
  ON path. This within-run control is what licenses the cross-run comparison below.
- **`describe` ON lost its 16 ms win** (36 → 53 against an unchanged OFF 52). "Back
  at parity" is a 47 % device-side regression that happens to land on OFF's number.
- **`settle:true` barely moved** (774/788 → 842/843, +9 %) while `settle:false` moved
  +78 % / +11 %. Under a 500 ms quiescence the screen is already settled when the new
  work runs; under `settle:false` it runs mid-transition. That is the signature of
  cause 1, not of a generic slowdown.

## 2. Evidence — stage level

`describeSplitAfterTap` / `describeSplitIdle`, p50 ms, N=10 after-tap / N=20 idle per
arm. `residual` = `captureP50 − Σ p50(rootMs, windowsMs, rootsMs, serializeMs, encodeMs)`
— a proxy, since p50s are not additive, but the only handle the artifacts give on
un-staged capture work.

### ON-scrcpy, describe **after a tap**

| stage                           | run 33975063607 | run 34813849446 | Δ             |
| ------------------------------- | --------------- | --------------- | ------------- |
| `captureMs`                     | **245**         | **374**         | **+129**      |
| `idleMs`                        | 0               | 1               | +1            |
| `rootMs`                        | 116             | 104             | −12           |
| `windowsMs`                     | 0               | 0               | 0             |
| `rootsMs`                       | 90              | 114             | +24           |
| `serializeMs`                   | 43              | 98              | +55           |
| `encodeMs`                      | 9               | 19              | +10           |
| **residual (unstaged capture)** | **−13**         | **+39**         | **+52**       |
| `hostTtfbMs` p50 / p95          | 249 / 660       | 377 / 878       | +128 / +218   |
| `hostRttMs` p50                 | 267             | 379             | +112          |
| `wireBytes`                     | 31 892          | 32 030          | +138 (+0.4 %) |

### ON-uiautomation, describe **after a tap**

| stage         | run 33975063607 | run 34813849446 | Δ       |
| ------------- | --------------- | --------------- | ------- |
| `captureMs`   | 296             | 360             | +64     |
| `rootMs`      | 148             | 204             | +56     |
| `rootsMs`     | 125             | 40              | −85     |
| `serializeMs` | 18              | 61              | +43     |
| `encodeMs`    | 25              | 24              | −1      |
| **residual**  | **−20**         | **+31**         | **+51** |

### Both arms, describe **at idle** (control)

| stage         | run7 scrcpy | 34813 scrcpy | run7 uiaut. | 34813 uiaut. |
| ------------- | ----------- | ------------ | ----------- | ------------ |
| `captureMs`   | 33          | 48           | 35          | 48           |
| `rootMs`      | 1           | 1            | 1           | 1            |
| `rootsMs`     | 1           | 2            | 1           | 2            |
| `serializeMs` | 6           | 7            | 6           | 7            |
| `encodeMs`    | **26**      | **36**       | **27**      | **36**       |
| **residual**  | **−1**      | **+2**       | **0**       | **+2**       |
| `wireBytes`   | 31 886      | 32 020       | 31 886      | 32 020       |

### Back-to-back RPC floor, same blocks (`rpcBreakdowns`, N=20, idle)

| metric                                  | run7 scrcpy / uiaut. | 34788 scrcpy / uiaut. | 34813 scrcpy / uiaut. |
| --------------------------------------- | -------------------- | --------------------- | --------------------- |
| `ping` p50 (no tree work at all)        | 0.42 / 0.50          | 0.63 / 0.67           | **0.86 / 0.82**       |
| `getNestedState` host RTT p50           | 27.6 / 26.2          | 33.8 / 34.3           | 37.0 / 40.2           |
| `getNestedState` server `captureMs` p50 | 25 / 24              | 31 / 31               | 34 / 37               |
| `getNestedState` server `encodeMs` p50  | 17 / 16              | 21 / 21               | 23 / 24               |
| `getNestedState` wireBytes              | 31 886               | 32 018                | 32 021                |

Reading of the split, ON-scrcpy after-tap (+129 ms):

- **+52 ms** unstaged capture residual — new work between `captureStart` and
  `rootStart`. The idle residual stays ≈ 0, i.e. the new work is version-gated.
- **+77 ms** across `rootsMs` + `serializeMs` + `encodeMs`, all untouched code on an
  unchanged payload — the same ≈ 35 % factor the idle read shows in `encodeMs`
  (26 → 36) and `ping` shows (0.42 → 0.86). 35 % of the 258 ms of run-7 stage work
  is +90 ms; observed +77 ms.

Note that `ping` and the idle `encodeMs` are already degraded in **34788497583**, the
same merged tree _before_ the outcome-default-off fix. Cause 2 arrived with the merge,
not with 3k or the outcome fix.

## 3. Ranked candidate causes

### C1 — `TreeStore.ensure()` forced on every `getState` / `getAccessibilityTree` (top cause for the after-tap-only signature)

- `packages/android-device-server/src/main/java/com/argent/devicecontrol/handlers/StateHandler.kt:138`
  — `val snap = TreeStore.ensure()`, unconditional, step 3 of the capture. Added by
  this merge (`git diff 3da4aa7c..5edb4b6c`).
- `StateHandler.kt:114` / `:152` / `:218` — `captureStart` … `rootStart` … `captureMs`.
  `ensure()` sits between `captureStart` and `rootStart`, so it is inside `captureMs`
  but inside **no** reported stage. That is precisely the +52 ms residual.
- `packages/android-device-server/src/main/java/com/argent/devicecontrol/TreeStore.kt:106-145`
  — `ensure()`: returns the cache when `lastBuiltAtVersion == version` (**idle
  describe → free**), otherwise rebuilds.
- `TreeStore.kt:116` — the rebuild reads `ui.rootInActiveWindow`. `StateHandler.kt:146-150`
  states in-tree that this call "blocks ~170-210 ms mid-transition (phase 3g bench)"
  and that the capture path deliberately uses the interactive-windows snapshot
  instead — `NestedWindowSerializer.activeRoot`
  (`.../accessibility/NestedWindowSerializer.kt:92-100`). `TreeStore.ensure()` bypasses
  that fix.
- `TreeStore.kt:123` — `ScreenTree.build(root, w, h)`, a second full traversal of the
  live `AccessibilityNodeInfo` forest (cap 1200 nodes, one binder round-trip per
  child), on top of the capture's own `NestedWindowSerializer.serialize`.
- `TreeStore.kt:134-136` — three hash passes per rebuild
  (`ScreenHash.structural` + `.state` + `.identity`).
- `packages/android-device-server/src/main/java/com/argent/devicecontrol/handlers/HierarchyHandler.kt:93`
  — the same forced `ensure()` on the flat `getAccessibilityTree` path.
- Version gating is what produces the "only after a tap" signature: the AX clock is
  bumped by the event listener (`TreeStore.kt:97-103`), so an idle describe hits the
  cache and a describe following a tap always misses.
- Corroborated by `settle:true` moving only +9 % (774 → 842): with a 500 ms quiescence
  the rebuild runs on a settled tree and `rootInActiveWindow` does not block.

### C2 — process-wide slowdown of the open server in APK 0.1.21

- `packages/android-device-server/assets/manifest.json` / `build.gradle.kts` —
  versionCode 24 → 25, versionName 0.1.20 → 0.1.21 in this range; both benches
  install the APK from the tree under test.
- Measured, same code / same payload: `ping` p50 0.42 → 0.86 ms; idle `encodeMs`
  26 → 36 ms on a 32 KB tree that grew 0.4 %; idle `getNestedState` server capture
  25 → 34 ms. Present already in 34788497583.
- Mechanism is **inference, not measured**: the only new always-on resident in the
  instrumentation process is the AX event listener registered at
  `DeviceControlInstrumentation.kt:73` → `TreeStore.kt:86-94`. Once an
  `OnAccessibilityEventListener` is set, `UiAutomation` clones every event and posts
  it to a handler, and `TreeStore.onEvent()` takes `waitLock` + `notifyAll` per event;
  `TreeStore.kt:54-55,140-141` additionally retain two full `AxNode` forests forever.
  No GC evidence for the `…devicecontrol` process in
  `run34813/.bench-results/logcat-bench.txt` (0 matching "Background concurrent
  copying GC" lines for that process), so the heap-pressure half is **unsupported**.

### C3 — serializer / payload change — REJECTED

`NodeSerializer` and `NestedWindowSerializer` are untouched in `3da4aa7c..5edb4b6c`
(the device-server diff is 16 files: new screen-graph files + handlers). Wire grew
31 886 → 32 021 bytes, the new `hash`/`stateHash`/`idHash`/`version`/`unchanged`/
`truncated` members (`StateHandler.kt:230-244`). +0.4 % of payload cannot be +130 ms.

### C4 — bench measurement change — REJECTED

`git diff 3da4aa7c..HEAD -- packages/tool-server/scripts/bench-open-vs-proprietary.ts`
is −88/+53 and touches only: the F7 no-effect diagnostics
(`bench-open-vs-proprietary.ts:560-620`), the F6 dump short-circuit note
(`:1436-1460`), and the removal of `destinationVisibleRate`, which ran _after_ the tap
rows. The timed window is unchanged: `tapDescribeAt` /
`tapThenDescribeFixed` = tap RPC + describe RPC, locate / effect-poll / BACK outside it
(`bench-open-vs-proprietary.ts:2010-2036`); the after-tap split still calls
`describeSplit(reg, min(N,10), setup = ensureSettings + gesture-tap)` (`:2043-2048`).

### C5 — host-side outcome path still firing — REJECTED for 34806/34813

`packages/tool-server/src/tools/gesture-tap/index.ts:139-151` takes the plain
`openServerTap` branch when `screenGraphRecordingEnabled()` is false. Confirmed by the
artifacts: `gesture-tap` p50 51/78 ms in 34806/34813 versus 965/852 ms in 34788497583,
where the outcome settle was still on and it moved the cost onto the tap
(`describeSplitAfterTap.stages.prevServerHandleMs` p50 544/504 ms there).

## 4. Most likely single cause and mechanism

**`TreeStore.ensure()` on the describe capture path** is the cause of the
after-tap-only shape; C2 is a flat tax on top that the "parity" rows hide.

Mechanism, one `tap` + `describe(settle:false)` pair:

1. The tap injects, the app starts a transition, the AX event listener bumps
   `TreeStore.version` (`TreeStore.kt:97-103`).
2. `describe` issues one `getState({ nested:true, waitTimeoutMs:0 })`. With
   `waitTimeoutMs:0` the handler deliberately does **not** wait for idle, so the
   screen is still transitioning (`StateHandler.kt:110-112`).
3. `StateHandler.kt:138` calls `TreeStore.ensure()`. `lastBuiltAtVersion != version`
   → full rebuild: `rootInActiveWindow` (blocking, mid-transition), `ScreenTree.build`
   over the whole live forest, three hashes. None of this is the tree that ships.
4. Only then does the real capture run — `activeRoot` + `NestedWindowSerializer` —
   traversing the same forest a second time and paying the same mid-transition binder
   costs, now with an extra contender in the process.

At idle, step 3 is a cache hit and the whole thing is invisible. That is the exact
"only when describe follows a tap" boundary the question asks about.

## 5. Proposed fix (contract level, no patch)

1. **Fingerprints become opt-in on the read RPCs.** `getState` / `getAccessibilityTree`
   keep returning `version` unconditionally (a volatile counter, free), but
   `hash` / `stateHash` / `idHash` are computed **only** when the request asks for them
   (`fingerprints: true`, or implicitly when `sinceVersion` is present). Default off ⇒
   the describe hot path never forces a rebuild. Hosts must treat an absent hash as
   "not requested", never as "empty screen" — `EMPTY_TREE_HASH` must not be
   synthesised. Screen-graph consumers already have explicit entry points
   (`describe({tier})`, `awaitChange`, `recordOpenServerObservation`) and opt in there.
2. **If a rebuild ever runs on the capture path, it must share the capture's root.**
   `TreeStore.ensure()` must accept the already-resolved `activeRoot`
   (windows-snapshot, `NestedWindowSerializer.activeRoot`) rather than calling
   `rootInActiveWindow`, so the phase-3g fix is not bypassed, and the forest must be
   traversed once, not twice.
3. **No un-staged work inside `captureMs`.** Add a `fingerprintMs` entry to the
   `timings` object and make the contract explicit: `Σ(stages) ≈ captureMs` within a
   stated tolerance (say 10 ms). Any future step that hides in the residual then fails
   its own gate instead of showing up as "serialize got slower".
4. **The AX event listener is lazy.** Register it on first need (`awaitChange`, an
   outcome-bearing action, or the `screen-graph` flag) and drop it when nothing needs
   the clock, so the default open path runs the 0.1.20 process shape. Contract:
   `version` is `0` and `unchanged` is absent while the clock is not armed; callers
   that need the clock arm it explicitly.

Expected effect: after-tap `captureMs` back to ≈ 250 ms (C1 removed), idle `describe`
back to ≈ 36 ms and `ping` back to ≈ 0.45 ms (C2 removed by item 4), which puts
`tap+describe(settle:false)` back inside the OFF number.

## 6. Verification in one CI run

One `bench-latency` run on a branch carrying items 1–4, reading only artifacts the
bench already emits. Pre-register all six gates before the run:

| gate | metric (source)                                                                                   | threshold            | proves                                       |
| ---- | ------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------- |
| G1   | `describeSplitAfterTap.stages.fingerprintMs` p50, both ON arms                                    | ≤ 5 ms               | fingerprints no longer forced                |
| G2   | `captureP50 − Σ p50(stages)` after-tap, both ON arms                                              | ≤ 10 ms              | nothing left hiding in the residual (item 3) |
| G3   | `verbs[describe].latency.p50`, ON-scrcpy                                                          | ≤ 45 ms (OFF is ~52) | C2 gone; the pre-merge win is back           |
| G4   | `pingP50`, both ON arms                                                                           | ≤ 0.60 ms            | C2 gone, independent of any tree work        |
| G5   | `describeSplitIdle.stages.encodeMs` p50                                                           | ≤ 30 ms              | C2 gone, pure-CPU probe                      |
| G6   | `verbs[tap+describe(settle:false)].p50` ON-scrcpy ÷ `verbs[tap+describe].p50` OFF-1, **same run** | ≤ 1.15               | the headline row, compared within-run only   |

Two cheap additions make the run self-diagnosing and are worth one ticket:

- Have the bench read `getInfo().traversals` (already exposed —
  `packages/android-device-server/src/main/java/com/argent/devicecontrol/handlers/InfoHandler.kt:32-33`)
  immediately before and after each after-tap describe and persist the delta. Expected
  **0** with the fix, **1** on today's build. That turns C1 from an inference off a
  residual into a counted fact, in the same run.
- Emit `timings.rootSource` into the stage table, so a regression back to
  `rootInActiveWindow` is visible.

G3–G5 separate C2 from C1 without a second run: C1 shows up only in the after-tap
residual (G1/G2), C2 only in the idle / no-tree probes (G3/G4/G5).

## 7. Constraints and open items

- **Cross-run comparison.** run 33975063607 vs 34813849446 are different CI runs on
  ubuntu-latest x86_64/KVM (`ci-runner-env.json` matches in both, and both carry the
  "NOT comparable to local arm64/HVF" note). Absolute ms are only as trustworthy as
  the within-run OFF control, which is flat. Any gate written from this doc must be
  **within-run** (G6), not "beat run 7".
- **N is small.** Stage splits are N=10 per arm (`describeSplitAfterTap.n`), verbs
  N=19–20. The after-tap `serializeMs` p95 is 332–333 ms in _both_ runs: the tail is
  dominated by mid-transition variance, so p95 gates on these stages would be noise.
- **Residuals are p50-of-difference, not difference-of-p50.** Every "residual" figure
  here is `p50(capture) − Σ p50(stage)`. The per-sample residual is not in the
  artifacts; that is exactly why item 3 / G2 asks for a `fingerprintMs` stage.
- **34813's two ON `tap+describe(settle:false)` rows are N=19 with 1 error each**
  (`"[Tool:describe] Failed to parse uiautomator dump output"`). That error is on the
  bench's untimed locate fallback, not on the timed path, but the row lost a sample.
- **34788497583 is not stage-comparable.** Its after-tap `wireBytes` is 18 655 versus
  32 030 in 34813 — the outcome-settled describe read a different (settled) screen.
  Use that run only for the "outcome settle moves the cost onto the tap" point
  (`gesture-tap` 965/852 ms, `prevServerHandleMs` 544/504 ms), never for stage deltas.
- **`prevServer*` is keyed by method**, not by connection
  (`JsonRpcHandler.kt:85,94,164-167`): `prevServerHandleMs` on a `getState` reply is
  the _previous `getState`_, never the intervening tap. Any reading of these fields as
  "the tap took 411 ms" is wrong.
- **Unanswered inside this scope.** The mechanism behind C2 is inferred from `ping`
  and idle `encodeMs`; nothing in the artifacts times the event listener or the
  instrumentation heap, and logcat shows no GC activity for that process. Deciding
  between "listener dispatch cost" and "retained `AxNode` forests" needs item 4 shipped
  and G4/G5 read, or a dedicated A/B of the listener registration.
- Run 33975063607's raw JSON was read from the local scratch copy
  (`…/scratchpad/run7/.bench-results/`); no `gh run download` was needed.
