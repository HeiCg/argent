import { describe, it, expect } from "vitest";
import {
  loadFixture,
  countNodes,
  percentile,
  stat,
  runHostBench,
  DEFAULT_FIXTURE_PATH,
} from "../scripts/bench-describe-host";

// Harness unit test for the phase 3i host micro-bench. Pins the committed fixture
// shape and the pure stat helpers so the bench numbers stay comparable run to run.

describe("bench-describe-host harness", () => {
  describe("percentile (nearest-rank, unsorted input)", () => {
    it("handles the ends and the middle", () => {
      const xs = [5, 1, 4, 2, 3]; // sorted: 1 2 3 4 5
      expect(percentile(xs, 0)).toBe(1);
      expect(percentile(xs, 50)).toBe(3);
      expect(percentile(xs, 100)).toBe(5);
      // p95 of 5 samples -> ceil(0.95*5)-1 = 4 -> the max
      expect(percentile(xs, 95)).toBe(5);
    });
    it("returns NaN for an empty sample", () => {
      expect(Number.isNaN(percentile([], 50))).toBe(true);
    });
  });

  describe("stat", () => {
    it("summarizes a sample", () => {
      const s = stat([2, 4, 6, 8]);
      expect(s.n).toBe(4);
      expect(s.min).toBe(2);
      expect(s.mean).toBe(5);
      expect(s.p50).toBe(4); // ceil(0.5*4)-1 = 1 -> 4
    });
    it("is all-NaN for an empty sample", () => {
      const s = stat([]);
      expect(s.n).toBe(0);
      expect(Number.isNaN(s.p50)).toBe(true);
    });
  });

  describe("fixture", () => {
    it("loads the committed idle-Settings nested tree", () => {
      const fx = loadFixture(DEFAULT_FIXTURE_PATH);
      expect(fx.screen).toEqual({ width: 1080, height: 2400 });
      expect(Array.isArray(fx.tree)).toBe(true);
      // Two window roots: a status-bar system window + the app window.
      expect(fx.tree.length).toBe(2);
      // Locked node count so a fixture edit that changes the payload is noticed.
      expect(countNodes(fx.tree)).toBe(126);
    });
  });

  describe("runHostBench", () => {
    it("reports payload facts and finite per-stage p50s", () => {
      const fx = loadFixture(DEFAULT_FIXTURE_PATH);
      const r = runHostBench(fx, { iterations: 30, warmup: 5, tokenize: true });
      // Payload facts are deterministic (independent of timing).
      expect(r.payload.wireBytes).toBe(21829);
      expect(r.payload.nodeCount).toBe(126);
      expect(r.payload.renderedLines).toBe(23);
      expect(r.payload.renderedBytes).toBe(1811);
      // o200k count of the rendered idle Settings tree — the representative figure
      // the device bench should land near (device idle Settings is 657 tokens).
      expect(r.payload.tokens).toBe(667);
      // Every host stage produced a finite, non-negative p50.
      for (const s of [
        r.stages.parseMs,
        r.stages.lowerMs,
        r.stages.trimMs,
        r.stages.renderMs,
        r.stages.totalMs,
      ]) {
        expect(Number.isFinite(s.p50)).toBe(true);
        expect(s.p50).toBeGreaterThanOrEqual(0);
        expect(s.n).toBe(30);
      }
      // The whole host CPU pipeline is sub-millisecond — the residual the CI bench
      // measures is transport, not host CPU (phase 3i finding).
      expect(r.stages.totalMs.p50).toBeLessThan(5);
    });

    it("runs with tokenization disabled", () => {
      const fx = loadFixture(DEFAULT_FIXTURE_PATH);
      const r = runHostBench(fx, { iterations: 10, warmup: 2, tokenize: false });
      expect(r.payload.tokens).toBeNull();
      expect(r.stages.tokenizeMs.n).toBe(0);
      expect(Number.isFinite(r.stages.trimMs.p50)).toBe(true);
    });
  });
});
