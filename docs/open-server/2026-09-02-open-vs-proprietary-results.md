> SUPERSEDED. The tap and pinch "ON wins" rows below are artifacts (zero-hold tap,
> 180 ms pinch cap) — retracted in `2026-09-02-open-vs-proprietary-results-v3.md`.
> Current like-for-like numbers: `2026-09-02-open-vs-proprietary-results-v4.md`.

# Results: argent proprietary Android backend vs open-device-server

Measurement-only benchmark for the spec
`2026-09-02-open-vs-proprietary-bench.md`. Same AVD, same tool-registry call
sites (`registry.invokeTool`), feature flag `open-device-server` toggled per
block (OFF = proprietary simulator-server + argent-android-devtools APK; ON =
open Kotlin android-device-server). N=20 per verb per config after 3 warm-ups,
blocks run OFF-1 → ON → OFF-2 (the UiAutomation channel is exclusive; the ADT
apk and the open server are mutually exclusive, so blocks cannot interleave;
OFF-2 detects drift).

## Environment

| Item | Value |
|---|---|
| Host | macOS (Darwin 25.6.0), Apple Silicon |
| Emulator | AVD `bench-api35`, Android 15 (API 35), abi arm64-v8a, 1080×2400 @ 420dpi |
| Emulator serial | `emulator-5554` (headless: `-no-window -no-audio -no-boot-anim -grpc 8554 -grpc-use-token`) |
| Emulator build | `emulator 37.1.11.0` |
| Physical device | `ZF524RZBHD` attached over USB — never targeted (all adb calls `-s emulator-5554`; RSS probe matched only `--id emulator-5554`) |
| Fork (open server) | `argent-p3` @ `93fd5b17`, branch `feat/android-open-server`, `@argent/tool-server` 0.22.1 |
| Proprietary binaries | vendored published package **v0.22.1**: `bin/darwin/simulator-server` (universal mach-o x86_64+arm64), `bin/argent-android-devtools-0.1.0.apk` |
| Binary resolution | `ARGENT_SIMULATOR_SERVER_DIR` + `ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR` → vendored `bin/` (createRegistry called directly, not via the argent launcher, so env overrides are honoured; no binaries committed) |
| Version match | APK `0.1.0` == fork's expected `argent-android-devtools-${versionName=0.1.0}.apk`; no version gate on simulator-server. Proprietary path started; no legacy `uiautomator dump` fallback was needed |
| Token estimator | **chars/4** (spec fallback; the token-bench harness's `js-tiktoken` o200k_base is not installed in the argent-p3 checkout) |
| Path confirmation | `describe.source` = `android-devtools` every OFF block, `open-device-server` every ON block; simulator-server host process present only under OFF |
| Result JSON | throwaway `argent-p3/.bench-results/bench-2026-09-02T14-55-10-518Z.json` (not committed) |

## Latency per verb — p50 / p95 / max (ms)

Same call sites (`registry.invokeTool`), same screens (Settings root; Settings
search for `paste`; Chrome `example.com` for `gesture-pinch`). All cells N=20,
0 errors, 0 fallbacks.

| Verb | OFF-1 (prop) | ON (open) | OFF-2 (prop) | winner |
|---|---|---|---|---|
| describe | 73 / 79 / 569 | 74 / 77 / 80 | 72 / 79 / 91 | ≈ equal |
| screenshot | 5 / 7 / 7 | 78 / 122 / 124 | 6 / 7 / 8 | OFF (see caveat: resolution differs) |
| gesture-tap | 53 / 54 / 55 | 146 / 170 / 1399 | 53 / 55 / 55 | OFF ~2.7× |
| gesture-swipe | 298 / 306 / 314 | 650 / 667 / 669 | 300 / 303 / 303 | OFF ~2.2× |
| await-screen-idle | 498 / 528 / 532 | 502 / 981 / 1000 | 495 / 525 / 543 | ≈ equal (p50) |
| await-ui-element | 72 / 75 / 76 | 72 / 76 / 77 | 76 / 83 / 83 | ≈ equal |
| paste | 78 / 111 / 114 | 57 / 68 / 68 | 82 / 104 / 117 | ON ~1.4× |
| gesture-pinch | 348 / 358 / 359 | 846 / 1163 / 1305 | 351 / 356 / 357 | OFF ~2.4× |

Drift: OFF-1 vs OFF-2 p50 within ±4 ms on every verb — no drift across the ON
block. Gesture/swipe/pinch p50 are dominated by the injected gesture duration
(250–300 ms) plus per-call overhead; the open server adds ~2× overhead on those.

## describe output size (same Settings root)

| Metric | OFF (android-devtools) | ON (open-device-server) |
|---|---|---|
| bytes | 1892 | 4307 |
| tokens (chars/4) | 473 | 1077 |
| rendered elements | 14 | 59 |
| render mode | nested, pruned to labelled rows | flat, all UiAutomation nodes |

OFF-1 and OFF-2 describe were byte-identical (1892 b / 14 el). Proprietary
describe is **~2.28× smaller in bytes and tokens** on this screen — it prunes to
labelled rows and concatenates row title + summary; the open server emits every
node (including layout containers) unpruned.

## Fidelity (Settings root, OFF-1 vs ON)

Set of visible `(resource-id | text)` identifiers per side.

| Metric | Value |
|---|---|
| raw Jaccard | 0.057 |
| normalized Jaccard | 0.615 |
| text labels shared (normalized) | 17 / 17 (1.000) — OFF misses no ON row, ON misses no OFF row |
| resource-ids | OFF 7, ON 22; OFF's 7 are a strict subset of ON's |

The raw 0.057 is representational, not informational: OFF uses
package-qualified ids (`com.android.settings:id/search_bar`) and concatenated
row text (`"Network & internet / Mobile, Wi‑Fi, hotspot"`); ON uses bare ids
(`id:search_bar`) and split text (`"Network & internet"`). After stripping the
package prefix and splitting OFF's `title / summary`, the **text sets are
identical (17/17)** and every OFF resource-id also appears on ON. ON exposes 15
additional layout-container ids OFF prunes (`content`, `app_bar`,
`list_container`, `text_frame`, `title`, …). Neither side dropped a Settings
row the other reported.

## Cold start — spawn to first successful describe (ms, 3× each)

| Block | run 1 | run 2 | run 3 | median |
|---|---|---|---|---|
| OFF-1 | 914 | 739 | 700 | 739 |
| ON | 869 | 751 | 770 | 770 |
| OFF-2 | 774 | 708 | 757 | 757 |

≈ equal (~700–900 ms). Both APKs were already installed, so this is
instrument-spawn + first-tree, not first-ever APK install. OFF cold start
measures the ADT `am instrument` spawn (describe path); the simulator-server
gesture backend spawns separately on the first gesture/screenshot (not on the
describe cold path). ON measures the open server `am instrument` spawn.

## Failures / timeouts / fallbacks

- **0 errors, 0 timeouts, 0 fallbacks** across all 480 measured calls
  (8 verbs × 20 × 3 blocks). `describe.source` was correct in every block, so no
  ON call was silently served by the proprietary fallback.
- Observation (not scored): during an earlier unhardened pass the proprietary
  ADT `SnapshotInstrumentation` produced a transient "Argent Android Devtools
  keeps stopping" system dialog under rapid cold-start teardown; the open server
  did not. The final run resets Settings + dismisses system dialogs between
  screens, and recorded no such event. Flagged for follow-up, not fixed here.

## Host process cost (RSS after run)

| Config | Backend host process | RSS |
|---|---|---|
| OFF | `simulator-server android --id emulator-5554` | ~62.3 MB (63856 / 63680 KB) |
| ON | none beyond adb (server runs on-device via `am instrument`) | 0 host RSS |

The proprietary gesture/screenshot backend keeps a ~62 MB host process alive per
device; the open path has no host process beyond adb. (The proprietary describe
path via the ADT apk also has no persistent host process — it is on-device
`am instrument` + a short-lived TCP client.)

## Verdict (5 lines)

1. Latency: proprietary wins the injected gestures (tap ~2.7×, swipe ~2.2×,
   pinch ~2.4×) and screenshot wall-time; describe, both awaits are ≈ equal;
   the open server wins `paste` (~1.4×).
2. Token cost: proprietary describe is ~2.3× smaller (473 vs 1077 tokens, same
   screen) because it prunes to labelled rows; the open server emits every node.
3. Fidelity: no semantic loss either way — text labels are 17/17 identical and
   OFF's resource-ids are a subset of ON's; the open server additionally exposes
   layout-container ids.
4. Footprint / reliability: the open path carries no host process (vs ~62 MB
   simulator-server) and showed no instrumentation crash; both had 0
   errors/fallbacks over 480 calls.
5. Caveats: screenshot is not apples-to-apples — OFF returns a 270×600 stream
   frame (~71 KB, 5 ms), ON a full 1080×2400 capture (~140 KB, 78 ms); tokens
   are chars/4 (js-tiktoken absent); cold start excludes first-ever APK install;
   results are one AVD / one screen set on Apple Silicon.
