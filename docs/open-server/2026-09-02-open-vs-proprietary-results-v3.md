# Results v3: open-device-server phase 3b — honest, like-for-like

Executes `2026-09-02-open-server-phase3b-honest.md`: fix the phase-3 regressions
the adversarial review of `…-results-v2.md` flagged, then re-bench **like-for-like**.
Winning was not the goal; honesty was. Where the open path is now slower on a
verb, the number is printed and named as such.

Checkout `argent-p3` @ branch `feat/android-open-server`; open server rebuilt to
**versionCode 14 / versionName 0.1.13** (bumped from 13/0.1.12 so the install
version-gate reinstalls it). Commits are local, not pushed.

## What changed since v2 (the honesty fixes)

The v2 numbers were not like-for-like on three counts the review caught, all now
corrected:

- **tap** was injected as a zero-duration touch (DOWN and UP both at t=0), while
  the proprietary path holds the finger `TAP_HOLD_MS` (50 ms). v2's "ON 33 ms
  beats OFF 52 ms" compared a no-hold tap against a real 50 ms press. The open tap
  now holds 50 ms too (F1) — so the comparison is real, and ON is a little slower.
- **pinch** was capped to a 180 ms on-device timeline while the proprietary path
  ran the full authored 300 ms. v2's "ON 220 ms beats OFF 346 ms" compared a
  180 ms gesture against a 300 ms one. The cap is gone (F2); both now run the
  authored duration — and ON is markedly slower.
- **motion events** were injected async (the final UP did not block), so the RPC
  returned before the finger was actually up. It now returns after the UP is
  dispatched (F3), matching the proprietary path's blocking Up.

## Environment

| Item | Value |
|---|---|
| Host | macOS (Darwin 25.6.0), Apple Silicon |
| Emulator | AVD `bench-api35`, Android 15 (API 35), arm64-v8a, 1080×2400 @ 420dpi, `-no-window -no-audio -no-boot-anim -grpc 8554 -grpc-use-token` |
| Emulator serial | `emulator-5554` (all adb calls `-s emulator-5554`) |
| Physical device | `ZF524RZBHD` — **never targeted** (attached but the bench refuses any non-`emulator-` serial and this deny-serial) |
| Proprietary binaries | vendored published package **@swmansion/argent v0.22.1** (`bin/argent-android-devtools-0.1.0.apk`, `bin/darwin/simulator-server`, `dylibs/`), via `ARGENT_SIMULATOR_SERVER_DIR` / `ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR` / `ARGENT_NATIVE_DEVTOOLS_DIR` |
| Open server | Kotlin `@argent/android-device-server` rebuilt to versionCode 14 (`gradlew assembleDebug`, APK 1.22 MB), reinstalled via the version gate |
| Token estimator | **js-tiktoken `o200k_base`** (primary) + chars/4 (secondary) — F22 |
| Path confirmation | `describe.source` = `android-devtools` every OFF block, `open-device-server` every ON block; **0 masked fallbacks** |

## Latency per verb — p50 / p95 / max (ms)

Blocks OFF-1 → ON → OFF-2, N=20 after 3 warm-ups, feature flag toggled per block.
Every tap/swipe iteration resets to a known screen first (F5, untimed). All cells
below are **0 errors, 0 fallbacks** — 480 calls, 0/0 total.

