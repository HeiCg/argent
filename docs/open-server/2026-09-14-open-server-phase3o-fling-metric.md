# Ticket: 3o — a fling metric that measures (Android), then re-run the fling question

Status: written 2026-09-14, dispatch after 3n.3 merges. Why: the anchor-displacement
metric is censored, quantized and clamped (3N-H3: 127/355 samples exactly at the 0.175
floor, 36 at 0.657, `return 1` clamp); two identical-code arms diverged 41 % (P8,
run 34870686468); every fling verdict so far rests on it. The 3n.2 removal deleted the
old fling harness on purpose; this ticket rebuilds the instrument first, then measures.

## Instrument (pre-registered before any arm comparison)
1. **Optical scroll metric**: pixel offset of the scrollable region between a pre-swipe
   and a post-settle screenshot by strip cross-correlation (1-D along the scroll axis on a
   downscaled grayscale strip; sub-pixel peak; report the peak's correlation as
   confidence and refuse the sample when < 0.6). Screenshots taken by the host via
   `adb exec-out screencap` (backend-independent), outside any timed window. Emit the
   raw offset per sample; no clamp, no floor, no ratio inside the harness.
2. **Self-test**: two identical-code arms `uia-A`/`uia-B` interleaved per sample must
   agree within ±5 % of the median offset on every cell, else the run is
   INSTRUMENT-UNRESOLVED and no arm is graded. A synthetic test (rendered list scrolled
   by known N px in a unit test with generated images) proves the estimator's accuracy
   (±1 px) before CI.
3. Cells: durations 150 / 250 / 400 ms × distance 0.3 / 0.5 screen heights; N = 16 per
   cell-arm; arms `OFF (proprietary)`, `ON-input-manager` (shipped default),
   `ON-uiautomation` (control), `uia-A`/`uia-B` (self-test), interleaved per sample with
   drop reasons recorded and n per cell-arm printed.
4. Gate (report-only for this run; becomes blocking only after the self-test passes
   twice): per cell `|ON/OFF − 1| ≤ 0.15` on medians, n ≥ 12 every arm, plus the paired
   permutation p per arm pair.

## Then
Answer, per cell: does `input-manager` under-scroll vs proprietary on a metric that
measures? If yes, the device-side mechanism candidates from
`2026-09-14-review-3n-run1-findings.md` (§ Fling mechanism candidates) get their one
discriminating device test (`uia-nowait` 3-arg `injectInputEvent(ev,false,false)` arm,
event source/flags/deviceId variants, per-arm dumpsys inter-arrival histograms). Results
file `docs/open-server/2026-09-1x-open-server-3o-results-ci.md`; scoreboard fling row
updated only after adversarial review. One or two CI runs; same polling rules; worktree
`../argent-fork-wt-3o`, branch `feat/open-server-3o-fling-metric` off `open/main` after
3n.3 lands.
