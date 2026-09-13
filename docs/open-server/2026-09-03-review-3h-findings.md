# Adversarial review — phase 3h (section A of the 3h/3i/C.3 ticket)

Reviewed read-only in throwaway worktrees off `HeiCg/argent`:
code `feat/android-open-server-p3h` @ `0c9666cf`, CI `feat/bench-ci-3h` @ `dcc25a2f`.
Artifacts: runs **33812265077** (green, headSha `dcc25a2f`), **33804707586**
(`3d96bb42`, device 15/17), **33790646124** (`b71b13cd`). No local device used.

## Verdict: ACCEPT-WITH-CAVEATS

The deliverable stands — the scrcpy fast-inject tap **lands** and is **faster than
the open UiAutomation tap** — but the proprietary (OFF) rows of run 33812265077
are **VOID** and must be requalified from run 33804707586. The OFF arm of the green
run is degraded well beyond the missing effect check, and the scoreboard's effect
gate passes vacuously on an unarmed block.

---

## Findings

### Blocking

**A1 — HIGH — the OFF arm of run 33812265077 is degraded, not merely unarmed.**
`bench-block-OFF-1.json`: `await-screen-idle` p50 **4028** ms and `await-ui-element`
p50 **4029** ms (N=20, cap 4000) — every iteration hit the timeout. The same verbs
read 505/80 in OFF-2 of the same run and 494–511 / 72–84 in **both** OFF blocks of
runs 33790646124 and 33804707586. `await-ui-element` used `selector="Settings"`
(block JSON `verbs[].extra`), so the screen was not Settings, despite
`ensureSettings` at `bench-open-vs-proprietary.ts:1061`. OFF-2 of the same run
carries `"paste: could not locate Settings search field; measured on current focus"`
with paste p50 **71** ms vs 480–850 elsewhere. Both OFF blocks were on the wrong
screen for part of the block. *Fix:* rerun; do not quote OFF rows from this run.

