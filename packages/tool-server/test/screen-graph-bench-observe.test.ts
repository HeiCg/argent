import { describe, expect, it } from "vitest";
import { observationQuery } from "../src/screen-graph/bench/observe";
import { parseDescribeLocate } from "../src/screen-graph/bench/describe-locate";
import type { BenchTask } from "../src/screen-graph/bench/types";

/**
 * C.4 work item D — the per-step OBSERVATION selector must NOT depend on the
 * assertion needle. The acceptance test: swap one needle and every step's
 * observation selector is byte-identical (the C.3 bug fed `task.assertion` on
 * every non-tap step, so O1/O2 tokens moved with the needle).
 */
const settingsTask = (assertion: string): BenchTask => ({
  id: "settings-display",
  app: "settings",
  description: "Scroll to and open Display",
  steps: [
    { action: { kind: "launch" } },
    { action: { kind: "swipe", direction: "up" } },
    { action: { kind: "tap", selector: { text: "Display" } }, knownTarget: true },
  ],
  assertion: { text: assertion },
  navTarget: { text: "Brightness" },
  query: { text: "Display" },
});

describe("observationQuery — needle independence (C.4 work item D)", () => {
  it("is identical for every step before and after swapping the needle", () => {
    const before = settingsTask("Brightness level");
    const after = settingsTask("A COMPLETELY DIFFERENT NEEDLE");
    for (let i = 0; i < before.steps.length; i++) {
      expect(observationQuery(after, after.steps[i]!)).toEqual(
        observationQuery(before, before.steps[i]!)
      );
    }
  });

  it("observes the step's own target for tap/type, and the query anchor otherwise", () => {
    const task = settingsTask("Brightness level");
    // launch → query anchor
    expect(observationQuery(task, task.steps[0]!)).toEqual({ text: "Display" });
    // swipe → query anchor (never the needle)
    expect(observationQuery(task, task.steps[1]!)).toEqual({ text: "Display" });
    // tap → its own selector
    expect(observationQuery(task, task.steps[2]!)).toEqual({ text: "Display" });
  });

  it("never returns the assertion needle even without a declared query", () => {
    const noQuery: BenchTask = {
      id: "settings-network",
      app: "settings",
      description: "Open Network & internet",
      steps: [
        { action: { kind: "launch" } },
        { action: { kind: "tap", selector: { text: "Network & internet" } }, knownTarget: true },
      ],
      assertion: { text: "Calls & SMS" },
    };
    // launch falls back to the FIRST tap selector, not the assertion.
    expect(observationQuery(noQuery, noQuery.steps[0]!)).toEqual({ text: "Network & internet" });
    expect(observationQuery(noQuery, noQuery.steps[1]!)).toEqual({ text: "Network & internet" });
  });
});

describe("parseDescribeLocate — B1 live describe+tap locate (C.4 work item A)", () => {
  // A realistic Android `describe` rendering: one line per node, frame last.
  const describe_ = [
    "Source: android-devtools",
    "Mode: nested",
    "Coordinates are normalized [0,1] fractions of the screen (x, y, width, height), not pixels.",
    "",
    "ROOT  AXWindow (0.000, 0.000, 1.000, 1.000)",
    "",
    '  AXStaticText "Settings"  (0.050, 0.040, 0.300, 0.030)',
    '  AXButton "Network & internet" id="title" [clickable]  (0.000, 0.180, 1.000, 0.070)',
    '  AXStaticText "Mobile, Wi‑Fi, hotspot"  (0.050, 0.210, 0.600, 0.020)',
    '  AXButton "Connected devices" [clickable]  (0.000, 0.260, 1.000, 0.070)',
  ].join("\n");

  it("finds the topmost matching row and returns its frame centre", () => {
    const loc = parseDescribeLocate(describe_, { text: "Network & internet" });
    expect(loc.found).toBe(true);
    expect(loc.xNorm).toBeCloseTo(0.5, 3); // 0.000 + 1.000/2
    expect(loc.yNorm).toBeCloseTo(0.215, 3); // 0.180 + 0.070/2
  });

  it("matches case-insensitively and by contained substring", () => {
    expect(parseDescribeLocate(describe_, { text: "connected devices" }).found).toBe(true);
    expect(parseDescribeLocate(describe_, { text: "wi‑fi" }).found).toBe(true);
  });

  it("matches by resource-id when given one", () => {
    const loc = parseDescribeLocate(describe_, { id: "title" });
    expect(loc.found).toBe(true);
    expect(loc.yNorm).toBeCloseTo(0.215, 3);
  });

  it("returns found:false (never a centre tap) when the target is absent", () => {
    expect(parseDescribeLocate(describe_, { text: "Bluetooth settings" })).toEqual({
      xNorm: 0.5,
      yNorm: 0.5,
      found: false,
    });
  });

  // Phase D.3 (D2-H3): an EXACT quoted label beats a contains-hit that comes first.
  const netInternet = [
    '  AXStaticText "Network & internet" id="collapsing_toolbar"  (0.000, 0.030, 1.000, 0.100)',
    '  AXButton "Internet" "AndroidWifi" id="title" [clickable]  (0.000, 0.200, 1.000, 0.070)',
    '  AXButton "Calls & SMS" id="title" [clickable]  (0.000, 0.280, 1.000, 0.070)',
  ].join("\n");

  it("D2-H3: t('Internet') takes the exact 'Internet' row, NOT the 'Network & internet' toolbar", () => {
    const loc = parseDescribeLocate(netInternet, { text: "Internet" });
    expect(loc.found).toBe(true);
    expect(loc.yNorm).toBeCloseTo(0.235, 3); // 0.200 + 0.070/2 — the Internet row
  });

  it("finds a row that carries a subtitle value (exact label match)", () => {
    const display = '  AXButton "Display" "Dark theme, font size, brightness" id="title" [clickable]  (0.000, 0.400, 1.000, 0.070)';
    const loc = parseDescribeLocate(display, { text: "Display" });
    expect(loc.found).toBe(true);
    expect(loc.yNorm).toBeCloseTo(0.435, 3);
  });

  it("falls back to the topmost contains-hit when nothing matches exactly", () => {
    // No exact "wi-fi" label; the contains-hit is the subtitle row.
    expect(parseDescribeLocate(describe_, { text: "hotspot" }).found).toBe(true);
  });
});
