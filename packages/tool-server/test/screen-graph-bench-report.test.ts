import { describe, expect, it } from "vitest";
import {
  formatEnvValue,
  MULTIHOP_PREREGISTRATION,
  multihopSummary,
  renderMultihopReport,
  welch,
  type MultihopReportSample,
} from "../src/screen-graph/bench/report";

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

describe("Welch two-sample t", () => {
  it("matches a hand-computed case (unequal variances)", () => {
    const w = welch([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])!;
    expect(w.diff).toBe(-3);
    expect(w.t).toBeCloseTo(-1.8974, 3);
    expect(w.df).toBeCloseTo(5.882, 2);
    expect(w.p).toBeGreaterThan(0.1);
    expect(w.p).toBeLessThan(0.115);
  });

  it("is null when a side has fewer than 2 values or no variance at all", () => {
    expect(welch([1], [1, 2])).toBeNull();
    expect(welch([3, 3, 3], [3, 3, 3])).toBeNull();
  });
});

/** Two tasks x 3 reps; one graph failure (mh-b rep 2), one nograph failure (mh-a rep 1). */
function synthetic(): MultihopReportSample[] {
  const out: MultihopReportSample[] = [];
  for (const task of ["mh-a", "mh-b"]) {
    for (let rep = 0; rep < 3; rep++) {
      out.push({
        task,
        arm: "graph",
        rep,
        hops: 3,
        plannedHops: 3,
        toolCalls: 2,
        obsTokens: 100 + rep,
        rpcs: 8,
        wallMs: 900,
        success: !(task === "mh-b" && rep === 2),
        targetInSummary: task === "mh-a",
      });
      out.push({
        task,
        arm: "nograph",
        rep,
        hops: 3,
        plannedHops: 3,
        toolCalls: 6,
        obsTokens: 600 + 6 * rep,
        rpcs: 6,
        wallMs: 2700 + rep,
        success: !(task === "mh-a" && rep === 1),
      });
    }
  }
  return out;
}

describe("MULTIHOP report", () => {
  it("pairs graph and nograph by task + rep and scores success non-inferiority", () => {
    const s = multihopSummary(synthetic());
    expect(s.paired).toMatchObject({ pairs: 6, both: 4, graphOnly: 1, nographOnly: 1, neither: 0 });
    expect(s.paired.diffPp).toBe(0);
    // Cost ratios over the 4 pairs where both arms succeeded.
    expect(s.aggregate.toolCalls.ratio).toBe(0.333);
    expect(s.aggregate.obsTokens.ratio).toBe(0.167);
    expect(s.aggregate.toolCalls.n).toBe(4);
    // 2 vs 2k by construction: reported, never graded.
    expect(s.aggregate.toolCalls.bar).toBeUndefined();
    expect(s.aggregate.toolCalls.met).toBeUndefined();
    expect(s.aggregate.obsTokens.met).toBe(true);
    expect(s.perTask.map((r) => r.task)).toEqual(["mh-a", "mh-b"]);
    expect(s.perTask[0]).toMatchObject({ task: "mh-a", graphOk: 3, nographOk: 2, n: 3 });
  });

  it("does not meet a bar the data misses", () => {
    const heavy = synthetic().map((x) => (x.arm === "graph" ? { ...x, obsTokens: 500 } : x));
    const s = multihopSummary(heavy);
    expect(s.aggregate.obsTokens.met).toBe(false);
  });

  it("renders the pre-registration, a per-task table, the aggregate and the paired success", () => {
    const md = renderMultihopReport({
      samples: synthetic(),
      warmups: [
        { task: "mh-a", ok: true, target: { label: "A" } },
        { task: "mh-b", ok: true, target: { screen: "bbbbbbbb" } },
      ],
      reps: 3,
    });
    expect(MULTIHOP_PREREGISTRATION).toMatch(
      /^Cost claims \(graph target supplied by the harness\)/
    );
    expect(MULTIHOP_PREREGISTRATION).toMatch(/tokens ≤ 0\.7× nograph/);
    expect(MULTIHOP_PREREGISTRATION).toMatch(/non-inferior \(paired/);
    expect(MULTIHOP_PREREGISTRATION).toMatch(/tool calls .*reported without a bar \(2 vs 2k/);
    expect(MULTIHOP_PREREGISTRATION).toMatch(/Discovery claim \(report only\)/);
    expect(md).toContain(MULTIHOP_PREREGISTRATION);
    expect(md).toMatch(/^\| mh-a \| 3 \|/m);
    expect(md).toMatch(/^\| mh-b \| 3 \|/m);
    expect(md).toMatch(/\| tool calls \|.*\| 0\.333 \|.*structural \(2 vs 2k\) \|/);
    expect(md).toContain(
      "Cost claims hold with the graph target supplied by the harness, not discovered by the model."
    );
    expect(md).toMatch(/\| observation tokens \|.*\| 0\.167 \|/);
    expect(md).toContain("pairs 6: both 4, graph only 1, nograph only 1, neither 0");
    expect(md).toContain("measurement only, no promotion gate");
    expect(md).toContain("target `bbbbbbbb` (screen)");
    expect(md).toContain("same renderer on both arms");
    expect(md).toContain("### Discovery claim (report only)");
    expect(md).toContain(
      "the model can address a depth ≥3 target from the root summary only if it is listed; with the current cap of 8 and this Settings graph it is 3/6 — product gap, see plan Amendments (summary cap)"
    );
    expect(md).not.toContain("store reset");
    expect(md).toMatch(/Welch p is unpaired/);
  });

  it("excludes tasks whose warm-up failed from the pairs and says so", () => {
    const s = multihopSummary(synthetic(), { excludeTasks: ["mh-b"] });
    expect(s.paired.pairs).toBe(3);
    expect(s.perTask.map((r) => r.task)).toEqual(["mh-a"]);
    const md = renderMultihopReport({
      samples: synthetic(),
      warmups: [
        {
          task: "mh-a",
          ok: true,
          target: { label: "A" },
          taps: 3,
          rpcs: 9,
          wallMs: 1200,
          listedFromDepth: 1,
        },
        { task: "mh-b", ok: false, error: "warm-up hop 3", taps: 2, rpcs: 6, wallMs: 800 },
      ],
      reps: 3,
    });
    expect(md).toContain("warm-up failed: 1 task excluded (mh-b)");
    expect(md).toMatch(/^\| mh-a \| ok \| target `A` \(label\) \| 3 \| 9 \| 1200 \| 1 \|/m);
    expect(md).not.toMatch(/^\| mh-b \| 3 \|/m);
    expect(md).toContain("pairs 3:");
  });

  it("states whether the app graph was reset before the warm-up", () => {
    const base = { samples: synthetic(), warmups: [], reps: 3 };
    const reset = renderMultihopReport({
      ...base,
      storeReset: {
        reset: true,
        packageName: "com.android.settings",
        nodesBefore: 11,
        edgesBefore: 10,
      },
    });
    expect(reset).toContain(
      "store reset before the warm-up: yes (com.android.settings held 11 nodes, 10 edges)"
    );
    const kept = renderMultihopReport({
      ...base,
      storeReset: {
        reset: false,
        packageName: "com.android.settings",
        nodesBefore: 4,
        edgesBefore: 3,
      },
    });
    expect(kept).toContain(
      "store reset before the warm-up: no, BENCH_FRESH_STORE unset (com.android.settings held 4 nodes, 3 edges)"
    );
  });
});
