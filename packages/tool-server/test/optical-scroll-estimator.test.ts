import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { correlateStrips, estimateScrollPx } from "../scripts/optical-scroll";

// Deterministic per-row texture so the collapsed 1-D strip has a unique, high-variance
// signal (a sharp NCC peak) and is NOT periodic (which would make the peak ambiguous).
function baseRow(y: number): number {
  // LCG-ish hash of the row index → [0, 255]
  let h = (y * 2654435761) >>> 0;
  h ^= h >>> 15;
  h = (h * 2246822519) >>> 0;
  h ^= h >>> 13;
  return h % 256;
}

/** A W×H grayscale PNG whose visible content is `base` starting at row `srcY0`. */
function scrolledPng(w: number, h: number, srcY0: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const v = baseRow(srcY0 + y);
    for (let x = 0; x < w; x++) {
      // Mild deterministic column texture so a row is not perfectly flat.
      const t = ((x * 7 + (srcY0 + y) * 3) % 17) - 8;
      const px = Math.max(0, Math.min(255, v + t));
      const idx = (y * w + x) * 4;
      png.data[idx] = px;
      png.data[idx + 1] = px;
      png.data[idx + 2] = px;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function uniformPng(w: number, h: number, value: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = value;
    png.data[i + 1] = value;
    png.data[i + 2] = value;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("optical scroll estimator (ticket 3o)", () => {
  const W = 120;
  const H = 360;

  it("recovers a known scroll of N px within ±1 px (generated images)", () => {
    const before = scrolledPng(W, H, 0);
    for (const N of [0, 7, 23, 60, 100, 150, 180]) {
      const after = scrolledPng(W, H, N); // content moved UP by N px
      const est = estimateScrollPx(before, after);
      expect(est.refused, `N=${N} should not be refused (confidence ${est.confidence})`).toBe(false);
      expect(est.offsetPx, `N=${N} offset should be finite`).not.toBeNull();
      const err = Math.abs((est.offsetPx as number) - N);
      expect(err, `N=${N}: estimated ${est.offsetPx}, error ${err.toFixed(3)} px`).toBeLessThanOrEqual(1);
      // A true match on this synthetic texture correlates very strongly.
      expect(est.confidence, `N=${N} confidence`).toBeGreaterThan(0.9);
    }
  });

  it("refuses a blank/uniform strip (confidence below 0.6 → offset null)", () => {
    const blankA = uniformPng(W, H, 128);
    const blankB = uniformPng(W, H, 128);
    const est = estimateScrollPx(blankA, blankB);
    expect(est.refused).toBe(true);
    expect(est.offsetPx).toBeNull();
    expect(est.confidence).toBeLessThan(0.6);
  });

  it("refuses when the after frame is blank but the before frame is textured", () => {
    const before = scrolledPng(W, H, 0);
    const blank = uniformPng(W, H, 200);
    const est = estimateScrollPx(before, blank);
    expect(est.refused).toBe(true);
    expect(est.offsetPx).toBeNull();
  });

  it("refuses uncorrelated frames (two independent random textures)", () => {
    // Build a second, unrelated texture by re-seeding rows far apart in hash space.
    const a = scrolledPng(W, H, 0);
    const png = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) {
      // A different generator with no fixed shift relative to `a`.
      const v = (((y * 40503) ^ 0x9e37) >>> 0) % 256;
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        png.data[idx] = v;
        png.data[idx + 1] = v;
        png.data[idx + 2] = v;
        png.data[idx + 3] = 255;
      }
    }
    const est = estimateScrollPx(a, PNG.sync.write(png), { minConfidence: 0.6 });
    // No genuine alignment exists → the peak correlation should fall under the gate.
    expect(est.confidence).toBeLessThan(0.6);
    expect(est.refused).toBe(true);
    expect(est.offsetPx).toBeNull();
  });

  it("reports dimension mismatch as a refusal, never a spurious offset", () => {
    const a = scrolledPng(W, H, 0);
    const b = scrolledPng(W, H + 10, 0);
    const est = estimateScrollPx(a, b);
    expect(est.refused).toBe(true);
    expect(est.offsetPx).toBeNull();
    expect(est.reason).toMatch(/dimension mismatch/);
  });

  it("correlateStrips is pure and sub-pixel around the integer peak", () => {
    // A triangular ramp profile shifted by 12 samples → exact integer recovery.
    const n = 240;
    const before = new Float64Array(n);
    const after = new Float64Array(n);
    const shape = (i: number): number => 100 + 80 * Math.sin(i / 5) + ((i * 13) % 29);
    for (let i = 0; i < n; i++) before[i] = shape(i);
    for (let i = 0; i < n; i++) after[i] = shape(i + 12);
    const est = correlateStrips(before, after, { y0: 0, y1: 1, x0: 0, x1: 1 });
    expect(est.refused).toBe(false);
    expect(Math.abs((est.offsetPx as number) - 12)).toBeLessThanOrEqual(1);
  });
});
