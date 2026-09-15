/**
 * Optical scroll estimator (ticket 3o). Measures how far a scrollable region
 * travelled between a pre-swipe and a post-settle screenshot, in PIXELS of the
 * original framebuffer, by 1-D cross-correlation of a downscaled grayscale strip
 * along the scroll (vertical) axis.
 *
 * WHY optical, not anchor-displacement: the deleted 3n.2 fling metric
 * (`775ae6fc:bench-fling-fidelity.ts`) scored the median downward displacement of
 * labelled rows surviving in BOTH describes, with a `> 0.02` filter and an
 * `if (disps.length === 0) return 1` clamp. Review 3N-H3 showed it censored,
 * quantized (47 % of samples on three atoms) and clamped — unfit for a ratio gate.
 * This estimator is backend-independent (it reads the host framebuffer, not the
 * describe tree), emits a RAW pixel offset per sample, and has NO clamp, NO floor
 * and NO ratio: the ratio/gate live in the merge, never here.
 *
 * Design:
 *  1. Both screenshots (PNG from `adb exec-out screencap -p`) are decoded to RGBA.
 *  2. Over a region of interest (a central vertical band, so a sticky top nav bar
 *     or bottom action bar contributes little), each source ROW is collapsed to one
 *     grayscale value by averaging `colBins` evenly-spaced columns — a 1-D strip at
 *     FULL resolution along the scroll axis (downscaled only across columns), so the
 *     offset keeps single-pixel resolution.
 *  3. Zero-mean normalized cross-correlation (NCC) between the two strips over integer
 *     shifts `s ∈ [-maxShift, +maxShift]`; `after[y] ≈ before[y + s]` when the content
 *     moved UP (a flinging swipe-up) by `s` px, so the argmax `s*` is the offset.
 *  4. Sub-pixel refinement by parabolic interpolation of NCC at `s*-1, s*, s*+1`.
 *  5. The peak NCC is the CONFIDENCE; a sample below `minConfidence` (default 0.6) is
 *     REFUSED (`offsetPx: null`) rather than reported — a blank strip (zero variance)
 *     or an unmatched pair never yields a spurious offset.
 */
import { PNG } from "pngjs";

export interface ScrollEstimate {
  /** Sub-pixel offset in framebuffer px (content moved up ⇒ positive); null when refused. */
  offsetPx: number | null;
  /** Peak normalized cross-correlation in [-1, 1] — the confidence. */
  confidence: number;
  /** Integer argmax shift before sub-pixel refinement (diagnostic). */
  peakShift: number;
  /** True when confidence < minConfidence (or the strips were degenerate). */
  refused: boolean;
  reason?: string;
}

interface StripOptions {
  /** ROI column band as fractions of width (default 0.1 … 0.9). */
  x0?: number;
  x1?: number;
  /** ROI row band as fractions of height (default 0.22 … 0.86). */
  y0?: number;
  y1?: number;
  /** Max |shift| as a fraction of ROI height (default 0.9). */
  maxShiftFrac?: number;
  /** Refuse the sample below this peak correlation (default 0.6). */
  minConfidence?: number;
  /** Columns sampled per row when collapsing to the 1-D strip (default 64). */
  colBins?: number;
}

const DEFAULTS: Required<StripOptions> = {
  x0: 0.1,
  x1: 0.9,
  y0: 0.22,
  y1: 0.86,
  maxShiftFrac: 0.9,
  minConfidence: 0.6,
  colBins: 64,
};

interface Decoded {
  width: number;
  height: number;
  data: Buffer; // RGBA
}

