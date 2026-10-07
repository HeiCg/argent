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

// Review 2026-10-07 run 37591260027 finding 7: P2 read Δ +1.3 ms, CI [1.0, 1.7], margin
// ±1.1 as "inconclusive". The CI excludes zero and the point estimate is outside the
// margin: ON is slower, by an amount the CI cannot place beyond the margin. That reads
// "loss (within/at margin)" (gate NOT PASSED). Symmetric on the other side: "win
// (within/at margin)", the whole CI below zero (gate PASS: no value in the CI is worse).
const LOSS_WITHIN = "loss (within/at margin)";
const WIN_WITHIN = "win (within/at margin)";

/**
 * The one reading rule: the CI of Δ against ±margin. With `delta` (the point estimate),
 * a CI that excludes zero with the point outside the margin, but that does not clear the
 * margin, reads LOSS_WITHIN / WIN_WITHIN instead of inconclusive.
 * @param {[number, number] | null} ci @param {number | null} margin
 * @param {number | null} [delta]
 * @returns {string} "win" | "loss" | "parity" | LOSS_WITHIN | WIN_WITHIN | "inconclusive" | "N/A"
 */
function readCI(ci, margin, delta) {
  if (!ci || margin == null || !Number.isFinite(margin)) return "N/A";
  if (ci[1] < -margin) return "win";
  if (ci[0] > margin) return "loss";
  if (ci[0] >= -margin && ci[1] <= margin) return "parity";
  if (delta != null && Number.isFinite(delta)) {
    if (ci[0] > 0 && delta > margin) return LOSS_WITHIN;
    if (ci[1] < 0 && delta < -margin) return WIN_WITHIN;
  }
  return "inconclusive";
}

/**
 * Gate verdict of a reading: win/parity pass, loss fails, the rest is not a pass.
 * WIN_WITHIN passes (the whole CI is below zero); LOSS_WITHIN is NOT PASSED (slower, not
 * shown beyond the margin), distinct from FAIL and from INCONCLUSIVE.
 */
function gateOf(reading) {
  if (reading === "win" || reading === "parity" || reading === WIN_WITHIN) return "PASS";
  if (reading === "loss") return "FAIL";
  if (reading === LOSS_WITHIN) return "NOT PASSED";
  if (reading === "inconclusive") return "INCONCLUSIVE";
  return "N/A";
}

/** Readings that settle the margin hypotheses (Holm continues past them). */
const DECISIVE = new Set(["win", "loss", "parity"]);

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
 * Holm step-down over readings already listed in rank order: the first reading that does
 * not settle a margin hypothesis (inconclusive, or a within/at-margin win/loss) stops the
 * procedure and every later one is retained (inconclusive).
 * @param {string[]} readingsInRankOrder @returns {{ reading: string, holmStop: boolean }[]}
 */
