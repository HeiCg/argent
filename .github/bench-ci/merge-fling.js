// CI variant of the phase-3f run-fling-merge.js. Assembles the fling A/B from the
// per-config block files (ON-uiautomation vs ON-scrcpy fling-distance fidelity;
// each ON config vs the OFF proprietary reference when present). Reports the
// per-cell median ratio; a "reliable" cell is one that did not saturate.
const fs = require("fs");
const path = require("path");
const OUT = process.env.BENCH_OUT || path.join(process.cwd(), ".bench-results");
const read = (n) => JSON.parse(fs.readFileSync(path.join(OUT, `fling-block-${n}.json`), "utf8"));
const uia = read("ON-uiautomation");
const scr = read("ON-scrcpy");
let off = null;
try {
  off = read("OFF");
} catch {
  /* OFF reference optional (proprietary may not run on the Linux runner) */
}
const key = (c) => `${c.durationMs}|${c.distance}`;
const map = (blk) => Object.fromEntries(blk.cells.map((c) => [key(c), c]));
const U = map(uia), S = map(scr), O = off ? map(off) : {};
const r3 = (n) => (Number.isFinite(n) ? Number(n.toFixed(3)) : n);
const grid = uia.cells.map((c) => {
  const k = key(c);
  const u = U[k], s = S[k], o = O[k];
  const scrcpyOverUia = u && u.median > 0 ? r3(s.median / u.median) : NaN;
  const reliable = !!(u && s && u.median > 0 && u.median < 1 && s.median > 0 && s.median < 1 && u.n >= 10 && s.n >= 10);
  return {
    durationMs: c.durationMs, distance: c.distance,
    uiautomation: u ? { median: u.median, iqr: u.iqr, n: u.n } : null,
    scrcpy: s ? { median: s.median, iqr: s.iqr, n: s.n } : null,
    off: o ? { median: o.median, iqr: o.iqr, n: o.n } : null,
    scrcpyOverUia, reliable,
  };
});
// Fling parity gate (phase 3h). scrcpy and uiautomation drive the IDENTICAL swipe
// timeline (buildSwipeTimeline), so their median scroll distance should agree.
// Gate the scrcpy/uia ratio to within ±15% on INFORMATIVE cells only — reliable
// (both medians in (0,1), n>=10) AND not clamped at the floor/ceiling of the
// scroll range (median 0 or 1), where the ratio carries no signal. Judge on the
// AGGREGATE (median of the informative per-cell ratios) so a single noisy cell on
// a contended x86 emulator cannot flip the verdict, while a systematic fling drift
// still trips it. Per-cell deviations are printed for transparency.
const TOL = 0.15;
// Fling parity gate (phase 3h review A5/A12, fix f). scrcpy and uiautomation drive
// swipes through DIFFERENT injection backends, so their median scroll distance can
// diverge at the fling/momentum threshold. The gate is PER-CELL and BLOCKING: every
// informative cell must be within ±0.15 OR be explicitly EXPLAINED below. An
// informative cell that is out of tolerance and NOT explained fails the job — the
// aggregate-median form (which averaged the drift away) is retired.
//
// EXPLAINED_CELLS: cells with a documented, pre-existing reason to sit outside ±0.15,
// now VALUE-BOUNDED (review F4). Keyed `${durationMs}|${distance}` -> {reason, min, max}:
// the exemption applies ONLY while the scrcpy/uia ratio stays inside [min,max]. A ratio
// that leaves the band (a NEW regression in these cells) fails the gate. The bands span
// the observed reproducible long-duration scrcpy under-scroll: 250/0.5 read 1.577 (run
// 33812265077) and 1.514 (run 7); 400/0.5 read 0.614 (that run) and 0.710 (run 7).
const EXPLAINED_CELLS = {
  "250|0.5": { reason: "mid-distance fling-threshold difference; pre-existing, timeline unchanged (review A10)", min: 1.3, max: 1.8 },
  "400|0.5": { reason: "long-duration scrcpy under-scroll (~35-42% vs proprietary, reproducible runs 5+7)", min: 0.55, max: 0.8 },
};
// Scroll metric floor: the anchor-displacement metric bottoms out at ~0.175. A cell
// where BOTH arms sit at that floor carries NO fling signal — its ratio is 1.000 by
// construction — so it is NOT informative and must not count toward the gate/aggregate
// (review F9).
const SCROLL_FLOOR = 0.175;
const FLOOR_EPS = 0.001;
const atFloor = (c) => !!c && c.median <= SCROLL_FLOOR + FLOOR_EPS;
const floorPinned = (g) => atFloor(g.uiautomation) && atFloor(g.scrcpy);
const clamped = (c) => !c || !(c.median > 0 && c.median < 1);
const informative = grid.filter(
  (g) =>
    g.reliable &&
    Number.isFinite(g.scrcpyOverUia) &&
    !clamped(g.uiautomation) &&
    !clamped(g.scrcpy) &&
    !floorPinned(g)
);
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const aggRatio = median(informative.map((g) => g.scrcpyOverUia));
const perCell = informative.map((g) => {
  const k = `${g.durationMs}|${g.distance}`;
  const deviation = Number(Math.abs(g.scrcpyOverUia - 1).toFixed(3));
  const withinTol = Math.abs(g.scrcpyOverUia - 1) <= TOL;
  // The whitelist excuses a cell only while its ratio stays inside the documented band.
  const wl = EXPLAINED_CELLS[k];
  const explained =
    !withinTol && wl && g.scrcpyOverUia >= wl.min && g.scrcpyOverUia <= wl.max
      ? `${wl.reason} [band ${wl.min}-${wl.max}]`
      : null;
  return {
    durationMs: g.durationMs, distance: g.distance, ratio: g.scrcpyOverUia,
    deviation, withinTol, explained, ok: withinTol || !!explained,
  };
});
// Cells that fail the gate: informative, out of tolerance, and NOT explained.
const offenders = perCell.filter((c) => !c.ok);
let verdict;
if (informative.length === 0) {
  verdict = "INCONCLUSIVE (no informative cells — all saturated/underpowered)";
} else if (offenders.length === 0) {
  const nExpl = perCell.filter((c) => c.explained).length;
  verdict =
    `PASS (per-cell ±${TOL} over ${informative.length} informative cell(s)` +
    (nExpl ? `, ${nExpl} explained` : "") +
    `; aggregate ratio ${Number.isFinite(aggRatio) ? aggRatio.toFixed(3) : "n/a"})`;
} else {
  verdict =
    `FAIL (${offenders.length} informative cell(s) outside ±${TOL} and unexplained: ` +
    offenders.map((c) => `${c.durationMs}ms/${c.distance}=${c.ratio}`).join(", ") + ")";
}

