// CI variant of the phase-3f run-fling-merge.js. Assembles the fling A/B from the
// per-config block files (ON-uiautomation vs ON-scrcpy fling-distance fidelity;
// each ON config vs the OFF proprietary reference when present). Reports the
// per-cell median ratio; a "reliable" cell is one that did not saturate.
//
// Phase 3k. The gate is scrcpy(drift)/uiautomation within ±0.15 on INFORMATIVE
// cells, PER-CELL and BLOCKING, with NO whitelist (review A.3 — the value-bounded
// whitelist is retired; a cell that is out of tolerance now fails, full stop). The
// floor-pinned exclusion is KEPT (review F9): a cell where both arms sit at the
// ~0.175 scroll floor carries no fling signal and is not gated. Two transparency
// arms are added: the scrcpy/off and uia/off ratios per cell (the proprietary
// reference the deficit is measured against), and — when the fling ran the pre-3k
// `ON-scrcpy-legacy` pacing in the same run — the before/after (legacy vs drift)
// scrcpy/uia and scrcpy/off per cell, so the pacing fix is shown in-run, not gated.
const fs = require("fs");
const path = require("path");
const OUT = process.env.BENCH_OUT || path.join(process.cwd(), ".bench-results");
const readOpt = (n) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(OUT, `fling-block-${n}.json`), "utf8"));
  } catch {
    return null;
  }
};
const uia = readOpt("ON-uiautomation");
const scr = readOpt("ON-scrcpy");
if (!uia || !scr) {
  throw new Error(
    `fling merge needs fling-block-ON-uiautomation.json and fling-block-ON-scrcpy.json under ${OUT}`
  );
}
const off = readOpt("OFF"); // proprietary reference optional on the Linux runner
const scrLegacy = readOpt("ON-scrcpy-legacy"); // phase-3k before arm (optional)

const key = (c) => `${c.durationMs}|${c.distance}`;
const map = (blk) => (blk ? Object.fromEntries(blk.cells.map((c) => [key(c), c])) : {});
const U = map(uia),
  S = map(scr),
  O = map(off),
  SL = map(scrLegacy);
const r3 = (n) => (Number.isFinite(n) ? Number(n.toFixed(3)) : n);
const ratio = (a, b) => (a && b && b.median > 0 && a.median >= 0 ? r3(a.median / b.median) : NaN);

const grid = uia.cells.map((c) => {
  const k = key(c);
  const u = U[k],
    s = S[k],
    o = O[k],
    sl = SL[k];
  const scrcpyOverUia = ratio(s, u);
  const scrcpyOverOff = ratio(s, o);
  const uiaOverOff = ratio(u, o);
  const scrcpyLegacyOverUia = ratio(sl, u);
  const scrcpyLegacyOverOff = ratio(sl, o);
  const reliable = !!(
    u &&
    s &&
    u.median > 0 &&
    u.median < 1 &&
    s.median > 0 &&
    s.median < 1 &&
    u.n >= 10 &&
    s.n >= 10
  );
  return {
    durationMs: c.durationMs,
    distance: c.distance,
    uiautomation: u ? { median: u.median, iqr: u.iqr, n: u.n } : null,
    scrcpy: s ? { median: s.median, iqr: s.iqr, n: s.n } : null,
    scrcpyLegacy: sl ? { median: sl.median, iqr: sl.iqr, n: sl.n } : null,
    off: o ? { median: o.median, iqr: o.iqr, n: o.n } : null,
    scrcpyOverUia,
    scrcpyOverOff,
    uiaOverOff,
    scrcpyLegacyOverUia,
    scrcpyLegacyOverOff,
    reliable,
  };
});

// Fling parity gate (phase 3k, review A.3). scrcpy(drift) and uiautomation drive
// swipes through DIFFERENT injection backends; the gate asserts their median scroll
// distance agrees within ±0.15 on every INFORMATIVE cell, PER-CELL and BLOCKING,
// with NO whitelist. An informative cell out of tolerance fails the job — there is
// no per-key exemption any more.
const TOL = 0.15;
// Scroll metric floor: the anchor-displacement metric bottoms out at ~0.175. A cell
// where BOTH arms sit at that floor carries NO fling signal — its ratio is 1.000 by
// construction — so it is NOT informative and must not count toward the gate/aggregate
// (review F9). This exclusion is KEPT.
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
  const deviation = Number(Math.abs(g.scrcpyOverUia - 1).toFixed(3));
  const withinTol = Math.abs(g.scrcpyOverUia - 1) <= TOL;
  return {
    durationMs: g.durationMs,
    distance: g.distance,
    ratio: g.scrcpyOverUia,
    deviation,
    withinTol,
    ok: withinTol,
  };
});
// Cells that fail the gate: informative and out of tolerance (no whitelist).
const offenders = perCell.filter((c) => !c.ok);
let verdict;
if (informative.length === 0) {
  verdict = "INCONCLUSIVE (no informative cells — all saturated/underpowered)";
} else if (offenders.length === 0) {
  verdict =
    `PASS (per-cell ±${TOL}, NO whitelist, over ${informative.length} informative cell(s)` +
    `; aggregate ratio ${Number.isFinite(aggRatio) ? aggRatio.toFixed(3) : "n/a"})`;
} else {
  verdict =
    `FAIL (${offenders.length} informative cell(s) outside ±${TOL}: ` +
    offenders.map((c) => `${c.durationMs}ms/${c.distance}=${c.ratio}`).join(", ") +
    ")";
}

