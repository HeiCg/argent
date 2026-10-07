// Shared latency statistics for the Android open-vs-proprietary bench.
//
// Review 2026-10-07 finding 4: the bench script computed p50 as the lower-middle
// value while the scoreboard bootstrap used the true median, and the noise floor was
// one difference of two block medians. Everything here is the ONE definition used by
// the bench script (bench-open-vs-proprietary.ts imports this file), merge-blocks.js
// and scoreboard.js:
//  - quantile: linear interpolation between order statistics (Hyndman-Fan type 7,
//    R's default). quantile(xs, 0.5) is the true median (mean of the two middle
//    values for an even n).
//  - bootstrap: seeded mulberry32, 10 000 draws, independent resampling of each arm.
//  - margin: the 95th percentile of |Δp50| when OFF-1 and OFF-2 are each resampled
//    (driftMargin), or, for two different arms (P6), when both resamples are drawn
//    from the pooled samples (pooledNullMargin). The OFF-graded gates use
//    equivalenceMargin = max(driftMargin, 2 % of the pooled OFF p50, 1 ms), the
//    pre-registered practical margin (run 37561512651, Review 2026-10-07).
//  - reading: the CI of Δp50 against ±margin. win = CI upper < -margin, loss = CI
//    lower > +margin, parity = the whole CI inside [-margin, +margin], otherwise
//    inconclusive.
//  - Holm: a family of verbs is graded with per-verb adjusted alpha (the CI is
//    widened to 1 - alpha_k), step-down: after the first inconclusive verb in rank
//    order, every later verb reads inconclusive.
"use strict";

const DEFAULT_B = 10000;
const DEFAULT_SEED = 0x3e1f005;
const FAMILY_ALPHA = 0.05;