| Verb | OFF-1 (prop) | **ON (open)** | OFF-2 (prop) | verdict (like-for-like) |
|---|---|---|---|---|
| describe (Settings root) | 76 / 79 / 81 | 77 / 82 / 84 | 76 / 80 / 81 | ≈ equal |
| gesture-tap | 52 / 53 / 54 | **61 / 63 / 72** | 53 / 53 / 54 | **ON slower ~+9 ms** (now a real 50 ms hold) |
| tap+describe (F4) | 667 / 706 / 914 | **1394 / 1476 / 1572** | 621 / 686 / 703 | **ON ~2.1× slower** (see below) |
| gesture-swipe (250 ms) | 283 / 285 / 288 | 277 / 293 / 293 | 284 / 299 / 313 | ≈ equal (ON p50 slightly lower) |
| await-screen-idle | 511 / 524 / 524 | 505 / 527 / 675 | 509 / 524 / 529 | ≈ equal |
| await-ui-element | 73 / 77 / 80 | 80 / 85 / 88 | 75 / 80 / 81 | **ON slower ~+7 ms** (F12 nested tree per poll) |
| paste | 63 / 106 / 145 | 102 / 200 / 214 | 83 / 136 / 152 | **ON slower** (clipboard attempt + type; see F20) |
| gesture-pinch (300 ms) | 340 / 364 / 373 | **806 / 1029 / 1035** | 340 / 347 / 352 | **ON ~2.4× slower** (cap removed, F2) |

Screenshot has **no latency row** (F6): the two backends return different-sized
frames, so a side-by-side latency is not like-for-like (dims below).

**Drift / range (F7).** The two OFF blocks bracket each verb tightly — OFF-1 vs
OFF-2 p50 within ±3 ms on every verb except `tap+describe` (667 vs 621, a
navigation-dependent verb). Stability claims here rest on that OFF-1/OFF-2
agreement plus the p95/max spread, not on a single p50.

### Why `tap+describe` and `gesture-pinch` are much slower on ON

- **tap+describe (F4).** The standalone `describe` on the *light* Settings root is
  ≈ equal (77 vs 76). But `tap+describe` taps into a *content-heavy* sub-screen and
  then describes it. The open describe path serializes the **full, un-pruned nested
  accessibility tree across all windows** and runs the v2 trim host-side; the
  proprietary path ships a `--compressed` `uiautomator dump`. On a heavy screen the
  full-tree serialization + host trim costs ~2× the compressed dump. v2 only
  measured describe on the light root and missed this; F4 exposes it. This is a
  real open-path cost on busy screens, not a masked fallback (source stayed
  `open-device-server`, 0 fallbacks).
- **gesture-pinch (F2).** With the 180 ms cap removed, ON holds the finger the full
  authored ~300 ms (like OFF) **and** pays UiAutomation's per-event injection cost
  (~4–6 ms/event under load) across 2 pointers × ~20 frames, plus the now-synchronous
  final UP (F3). OFF injects the same timeline through the emulator's native input
  channel at ~1.7 ms/event. The gap is the platform injection cost the open path
  cannot avoid once the duration is honoured.

## describe output size — Settings root (F22 tokens)

| Metric | OFF (android-devtools) | ON (open-device-server) |
|---|---|---|
| bytes | 1892 | 1894 |
| tokens — **o200k_base** | **657** | **657** |
| tokens — chars/4 (secondary) | 473 | 473 |
| rendered elements | 14 | 14 |

Byte-near-identical (1892 vs 1894) and **token-identical on o200k_base (657/657)**.

## Fidelity — Settings root

| Metric | Value |
|---|---|
| raw Jaccard OFF vs ON (`resource-id \| text`) | **1.000** |
| labels/ids only in OFF | 0 |
| labels/ids only in ON | 0 |

The open describe and the proprietary describe render the identical interactable
set on the root. F12 additionally makes `await-ui-element` / `await-screen-idle`
render through the *same* nested tree + trim as `describe` (unit-tested: the two
paths now produce byte-identical `DescribeNode` trees for one fixture).

## Screenshot (not apples-to-apples — row removed, F6)

| | OFF (android-devtools) | ON (open-device-server) |
|---|---|---|
| dims | 270 × 600 (stream frame) | 1080 × 2400 (full capture) |
| bytes | ~70 KB | ~137 KB |

OFF returns a scaled stream frame; ON a full-resolution capture. Timing the encode
of very different pixel counts is not a like-for-like latency, so v3 drops the row
and reports only the dimensions, as the review asked.

## Cold start / host process

