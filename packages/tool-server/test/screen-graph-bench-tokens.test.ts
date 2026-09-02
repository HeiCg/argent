import { describe, expect, it } from "vitest";
import {
  charsOver4,
  countBoth,
  pct,
  range,
  ratio,
  summarize,
  tiktokenCount,
} from "../src/screen-graph/bench/tokens";

describe("screen-graph bench tokens + stats", () => {
  it("chars/4 rounds up", () => {
    expect(charsOver4("")).toBe(0);
    expect(charsOver4("abcd")).toBe(1);
    expect(charsOver4("abcde")).toBe(2);
  });

  it("tiktoken count is a positive integer for non-empty text and 0 for empty", () => {
    expect(tiktokenCount("")).toBe(0);
    const n = tiktokenCount("hello world, this is a screen dump");
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });

  it("countBoth returns both estimates", () => {
    const both = countBoth("battery usage 42%");
    expect(both.charsDiv4).toBe(charsOver4("battery usage 42%"));
    expect(both.tiktoken).toBeGreaterThan(0);
  });

  it("percentiles pick the ceil-indexed order statistic", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(pct(xs, 50)).toBe(5);
    expect(pct(xs, 95)).toBe(10);
    expect(pct([], 50)).toBeNaN();
  });

  it("summarize reports n/p50/p95/min/max/mean", () => {
    const s = summarize([10, 20, 30, 40]);
    expect(s.n).toBe(4);
    expect(s.min).toBe(10);
    expect(s.max).toBe(40);
    expect(s.mean).toBe(25);
    expect(s.p50).toBe(20);
  });

  it("range prints min–max across repetitions", () => {
    expect(range([30, 10, 20])).toBe("10–30");
    expect(range([])).toBe("—");
  });

  it("ratio guards divide-by-zero", () => {
    expect(ratio(1, 5)).toBe(0.2);
    expect(ratio(1, 0)).toBeNaN();
    expect(ratio(NaN, 5)).toBeNaN();
  });
});