/** @param {number[]} s sorted ascending @param {number} p in [0, 1] @returns {number} */
function quantileSorted(s, p) {
  const n = s.length;
  if (!n) return NaN;
  if (n === 1) return s[0];
  const h = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

/** @param {number[]} xs @param {number} p in [0, 1] @returns {number} */
function quantile(xs, p) {
  if (!xs || !xs.length) return NaN;
  return quantileSorted(
    xs.slice().sort((a, b) => a - b),
    p
  );
}

/** True median: mean of the two middle values for an even n. @param {number[]} xs */
function median(xs) {
  return quantile(xs, 0.5);
}

/**
 * Summary used for every latency row. p50/p95 are not rounded; mean to 0.1 ms.
 * @param {number[]} xs
 * @returns {{ n: number, p50: number, p95: number, max: number, min: number, mean: number }}
 */
function summarize(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  return {
    n: xs.length,
    p50: quantileSorted(s, 0.5),
    p95: quantileSorted(s, 0.95),
    max: s.length ? s[s.length - 1] : NaN,
    min: s.length ? s[0] : NaN,
    mean: Number(mean.toFixed(1)),
  };
}

/** @param {number} seed @returns {() => number} uniform in [0, 1) */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    let t = (a = (a + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const okSamples = (xs) => Array.isArray(xs) && xs.length >= 2;

/** @param {number[]} src @param {number} n @param {() => number} rnd @param {number[]} out */
function resampleInto(src, n, rnd, out) {
  for (let j = 0; j < n; j++) out[j] = src[(rnd() * src.length) | 0];
  return out;
}

/**
 * Sorted bootstrap distribution of stat(a*) - stat(b*), a* and b* resampled
 * independently with replacement. null when an arm has fewer than 2 samples.
 * @param {number[]} a @param {number[]} b
 * @param {{ B?: number, seed?: number, p?: number }} [opt] p = the quantile (0.5 = p50)
 * @returns {number[] | null}
 */
function bootstrapDiffs(a, b, opt = {}) {
  if (!okSamples(a) || !okSamples(b)) return null;
  const B = opt.B || DEFAULT_B;
  const p = opt.p == null ? 0.5 : opt.p;
  const rnd = mulberry32(opt.seed == null ? DEFAULT_SEED : opt.seed);
  const ra = new Array(a.length);
  const rb = new Array(b.length);
  const out = new Array(B);
  for (let i = 0; i < B; i++) {
    out[i] =
      quantile(resampleInto(a, a.length, rnd, ra), p) -
      quantile(resampleInto(b, b.length, rnd, rb), p);
  }
  return out.sort((x, y) => x - y);
}

/**
 * Two-sided percentile CI at `level` from a sorted bootstrap distribution.
 * @param {number[]} sorted @param {number} level e.g. 0.95 @returns {[number, number]}
 */
function percentileCI(sorted, level) {
  const tail = (1 - level) / 2;
  return [quantileSorted(sorted, tail), quantileSorted(sorted, 1 - tail)];
}

const round1 = (x) => (x == null || !Number.isFinite(x) ? x : Number(x.toFixed(1)));

/**
 * Noise margin from the OFF-1 vs OFF-2 difference itself: the 95th percentile of
 * |p50(OFF-1*) - p50(OFF-2*)| over B draws, each block resampled on its own. Rounded
 * to 0.1 ms (the reading uses the rounded value the scoreboard prints).
 * @param {number[]} off1 @param {number[]} off2 @param {{ B?: number, seed?: number }} [opt]
 * @returns {number | null}
 */
function driftMargin(off1, off2, opt = {}) {
  const d = bootstrapDiffs(off1, off2, opt);
  if (!d) return null;
  return round1(quantile(d.map(Math.abs), 0.95));
}

// Pre-registered practical equivalence margin (run 37561512651, Review 2026-10-07): a
// difference smaller than 2 % of the proprietary p50, or than 1 ms, is not a practical
// difference, and the margin is never below the measured OFF drift (driftMargin). With
// the bootstrap margin alone a tight verb could only read parity with a sub-ms CI.
const EQUIV_PCT = 0.02;
const EQUIV_FLOOR_MS = 1.0;

/**
 * Gate margin of a verb: max(driftMargin(OFF-1, OFF-2), 2 % of p50(OFF-1 ∪ OFF-2), 1 ms),
 * rounded to 0.1 ms. null when either OFF block has fewer than 2 samples.
 * @param {number[] | null} off1 @param {number[] | null} off2
 * @param {{ B?: number, seed?: number }} [opt]
 * @returns {{ margin: number, bootstrap: number, pctOfP50: number, floor: number,
 *   binding: "bootstrap" | "2% of p50" | "1 ms floor" } | null}
 */
function equivalenceMargin(off1, off2, opt = {}) {
  const bootstrap = driftMargin(off1, off2, opt);
  if (bootstrap == null) return null;
  const pctOfP50 = round1(EQUIV_PCT * median(off1.concat(off2)));
  const margin = round1(Math.max(bootstrap, pctOfP50, EQUIV_FLOOR_MS));
  const binding =
    margin === bootstrap ? "bootstrap" : margin === pctOfP50 ? "2% of p50" : "1 ms floor";
  return { margin, bootstrap, pctOfP50, floor: EQUIV_FLOOR_MS, binding };
}

/**
 * Null margin for two different arms (P6, ON-input-manager vs ON-uiautomation). Each
 * arm is recentred on its own median and the residuals are pooled (the null "same
 * distribution, no shift"); both resamples are drawn from that pool, sizes kept, and
 * the margin is the 95th percentile of |Δp50|. Recentring keeps the margin a measure
 * of the pair's noise: pooling the raw samples of two arms that really differ gives a
 * bimodal pool whose margin grows with the very shift under test. Rounded to 0.1 ms.
 * @param {number[]} a @param {number[]} b @param {{ B?: number, seed?: number }} [opt]
 * @returns {number | null}
 */
function pooledNullMargin(a, b, opt = {}) {
  if (!okSamples(a) || !okSamples(b)) return null;
  const ma = median(a);
  const mb = median(b);
  const pool = a.map((x) => x - ma).concat(b.map((x) => x - mb));
  const B = opt.B || DEFAULT_B;
  const rnd = mulberry32(opt.seed == null ? DEFAULT_SEED : opt.seed);
  const ra = new Array(a.length);
  const rb = new Array(b.length);
  const abs = new Array(B);
  for (let i = 0; i < B; i++) {
    abs[i] = Math.abs(
      median(resampleInto(pool, a.length, rnd, ra)) - median(resampleInto(pool, b.length, rnd, rb))
    );
  }
  return round1(quantile(abs, 0.95));
}

/**
 * The one reading rule: the CI of Δ against ±margin.
 * @param {[number, number] | null} ci @param {number | null} margin
 * @returns {"win" | "loss" | "parity" | "inconclusive" | "N/A"}
 */
function readCI(ci, margin) {
  if (!ci || margin == null || !Number.isFinite(margin)) return "N/A";
  if (ci[1] < -margin) return "win";
  if (ci[0] > margin) return "loss";
  if (ci[0] >= -margin && ci[1] <= margin) return "parity";
  return "inconclusive";
}

/** Gate verdict of a reading: win/parity pass, loss fails, the rest is not a pass. */
function gateOf(reading) {
  if (reading === "win" || reading === "parity") return "PASS";
  if (reading === "loss") return "FAIL";
  if (reading === "inconclusive") return "INCONCLUSIVE";
  return "N/A";
}

/**
 * Holm adjusted alpha per test. ps[i] is test i's p-value; returns, per input index,
 * its 1-based rank (ascending p, ties by index) and alpha_k = alpha / (m - rank + 1).
 * @param {number[]} ps @param {number} [alpha]
 * @returns {{ rank: number, alpha: number }[]}
 */
function holmAlphas(ps, alpha = FAMILY_ALPHA) {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p || x.i - y.i);
  const out = new Array(m);
  order.forEach(({ i }, k) => {
    out[i] = { rank: k + 1, alpha: alpha / (m - k) };
  });
  return out;
}

/**
 * Holm step-down over readings already listed in rank order: the first inconclusive
 * reading stops the procedure and every later one is retained (inconclusive).
 * @param {string[]} readingsInRankOrder @returns {{ reading: string, holmStop: boolean }[]}
 */
function holmStepDown(readingsInRankOrder) {
  let stopped = false;
  return readingsInRankOrder.map((r) => {
    if (stopped && r !== "N/A") return { reading: "inconclusive", holmStop: r !== "inconclusive" };
    if (r === "inconclusive") stopped = true;
    return { reading: r, holmStop: false };
  });
}

/**
 * p-value of the CI rule at margin M: the smallest alpha at which a (1 - alpha) CI
 * from this bootstrap distribution reads win, loss or parity. Used only to rank the
 * family for Holm; the reading itself always comes from the printed CI.
 * @param {number[]} sorted @param {number} M
 */
function decisiveP(sorted, M) {
  const B = sorted.length;
  let ge = 0,
    le = 0,
    lt = 0,
    gt = 0;
  for (const d of sorted) {
    if (d >= -M) ge++;
    if (d < -M) lt++;
    if (d <= M) le++;
    if (d > M) gt++;
  }
  const pWin = (2 * ge) / B;
  const pLoss = (2 * le) / B;
  const pParity = (2 * Math.max(lt, gt)) / B;
  return Math.min(1, pWin, pLoss, pParity);
}

/**
 * Grade a family of comparisons with ONE rule (table reading == gate verdict).
 * items: [{ key, a, b, margin }] with a = candidate samples, b = comparator samples.
 * Returns, per item (input order): delta = p50(a) - p50(b) (true medians, 0.1 ms),
 * margin, p, rank, alpha, level, ci (rounded to 0.1 ms, at level 1 - alpha_k),
 * reading (Holm step-down applied), holmStop, gate.
 * @param {{ key: string, a: number[] | null, b: number[] | null, margin: number | null }[]} items
 * @param {{ B?: number, seed?: number, alpha?: number }} [opt]
 */
function gradeFamily(items, opt = {}) {
  const alpha = opt.alpha == null ? FAMILY_ALPHA : opt.alpha;
  const rows = items.map((it) => {
    const ok = okSamples(it.a) && okSamples(it.b) && it.margin != null;
    const delta =
      it.a && it.a.length && it.b && it.b.length ? round1(median(it.a) - median(it.b)) : null;
    return {
      key: it.key,
      delta,
      margin: it.margin == null ? null : round1(it.margin),
      dist: ok ? bootstrapDiffs(it.a, it.b, opt) : null,
    };
  });
  const tested = rows.filter((r) => r.dist);
  const alphas = holmAlphas(
    tested.map((r) => decisiveP(r.dist, r.margin)),
    alpha
  );
  tested.forEach((r, i) => {
    r.p = Number(decisiveP(r.dist, r.margin).toFixed(4));
    r.rank = alphas[i].rank;
    r.alpha = alphas[i].alpha;
    r.level = 1 - r.alpha;
    const ci = percentileCI(r.dist, r.level);
    r.ci = [round1(ci[0]), round1(ci[1])];
    r.ownReading = readCI(r.ci, r.margin);
  });
  const ranked = tested.slice().sort((x, y) => x.rank - y.rank);
  const stepped = holmStepDown(ranked.map((r) => r.ownReading));
  ranked.forEach((r, k) => {
    r.reading = stepped[k].reading;
    r.holmStop = stepped[k].holmStop;
  });
  return rows.map((r) => {
    const base = {
      key: r.key,
      delta: r.delta,
      margin: r.margin,
      m: tested.length,
    };
    if (!r.dist)
      return {
        ...base,
        p: null,
        rank: null,
        alpha: null,
        level: null,
        ci: null,
        reading: "N/A",
        holmStop: false,
        gate: "N/A",
      };
    return {
      ...base,
      p: r.p,
      rank: r.rank,
      alpha: r.alpha,
      level: r.level,
      ci: r.ci,
      reading: r.reading,
      holmStop: r.holmStop,
      gate: gateOf(r.reading),
    };
  });
}

/**
 * A single report-only comparison (not part of a gated family): Δ of quantile p and
 * its unadjusted CI at `level`.
 * @param {number[] | null} a @param {number[] | null} b
 * @param {{ p?: number, level?: number, B?: number, seed?: number }} [opt]
 * @returns {{ delta: number | null, ci: [number, number] | null }}
 */
function compareOnce(a, b, opt = {}) {
  const p = opt.p == null ? 0.5 : opt.p;
  const delta = a && a.length && b && b.length ? round1(quantile(a, p) - quantile(b, p)) : null;
  const dist = bootstrapDiffs(a, b, opt);
  if (!dist) return { delta, ci: null };
  const ci = percentileCI(dist, opt.level == null ? 0.95 : opt.level);
  return { delta, ci: [round1(ci[0]), round1(ci[1])] };
}

module.exports = {
  median,
  summarize,
  driftMargin,
  equivalenceMargin,
  pooledNullMargin,
  readCI,
  gateOf,
  gradeFamily,
  compareOnce,
  round1,
};
