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
const result = { serial: uia.serial, N: uia.N, offReferencePresent: !!off, grid, generatedAt: new Date().toISOString() };
const outPath = path.join(OUT, `fling-ab-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log("\n=== FLING A/B (scrcpy vs uiautomation median scroll; reliable cells) ===");
for (const g of grid) {
  console.log(
    `d=${g.durationMs}ms dist=${g.distance}: uia ${g.uiautomation && g.uiautomation.median} ` +
    `scrcpy ${g.scrcpy && g.scrcpy.median} → ratio ${g.scrcpyOverUia}` +
    (g.off ? ` (off ${g.off.median})` : "") + (g.reliable ? "  [reliable]" : "  [saturated]")
  );
}
console.log("FLING_AB_JSON=" + outPath);
