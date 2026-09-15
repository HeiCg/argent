// Fling merge (ticket 3o). Assembles the OPTICAL fling grid from the per-arm block
// files written by bench-fling-fidelity.ts and applies, in order:
//
//   (A) SELF-TEST (pre-registered, decides whether ANY arm is graded). Two
//       identical-code arms ON-uia-A / ON-uia-B, interleaved per sample. For EVERY
//       cell: require n>=12 on both arms AND |med(A) - med(B)| <= 0.05 * m, where
//       m is the pooled median of A∪B (the cell's median offset). If any cell fails
//       (or is underpowered), the instrument is INSTRUMENT-UNRESOLVED: no arm is
//       graded, the raw distributions are printed, and we STOP (report-only, exit 0).
//
//   (B) ARM GATE (report-only this run — becomes blocking only after the self-test
//       passes twice; ticket 3o). Only reached when the self-test is OK. Per cell,
//       for ON-input-manager and ON-uiautomation vs OFF (proprietary): ratio
//       med(arm)/med(OFF); gate |ratio - 1| <= 0.15 with n>=12 on both arms; plus a
//       two-sided permutation p on the median difference (B=20000, seed 7). Also
//       reports input-manager vs OFF explicitly (does input-manager under-scroll?).
//
// NO clamp / floor / ratio lives in the estimator or the harness; the metric is raw
// px. This step ALWAYS exits 0 (fling is report-only for this run).
const fs = require("fs");
const path = require("path");
const OUT = process.env.BENCH_OUT || path.join(process.cwd(), ".bench-results");

const SELF_TEST_TOL = 0.05; // ±5% of the pooled median offset, per cell (ticket 3o)
const GATE_TOL = 0.15; // report-only |ON/OFF − 1| ≤ 0.15
const MIN_N = 12; // n ≥ 12 every arm
const PERM_B = 20000;
const PERM_SEED = 7;

