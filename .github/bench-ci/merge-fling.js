// CI variant of the phase-3f run-fling-merge.js. Assembles the fling A/B from the
// per-config block files (ON-uiautomation vs ON-scrcpy fling-distance fidelity;
// each ON config vs the OFF proprietary reference when present). Reports the
// per-cell median ratio; an "informative" cell is one the gate can grade.
//
// Phase 3k.1 — PRE-REGISTERED gate rule (docs/open-server/2026-09-14-review-3k-findings.md
// "Gate recommendation", fixed before the reference run). The gate is scrcpy(drift)
// vs the reference within ±0.15, PER-CELL and BLOCKING, with NO whitelist, and three
// changes over 3k:
//   (1) REFERENCE-BIMODALITY exclusion, keyed on the REFERENCE arms only, never on
//       scrcpy: a cell is non-informative when q25(uia) <= SCROLL_FLOOR + eps (and,
//       when `off` is used as a denominator, when q25(off) <= SCROLL_FLOOR + eps). A
//       scrcpy defect can never exempt its own cell. This replaces the 3k
//       "both arms pinned at the floor" rule (its degenerate case).
//   (2) POWER FLOOR n >= 10 on EVERY arm entering a gated ratio, `off` included —
//       otherwise the cell is non-informative, not passed.
//   (3) TWO-SIDED reference on surviving cells: both |scrcpy/uia - 1| <= 0.15 AND
//       |scrcpy/off - 1| <= 0.15 when the OFF arm is present (one-sided scrcpy/uia
//       only when OFF is absent, e.g. a runner with no executable proprietary).
// Transparency rows scrcpy/off, uia/off and the legacy→drift before/after are still
// printed, never gated.
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

// Scroll metric floor: the anchor-displacement metric bottoms out at ~0.175. The
// pre-registered rule keys bimodality on the REFERENCE arm's lower quartile (q25 =
// iqr[0]): a reference whose q25 sits at the floor straddles it (a swipe that either
// catches a fling or floors), so its median ratio is a coin-flip and the cell carries
// no gradable fling signal — NEVER keyed on the scrcpy arm.
const SCROLL_FLOOR = 0.175;
const FLOOR_EPS = 0.001;
const q25 = (c) => (c && Array.isArray(c.iqr) ? c.iqr[0] : NaN);
const refStraddlesFloor = (c) => !(Number.isFinite(q25(c)) && q25(c) > SCROLL_FLOOR + FLOOR_EPS);
const underpowered = (c) => !(c && Number.isFinite(c.n) && c.n >= 10);
const TOL = 0.15;

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
  const offPresent = !!o;

  // Non-informative reasons (pre-registered rule). Keyed on the references only.
  const reasons = [];
  if (!(u && s && Number.isFinite(scrcpyOverUia))) reasons.push("missing arm / no scrcpy-uia ratio");
  else {
    if (refStraddlesFloor(u)) reasons.push(`uia reference q25=${q25(u)} at the ${SCROLL_FLOOR} floor`);
    if (underpowered(u)) reasons.push(`uia n=${u && u.n} < 10`);
    if (underpowered(s)) reasons.push(`scrcpy n=${s && s.n} < 10`);
    if (offPresent) {
      // OFF enters the two-sided ratio as a denominator, so its bimodality/power
      // gate the cell too (change 1 + change 2) — a floored/underpowered proprietary
      // reference cannot silently drop to a one-sided scrcpy/uia pass.
      if (!Number.isFinite(scrcpyOverOff)) reasons.push("no scrcpy-off ratio");
      if (refStraddlesFloor(o)) reasons.push(`off reference q25=${q25(o)} at the ${SCROLL_FLOOR} floor`);
      if (underpowered(o)) reasons.push(`off n=${o && o.n} < 10`);
    }
  }
  const informative = reasons.length === 0;

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
    offPresent,
    informative,
    nonInformativeReasons: reasons,
  };
});

const informativeCells = grid.filter((g) => g.informative);
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const aggRatio = median(informativeCells.map((g) => g.scrcpyOverUia));

// Per-cell TWO-SIDED verdict (change 3): both scrcpy/uia AND scrcpy/off within ±0.15
// when OFF is present; scrcpy/uia only when OFF is absent.
const perCell = informativeCells.map((g) => {
  const devUia = Number(Math.abs(g.scrcpyOverUia - 1).toFixed(3));
  const withinUia = Math.abs(g.scrcpyOverUia - 1) <= TOL;
  const devOff = g.offPresent ? Number(Math.abs(g.scrcpyOverOff - 1).toFixed(3)) : null;
  const withinOff = g.offPresent ? Math.abs(g.scrcpyOverOff - 1) <= TOL : true;
  const ok = withinUia && withinOff;
  const failSides = [];
  if (!withinUia) failSides.push(`scrcpy/uia ${g.scrcpyOverUia} dev ${devUia}`);
  if (!withinOff) failSides.push(`scrcpy/off ${g.scrcpyOverOff} dev ${devOff}`);
  return {
    durationMs: g.durationMs,
    distance: g.distance,
    ratioUia: g.scrcpyOverUia,
    ratioOff: g.offPresent ? g.scrcpyOverOff : null,
    devUia,
    devOff,
    withinUia,
    withinOff,
    ok,
    failSides,
  };
});
const offenders = perCell.filter((c) => !c.ok);
const totalCells = grid.length;
const nonInformativeCount = totalCells - informativeCells.length;

