import { describe, expect, it } from "vitest";
import { gradeNavG3 } from "../src/screen-graph/bench/churn";

const ok = { arrived: true, targetPresent: true };
const miss = { arrived: false, targetPresent: true };
const absent = { arrived: false, targetPresent: false };

describe("E1-G3 grades navigate-to over present targets only", () => {
  it("passes 38/40 and fails 37/40 when every target was present", () => {
    const pass = gradeNavG3([...Array(38).fill(ok), ...Array(2).fill(miss)]);
    expect(pass.pass).toBe(true);
    expect(pass.detail).toContain("present-only 38/40 (bar 38/40");
    expect(pass.detail).toContain("raw 38/40");
    const fail = gradeNavG3([...Array(37).fill(ok), ...Array(3).fill(miss)]);
    expect(fail.pass).toBe(false);
  });

  it("drops attempts whose target was churned away from the denominator", () => {
    const g = gradeNavG3([...Array(36).fill(ok), ...Array(4).fill(absent)]);
    // 36/36 present (bar ceil(0.95 x 36) = 35); the raw 36/40 is still reported.
    expect(g.presentOk).toBe(36);
    expect(g.presentTotal).toBe(36);
    expect(g.pass).toBe(true);
    expect(g.detail).toContain("bar 35/36");
    expect(g.detail).toContain("raw 36/40");
  });

  it("fails when no attempt had its target present", () => {
    expect(gradeNavG3([absent, absent]).pass).toBe(false);
  });
});
