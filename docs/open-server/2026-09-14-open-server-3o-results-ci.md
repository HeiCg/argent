# Results — phase 3o: a fling metric that measures (Android)

Ticket: `2026-09-14-open-server-phase3o-fling-metric.md`. Branch
`feat/open-server-3o-fling-metric` off `open/main` @ `b5be6a9a`, worktree
`../argent-fork-wt-3o`. This file is written in two halves: the **pre-registration**
(instrument, self-test rule and gate — fixed BEFORE any CI run) and the **result**
(filled from the run's artifact). Fling stays OPEN and pinned to 34813849446 until
adversarial review clears a scoreboard row.

## Pre-registration (fixed before the run)

### Instrument 1 — optical scroll metric

`packages/tool-server/scripts/optical-scroll.ts`. The pixel offset a scrollable region
travelled between a pre-swipe and a post-settle screenshot, by 1-D normalized
cross-correlation (NCC) of a downscaled grayscale strip along the scroll (vertical)
axis:

- Screenshots by the HOST via `adb exec-out screencap -p` (PNG), backend-independent
  (same channel for OFF/proprietary and every ON arm), taken OUTSIDE any timed window
  (this is a displacement metric, not a latency metric).
- ROI is a central vertical band (default columns 0.1–0.9, rows 0.22–0.86) so a sticky
  top nav bar / bottom action bar contributes little. Each source ROW is collapsed to
  one grayscale value over `colBins=64` columns → a 1-D strip at FULL resolution along
  the scroll axis (single-pixel offset resolution).
- Zero-mean NCC over integer shifts (`after[y] ≈ before[y+s]` when content moved up by
  `s`), argmax, then sub-pixel parabolic refinement at `s*-1, s*, s*+1`.
- The peak NCC is the CONFIDENCE; a sample below **0.6** is REFUSED (`offsetPx: null`),
  never reported. A blank/uniform strip (zero variance) is refused.
- **No clamp, no floor, no ratio inside the harness.** The raw sub-pixel offset (px)
  and its confidence are persisted per sample. The ratio and the gate live only in the
  merge.

This replaces the deleted anchor-displacement metric (`775ae6fc`), which review 3N-H3
showed was censored, quantized (47 % of samples on three atoms) and clamped
(`if (disps.length === 0) return 1`). That metric is NOT resurrected.

**Synthetic proof (before CI), `test/optical-scroll-estimator.test.ts`:** on generated
images scrolled by a known N px the estimator recovers N within ±1 px — measured error
≤ **0.006 px** for N ∈ {0, 7, 23, 60, 100, 150, 180}, confidence 1.0 — and REFUSES a
blank/uniform strip (confidence 0, `offsetPx` null), an all-blank `after`, uncorrelated
frames, and a dimension mismatch. 6/6 pass under `vitest --maxWorkers=2`.

### Instrument 2 — self-test (decides whether ANY arm is graded)

Two identical-code arms `ON-uia-A` / `ON-uia-B` (both pin `ARGENT_OPEN_INJECT_STRATEGY
= default` → the pre-3n.1 Kotlin DEFAULT UiAutomation path; NEVER an unset env, which
resolves to `input-manager` after the 3n.1 flip — review 3N1-H1), **interleaved per
sample** within one live registry.

> **Self-test rule (pre-registered).** For EVERY one of the six cells: require
> `n(uia-A) ≥ 12` AND `n(uia-B) ≥ 12`, AND
> `|median(uia-A) − median(uia-B)| ≤ 0.05 × pooledMedian`, where `pooledMedian` is the
> median of the combined A∪B offsets for that cell (i.e. the two same-code arms agree
> within ±5 % of the cell's median offset). If ANY cell fails this — a divergence over
> ±5 % OR fewer than 12 samples on either arm — the instrument is
> **INSTRUMENT-UNRESOLVED**: no arm is graded, the raw per-cell distributions (median,
> IQR, n, deviation, permutation p) are reported, and we STOP. No second run to "get a
> pass".

(±5 % here is TIGHTER than the 3n.1 P8 ±0.15 instrument tolerance — the optical metric
is expected to reproduce far better than the censored one it replaces.)

### Instrument 3 — cells and arms

Cells: durations **150 / 250 / 400 ms** × distances **0.3 / 0.5** screen heights (6
cells). **N = 16** per cell-arm, 4 rounds × 4 per round; arm/visit order rotates per
round. Arms:

- `OFF` — proprietary driver (open-device-server off).
- `ON-input-manager` — shipped default injector (`ARGENT_OPEN_INJECT_STRATEGY=input-manager`).
- `ON-uiautomation` — control; pins `default` (pre-3n.1 DEFAULT path).
- `ON-uia-A` / `ON-uia-B` — self-test (both pin `default`), interleaved per sample.

Drop reasons are recorded per sample; n per cell-arm is printed. Screenshots and raw
offsets persisted per sample (`fling-block-<arm>.json`), interleave evidence in
`fling-interleave-evidence.json`.

### Instrument 4 — gate (report-only this run)

> **Arm gate (pre-registered; REPORT-ONLY for this run — becomes blocking only after
> the self-test passes twice).** Only reached when the self-test is INSTRUMENT-OK. Per
> cell, for `ON-input-manager` and `ON-uiautomation` vs `OFF` (proprietary):
> `|median(arm)/median(OFF) − 1| ≤ 0.15` on medians, with `n ≥ 12` on both arms; plus a
> two-sided permutation p on the median difference (B = 20000, seed 7) per arm pair.
> "Does `input-manager` under-scroll vs proprietary?" is answered per cell as
> `ratio < 1` with permutation `p < 0.05`.

The merge (`.github/bench-ci/merge-fling.js`) NEVER exits non-zero on the gate; the
fling step is report-only this run. The harness fails loudly only on an arm-round
collapse (a broken run must not masquerade as a clean instrument result).

### CI shape

The workflow YAML cannot be edited from here (the push token has no `workflow` OAuth
scope — the same constraint that made the 3n strategy arms self-orchestrate). So the
fling harness self-orchestrates from `.github/bench-ci/run-bench.js`, exactly like the
strategy arms: a **`FLING`** token in the `blocks` input runs `run-fling.js` +
`merge-fling.js` once, inside the existing `latency` job's already-booted emulator
(animations off, proprietary fetched for the OFF arm). It is part of the **latency
suite**. One run: `suite=latency`, `blocks=OFF-1,ON-uiautomation,ON-input-manager,OFF-2,FLING`,
defaults `FLING_N=16`, `FLING_ROUNDS=4`. The device-test step still runs (and may mark
the run `failure` on the unrelated 3m.1 residual gate); fling artifacts upload
regardless (`if: always`). Local proof before CI: `optical-scroll-estimator.test.ts`
6/6, `gates.test.js` (incl. 4 fling-merge cases) 21/21, `typecheck:scripts` green.

## Result — run 34914983320 (INSTRUMENT-UNRESOLVED)

Run **34914983320**, head `34dec6c5`, `workflow_dispatch`, `suite=latency`,
`blocks=ON-uiautomation,FLING`, N=16 per cell-arm, `system-images;android-34;
google_apis;x86_64`, ubuntu-latest KVM x86_64. Conclusion **success** (the device suite
passed — this base carries 3n.3's repaired residual gate). Fling artifact in
`bench-latency` (`fling-block-*.json`, `fling-ab-1789437350675.json`,
`fling-interleave-evidence.json`, `bench-log-FLING.txt`).

**Estimator health on the real device: the metric measured cleanly — 0 refused samples
across all 480 flings (n=16 on every one of 30 arm-cells, 0 drops), with broad,
continuous IQRs (e.g. input-manager 400/0.5 IQR [382, 1112] px).** This is the opposite
of the deleted metric (3N-H3: 47 % of samples on three atoms, hard clamp). No clamp, no
floor, no ratio fired.

### Self-test (uia-A vs uia-B, ±5 % of pooled median per cell, n≥12 both) — the decision

| cell | uia-A med (n) | uia-B med (n) | pooled med | \|A−B\| | tol (5 %) | relDev | perm p | verdict |
|---|---|---|---|---|---|---|---|---|
| 150/0.3 | 613.5 (16) | 771.4 (16) | 746.4 | 157.9 | 37.3 | **0.212** | 0.394 | **FAIL** |
| 150/0.5 | 1010.885 (16) | 1010.885 (16) | 1010.885 | 0 | 50.5 | 0.000 | 1.00 | OK* |
| 250/0.3 | 712.0 (16) | 847.0 (16) | 775.5 | 135.0 | 38.8 | **0.174** | 0.469 | **FAIL** |
| 250/0.5 | 854.0 (16) | 953.9 (16) | 893.5 | 100.0 | 44.7 | **0.112** | 0.548 | **FAIL** |
| 400/0.3 | 694.5 (16) | 743.5 (16) | 732.5 | 49.0 | 36.6 | **0.067** | 0.525 | **FAIL** |
| 400/0.5 | 916.0 (16) | 608.0 (16) | 867.5 | 308.0 | 43.4 | **0.355** | 0.437 | **FAIL** |

\* 150/0.5 is end-of-list **saturation**, not reproducibility: every arm (OFF,
input-manager, uiautomation, uia-A, uia-B) reads exactly **1010.885 px** — the fling ran
the Settings list to its bottom, so the measurable ROI displacement is capped there.

**SELF-TEST VERDICT: INSTRUMENT-UNRESOLVED** — two identical-code arms diverge 7–35 % on
the five non-saturated cells. The permutation p per cell is non-significant (0.39–0.55),
i.e. the divergence is not *demonstrated* significant at n=16 — it demonstrates that the
underlying **fling distance on this emulator is not reproducible enough** to grade a
±0.15 arm difference (the same class of finding review 3N1-M7 flagged for the old metric,
now shown with an uncensored metric and the raw distributions). Per the pre-registered
rule and the ticket, **no arm is graded and we STOP — no second run to "get a pass".**

### Per cell-arm raw offset median + IQR + n (drops = 0 everywhere)

| cell | OFF | ON-input-manager | ON-uiautomation | uia-A | uia-B |
|---|---|---|---|---|---|
| 150/0.3 | 624.0 [523,911] | 937.0 [700,1055] | 748.0 [475,844] | 613.5 [483,903] | 771.4 [518,1011] |
| 150/0.5 | 1010.9 [1011,1011] | 1010.9 [1011,1011] | 1010.9 [1011,1011] | 1010.9 [1000,1011] | 1010.9 [1011,1011] |
| 250/0.3 | 1021.0 [868,1087] | 964.0 [829,1011] | 991.0 [713,1035] | 712.0 [544,1011] | 847.0 [698,1064] |
| 250/0.5 | 758.5 [444,937] | 884.9 [669,1006] | 681.9 [485,1022] | 854.0 [585,1011] | 953.9 [746,1011] |
| 400/0.3 | 840.5 [711,877] | 732.0 [661,785] | 731.0 [679,764] | 694.5 [519,808] | 743.5 [633,793] |
| 400/0.5 | 369.0 [245,425] | 969.4 [382,1112] | 439.0 [327,1077] | 916.0 [602,1011] | 608.0 [254,1011] |

n=16, drops=0 for every cell-arm (px, IQR = [q25, q75]).

### Downstream questions (blocked by the instrument verdict)

- **Arm gate (ON/OFF ±0.15, report-only) + paired permutation p:** NOT computed. The
  self-test failed, so per the pre-registration no arm is graded.
- **Does `input-manager` under-scroll vs proprietary on this metric?** Cannot be answered
  (instrument unresolved). Descriptively — NOT a graded finding — input-manager did *not*
  under-scroll: its medians sit at or ABOVE OFF in most cells (150/0.3 937 vs 624; 250/0.5
  885 vs 758; 400/0.5 969 vs 369), the opposite of an under-scroll, but the IQRs overlap
  entirely and the instrument is unresolved, so no claim is made.
- **Mechanism-discriminating arm (`uia-nowait`, event source/flags/deviceId, dumpsys
  histograms):** NOT run. It was pre-conditioned on the instrument resolving AND
  input-manager under-scrolling on a metric that measures — neither holds. No Kotlin
  change was made.

### Disposition

Fling stays **OPEN**, pinned to **34813849446**. No scoreboard row enters. The one
sentence this run may add after adversarial review: *"a rebuilt, uncensored optical
scroll metric (proven ±1 px on synthetic images, 0 clamp/floor/ratio, 0 refused samples
on-device) still fails a per-sample-interleaved same-code A/B self-test — identical arms
diverge 7–35 % of the median (perm p 0.39–0.55) — so the emulator's fling distance is not
reproducible enough at N=16 to grade a ±0.15 arm difference; INSTRUMENT-UNRESOLVED, no arm
graded."* Next options for a future ticket (not this one): much larger N per cell, or a
different, more deterministic scroll target than the momentum fling (the variance is in
the fling physics, not the metric).
