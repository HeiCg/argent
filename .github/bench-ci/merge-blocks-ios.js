// iOS bench block merge + pre-registered gates (ticket iOS-2). A NEW file — it
// does NOT touch the Android merge-blocks.js/scoreboard.js (another agent owns
// those). Reads the per-block JSONs written by BENCH_ONLY runs of
// bench-ios-open-vs-proprietary.ts and:
//   - enforces the FATAL pre-registered gates G0 / G1 / G3 + the gesture-param
//     drift gate (throws on violation, after printing every block's status so one
//     failing block never hides the others);
//   - computes the REPORT-ONLY G2 (Δ vs the pooled OFF blocks per verb, with a
//     bootstrap 95% CI on the p50 difference, graded against the OFF-1↔OFF-2 drift
//     floor: win / parity / loss) and G4 (tokens per tree backend at the cap);
//   - folds the optical scroll offsets per arm and the G3 stage sums;
//   - writes a merged JSON the iOS scoreboard renders.
//
// The block universe is the four iOS blocks; there are NO Android concepts here
// (no redir transport, no input-manager strategy arms).
const fs = require("fs");
const path = require("path");

const OUT = process.env.BENCH_OUT || path.join(process.cwd(), ".bench-results");
const ALL = ["OFF-1", "ON-xcuitest", "ON-siminput", "OFF-2"];
// iOS-2.1 (IOS2-H6): the tap+describe verb is no longer mislabelled `settle:false`
// (settle is Android-only and no iOS arm passes it).
const VERBS = [
  "describe",
  "gesture-tap",
  "tap+describe",
  "gesture-swipe",
  "await-screen-idle",
  "await-ui-element",
];
const LANDING_FLOOR = 0.95;
const STAGE_DELTA_MS = 10;
const BOOT = Number(process.env.BENCH_BOOTSTRAP || 2000);
// IOS2-H3: the four blocks locate the SAME target from the shared open tree; their
// per-block median tap coordinate must agree within this normalized tolerance.
const TAP_COORD_TOL = Number(process.env.BENCH_TAP_COORD_TOL || 0.03);

