/**
 * Artemis A2 §B — the token-table generator. Unit tests for the pure tier
 * measurement, plus a fixture-driven table over the committed screen-graph
 * captures whose console output IS the measurement written to the ticket Result.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  indexLinesFromDescribe,
  renderIndexFromDescribe,
  measureScreenTiers,
  summarizeTierTable,
  type TierMeasure,
  type IndexLine,
  type ScreenInput,
  type TierTableSummary,
} from "../src/screen-graph/bench/index-tier-tokens";
import { buildSummary, renderSummary } from "../src/screen-graph/describe-tiers";
import type { ScreenNode, Edge } from "../src/screen-graph/types";

describe("indexLinesFromDescribe / renderIndexFromDescribe", () => {
  const describeText = [
    "Source: open-device-server",
    "ROOT  Screen (0.000, 0.000, 1.000, 1.000)",
    '  Button  "Network & internet" (0.100, 0.200, 0.800, 0.050)',
    '  TextView  "Connected devices" (0.100, 0.260, 0.800, 0.050)',
    "  FrameLayout (0.000, 0.900, 1.000, 0.100)",
  ].join("\n");

  it("parses one row per framed line, keeping role + first quoted label", () => {
    const rows: IndexLine[] = indexLinesFromDescribe(describeText);
    // ROOT Screen, Button, TextView, FrameLayout — 4 framed lines.
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual({ role: "Button", label: "Network & internet" });
    expect(rows[3]).toEqual({ role: "FrameLayout", label: "" });
  });

  it("renders indexed [i] label (role) lines with a version header", () => {
    const text = renderIndexFromDescribe(describeText, 7);
    const lines = text.split("\n");
    expect(lines[0]).toContain("version 7");
    expect(lines).toContain("[1] Network & internet (Button)");
    expect(lines).toContain("[3] (FrameLayout)");
  });
});

describe("measureScreenTiers / summarizeTierTable", () => {
  it("reports index far below compact at equal-or-better locate on a labelled screen", () => {
    const compactText = [
      'Button  "Network & internet" (0.100, 0.200, 0.800, 0.050)',
      'Button  "Connected devices" (0.100, 0.260, 0.800, 0.050)',
      'Button  "Apps" (0.100, 0.320, 0.800, 0.050)',
    ].join("\n");
    const input: ScreenInput = {
      screen: "settings-root",
      compactText,
      summaryText: "screen: Settings",
    };
    const m = measureScreenTiers(input);
    expect(m.tokens.index).toBeLessThan(m.tokens.compact);
    expect(m.indexVsCompactPct).toBeGreaterThan(0);
    // every label is unique → resolvable by label AND addressable by index.
    expect(m.locate.uniqueByLabel).toBe(3);
    expect(m.locate.indexAddressable).toBe(3);
  });

  it("applies the ship rule: ≥20% median savings at ≥ compact locate", () => {
    const rows: TierMeasure[] = [
      {
        screen: "a",
        tokens: { full: 100, summary: 20, compact: 100, index: 70 },
        locate: { targets: 5, uniqueByLabel: 5, indexAddressable: 5 },
        indexVsCompactPct: 30,
      },
      {
        screen: "b",
        tokens: { full: 200, summary: 20, compact: 200, index: 150 },
        locate: { targets: 5, uniqueByLabel: 4, indexAddressable: 5 },
        indexVsCompactPct: 25,
      },
    ];
    const s: TierTableSummary = summarizeTierTable(rows);
    expect(s.medianIndexVsCompactPct).toBe(27.5);
    expect(s.shipAsDefault).toBe(true);
  });

  it("keeps index opt-in when savings are under 20%", () => {
    const rows: TierMeasure[] = [
      {
        screen: "a",
        tokens: { full: 100, summary: 20, compact: 100, index: 90 },
        locate: { targets: 5, uniqueByLabel: 5, indexAddressable: 5 },
        indexVsCompactPct: 10,
      },
    ];
    expect(summarizeTierTable(rows).shipAsDefault).toBe(false);
  });
});

describe("token table over committed screen-graph fixtures (Result data)", () => {
  const fixtureDir = path.join(__dirname, "fixtures");
  const runFixtures = [
    "screen-graph-run-33947160117-settings.json",
    "screen-graph-run-33958064084-settings.json",
  ];

  it("measures full/summary/compact/index tokens + locate on every captured screen", () => {
    const rows: TierMeasure[] = [];
    for (const file of runFixtures) {
      const full = path.join(fixtureDir, file);
      if (!fs.existsSync(full)) continue;
      const graph = JSON.parse(fs.readFileSync(full, "utf-8")) as {
        nodes: Record<string, ScreenNode>;
        edges: Edge[];
      };
      const nodes = graph.nodes;
      const runId = file.match(/run-(\d+)/)?.[1] ?? "?";
      for (const [hash, node] of Object.entries(nodes)) {
        if (typeof node.compact !== "string" || node.compact.length === 0) continue;
        const outgoing = graph.edges.filter((e) => e.from === hash);
        const summaryText = renderSummary(buildSummary(node, outgoing, nodes));
        rows.push(
          measureScreenTiers({
            screen: `${runId}:${node.label ?? hash.slice(0, 8)}`,
            compactText: node.compact,
            summaryText,
            version: node.version,
          })
        );
      }
    }

    expect(rows.length).toBeGreaterThan(0);
    const summary = summarizeTierTable(rows);

    // Print the table for the ticket Result.
    console.log("\n===== A2 §B TOKEN TABLE (o200k) — full / summary / compact / index =====");
    console.log(
      "screen".padEnd(40),
      "full".padStart(6),
      "summ".padStart(6),
      "comp".padStart(6),
      "index".padStart(6),
      "idx<comp%".padStart(10),
      "locate(uniq/idx/tot)"
    );
    for (const r of rows) {
      console.log(
        r.screen.slice(0, 39).padEnd(40),
        String(r.tokens.full).padStart(6),
        String(r.tokens.summary).padStart(6),
        String(r.tokens.compact).padStart(6),
        String(r.tokens.index).padStart(6),
        String(r.indexVsCompactPct).padStart(10),
        `${r.locate.uniqueByLabel}/${r.locate.indexAddressable}/${r.locate.targets}`
      );
    }
    console.log("-".repeat(96));
    console.log(
      "MEDIAN".padEnd(40),
      String(summary.medians.full).padStart(6),
      String(summary.medians.summary).padStart(6),
      String(summary.medians.compact).padStart(6),
      String(summary.medians.index).padStart(6),
      String(summary.medianIndexVsCompactPct).padStart(10)
    );
    console.log(
      `TOTALS full=${summary.totals.full} summary=${summary.totals.summary} compact=${summary.totals.compact} index=${summary.totals.index}`
    );
    console.log(
      `LOCATE Σ uniqueByLabel=${summary.locate.uniqueByLabel} indexAddressable=${summary.locate.indexAddressable} targets=${summary.locate.targets}`
    );
    console.log(
      `DECISION: median index-vs-compact savings = ${summary.medianIndexVsCompactPct}% → shipAsDefault=${summary.shipAsDefault} (rule: ≥20% at ≥ compact locate)\n`
    );

    // Invariants that must hold on real captures: index never larger than compact,
    // and index locate (unique index) is at least compact's label locate.
    expect(summary.totals.index).toBeLessThanOrEqual(summary.totals.compact);
    expect(summary.locate.indexAddressable).toBeGreaterThanOrEqual(summary.locate.uniqueByLabel);
  });
});