// Pre-registered verdict string (docs/open-server/2026-09-14-...-phase3k1...md Decisions):
// `PASS|FAIL (per-cell ±0.15 on scrcpy/uia AND scrcpy/off, NO whitelist, over k
//  informative cell(s); m of 6 non-informative at the metric floor)`.
const RULE = "per-cell ±0.15 on scrcpy/uia AND scrcpy/off, NO whitelist";
let verdict;
if (informativeCells.length === 0) {
  verdict = `INCONCLUSIVE (${RULE}, 0 informative cells; ${nonInformativeCount} of ${totalCells} non-informative at the metric floor)`;
} else {
  const head = offenders.length === 0 ? "PASS" : "FAIL";
  verdict =
    `${head} (${RULE}, over ${informativeCells.length} informative cell(s); ` +
    `${nonInformativeCount} of ${totalCells} non-informative at the metric floor)`;
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
    mode: "per-cell (blocking), no whitelist, two-sided scrcpy/uia AND scrcpy/off",
    scrcpyArm: "drift",
    rule: RULE,
    informativeCells: informativeCells.length,
    nonInformativeCells: nonInformativeCount,
    totalCells,
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
      `uia ${g.uiautomation && g.uiautomation.median} iqr${iqrStr(g.uiautomation)} n=${(g.uiautomation && g.uiautomation.n) || "?"} ` +
      `scrcpy ${g.scrcpy && g.scrcpy.median} iqr${iqrStr(g.scrcpy)} n=${(g.scrcpy && g.scrcpy.n) || "?"} ` +
      `→ ratio ${g.scrcpyOverUia}` +
      (g.off ? ` (off ${g.off.median} n=${g.off.n})` : "") +
      (g.informative ? "  [informative]" : "  [non-informative]")
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
// Before/after: the pre-3k legacy pacing vs the drift arm, same run (review A / F2).
// NOTE (3k.1): legacy is now the DEFAULT and drift is opt-in; this row is reported,
// never gated (the same-run paired test governs whether the default may change).
if (scrLegacy) {
  console.log("\n=== FLING PACING legacy(default) → drift(opt-in), same run (scrcpy/uia; scrcpy/off) ===");
  for (const g of grid) {
    console.log(
      `  d=${g.durationMs}ms dist=${g.distance}: ` +
        `scrcpy/uia ${g.scrcpyLegacyOverUia} → ${g.scrcpyOverUia}` +
        (off ? `  |  scrcpy/off ${g.scrcpyLegacyOverOff} → ${g.scrcpyOverOff}` : "") +
        ` (legacy med ${g.scrcpyLegacy && g.scrcpyLegacy.median} → drift med ${g.scrcpy && g.scrcpy.median})`
    );
  }
} else {
  console.log("\n(no ON-scrcpy-legacy arm this run — legacy/drift before/after skipped)");
}
// Non-informative cells (pre-registered exclusion): list them with the reason.
const excluded = grid.filter((g) => !g.informative);
if (excluded.length) {
  console.log("\n=== NON-INFORMATIVE cells (reference-bimodality / power floor — not gated) ===");
  for (const g of excluded) {
    console.log(
      `  d=${g.durationMs}ms dist=${g.distance}: uia ${g.uiautomation && g.uiautomation.median} ` +
        `iqr${iqrStr(g.uiautomation)} scrcpy ${g.scrcpy && g.scrcpy.median} ` +
        (g.off ? `off ${g.off.median} iqr${iqrStr(g.off)} ` : "") +
        `— ${g.nonInformativeReasons.join("; ")}`
    );
  }
}
console.log(`\n=== FLING PARITY GATE (${RULE}, BLOCKING) ===`);
for (const c of perCell) {
  console.log(
    `  d=${c.durationMs}ms dist=${c.distance}: scrcpy/uia ${c.ratioUia} dev ${c.devUia}` +
      (c.ratioOff !== null ? ` | scrcpy/off ${c.ratioOff} dev ${c.devOff}` : "") +
      (c.ok ? "  OK" : `  OUT — FAIL (${c.failSides.join(", ")})`)
  );
}
console.log(`FLING VERDICT: ${verdict}`);
console.log("FLING_AB_JSON=" + outPath);
// BLOCKING: an informative cell out of tolerance fails the job. INCONCLUSIVE (no
// informative cells) is reported, not gated.
if (verdict.startsWith("FAIL")) {
  console.error("::error::fling parity gate FAILED (two-sided, per-cell, no whitelist) — " + verdict);
  process.exit(1);
}