function readBlocks() {
  const files = {};
  for (const n of ALL) {
    const p = path.join(OUT, `bench-block-${n}.json`);
    if (fs.existsSync(p)) files[n] = JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return files;
}

// ---- stats -----------------------------------------------------------------
function pct(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}
function p50(xs) {
  return pct(
    xs.slice().sort((a, b) => a - b),
    50
  );
}
function resample(xs, rng) {
  const out = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[(rng() * xs.length) | 0];
  return out;
}
// Deterministic-ish PRNG so a re-merge of the same JSON gives the same CI.
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
/** Bootstrap 95% CI on p50(on) − p50(off). Returns [lo, hi] or [NaN, NaN]. */
function bootstrapDiffCI(on, off) {
  if (on.length < 2 || off.length < 2) return [NaN, NaN];
  const rng = mulberry32(0x1057 ^ on.length ^ (off.length << 8));
  const diffs = new Array(BOOT);
  for (let b = 0; b < BOOT; b++) diffs[b] = p50(resample(on, rng)) - p50(resample(off, rng));
  diffs.sort((a, b) => a - b);
  return [Number(pct(diffs, 2.5).toFixed(2)), Number(pct(diffs, 97.5).toFixed(2))];
}

function verbSamples(block, verb) {
  const v = (block.verbs || []).find((x) => x.verb === verb);
  return v && Array.isArray(v.latencySamples)
    ? v.latencySamples.filter((n) => Number.isFinite(n))
    : [];
}

// ---- load + presence (G0) --------------------------------------------------
const files = readBlocks();
const present = ALL.filter((n) => files[n]);
console.log(`iOS blocks present: ${present.join(", ") || "(none)"}`);
for (const n of present) {
  const b = files[n].block;
  const land =
    b.effectCheckedTotal > 0
      ? ((b.effectCheckedTotal - b.firstTapNoEffectTotal) / b.effectCheckedTotal) * 100
      : null;
  console.log(
    `  ${n}: backend=${b.treeBackend} oracleSelfTest=${b.oracle && b.oracle.selfTestPassed ? "pass" : "FAILED"} ` +
      `landing=${b.effectCheckedTotal - b.firstTapNoEffectTotal}/${b.effectCheckedTotal}` +
      `${land == null ? "" : ` (${land.toFixed(1)}%)`} ackTimeouts=${b.simInputAckTimeouts} crashes=${b.runnerCrashes} ` +
      `stageMaxDelta=${b.describeStages ? b.describeStages.maxDelta : "n/a"}`
  );
}

const failures = [];

// G0 control: both OFF blocks and both ON arms present + oracle self-test passed.
const missing = ALL.filter((n) => !files[n]);
if (missing.length)
  failures.push(`G0: missing block(s): ${missing.join(", ")} (all four required)`);
const oracleFailed = present.filter(
  (n) => !(files[n].block.oracle && files[n].block.oracle.selfTestPassed)
);
if (oracleFailed.length)
  failures.push(
    `G0: oracle self-test FAILED on block(s): ${oracleFailed.map((n) => `${n} (${files[n].block.oracle && files[n].block.oracle.note})`).join("; ")}`
  );

// G1 landing >= 95% first-attempt on every block; 0 runner crashes; 0 sim-input ack timeouts.
for (const n of present) {
  const b = files[n].block;
  const c = b.effectCheckedTotal || 0;
  if (c > 0) {
    const miss = b.firstTapNoEffectTotal || 0;
    const rate = (c - miss) / c;
    if (rate < LANDING_FLOOR)
      failures.push(`G1: landing ${(rate * 100).toFixed(1)}% < 95% on ${n} (${c - miss}/${c})`);
  } else {
    failures.push(
      `G1: ${n} armed 0 effect-checked taps (denominator 0 — the tap oracle never ran)`
    );
  }
  if ((b.runnerCrashes || 0) > 0)
    failures.push(`G1: ${n} runnerCrashes=${b.runnerCrashes} (must be 0)`);
  if ((b.simInputAckTimeouts || 0) > 0)
    failures.push(`G1: ${n} sim-input ackTimeouts=${b.simInputAckTimeouts} (must be 0)`);
}

// IOS2-M4: gate on errors, short samples, block notes and locate failures — a
// verb that errors 20/20 (run-1 OFF gesture-swipe / await-ui-element) or a block
// that dropped iterations to a locate miss is not a valid baseline. N/A verbs
// (`extra.na`, e.g. the ON await-* rows with no product path) are exempt.
for (const n of present) {
  const b = files[n].block;
  const N = (files[n].env && files[n].env.N) || 20;
  if ((b.notes || []).length) failures.push(`M4: ${n} carries notes: ${b.notes.join("; ")}`);
  if ((b.locateFailedTotal || 0) > 0)
    failures.push(`M4: ${n} locateFailedTotal=${b.locateFailedTotal} (must be 0)`);
  for (const v of b.verbs || []) {
    if (v.extra && v.extra.na) continue; // N/A verb, not measured
    if ((v.errors || 0) > 0)
      failures.push(`M4: ${n} verb "${v.verb}" errors=${v.errors} (must be 0)`);
    const got = Array.isArray(v.latencySamples) ? v.latencySamples.length : 0;
    if (got !== N)
      failures.push(`M4: ${n} verb "${v.verb}" latencySamples=${got} != N=${N} (short run)`);
    if ((v.locateFailed || 0) > 0)
      failures.push(`M4: ${n} verb "${v.verb}" locateFailed=${v.locateFailed} (must be 0)`);
  }
}

// IOS2-H3: the four blocks tap the SAME located target. Every present block's
// median tap coordinate must agree within TAP_COORD_TOL; otherwise the landing
// rates are not comparable across arms.
{
  const coords = present
    .map((n) => ({ n, c: files[n].block.medianTapCoord }))
    .filter((x) => x.c && Number.isFinite(x.c.x) && Number.isFinite(x.c.y));
  for (let i = 0; i < coords.length; i++) {
    for (let j = i + 1; j < coords.length; j++) {
      const a = coords[i].c;
      const b = coords[j].c;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > TAP_COORD_TOL)
        failures.push(
          `H3: tap coordinate drift ${coords[i].n} (${a.x.toFixed(3)},${a.y.toFixed(3)}) vs ` +
            `${coords[j].n} (${b.x.toFixed(3)},${b.y.toFixed(3)}) = ${dist.toFixed(3)} > ${TAP_COORD_TOL}`
        );
    }
  }
}