const result = {
  serial: uia.serial,
  N: uia.N,
  offReferencePresent: !!off,
  legacyArmPresent: !!scrLegacy,
  scrcpyPacing: scr.pacing || "drift",
  grid,
  flingGate: {
    tolerance: TOL,
    mode: "per-cell (blocking), no whitelist",
    scrcpyArm: "drift",
    informativeCells: informative.length,
    aggregateRatio: Number.isFinite(aggRatio) ? Number(aggRatio.toFixed(3)) : null,
    perCell,
    offenders,
    verdict,
  },
  generatedAt: new Date().toISOString(),
};
const outPath = path.join(OUT, `fling-ab-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
const iqrStr = (m) => (m && m.iqr ? `[${m.iqr[0]},${m.iqr[1]}]` : "[-]");
console.log("\n=== FLING A/B (scrcpy[drift] vs uiautomation median scroll + IQR, n per cell) ===");
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
// Transparency: the proprietary reference the deficit is measured against (review
// F2/F4). scrcpy/off and uia/off per cell, printed for every cell, never gated.
if (off) {
  console.log("\n=== FLING vs PROPRIETARY reference (scrcpy/off, uia/off — transparency, not gated) ===");
  for (const g of grid) {
    console.log(
      `  d=${g.durationMs}ms dist=${g.distance}: ` +
        `scrcpy/off ${g.scrcpyOverOff} uia/off ${g.uiaOverOff} ` +
        `(scrcpy ${g.scrcpy && g.scrcpy.median}, uia ${g.uiautomation && g.uiautomation.median}, off ${g.off.median})`
    );
  }
}
// Before/after: the pre-3k legacy pacing vs the drift fix, same run (review A / F2).
if (scrLegacy) {
  console.log("\n=== FLING PACING before(legacy) → after(drift), same run (scrcpy/uia; scrcpy/off) ===");
  for (const g of grid) {
    console.log(
      `  d=${g.durationMs}ms dist=${g.distance}: ` +
        `scrcpy/uia ${g.scrcpyLegacyOverUia} → ${g.scrcpyOverUia}` +
        (off ? `  |  scrcpy/off ${g.scrcpyLegacyOverOff} → ${g.scrcpyOverOff}` : "") +
        ` (legacy med ${g.scrcpyLegacy && g.scrcpyLegacy.median} → drift med ${g.scrcpy && g.scrcpy.median})`
    );
  }
} else {
  console.log("\n(no ON-scrcpy-legacy before arm this run — before/after pacing comparison skipped)");
}
// Clamped / excluded cells (run-5 review: list them, don't silently drop).
const excluded = grid.filter((g) => !informative.includes(g));
if (excluded.length) {
  console.log("\n=== EXCLUDED cells (clamped/saturated/underpowered — not gated) ===");
  for (const g of excluded) {
    const why = !g.reliable
      ? "not reliable (median saturated 0/1 or n<10)"
      : floorPinned(g)
        ? `floor-pinned (both arms at the ${SCROLL_FLOOR} scroll floor — no fling signal)`
        : clamped(g.uiautomation) || clamped(g.scrcpy)
          ? "clamped at scroll floor/ceiling"
          : "no finite ratio";
    console.log(
      `  d=${g.durationMs}ms dist=${g.distance}: uia ${g.uiautomation && g.uiautomation.median} ` +
        `scrcpy ${g.scrcpy && g.scrcpy.median} — ${why}`
    );
  }
}
console.log(`\n=== FLING PARITY GATE (per-cell scrcpy[drift]/uia ±${TOL}, NO whitelist, BLOCKING) ===`);
for (const c of perCell) {
  const g = grid.find((x) => x.durationMs === c.durationMs && x.distance === c.distance);
  console.log(
    `  d=${c.durationMs}ms dist=${c.distance}: ratio ${c.ratio} dev ${c.deviation} ` +
      `(uia ${g && g.uiautomation && g.uiautomation.median} iqr${iqrStr(g && g.uiautomation)}, ` +
      `scrcpy ${g && g.scrcpy && g.scrcpy.median} iqr${iqrStr(g && g.scrcpy)}) ` +
      (c.withinTol ? "OK" : "OUT — FAIL")
  );
}
console.log(`FLING VERDICT: ${verdict}`);
console.log("FLING_AB_JSON=" + outPath);
// BLOCKING: an out-of-tolerance informative cell fails the job. INCONCLUSIVE (all
// cells saturated) is not a failure — it is reported, not gated.
if (verdict.startsWith("FAIL")) {
  console.error("::error::fling parity gate FAILED (per-cell, no whitelist) — " + verdict);
  process.exit(1);
}
