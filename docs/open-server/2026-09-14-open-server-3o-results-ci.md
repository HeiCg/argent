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

## Result (filled from the run)

- Run id: _pending_
- Self-test verdict per cell: _pending_
- Per cell-arm raw offset median + IQR + n + drop reasons: _pending_
- If graded: per cell `ON/OFF` medians, ratio, permutation p, report-only gate outcome: _pending_
- Does `input-manager` under-scroll on this metric: _pending_
- Mechanism-discriminating arm (if warranted): _pending_

Scoreboard fling row is updated ONLY after adversarial review; until then fling stays
OPEN, pinned to 34813849446.