// Degraded-arm gate (mirrors the Android merge): a block on the wrong screen for
// part of the run is not a valid baseline.
for (const n of present) {
  const dr = files[n].block.degradedReasons || [];
  if (dr.length) failures.push(`degraded arm on ${n}: ${dr.join("; ")}`);
}

// Gesture-param drift gate.
const gp = present.map((n) => JSON.stringify(files[n].block.gestureParams));
if (new Set(gp).size > 1) failures.push(`gesture params drifted across blocks: ${gp.join(" | ")}`);

// G3 stage sums on the open tree: Σ(stages) ≈ captureMs, ≤ 10 ms over the samples.
for (const n of present) {
  const b = files[n].block;
  if (b.treeBackend === "xcuitest") {
    if (!b.describeStages || !b.describeStages.n) {
      failures.push(
        `G3: ${n} produced no describe stage samples (open tree must expose snapshot/serialize/encode/capture)`
      );
    } else if (b.describeStages.maxDelta > STAGE_DELTA_MS) {
      failures.push(
        `G3: ${n} Σ(stages) vs captureMs maxDelta=${b.describeStages.maxDelta}ms > ${STAGE_DELTA_MS}ms over ${b.describeStages.n} samples`
      );
    }
  }
}

// ---- G2 report (Δ vs pooled OFF per verb, CI, floor, verdict) --------------
let g2 = null;
if (files["OFF-1"] && files["OFF-2"]) {
  const off1 = files["OFF-1"].block;
  const off2 = files["OFF-2"].block;
  const onBlocks = present.filter((n) => n.startsWith("ON"));
  g2 = { verbs: {} };
  for (const verb of VERBS) {
    const off1s = verbSamples(off1, verb);
    const off2s = verbSamples(off2, verb);
    const offPooled = off1s.concat(off2s);
    const floor = Number(Math.abs(p50(off1s) - p50(off2s)).toFixed(2));
    const row = {
      floor,
      offP50: Number(p50(offPooled).toFixed(1)),
      off1P50: Number(p50(off1s).toFixed(1)),
      off2P50: Number(p50(off2s).toFixed(1)),
      arms: {},
    };
    for (const n of onBlocks) {
      const on = verbSamples(files[n].block, verb);
      const d = Number((p50(on) - p50(offPooled)).toFixed(2));
      const [lo, hi] = bootstrapDiffCI(on, offPooled);
      let verdict = "parity";
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        if (hi < -floor)
          verdict = "win"; // ON faster than OFF by more than the drift floor
        else if (lo > floor) verdict = "loss";
      } else verdict = "n/a";
      row.arms[n] = { onP50: Number(p50(on).toFixed(1)), delta: d, ci95: [lo, hi], verdict };
    }
    g2.verbs[verb] = row;
  }
}

// ---- G4 tokens per tree backend at the cap ---------------------------------
const g4 = { cap: null, backends: {} };
for (const n of present) {
  const d = files[n].block.describe;
  if (!d) continue;
  g4.cap = d.cap;
  // The two ON arms share the xcuitest tree; record once per backend.
  if (!g4.backends[d.backend]) {
    g4.backends[d.backend] = {
      block: n,
      source: d.source,
      elements: d.elements,
      tokens: d.tokens,
      tokensCharsDiv4: d.tokensCharsDiv4,
      capElements: d.capElements,
      capTokens: d.capTokens,
    };
  }
}