function decode(buf: Buffer): Decoded {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

/**
 * Collapse the ROI of a decoded RGBA image to a 1-D grayscale strip along y:
 * one value per SOURCE row, each the mean over `colBins` evenly-spaced columns.
 */
function stripFromDecoded(img: Decoded, opt: Required<StripOptions>): Float64Array {
  const xStart = Math.max(0, Math.floor(opt.x0 * img.width));
  const xEnd = Math.min(img.width, Math.ceil(opt.x1 * img.width));
  const yStart = Math.max(0, Math.floor(opt.y0 * img.height));
  const yEnd = Math.min(img.height, Math.ceil(opt.y1 * img.height));
  const rows = Math.max(0, yEnd - yStart);
  const strip = new Float64Array(rows);
  const cols = Math.max(1, Math.min(opt.colBins, xEnd - xStart));
  const colStep = (xEnd - xStart) / cols;
  for (let ry = 0; ry < rows; ry++) {
    const y = yStart + ry;
    let acc = 0;
    for (let c = 0; c < cols; c++) {
      const x = Math.min(xEnd - 1, xStart + Math.floor(c * colStep));
      const idx = (y * img.width + x) * 4;
      const r = img.data[idx]!;
      const g = img.data[idx + 1]!;
      const b = img.data[idx + 2]!;
      acc += 0.299 * r + 0.587 * g + 0.114 * b;
    }
    strip[ry] = acc / cols;
  }
  return strip;
}

/** Mean and variance of a slice of a strip. */
function stats(a: Float64Array, from: number, to: number): { mean: number; varSum: number } {
  let sum = 0;
  const n = to - from;
  for (let i = from; i < to; i++) sum += a[i]!;
  const mean = sum / n;
  let varSum = 0;
  for (let i = from; i < to; i++) {
    const d = a[i]! - mean;
    varSum += d * d;
  }
  return { mean, varSum };
}

/**
 * Zero-mean normalized cross-correlation of `after` against `before` at integer
 * shift `s` (after[y] vs before[y+s]), computed over the valid overlap only, with
 * means taken over the overlap. Returns NaN if either side has ~zero variance.
 */
function ncc(before: Float64Array, after: Float64Array, s: number, minOverlap: number): number {
  const n = after.length;
  // Overlap in `after` index space.
  const yLo = Math.max(0, -s);
  const yHi = Math.min(n, n - s);
  const len = yHi - yLo;
  if (len < minOverlap) return Number.NaN;
  // means over the overlap
  let sa = 0;
  let sb = 0;
  for (let y = yLo; y < yHi; y++) {
    sa += after[y]!;
    sb += before[y + s]!;
  }
  const ma = sa / len;
  const mb = sb / len;
  let num = 0;
  let da2 = 0;
  let db2 = 0;
  for (let y = yLo; y < yHi; y++) {
    const da = after[y]! - ma;
    const db = before[y + s]! - mb;
    num += da * db;
    da2 += da * da;
    db2 += db * db;
  }
  const denom = Math.sqrt(da2 * db2);
  if (!(denom > 0)) return Number.NaN;
  return num / denom;
}

/**
 * Cross-correlate two pre-built strips. Pure (no PNG), so unit tests can drive it
 * with synthetic profiles as well as decoded frames.
 */
export function correlateStrips(
  before: Float64Array,
  after: Float64Array,
  options: StripOptions = {}
): ScrollEstimate {
  const opt = { ...DEFAULTS, ...options };
  const n = Math.min(before.length, after.length);
  if (n < 8) {
    return {
      offsetPx: null,
      confidence: 0,
      peakShift: 0,
      refused: true,
      reason: "strip too short",
    };
  }
  // Degenerate (blank) strip → zero variance → refuse without a spurious peak.
  const va = stats(after, 0, after.length).varSum;
  const vb = stats(before, 0, before.length).varSum;
  if (!(va > 1e-6) || !(vb > 1e-6)) {
    return {
      offsetPx: null,
      confidence: 0,
      peakShift: 0,
      refused: true,
      reason: "blank/uniform strip (no variance)",
    };
  }
  const maxShift = Math.max(1, Math.floor(opt.maxShiftFrac * n));
  const minOverlap = Math.max(8, Math.floor(0.2 * n));
  let bestS = 0;
  let bestC = -Infinity;
  const cache = new Map<number, number>();
  const at = (s: number): number => {
    let v = cache.get(s);
    if (v === undefined) {
      v = ncc(before, after, s, minOverlap);
      cache.set(s, v);
    }
    return v;
  };
  for (let s = -maxShift; s <= maxShift; s++) {
    const c = at(s);
    if (Number.isFinite(c) && c > bestC) {
      bestC = c;
      bestS = s;
    }
  }
  if (!Number.isFinite(bestC)) {
    return { offsetPx: null, confidence: 0, peakShift: 0, refused: true, reason: "no valid shift" };
  }
  // Sub-pixel parabolic refinement around the integer peak.
  let offset = bestS;
  const cm = at(bestS - 1);
  const cp = at(bestS + 1);
  const c0 = bestC;
  if (Number.isFinite(cm) && Number.isFinite(cp)) {
    const denom = cm - 2 * c0 + cp;
    if (Math.abs(denom) > 1e-9) {
      const delta = (0.5 * (cm - cp)) / denom;
      if (Math.abs(delta) <= 1) offset = bestS + delta;
    }
  }
  const confidence = Number(c0.toFixed(4));
  const refused = c0 < opt.minConfidence;
  return {
    offsetPx: refused ? null : Number(offset.toFixed(3)),
    confidence,
    peakShift: bestS,
    refused,
    reason: refused ? `confidence ${confidence} < ${opt.minConfidence}` : undefined,
  };
}

/** Estimate the scroll offset (px) between two PNG framebuffers. */
export function estimateScrollPx(
  beforePng: Buffer,
  afterPng: Buffer,
  options: StripOptions = {}
): ScrollEstimate {
  const opt = { ...DEFAULTS, ...options };
  const b = decode(beforePng);
  const a = decode(afterPng);
  if (a.width !== b.width || a.height !== b.height) {
    return {
      offsetPx: null,
      confidence: 0,
      peakShift: 0,
      refused: true,
      reason: `dimension mismatch ${b.width}x${b.height} vs ${a.width}x${a.height}`,
    };
  }
  const before = stripFromDecoded(b, opt);
  const after = stripFromDecoded(a, opt);
  return correlateStrips(before, after, opt);
}