function holmStepDown(readingsInRankOrder) {
  let stopped = false;
  return readingsInRankOrder.map((r) => {
    if (stopped && r !== "N/A") return { reading: "inconclusive", holmStop: r !== "inconclusive" };
    if (r !== "N/A" && !DECISIVE.has(r)) stopped = true;
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
    r.ownReading = readCI(r.ci, r.margin, r.delta);
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

/* ---- block-level CI (run 37591260027, review "Next run": ABBA, ≥ 3 blocks per arm) ---- */

// Lanczos log-gamma (g = 7, n = 9).
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];
function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
// Continued fraction for the regularized incomplete beta (Numerical Recipes betacf).
function betacf(a, b, x) {
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
}
/** Regularized incomplete beta I_x(a, b). */
function incBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  return x < (a + 1) / (a + b + 2)
    ? (bt * betacf(a, b, x)) / a
    : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Student t CDF with `df` degrees of freedom (df may be fractional: Welch). */
function tCdf(t, df) {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const tail = 0.5 * incBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}
/** Student t quantile (inverse CDF) for p in (0, 1), by bisection. */
function tQuantile(p, df) {
  if (p === 0.5) return 0;
  if (p < 0.5) return -tQuantile(1 - p, df);
  let lo = 0;
  let hi = 1;
  while (tCdf(hi, df) < p && hi < 1e7) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const meanOf = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const varOf = (xs) => {
  const m = meanOf(xs);
  return xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
};

/**
 * Welch t on block-level values (one value per block, e.g. each block's p50): Δ = mean(a)
 * − mean(b), its standard error from the between-block variances, Welch–Satterthwaite df.
 * null when an arm has fewer than 2 blocks (no between-block variance).
 * @param {number[]} a @param {number[]} b
 * @returns {{ delta: number, se: number, df: number, nA: number, nB: number,
 *   sdA: number, sdB: number } | null}
 */
function welchBlocks(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) return null;
  const va = varOf(a);
  const vb = varOf(b);
  const qa = va / a.length;
  const qb = vb / b.length;
  const se = Math.sqrt(qa + qb);
  const den = (qa * qa) / (a.length - 1) + (qb * qb) / (b.length - 1);
  const df = den > 0 ? ((qa + qb) * (qa + qb)) / den : a.length + b.length - 2;
  return {
    delta: meanOf(a) - meanOf(b),
    se,
    df,
    nA: a.length,
    nB: b.length,
    sdA: Math.sqrt(va),
    sdB: Math.sqrt(vb),
  };
}

/** Two-sided t interval at `level` around w.delta. */
function welchCI(w, level) {
  const q = w.se > 0 ? tQuantile(1 - (1 - level) / 2, w.df) : 0;
  return [w.delta - q * w.se, w.delta + q * w.se];
}

/**
 * p-value of the CI rule at margin M for a t interval (the smallest α at which the
 * (1 − α) interval reads win, loss or parity), the analogue of decisiveP. Ranks Holm.
 */
function decisiveTP(w, M) {
  if (!(w.se > 0)) {
    const d = w.delta;
    return d < -M || d > M || (d >= -M && d <= M) ? 0 : 1;
  }
  const pOf = (x) => (x > 0 ? Math.min(1, 2 * (1 - tCdf(x, w.df))) : 1);
  const pWin = pOf((-M - w.delta) / w.se);
  const pLoss = pOf((w.delta - M) / w.se);
  const pParity = pOf(Math.min((w.delta + M) / w.se, (M - w.delta) / w.se));
  return Math.min(1, pWin, pLoss, pParity);
}

/**
 * Grade a family with the BLOCK-LEVEL rule: per item, a = the candidate's block values,
 * b = the comparator's block values (one number per block), Δ = mean(a) − mean(b), CI =
 * Welch t interval at the Holm-adjusted level, read against ±margin with the same rule as
 * gradeFamily (readCI with the point estimate), Holm step-down across the family.
 * `higherIsBetter` (a rate) flips the reading so that win = the candidate is higher.
 * Items whose arms have fewer than 2 blocks read N/A ("block-level variance not
 * estimable").
 * @param {{ key: string, a: number[] | null, b: number[] | null, margin: number | null,
 *   higherIsBetter?: boolean, digits?: number }[]} items
 * @param {{ alpha?: number }} [opt]
 */
function gradeFamilyBlocks(items, opt = {}) {
  const alpha = opt.alpha == null ? FAMILY_ALPHA : opt.alpha;
  const rnd = (x, digits) => (x == null || !Number.isFinite(x) ? x : Number(x.toFixed(digits)));
  const rows = items.map((it) => {
    const w = it.margin == null ? null : welchBlocks(it.a, it.b);
    const sign = it.higherIsBetter ? -1 : 1;
    return { it, w, sign, digits: it.digits == null ? 1 : it.digits };
  });
  const tested = rows.filter((r) => r.w);
  const ps = tested.map((r) => decisiveTP({ ...r.w, delta: r.sign * r.w.delta }, r.it.margin));
  const alphas = holmAlphas(ps, alpha);
  tested.forEach((r, i) => {
    r.p = Number(ps[i].toFixed(4));
    r.rank = alphas[i].rank;
    r.alpha = alphas[i].alpha;
    r.level = 1 - r.alpha;
    const ci = welchCI(r.w, r.level);
    r.ci = [rnd(ci[0], r.digits), rnd(ci[1], r.digits)];
    // The reading is taken on the "lower is better" orientation.
    const oriented = r.sign === 1 ? r.ci : [-r.ci[1], -r.ci[0]];
    r.ownReading = readCI(oriented, r.it.margin, r.sign * r.w.delta);
  });
  const ranked = tested.slice().sort((x, y) => x.rank - y.rank);
  const stepped = holmStepDown(ranked.map((r) => r.ownReading));
  ranked.forEach((r, k) => {
    r.reading = stepped[k].reading;
    r.holmStop = stepped[k].holmStop;
  });
  return rows.map((r) => {
    const base = {
      key: r.it.key,
      method: "Welch t on block values",
      margin: r.it.margin == null ? null : rnd(r.it.margin, r.digits),
      m: tested.length,
      nA: Array.isArray(r.it.a) ? r.it.a.length : 0,
      nB: Array.isArray(r.it.b) ? r.it.b.length : 0,
    };
    if (!r.w)
      return {
        ...base,
        delta:
          Array.isArray(r.it.a) && r.it.a.length && Array.isArray(r.it.b) && r.it.b.length
            ? rnd(meanOf(r.it.a) - meanOf(r.it.b), r.digits)
            : null,
        se: null,
        df: null,
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
      delta: rnd(r.w.delta, r.digits),
      se: rnd(r.w.se, r.digits + 1),
      df: Number(r.w.df.toFixed(2)),
      sdA: rnd(r.w.sdA, r.digits + 1),
      sdB: rnd(r.w.sdB, r.digits + 1),
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
 * Practical margin of a block-level gate (run 37591260027): max(2 % of the pooled OFF
 * p50, 1 ms). The between-block noise is in the CI itself, so it is not added again.
 * @param {number[] | null} pooledOff @returns {number | null}
 */
function practicalMargin(pooledOff) {
  if (!Array.isArray(pooledOff) || !pooledOff.length) return null;
  return round1(Math.max(EQUIV_PCT * median(pooledOff), EQUIV_FLOOR_MS));
}

/* ---- empty describes: quality metric + P11 (run 37571460849) ---- */

const Z95 = 1.959963984540054;
/** P11: the pre-registered ceiling on the empty-describe rate per timed verb per block. */
const P11_THRESHOLD = 0.25;

/**
 * Wilson score interval for a binomial proportion k/n (95 % by default), each bound
 * rounded to 4 decimals. null when n is 0.
 * @param {number} k
 * @param {number} n
 * @param {number} [z]
 * @returns {[number, number] | null}
 */
function wilsonCI(k, n, z = Z95) {
  if (!(n > 0)) return null;
  const p = k / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  const r4 = (x) => Number(x.toFixed(4));
  return [r4(Math.max(0, c - h)), r4(Math.min(1, c + h))];
}

/**
 * Newcombe (hybrid score, method 10) 95 % CI for the difference of two proportions
 * k1/n1 − k2/n2, from the two Wilson intervals; bounds rounded to 3 decimals. null when
 * either n is 0.
 */
function newcombeDiffCI(k1, n1, k2, n2) {
  const a = wilsonCI(k1, n1);
  const b = wilsonCI(k2, n2);
  if (!a || !b) return null;
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const d = p1 - p2;
  const lo = d - Math.sqrt((p1 - a[0]) ** 2 + (b[1] - p2) ** 2);
  const hi = d + Math.sqrt((a[1] - p1) ** 2 + (p2 - b[0]) ** 2);
  const r3 = (x) => Number(x.toFixed(3));
  return [r3(Math.max(-1, lo)), r3(Math.min(1, hi))];
}

/**
 * P11 for one (block, verb): `empty` timed windows with an empty describe out of `n`
 * windows that read one. PASS when the Wilson 95 % upper bound is ≤ 25 %, FAIL when the
 * lower bound is > 25 %, INCONCLUSIVE when the interval straddles 25 %. No denominator
 * (n = 0) is a FAIL: the rate cannot be shown to be under the ceiling (fail closed).
 * @param {number} empty
 * @param {number} n
 * @returns {{ empty: number, n: number, rate: number | null, ci: [number, number] | null,
 *   gate: "PASS" | "FAIL" | "INCONCLUSIVE" }}
 */
function p11Gate(empty, n) {
  const ci = wilsonCI(empty, n);
  if (!ci) return { empty, n: n || 0, rate: null, ci: null, gate: "FAIL" };
  const gate = ci[1] <= P11_THRESHOLD ? "PASS" : ci[0] > P11_THRESHOLD ? "FAIL" : "INCONCLUSIVE";
  return { empty, n, rate: Number((empty / n).toFixed(4)), ci, gate };
}

/** One verdict over many P11 rows: any FAIL → FAIL, else any INCONCLUSIVE, else PASS. */
function p11Verdict(rows) {
  if (!rows.length) return "N/A";
  const gates = rows.map((r) => r.gate);
  return gates.includes("FAIL") ? "FAIL" : gates.includes("INCONCLUSIVE") ? "INCONCLUSIVE" : "PASS";
}

module.exports = {
  newcombeDiffCI,
  LOSS_WITHIN,
  WIN_WITHIN,
  tCdf,
  tQuantile,
  welchBlocks,
  gradeFamilyBlocks,
  practicalMargin,
  wilsonCI,
  p11Gate,
  p11Verdict,
  P11_THRESHOLD,
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