// ---- fidelity OFF-1 vs first ON (describe tree identity) -------------------
let fidelity = null;
const firstOn = present.find((n) => n.startsWith("ON"));
if (files["OFF-1"] && firstOn) {
  const a = files["OFF-1"].block.fidelitySet || [];
  const b = files[firstOn].block.fidelitySet || [];
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  fidelity = {
    off1_vs: firstOn,
    jaccard: uni === 0 ? 1 : Number((inter / uni).toFixed(3)),
    offCount: a.length,
    onCount: b.length,
  };
}

// ---- scroll per arm (IOS2-H5: screen POINTS, raster scale stated) ----------
const scroll = {};
for (const n of present) {
  const s = files[n].block.scroll;
  if (s)
    scroll[n] = {
      unit: s.unit || "screen-points",
      rasterScale: s.rasterScale,
      median: s.median,
      q1: s.q1,
      q3: s.q3,
      iqr: s.iqr,
      refusals: s.refusals,
      n: s.n,
      offsetsPoints: s.offsetsPoints,
    };
}

// ---- G3 sums ---------------------------------------------------------------
const g3 = {};
for (const n of present) {
  const b = files[n].block;
  if (b.describeStages) g3[n] = { n: b.describeStages.n, maxDelta: b.describeStages.maxDelta };
}

const merged = {
  env: files[present[0]] ? files[present[0]].env : {},
  envPerBlock: Object.fromEntries(present.map((n) => [n, files[n].env])),
  blocksRan: present,
  gates: {
    G0: {
      passed: failures.filter((f) => f.startsWith("G0")).length === 0,
      notes: failures.filter((f) => f.startsWith("G0")),
    },
    G1: {
      // Landing/crashes/acks PLUS the iOS-2.1 integrity gates (M4 errors/short-run/
      // notes/locate-miss, H3 tap-coord drift, degraded arm, gesture-param drift).
      passed:
        failures.filter(
          (f) =>
            f.startsWith("G1") ||
            f.startsWith("M4") ||
            f.startsWith("H3") ||
            f.startsWith("degraded") ||
            f.startsWith("gesture params")
        ).length === 0,
      notes: failures.filter(
        (f) =>
          f.startsWith("G1") ||
          f.startsWith("M4") ||
          f.startsWith("H3") ||
          f.startsWith("degraded") ||
          f.startsWith("gesture params")
      ),
    },
    G3: {
      passed: failures.filter((f) => f.startsWith("G3")).length === 0,
      sums: g3,
      notes: failures.filter((f) => f.startsWith("G3")),
    },
  },
  g2,
  g4,
  scroll,
  fidelity,
  landingByBlock: Object.fromEntries(
    present.map((n) => {
      const b = files[n].block;
      const c = b.effectCheckedTotal || 0;
      return [
        n,
        {
          firstTapLanded: c - (b.firstTapNoEffectTotal || 0),
          effectChecked: c,
          rate: c > 0 ? Number(((c - (b.firstTapNoEffectTotal || 0)) / c).toFixed(4)) : null,
        },
      ];
    })
  ),
  finishedAt: new Date().toISOString(),
};

const outPath = path.join(OUT, `bench-ios-merged-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));

console.log(`iOS blocks merged: ${present.join(", ")}`);
if (failures.length) {
  console.error("PRE-REGISTERED GATE FAILURES (G0/G1/G3 + drift):");
  for (const f of failures) console.error("  ✗ " + f);
  console.log("MERGED_JSON=" + outPath);
  throw new Error(`iOS bench gates failed: ${failures.length} violation(s) — see above`);
}
console.log("G0/G1/G3 + gesture-drift gates: OK");
console.log("MERGED_JSON=" + outPath);