function readOpt(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(OUT, `fling-block-${name}.json`), "utf8"));
  } catch {
    return null;
  }
}
const r3 = (n) => (Number.isFinite(n) ? Number(n.toFixed(3)) : n);
const cellKey = (c) => `${c.durationMs}|${c.distance}`;
const cellsOf = (b) => (b ? Object.fromEntries(b.cells.map((c) => [cellKey(c), c])) : {});
function offsets(cell) {
  return cell && Array.isArray(cell.samples)
    ? cell.samples.map((s) => s.offsetPx).filter((x) => Number.isFinite(x))
    : [];
}
function median(xs) {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// Deterministic PRNG so the permutation p is reproducible (mulberry32, seed 7).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Two-sided permutation test on the difference of medians (label shuffle).
function permutationP(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const observed = Math.abs(median(a) - median(b));
  const pooled = a.concat(b);
  const na = a.length;
  const rnd = mulberry32(PERM_SEED);
  let ge = 0;
  for (let iter = 0; iter < PERM_B; iter++) {
    // Fisher-Yates partial shuffle: pick na items as group A.
    const arr = pooled.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    const gA = arr.slice(0, na);
    const gB = arr.slice(na);
    if (Math.abs(median(gA) - median(gB)) >= observed - 1e-12) ge++;
  }
  return r3((ge + 1) / (PERM_B + 1));
}

const A = readOpt("ON-uia-A");
const B = readOpt("ON-uia-B");
const IM = readOpt("ON-input-manager");
const UIA = readOpt("ON-uiautomation");
const OFF = readOpt("OFF");
if (!A || !B) {
  throw new Error(
    `fling merge needs fling-block-ON-uia-A.json and fling-block-ON-uia-B.json under ${OUT}`
  );
}
const mA = cellsOf(A),
  mB = cellsOf(B),
  mIM = cellsOf(IM),
  mUIA = cellsOf(UIA),
  mOFF = cellsOf(OFF);
const cellList = A.cells.map((c) => ({
  durationMs: c.durationMs,
  distance: c.distance,
  key: cellKey(c),
}));

// ── (A) SELF-TEST ───────────────────────────────────────────────────────────
const selfCells = [];
let unresolved = false;
for (const c of cellList) {
  const oa = offsets(mA[c.key]);
  const ob = offsets(mB[c.key]);
  const medA = median(oa);
  const medB = median(ob);
  const pooled = oa.concat(ob);
  const m = median(pooled);
  const powered = oa.length >= MIN_N && ob.length >= MIN_N;
  const dev = Number.isFinite(medA) && Number.isFinite(medB) ? Math.abs(medA - medB) : NaN;
  const tol = Number.isFinite(m) ? SELF_TEST_TOL * Math.abs(m) : NaN;
  const relDev = Number.isFinite(m) && m !== 0 ? Math.abs(medA - medB) / Math.abs(m) : NaN;
  const pass = powered && Number.isFinite(dev) && Number.isFinite(tol) && dev <= tol;
  if (!pass) unresolved = true;
  selfCells.push({
    durationMs: c.durationMs,
    distance: c.distance,
    nA: oa.length,
    nB: ob.length,
    medA: r3(medA),
    medB: r3(medB),
    pooledMedian: r3(m),
    absDev: r3(dev),
    relDev: r3(relDev),
    tol: r3(tol),
    powered,
    permP: permutationP(oa, ob),
    pass,
  });
}
const selfVerdict = unresolved
  ? `INSTRUMENT-UNRESOLVED (a cell missed n>=${MIN_N} on both arms or |med(A)-med(B)| > ${SELF_TEST_TOL * 100}% of the pooled median)`
  : `INSTRUMENT-OK (every cell: n>=${MIN_N} both arms and |med(A)-med(B)| <= ${SELF_TEST_TOL * 100}% of the pooled median)`;

// ── (B) ARM GATE (report-only; only when the instrument is OK) ────────────────
function gradeArm(mArm, label) {
  const cells = cellList.map((c) => {
    const oArm = offsets(mArm[c.key]);
    const oOff = offsets(mOFF[c.key]);
    const medArm = median(oArm);
    const medOff = median(oOff);
    const ratio =
      Number.isFinite(medArm) && Number.isFinite(medOff) && medOff !== 0 ? medArm / medOff : NaN;
    const powered = oArm.length >= MIN_N && oOff.length >= MIN_N;
    const ok = powered && Number.isFinite(ratio) ? Math.abs(ratio - 1) <= GATE_TOL : null;
    return {
      durationMs: c.durationMs,
      distance: c.distance,
      armMedianPx: r3(medArm),
      offMedianPx: r3(medOff),
      nArm: oArm.length,
      nOff: oOff.length,
      ratio: r3(ratio),
      permP: permutationP(oArm, oOff),
      powered,
      gateOk: ok,
    };
  });
  const gradable = cells.filter((c) => c.gateOk !== null);
  const out = gradable.filter((c) => c.gateOk === false);
  let verdict;
  if (!OFF) verdict = "NO-OFF (proprietary reference absent — arm/off not gradable)";
  else if (gradable.length === 0) verdict = "INCONCLUSIVE (0 powered cells)";
  else
    verdict = `${out.length === 0 ? "PASS" : "FAIL"} (report-only; ${gradable.length} powered, ${out.length} out)`;
  return { arm: label, verdict, cells };
}

const armGrades = unresolved
  ? []
  : [gradeArm(mIM, "ON-input-manager"), gradeArm(mUIA, "ON-uiautomation")];

// Does input-manager under-scroll vs proprietary? (per cell: ratio < 1 & p < 0.05)
let underScrollFinding = null;
if (!unresolved && IM && OFF) {
  const imCells = armGrades.find((g) => g.arm === "ON-input-manager").cells;
  const under = imCells.filter(
    (c) =>
      c.powered && Number.isFinite(c.ratio) && c.ratio < 1 && c.permP !== null && c.permP < 0.05
  );
  underScrollFinding = {
    cellsUnderScrolling: under.map((c) => ({
      cell: `${c.durationMs}/${c.distance}`,
      ratio: c.ratio,
      permP: c.permP,
    })),
    verdict:
      under.length === 0
        ? "input-manager does NOT significantly under-scroll vs proprietary on any powered cell"
        : `input-manager under-scrolls vs proprietary on ${under.length} powered cell(s) (ratio<1, p<0.05)`,
  };
}

const result = {
  ticket: "3o",
  metric: "optical-scroll-px",
  mode: "self-test-first",
  gating: false, // report-only this run (blocking only after the self-test passes twice)
  selfTest: {
    tolerance: SELF_TEST_TOL,
    minN: MIN_N,
    verdict: selfVerdict,
    unresolved,
    cells: selfCells,
  },
  gate: {
    tolerance: GATE_TOL,
    minN: MIN_N,
    permB: PERM_B,
    permSeed: PERM_SEED,
    offReferencePresent: !!OFF,
  },
  arms: armGrades,
  inputManagerUnderScroll: underScrollFinding,
  serial: A.serial,
  N: A.N,
  generatedAt: new Date().toISOString(),
};
const outPath = path.join(OUT, `fling-ab-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

// ── Print ─────────────────────────────────────────────────────────────────
console.log("\n=== FLING (ticket 3o — OPTICAL metric, SELF-TEST FIRST, report-only) ===");
console.log(
  "arms: OFF(proprietary), ON-input-manager, ON-uiautomation(control), ON-uia-A/ON-uia-B(self-test)"
);
console.log(
  `\n=== SELF-TEST (uia-A vs uia-B, ±${SELF_TEST_TOL * 100}% of pooled median, n>=${MIN_N} both) ===`
);
for (const c of selfCells) {
  console.log(
    `  d=${c.durationMs}ms dist=${c.distance}: A ${c.medA}px (n=${c.nA}) B ${c.medB}px (n=${c.nB}) ` +
      `pooledMed ${c.pooledMedian} absDev ${c.absDev} tol ${c.tol} relDev ${c.relDev} permP ${c.permP} → ${c.pass ? "OK" : "FAIL"}` +
      (c.powered ? "" : "  [UNDERPOWERED]")
  );
}
console.log(`SELF-TEST VERDICT: ${selfVerdict}`);
if (unresolved) {
  console.log(
    "\nInstrument unresolved → NO arm is graded (ticket 3o: report the raw distributions and STOP)."
  );
} else {
  for (const g of armGrades) {
    console.log(`\n=== ARM ${g.arm} vs OFF (proprietary), report-only |ratio−1|≤${GATE_TOL} ===`);
    for (const c of g.cells) {
      console.log(
        `  d=${c.durationMs}ms dist=${c.distance}: ${g.arm} ${c.armMedianPx}px (n=${c.nArm}) / OFF ${c.offMedianPx}px (n=${c.nOff}) ` +
          `= ${c.ratio}  permP ${c.permP}` +
          (c.gateOk === null ? "  [not powered]" : c.gateOk ? "  OK" : "  OUT")
      );
    }
    console.log(`  ${g.arm} VERDICT: ${g.verdict}`);
  }
  if (underScrollFinding) console.log(`\nUNDER-SCROLL: ${underScrollFinding.verdict}`);
}
console.log(`\nFLING_AB_JSON=${outPath}`);
console.log("FLING (3o) is REPORT-ONLY — this step always exits 0.");