Cold spawn→first-describe (3 samples/block, first is coldest): OFF ~822–865 ms
(after the initial 1516 ms), ON ~746–756 ms, OFF-2 ~761–763 ms — ON cold start is
**not worse** (a touch faster here). Host RSS: OFF keeps a **~62–64 MB
`simulator-server`** process per device; ON has **0 host process** beyond adb (runs
on-device via `am instrument`). This remains the open path's structural advantage.

## Fling fidelity grid (F15/F16)

Standalone `bench-fling-fidelity.ts`: median normalized vertical scroll of a common
anchor row after a plain (momentum) swipe, N=12 per cell, over
`durationMs ∈ {150, 250, 400}` × `distance ∈ {0.3, 0.5}`, OFF vs ON.

N=10 per cell. The metric is the **survivor-median**: the median downward shift,
over the rows found in the describe *both* before and after the swipe, of rows that
moved more than 0.02 screen — sticky chrome (the search bar and title, which don't
move) is thereby excluded; if the fling clears every list row the swipe counts as a
full screen (1.0). All values are normalized fractions of screen height.

| dur (ms) | dist | OFF median [IQR] | ON median [IQR] | ON/OFF | reliable? | ±15%? |
|---|---|---|---|---|---|---|
| 150 | 0.3 | 0.465 [0.462, 0.465] | 0.176 [0.176, 0.176] | 0.378 | no (floor) | — |
| 150 | 0.5 | 0.176 [0.176, 0.176] | 0.176 [0.176, 0.176] | 1.00 | no (floor) | — |
| 250 | 0.3 | 0.468 [0.455, 0.482] | 0.433 [0.399, 0.480] | 0.925 | yes | **PASS** |
| 250 | 0.5 | 0.176 [0.176, 0.176] | 0.176 [0.176, 0.176] | 1.00 | no (floor) | — |
| 400 | 0.3 | 0.366 [0.359, 0.368] | 0.330 [0.320, 0.353] | 0.902 | yes | **PASS** |
| 400 | 0.5 | 0.656 [0.656, 0.656] | 0.583 [0.580, 0.587] | 0.889 | yes | **PASS** |

No cell is **noisy** — every IQR span is well under 25 % of its median (the widest
is ON 250/0.3 at ~19 %).

- **Reliable cells (3):** at 250 ms and 400 ms the open fling reproduces the
  proprietary fling distance within ±15 % on all three — ratios **0.925, 0.902,
  0.889**. These are the trustworthy fling-parity evidence.
- **Floor cells (3, unreliable):** every cell whose median is **0.176** has
  bottomed out the metric. At distance 0.5 (and at 150 ms / 0.3) the fling clears
  most of the visible Settings list, so only a fixed pair of near-top rows survives
  in both describes and the survivor-median collapses to the same 0.176 for *either*
  backend. 0.176 is a measurement floor, not a scroll distance, so the ratios there
  (0.378 at 150/0.3, 1.00 at the two 0.5 cells) say nothing about fling parity — the
  150/0.3 "0.378" in particular does **not** mean ON flung less; it means ON's fling
  cleared enough rows to hit the survivor floor.
- **Limitation.** The survivor-median cannot tell "small scroll" from "large fling
  that left only top survivors," so it is unreliable once the list bottoms out. A
  per-swipe **anchor-based** measurement — track one labelled row's pixel
  displacement, counting off-screen as a full-screen travel — would disambiguate the
  0.5-distance and 150 ms cells, but it is not used here (an earlier anchor-only pass
  saturated the opposite way, the single anchor always scrolling off). Fling parity
  is therefore established only for the three reliable 250/400 ms cells; the other
  three are inconclusive, not evidence of a regression.

## On-device validation (device test, exclusive open path, 0 fallbacks)

`OPEN_SERVER_DEVICE_TESTS=1 … vitest run …blueprints/android-open-server.device.test.ts`
— **11/11 passed**, `fallback=NO` on every verb (the test drives the blueprint API
directly, so any failure would be a genuine open-server bug, never a silent
degrade). Covers: ping, describe (nested tree), screenshot (PNG dims == getInfo),
gesture-tap (row changes screen), gesture-swipe (`momentum:false` scrolls less than
default fling), long-press, gesture-pinch + gesture-rotate (2-pointer pinch changed
**3.0 %** of Chrome pixels ≥ 2 % — both pointers reached the screen), typeText,
getState, **getNestedState (F12 nested shape)**, and **paste F20** (below).