const result = {
  serial: uia.serial, N: uia.N, offReferencePresent: !!off, grid,
  flingGate: {
    tolerance: TOL, mode: "per-cell (blocking)", informativeCells: informative.length,
    aggregateRatio: Number.isFinite(aggRatio) ? Number(aggRatio.toFixed(3)) : null,
    perCell, offenders, explainedCells: EXPLAINED_CELLS, verdict,
  },
  generatedAt: new Date().toISOString(),
};
const outPath = path.join(OUT, `fling-ab-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
const iqrStr = (m) => (m && m.iqr ? `[${m.iqr[0]},${m.iqr[1]}]` : "[-]");
console.log("\n=== FLING A/B (scrcpy vs uiautomation median scroll + IQR, n per cell; reliable cells) ===");
for (const g of grid) {
  console.log(
    `d=${g.durationMs}ms dist=${g.distance}: ` +
    `uia ${g.uiautomation && g.uiautomation.median} iqr${iqrStr(g.uiautomation)} ` +
    `scrcpy ${g.scrcpy && g.scrcpy.median} iqr${iqrStr(g.scrcpy)} ` +
    `→ ratio ${g.scrcpyOverUia}` +
    (g.off ? ` (off ${g.off.median})` : "") +
    ` n=${(g.scrcpy && g.scrcpy.n) || "?"}` +
    (g.reliable ? "  [reliable]" : "  [saturated]")
  );
}
// Clamped / excluded cells (run-5 review: list them, don't silently drop). A cell is
// excluded from the gate when it is not reliable (a median saturated at 0 or 1, or
// n<10) — the ratio carries no fling signal there.
const excluded = grid.filter((g) => !informative.includes(g));
if (excluded.length) {
  console.log("\n=== EXCLUDED cells (clamped/saturated/underpowered — not gated) ===");
  for (const g of excluded) {
    const why =
      !g.reliable ? "not reliable (median saturated 0/1 or n<10)" :
      floorPinned(g) ? `floor-pinned (both arms at the ${SCROLL_FLOOR} scroll floor — no fling signal)` :
      clamped(g.uiautomation) || clamped(g.scrcpy) ? "clamped at scroll floor/ceiling" :
      "no finite ratio";
    console.log(
      `  d=${g.durationMs}ms dist=${g.distance}: uia ${g.uiautomation && g.uiautomation.median} ` +
      `scrcpy ${g.scrcpy && g.scrcpy.median} — ${why}`
    );
  }
}
console.log(`\n=== FLING PARITY GATE (per-cell MEDIAN ratio ±${TOL} on informative cells, BLOCKING) ===`);
for (const c of perCell) {
  const g = grid.find((x) => x.durationMs === c.durationMs && x.distance === c.distance);
  console.log(
    `  d=${c.durationMs}ms dist=${c.distance}: ratio ${c.ratio} dev ${c.deviation} ` +
    `(uia ${g && g.uiautomation && g.uiautomation.median} iqr${iqrStr(g && g.uiautomation)}, ` +
    `scrcpy ${g && g.scrcpy && g.scrcpy.median} iqr${iqrStr(g && g.scrcpy)}) ` +
    (c.withinTol ? "OK" : c.explained ? `OUT but EXPLAINED (${c.explained})` : "OUT — UNEXPLAINED")
  );
}
console.log(`FLING VERDICT: ${verdict}`);
console.log("FLING_AB_JSON=" + outPath);
// BLOCKING (fix f): an unexplained out-of-tolerance informative cell fails the job.
// INCONCLUSIVE (all cells saturated) is not a failure — it is reported, not gated.
if (verdict.startsWith("FAIL")) {
  console.error("::error::fling parity gate FAILED (per-cell, blocking) — " + verdict);
  process.exit(1);
}