**A2 — HIGH — the effect gate passes vacuously on an unarmed block.**
`.github/bench-ci/scoreboard.js:159-168` prints only the numerator ("no-effect taps
| 0") and computes `effect gate … PASS` from `effectZeroByBlock` alone. OFF-1 and
OFF-2 rendered "0" while truly 0/0. `merge-blocks.js:74-82` gates only
`effectZeroTotal > 0` on ON blocks; nothing requires `effectCheckedTotal > 0`
anywhere. *Fix:* print `zero/checked`; gate on `checked > 0 && zero === 0`.

**A3 — HIGH — "the proprietary root did not yield a parseable nav target" is a
description, not a cause; the derive is flaky, not structurally OFF-only.**
The same code armed OFF at **0/24 + 0/24** (run 33790646124, both blocks,
target "Network & internet") and **0/40** (OFF-2, run 33804707586). Both backends
render through the same formatter (`describe/format-tree.ts:105`, frame always
appended), and the OFF-1 `fidelitySet` of the green run contains
`text:Network & internet / Mobile, Wi‑Fi, hotspot`, which the prefix match at
`bench-open-vs-proprietary.ts:676-686` accepts. `deriveNavTarget` is **single-shot**:
any throw at line 664 or 694 returns null and silently disarms the entire block
(`:923-943`), downgraded to a note. Tolerating this as an OFF property is wrong.

### Material

**A4 — MED — the ON tap-only row excludes work the ON-uia row pays inline.**
The `flushInput` fold exists **only** in the scrcpy branch
(`blueprints/android-open-server.ts:621, 688-703`): after a fast-inject the drain is
deferred to the next read via `flush:true`. The UiAutomation tap RPC drains inline.
The bench's timed window is the tap RPC only (`:470-479`), so scrcpy's post-inject
settle is moved out of the measured row and into the untimed effect-check describe.
Corroborated in the 33804707586 logcat: 2 ms after each scrcpy UP the dispatcher
logs `Dropping event because the pointer is not down … action=CANCEL` +
`InputManager: Input event injection from pid 7506 failed` (line 16931-16932). The
fold's cost is visible in `tap+describe`, where the scrcpy win does not survive:
green run ON-scrcpy 494 vs ON-uia **477** (scrcpy 17 ms slower).

**A5 — MED — an assertion was removed, not made robust: the flushInput ordering
check.** Old `3f-tap→describe` asserted two things per iteration —
`settleHits === 20` **and** `quickHits === 20`, the latter being "a quick describe
right after the tap already reflects the post-UP screen". The new test issues
`getNestedState({waitTimeoutMs:300}).catch(() => undefined)` and never inspects it
(`android-open-server.device.test.ts:915-919`); only the ≤3 s poll is asserted.
Nothing on-device now verifies the ordering guarantee that A4 shows the tap row
depends on. The v9 text "the fixes were oracle/readiness, never a loosened numeric
bound" does not cover this.

**A6 — MED — the pinch assertion is now conditional and still records PASS.**
`expect(ratio).toBeGreaterThan(0.02)` runs only `if (ready)`; otherwise the test
logs and records PASS (device test diff, 3f gesture-pinch). In run 33812265077
`ready=true` (device-test.log:29, 2.90%) so this run is clean, but "17/17" can in
principle include a pinch that verified nothing.

**A7 — MED — 3k bound 50 → 200 ms is a 4× loosening with no observed failure
behind it.** `expect(dt).toBeLessThan(50)` → `GATE_MS = 200`. Worst observed:
**20 ms** (33812265077), **45 ms** (33804707586), **19 ms** (33790646124). No run in
hand exceeded 50. The test title still reads "each < 50ms"
(`android-open-server.device.test.ts:689`) — the name now lies about the gate.

**A8 — MED — the focus assertion does not assert what its comment claims.**
`foregroundFocus` returns `mCurrentFocus` **and** `mFocusedApp` joined
(`:107-112`, `grep -m2`), and the assert is
`expect(focus).toMatch(/com\.android\.settings/)` (`:871`, `:912`). It passes when
only `mFocusedApp` mentions Settings — exactly the early-flip state the comment says
it excludes. The real fix is the `am start -n …/.Settings` + `rooted` label poll in
`fiHome` (`:762-790`); the assert adds little.

### Minor

**A9 — LOW — one ON-scrcpy iteration was dropped with no recorded reason.**
`tap+describe(settle:false)` has `n=19, errors=1`; hence `effectZero 0/**59**`
(20+19+20) vs `0/60` for ON-uia. `timeTapEffect` swallows the error
(`:475-479`, bare `catch { errors++; }`), as does `timeCalls` (`:390-392`). The
failure mode is unrecoverable from the artifacts.

**A10 — LOW — the tap-timeline parity record is authored, not observed, for two of
three backends.** `describeInjectedTapTimeline` (`utils/bench-gesture-parity.ts:51-75`)
rebuilds the scrcpy timeline from the real `buildTapTimeline`, but returns a
hard-coded `[Down@0, Up@holdMs]` literal for `uiautomation` and `proprietary`, with
`holdMs` from the bench-local `BENCH_GESTURE_PARAMS` (`:106-110`). For those two
blocks "frames 2, holdMs 50" is true by construction. The underlying constants are
in fact 50 (`tools/gesture-tap/index.ts:60`, `utils/open-server-input.ts:21`), and
the logcat shows real DOWN→UP gaps of 49–50 ms, so the claim is true — but the gate
is not what proves it.

**A11 — LOW — the "host process: none beyond adb" note on ON blocks is a hard-coded
string** (`bench-open-vs-proprietary.ts:1166`); `simServerRssKb()` runs only for OFF
(`:1165`). The file header (`:10-14`) claims the bench "checks the simulator-server
host process — so a masked fallback is visible". It does not, for ON.
Compounding: `console.debug` is replaced and **not** forwarded to stdout (`:105-109`),
and `fallbackCountSince` (`:116-119`) matches only `[open-server-fast-inject]`, so a
tool-level `[gesture-tap] open-device-server failed, falling back to simulator-server`
(`tools/gesture-tap/index.ts:133-137`) would leave no trace. Not a live problem this
run — that path requires the Kotlin tap to fail too, and `fastInjectFallbacks = 0`.

**A12 — LOW — the fling gate is aggregate-only and non-blocking.**
`merge-fling.js:40-66` judges the **median of per-cell ratios**; `:84-88` downgrades a
FAIL to `::warning::`. Of the 6 informative cells, **2 are far outside ±0.15**
(250 ms/0.5 → **1.577**; 400 ms/0.5 → **0.614**). The aggregate lands on exactly
1.000 only because the two middle cells are byte-identical (0.175/0.175 and
0.299/0.299). The doc's "1.000 ± 0.15 over 6 cells" needs "aggregate median,
per-cell 2/6 out of tolerance, gate non-blocking".

### Confirmed as claimed

- **Effect check is outside the timed window in every armed block.** Timed = the tap
  RPC(s) only; fingerprint poll (≤3 s), BACK restore and `originLost` hard-reset are
  untimed (`bench-open-vs-proprietary.ts:459-494`). Target and fingerprint are derived
  identically per block; the ON gate is fatal (`merge-blocks.js:74-82`).
- **`fastInjectFallbacks = 6` explained.** `fallbackCountSince` (`:116-119`) now
  requires `[open-server-fast-inject].*falling back`, which cannot match
  `[describe.android] … falling back to uiautomator dump`. Counter is 0 in every
  block of the green run, and `merge-blocks.js:86-96` throws on any ON-scrcpy
  fallback.
- **Injector exoneration.** Run 33804707586 logcat: scrcpy tap @407,860 DOWN
  `eventTime=350123` → UP `350172` (49 ms) and @407,860 `358638` → `358688` (50 ms);
  UiAutomation @377,660 `287223` → `287273` (50 ms). All show `deviceId=-1`,
  `source=0x1002`, `toolType=TOOL_TYPE_FINGER`, `buttonState=0`, `flags=0x0`.
  Caveat: the quoted lines are `TaplEvents / TouchInteractionService.onInputEvent`,
  not `InputReader`/`InputDispatcher`, and injected events carry no intrinsic
  producer marker — the attribution is by coordinate and time correlation.
- **MOVE reverted.** `scrcpy-inject-timeline.ts` builds a bare two-frame DOWN→UP;
  `hasMoveFrame=false` in all four block JSONs.
- **Enforcement is real.** `bench-open-vs-proprietary.yml:249-257` keeps
  `continue-on-error: true` (the inline comment "continue-on-error is gone" is stale),
  but `:403-412` `if: always()` fails the job on
  `steps.devtest.outcome == 'failure'`. Run 33812265077: devtest step conclusion
  `success`, 17/17 (device-test.log:120). Bench blocks run under `set -eo pipefail`
  with `PIPESTATUS` propagation (`:298-300`, `:271-284`). OFF blocks are best-effort
  (`:313-320`) — a warning, not a failure.
- **fiHome fix** (`am start -n …/.Settings` + poll `mCurrentFocus` **and** a rendered
  root) turned 18/20 (33804707586, `expected 18 to be 20`) into 20/20.
- **typeText retry-once** does not weaken the end assertion — the URL must still be
  read back out of the field before `urlVia` is set.
- **Swipe anchor-displacement oracle** is stronger than the saturating pixel diff
  (7.03 % vs 7.09 %); green run 810 px fling > 653 px momentum-free
  (device-test.log:90,93). One caveat: if the anchor scrolls off-screen the code
  substitutes `beforeTop - screenHeight` (`:1017`), i.e. a maximal displacement,
  which biases the fling arm toward passing. It did not fire here (both < 2400).

---

## Scoreboard-grade numbers

Statistic p50/p95 in ms. **Every row below must carry its run id and label.**

| claim | value | block | N | run | label required |
| --- | --- | --- | --- | --- | --- |
| gesture-tap, open scrcpy | **51 / 52** | ON-scrcpy | 20 | 33812265077 | effect-checked 20/20, fallbacks 0 |
| gesture-tap, open UiAutomation | **83 / 125** | ON-uiautomation | 20 | 33812265077 | effect-checked 20/20 |
| gesture-tap, proprietary | **53 / 61** | OFF-2 | 20 | **33804707586** | effect-checked 0/40, target "Network & internet" |
| tap+describe, proprietary | **645 / 1194** | OFF-2 | 20 | **33804707586** | destination-visible 0/20 |
| tap+describe settle:false, open uia | **638 / 890** | ON-uiautomation | 20 | **33804707586** | destination-visible 0/20 |
| tap+describe settle:false, open scrcpy | **571 / 725** | ON-scrcpy | 20 | **33804707586** | destination-visible 0/20 |
| fling parity | aggregate median **1.000** | — | 12/cell | 33812265077 | 6 informative cells, **2 outside ±0.15**, gate non-blocking |
| device suite | **17/17** | — | — | 33812265077 | enforced by the `if: always()` gate |

**VOID from run 33812265077:** every OFF row (A1). Specifically void as a proprietary
baseline: gesture-tap 53/59 and 53/60, tap+describe 640/1077 and 598/828,
await-screen-idle 4028, await-ui-element 4029, paste 850/71.

**Not scoreboard-grade as stated:** ON-scrcpy 51 "beats OFF 53". The margin is 2 ms
against an OFF-1↔OFF-2 p50 drift of **0 ms** on this verb but an OFF baseline drawn
from a degraded block. Using the requalified OFF (53/61, run 33804707586, armed) the
sign survives and the honest statement is **p95 52 vs 61**, not the p50 pair.

**Noise floor, OFF-1 vs OFF-2 p50, run 33812265077:** describe 1, gesture-tap 0,
gesture-swipe 1, gesture-pinch 8, tap+describe 42 — and await-screen-idle 3523,
await-ui-element 3949, paste 779 (A1; those three rows void). ON−OFF differences
that clear the floor: describe **+52** (ON slower), gesture-tap ON-uia **+30**
(slower), gesture-swipe ON-scrcpy **−41**, gesture-pinch ON-scrcpy **−43**.
ON-scrcpy gesture-tap −2 does **not** clear the p50 floor; it clears it at p95.

## The exact change needed to arm the OFF effect check

In `packages/tool-server/scripts/bench-open-vs-proprietary.ts`:

1. **Derive the target off a source independent of the backend under test.**
   Replace the `reg.invokeTool("describe")` at `:664` (root) and `:694` (settled
   destination) with an untimed helper that reads `adb -s $SERIAL shell uiautomator
   dump /dev/tty`, matches `NAV_CANDIDATES` against `text=`/`content-desc=`, and
   converts `bounds=[l,t][r,b]` to normalized centre coordinates. The timed tap keeps
   going through `reg.invokeTool("gesture-tap")` on the proprietary path, so nothing
   about the measurement changes — only the oracle stops depending on the backend
   being measured.
2. **Use the same source for `fingerprint()`** (`:930`, `describeLabelHash` at `:801`)
   so OFF and ON effect checks have identical sensitivity. Today an OFF fingerprint
   would come from the proprietary describe and an ON one from the open describe.
3. **Retry the derive.** Wrap steps 1–2 in a 3-attempt loop with `ensureSettings`
   between attempts, mirroring `cleanSettingsDescribe` (`:300-320`). A single throw
   must not disarm a whole block.
4. **Make a disarm loud.** `merge-blocks.js`: fail when a block ran tap verbs and
   `effectCheckedTotal === 0`. `scoreboard.js:159-168`: print `effectZero/effectChecked`
   and compute the gate as `checked > 0 && zero === 0`.
5. **Record the discarded iteration.** In `timeTapEffect`/`timeCalls`, push the error
   message into a `errorSamples: string[]` on the verb result (A9).
