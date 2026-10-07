import { describe, expect, it } from "vitest";
import { arrivalCheck, gradeG5, gradeNavG3, summarizeMs } from "../src/screen-graph/bench/churn";

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

describe("E1-G3 excludes the deliberately absent targets (review E-1 finding 5)", () => {
  it("keeps give-up probes out of the denominator even when marked present", () => {
    const probe = { arrived: false, targetPresent: false, deliberatelyAbsent: true };
    const g = gradeNavG3([...Array(40).fill(ok), ...Array(4).fill(probe)]);
    expect(g.presentTotal).toBe(40);
    expect(g.presentOk).toBe(40);
    expect(g.detail).toContain("raw 40/40");
  });
});

describe("E1-G5 is graded against the pre-registered bar (review E-1 finding 1)", () => {
  it("fails run 4 (store 10/9, O1 136, O4 20) on O1 alone, with the numbers", () => {
    const g = gradeG5({ settingsNodes: 10, settingsEdges: 9, o1TokP50: 136, o4TokP50: 20 });
    expect(g.pass).toBe(false);
    expect(g.detail).toContain("O1 136 not in 138-179");
    expect(g.detail).toContain("store 10n/9e in");
    expect(g.detail).toContain("O4 20 in 20-22");
  });

  it("passes the D.4.1 reference (11/10, O1 179, O4 21)", () => {
    expect(
      gradeG5({ settingsNodes: 11, settingsEdges: 10, o1TokP50: 179, o4TokP50: 21 }).pass
    ).toBe(true);
  });

  it("fails on a store shape outside the published range", () => {
    const g = gradeG5({ settingsNodes: 14, settingsEdges: 10, o1TokP50: 150, o4TokP50: 21 });
    expect(g.pass).toBe(false);
    expect(g.detail).toContain("store 14n/10e not in");
  });

  it("fails (not measured) when the matrix numbers are missing", () => {
    const g = gradeG5({});
    expect(g.pass).toBe(false);
    expect(g.detail).toContain("not measured");
  });
});

describe("arrival is the requested item's detail (review E-1 finding 3)", () => {
  const detailRids = ["detail_body", "detail_toolbar", "title"];
  const detail = (headline: string) => [
    { text: headline, resourceId: "x:id/title" },
    { text: `Detail body for ${headline}`, resourceId: "x:id/detail_body" },
  ];

  it("accepts the right headline on the detail layout", () => {
    const a = arrivalCheck(detail("Headline 1001-32"), detailRids, "Headline 1001-32", detailRids);
    expect(a).toEqual({ headlineOk: true, layoutOk: true, arrived: true });
  });

  it("rejects another item's detail page (same layout, wrong headline)", () => {
    const a = arrivalCheck(detail("Headline 1001-33"), detailRids, "Headline 1001-32", detailRids);
    expect(a.headlineOk).toBe(false);
    expect(a.arrived).toBe(false);
  });

  it("rejects the feed, whose row summary carries the same headline text", () => {
    const feed = [
      { text: "Story 32" },
      { text: "Headline 1001-32", resourceId: "x:id/row_summary" },
    ];
    const a = arrivalCheck(feed, ["feed_toolbar", "title"], "Headline 1001-32", detailRids);
    expect(a.headlineOk).toBe(true);
    expect(a.layoutOk).toBe(false);
    expect(a.arrived).toBe(false);
  });
});

describe("timing summaries (review E-1 finding 4)", () => {
  it("summarises p50 and max, and an empty list as n=0", () => {
    expect(summarizeMs([300, 100, 200])).toEqual({ n: 3, p50: 200, max: 300 });
    expect(summarizeMs([])).toEqual({ n: 0, p50: null, max: null });
  });
});