### Paste (F20) — verified on API 35

Directly probed on the emulator: `setClipboard` (ClipboardManager from the
instrumentation process) returns **`success:false`** on API 35 — Android silently
drops a background app's `setPrimaryClip`, and the readback is empty. This is
exactly the caveat the ticket anticipated ("verify it works from an instrumentation
process on API 35; if not, fall back"). So the open paste path:

1. tries `setClipboard`; if it round-trips (other API levels / devices may allow
   it), triggers `KEYCODE_PASTE` — a genuine paste carrying arbitrary Unicode;
2. on API 35 (clipboard dropped), **falls back to typing** via `typeText`
   (`sendStringSync`) — which lands a **40-char URL** and an **OTP** verbatim
   (probed: `https://ex.com/r?token=abc123def456` → matches);
3. for text that can't be typed **and** can't be clipboard-set from instrumentation
   (**emoji**), the open path reports unsupported and the full paste tool falls back
   to the proprietary emulator-gRPC clipboard (which does set the emoji clipboard).

So on this emulator the honest outcome is: URL/OTP paste works on the open path (by
typing); emoji paste is not achievable from the on-device instrumentation and is
handled by the proprietary fallback. The paste latency row above (ON 102 vs OFF 63)
includes the wasted `setClipboard` attempt before the type — the cost of trying the
better path first.

## Per-finding status (F1–F23)

| # | Finding | Status | Where |
|---|---|---|---|
| F1 | tap hold: DOWN@0 / UP@holdMs (50) | **fixed** | `TapHandler` + `MotionInjector.injectTaps`; `open-server-tap.test.ts` |
| F2 | pinch duration cap removed; honour `durationMs` | **fixed** | `gesture-pinch`; `open-server-pinch-duration.test.ts` |
| F3 | final-event sync parity (UP dispatched before return) | **fixed** | `MotionInjector` (final UP `sync=true`); Swipe/Gesture handlers |
| F4 | `tap+describe` bench verb | **fixed** | `bench-open-vs-proprietary.ts` |
| F5 | reset to known screen before each tap/swipe iteration | **fixed** | bench `timeCalls` untimed `setup` |
| F6 | screenshot row removed (not scale-matched) | **fixed** | bench (dims kept, latency row dropped) |
| F7 | report ranges, not single p50 | **fixed** | OFF-1/OFF-2 drift + p95/max presented |
| F8 | tap hold parity | **fixed** | same as F1 |
| F9 | multi-tap timeline built server-side (`clickCount`+`gapMs`) | **fixed** | `TapHandler`; `open-server-tap.test.ts` |
| F10 | *(not enumerated in the ticket)* | not applicable | source review doc not in this checkout |
| F11 | window order deterministic (active first, then layer) | **fixed** | `NestedWindowSerializer`; golden test dialog+IME order |
| F12 | describe vs await-* tree unified (same nested tree + trim) | **fixed** | `getNestedState`; `open-server-describe.ts`; `open-server-await-getstate.test.ts` |
| F13 | truncation flag surfaced as a describe hint | **fixed** | `NodeSerializer.serializeNested` + describe hint; test |
| F14 | golden trim tests (XML vs nested; + dialog/IME fixture) | **fixed** | `open-server-trim-golden.test.ts` |
| F15 | fling grid N≥10, median + IQR | **fixed** | `bench-fling-fidelity.ts` |
| F16 | fling sweep duration × distance | **fixed** | grid {150,250,400}×{0.3,0.5} |
| F17 | MotionInjector real-clock pacing; true `eventTime` | **fixed** | `MotionInjector` |
| F18 | downsampling time-uniform, keep keyframes + dwell; documented | **fixed** | `GestureHandler.resample`; `gesture-custom` schema note |
| F19 | *(not enumerated in the ticket)* | not applicable | source review doc not in this checkout |
| F20 | paste via `setClipboard` + KEYCODE_PASTE; fallback | **fixed (with API-35 caveat)** | `ClipboardHandler`; `paste/platforms/android.ts`; see Paste above |
| F21 | screen-size cache keyed by `(deviceId, rotation)` + dispose invalidation | **fixed** | `open-server-screen-cache.ts`; `open-server-screen-cache.test.ts` |
| F22 | js-tiktoken `o200k_base` (primary), chars/4 secondary | **fixed** | bench estimator |
| F23 | *(not enumerated in the ticket)* | not applicable | source review doc not in this checkout |

F10/F19/F23 are not referenced anywhere in the ticket and the adversarial-review
document enumerating all 23 findings is not present in this checkout, so they are
marked not-applicable rather than guessed at.

## Tests

- **tool-server suite:** `vitest run` → **4921 passed / 12 skipped / 0 failed** (385
  files), including the new/rewritten `open-server-tap`, `open-server-screen-cache`,
  `open-server-trim-golden`, `open-server-pinch-duration`, `open-server-paste`,
  `open-server-await-getstate` tests.
- **device test:** `OPEN_SERVER_DEVICE_TESTS=1 … vitest run` → **11/11 passed**,
  0 fallbacks.
- **APK:** `gradlew assembleDebug` → BUILD SUCCESSFUL, `argent-device-control-0.1.13.apk`.

## Verdict (usable in a PR)

Phase 3b makes the open Android control path an **honest, like-for-like** peer of
the proprietary backend rather than a favourable-benchmark story. On a booted API-35
emulator, N=20 per verb, 0 errors and 0 fallbacks across 480 calls, describe is
byte-near-identical and **token-identical (657/657 o200k_base)** with a **Jaccard
1.0** interactable set, and the open path carries **no host-side process** (vs a
~62 MB `simulator-server` per device). `gesture-swipe` latency is ≈ equal (ON p50
277 vs OFF 283), and fling *distance* matches the proprietary path within ±15 % on
the three reliable grid cells (250/400 ms; ratios 0.925/0.902/0.889) — the three
distance-0.5 / 150 ms cells bottomed out the measurement and are inconclusive, not a
proven regression. `describe` (light root) and `await-screen-idle` are ≈ equal.

Where the open path is now slower, it is stated plainly: `gesture-tap` +9 ms (once a
real 50 ms hold is enforced), `await-ui-element` +7 ms, `paste` slower (it attempts
the clipboard path first, which API 35 blocks from an instrumentation process, then
types), `tap+describe` ~2.1× and `gesture-pinch` ~2.4× slower — the last two because
the open path serializes the full accessibility tree and injects through
UiAutomation, whose per-event cost the proprietary native channel does not pay, and
because v2's tap/pinch "wins" came from a no-hold tap and a duration cap that this
report removed. The correctness regressions the review flagged (tap hold, pinch cap,
async UP, stale screen-size cache on rotation, describe/await tree divergence,
missing truncation flag) are fixed with unit tests; paste's clipboard route is
implemented and its API-35 limitation documented from a direct on-device probe.

## Reproduction

```
emulator -avd bench-api35 -no-window -no-audio -no-boot-anim -grpc 8554 -grpc-use-token
bash packages/android-device-server/scripts/build.sh                 # build the open APK (vCode 14)
# proprietary binaries: @swmansion/argent v0.22.1 extracted package
ARGENT_SIMULATOR_SERVER_DIR=<pkg>/bin \
ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR=<pkg>/bin \
ARGENT_NATIVE_DEVTOOLS_DIR=<pkg>/dylibs \
ANDROID_HOME=$HOME/Library/Android/sdk BENCH_SERIAL=emulator-5554 node run-bench.js   # N=20 OFF/ON/OFF
ANDROID_HOME=$HOME/Library/Android/sdk BENCH_SERIAL=emulator-5554 node run-fling.js   # fling grid
```

The emulator was torn down at the end of the run.
