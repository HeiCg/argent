import { describe, expect, it } from "vitest";
import { formatEnvValue } from "../src/screen-graph/bench/report";

describe("results-ci.md environment cells (review E-1 finding 8)", () => {
  it("prints objects as JSON, never [object Object]", () => {
    const cell = formatEnvValue({ nodes: 10, edges: 9 });
    expect(cell).toBe('{"nodes":10,"edges":9}');
    expect(formatEnvValue({ gates: { "E1-G1": { pass: true } } })).not.toContain("[object Object]");
  });

  it("escapes table pipes and keeps scalars as they were", () => {
    expect(formatEnvValue({ d: "a | b" })).toBe('{"d":"a \\| b"}');
    expect(formatEnvValue(42)).toBe("42");
    expect(formatEnvValue("x")).toBe("x");
    expect(formatEnvValue(undefined)).toBe("undefined");
    expect(formatEnvValue(null)).toBe("null");
  });
});
