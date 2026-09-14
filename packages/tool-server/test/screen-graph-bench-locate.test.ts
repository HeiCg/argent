import { describe, expect, it } from "vitest";
import { pickUniqueNode, normLc, type QueryNodeLite } from "../src/screen-graph/bench/locate";
import { parseDescribeLocate } from "../src/screen-graph/bench/describe-locate";
import { isPreActionInfraError } from "../src/screen-graph/bench/oracle";

const b = (y: number) => ({ x1: 0, y1: y, x2: 500, y2: y + 60 });

describe("phase D.3 (D2-H3) — pickUniqueNode resolves EXACT before contains", () => {
  it("t('Internet') taps the Internet row, NOT the toolbar 'Network & internet'", () => {
    const nodes: QueryNodeLite[] = [
      { id: "collapsing_toolbar", text: "Network & internet", bounds: b(0) },
      { id: "title", text: "Internet", bounds: b(200) },
      { id: "title", text: "Calls & SMS", bounds: b(300) },
    ];
    const r = pickUniqueNode(nodes, { text: "Internet" });
    expect(r.node?.text).toBe("Internet");
    expect(r.ambiguous).toBe(false);
  });

  it("is AMBIGUOUS when two nodes share the exact text and no id disambiguates", () => {
    const nodes: QueryNodeLite[] = [
      { id: "title", text: "Internet", bounds: b(0) },
      { id: "title", text: "Internet", bounds: b(200) },
    ];
    const r = pickUniqueNode(nodes, { text: "Internet" });
    expect(r.node).toBeUndefined();
    expect(r.ambiguous).toBe(true);
  });

  it("falls to a UNIQUE contains match when no exact match exists", () => {
    const nodes: QueryNodeLite[] = [{ id: "title", text: "Media volume", bounds: b(0) }];
    const r = pickUniqueNode(nodes, { text: "Media" });
    expect(r.node?.text).toBe("Media volume");
  });

  it("is AMBIGUOUS when >1 node contains the text and none matches exactly", () => {
    const nodes: QueryNodeLite[] = [
      { id: "title", text: "Network & internet", bounds: b(0) },
      { id: "title", text: "Internet usage", bounds: b(200) },
    ];
    const r = pickUniqueNode(nodes, { text: "internet" });
    expect(r.node).toBeUndefined();
    expect(r.ambiguous).toBe(true);
  });

  it("resolves an exact resource-id first", () => {
    const nodes: QueryNodeLite[] = [
      { id: "search", text: "Search", bounds: b(0) },
      { id: "title", text: "Search settings", bounds: b(200) },
    ];
    const r = pickUniqueNode(nodes, { id: "search" });
    expect(r.node?.id).toBe("search");
  });

  it("normLc trims and lowercases", () => {
    expect(normLc("  Foo Bar ")).toBe("foo bar");
    expect(normLc(undefined)).toBe("");
  });
});

describe("phase D.3 (D2-M6) — isPreActionInfraError", () => {
  it("flags device/adb/server connectivity faults", () => {
    for (const m of [
      "connect ECONNREFUSED 127.0.0.1:9008",
      "adb: device offline",
      "no devices/emulators found",
      "open device server not ready",
      "socket hang up",
      "ETIMEDOUT",
    ]) {
      expect(isPreActionInfraError(m), m).toBe(true);
    }
  });

  it("does NOT flag ordinary task/assertion failures", () => {
    for (const m of [
      "assertion failed: needle not present",
      "TypeError: cannot read property 'bounds' of undefined",
      "locate failed for {text:'Display'}",
      "unexpected token in JSON",
      "",
    ]) {
      expect(isPreActionInfraError(m), m).toBe(false);
    }
  });
});

describe("phase D.4 — ONE resolver policy for both renderings (B1 describe vs open query)", () => {
  // The Network & internet screen as logical nodes (normalized bounds).
  type N = { id?: string; text?: string; cd?: string; bounds: { x1: number; y1: number; x2: number; y2: number } };
  const box = (y: number) => ({ x1: 0.0, y1: y, x2: 1.0, y2: y + 0.06 });
  const screen: N[] = [
    { id: "collapsing_toolbar", text: "Network & internet", bounds: box(0.03) },
    { id: "title", text: "Internet", cd: "Internet", bounds: box(0.20) },
    { id: "title", text: "Calls & SMS", bounds: box(0.28) },
    { id: "title", text: "SIMs", bounds: box(0.36) },
    { id: "title", text: "Airplane mode", bounds: box(0.44) },
  ];
  // Render the SAME nodes as a describe payload (format-tree line shape).
  const describeText = screen
    .map((n) => {
      const label = n.text ? ` "${n.text}"` : "";
      const value = n.cd && n.cd !== n.text ? ` "${n.cd}"` : "";
      const id = n.id ? ` id="${n.id}"` : "";
      const b = n.bounds;
      return `  AXButton${label}${value}${id}  (${b.x1.toFixed(3)}, ${b.y1.toFixed(3)}, ${(b.x2 - b.x1).toFixed(3)}, ${(b.y2 - b.y1).toFixed(3)})`;
    })
    .join("\n");

  const centreOf = (n: N) => ({ x: (n.bounds.x1 + n.bounds.x2) / 2, y: (n.bounds.y1 + n.bounds.y2) / 2 });

  for (const want of ["Internet", "Calls & SMS", "Airplane mode"]) {
    it(`both renderings resolve t(${JSON.stringify(want)}) to the same node`, () => {
      const open = pickUniqueNode(screen, { text: want });
      const b1 = parseDescribeLocate(describeText, { text: want });
      const expected = centreOf(screen.find((n) => n.text === want)!);
      // open path
      expect(open.node?.text).toBe(want);
      expect((open.node!.bounds.x1 + open.node!.bounds.x2) / 2).toBeCloseTo(expected.x, 3);
      // describe path — SAME node's centre
      expect(b1.found).toBe(true);
      expect(b1.xNorm).toBeCloseTo(expected.x, 3);
      expect(b1.yNorm).toBeCloseTo(expected.y, 3);
    });
  }

  it("D2-H3 the exact 'Internet' row wins over the 'Network & internet' toolbar in BOTH renderings", () => {
    expect(pickUniqueNode(screen, { text: "Internet" }).node?.text).toBe("Internet");
    expect(parseDescribeLocate(describeText, { text: "Internet" }).yNorm).toBeCloseTo(0.23, 3);
  });

  it("BOTH renderings REFUSE an ambiguous selector (no exact, >1 contains) — no nodes[0] tap", () => {
    // "title" as text is shared by 4 rows; "network" contains both toolbar and none exactly.
    const openAmb = pickUniqueNode(screen, { text: "network" }); // "Network & internet" only → unique
    expect(openAmb.node?.text).toBe("Network & internet");
    // Build a genuinely ambiguous case: two rows with identical text.
    const dup: N[] = [
      { id: "title", text: "Wi‑Fi", bounds: box(0.1) },
      { id: "title", text: "Wi‑Fi", bounds: box(0.2) },
    ];
    const dupDescribe = dup
      .map((n) => `  AXButton "${n.text}" id="${n.id}"  (${n.bounds.x1.toFixed(3)}, ${n.bounds.y1.toFixed(3)}, ${(n.bounds.x2 - n.bounds.x1).toFixed(3)}, ${(n.bounds.y2 - n.bounds.y1).toFixed(3)})`)
      .join("\n");
    expect(pickUniqueNode(dup, { text: "Wi‑Fi" }).ambiguous).toBe(true);
    expect(pickUniqueNode(dup, { text: "Wi‑Fi" }).node).toBeUndefined();
    const b1 = parseDescribeLocate(dupDescribe, { text: "Wi‑Fi" });
    expect(b1.found).toBe(false);
    expect(b1.ambiguous).toBe(true);
  });
});

describe("phase D.4 — CAPTURED Network & internet screen (run 34794414764)", () => {
  // The proprietary describe of the Network & internet screen, quoted verbatim from
  // run 34794414764 (logs/sg-matrix.log line 28): the ONLY node whose text contains
  // "internet" is the COLLAPSED combined summary — there is no discrete "Internet"
  // list row. The open `query` (below) surfaces that discrete row. Same resolver,
  // different rendering: this is exactly why B1 fails settings-network-internet NNNNN
  // (taps the combined summary FOUND-UNIQUE, never reaches "Add network") while every
  // open config resolves the clean "Internet" row and passes.
  const b1Describe = [
    `  LinearLayout "Network & internet / Mobile, Wi‑Fi, hotspot" [clickable]  (0.000, 0.321, 1.000, 0.096)`,
    `  LinearLayout "Connected devices / Bluetooth, pairing" [clickable]  (0.000, 0.417, 1.000, 0.096)`,
    `  LinearLayout "Airplane mode" id="airplane" [clickable]  (0.000, 0.700, 1.000, 0.060)`,
  ].join("\n");

  // The open query of the SAME screen: discrete rows, "Internet" a clean whole-field label.
  const openNodes = [
    { id: "collapsing_toolbar", text: "Network & internet", bounds: { x1: 0, y1: 0.03, x2: 1, y2: 0.09 } },
    { id: "title", text: "Internet", cd: "Internet", bounds: { x1: 0, y1: 0.2, x2: 1, y2: 0.26 } },
    { id: "title", text: "Calls & SMS", bounds: { x1: 0, y1: 0.28, x2: 1, y2: 0.34 } },
    { id: "title", text: "Airplane mode", bounds: { x1: 0, y1: 0.44, x2: 1, y2: 0.5 } },
  ];

  it("open query resolves the discrete 'Internet' row; B1 describe has only the collapsed 'Network & internet' summary", () => {
    // Open: the clean discrete row wins on exact whole-field text.
    const open = pickUniqueNode(openNodes, { text: "Internet" });
    expect(open.node?.text).toBe("Internet");
    expect(open.node?.id).toBe("title");

    // B1 describe: no discrete "Internet" row exists; the sole "internet"-bearing node
    // is the collapsed combined summary, which the SAME policy resolves FOUND-UNIQUE
    // via the unique-contains tier — a different (wrong) target than the open row.
    const b1 = parseDescribeLocate(b1Describe, { text: "Internet" });
    expect(b1.found).toBe(true);
    // Centre of the collapsed summary row (0.321 + 0.096/2 = 0.369), NOT a discrete row.
    expect(b1.yNorm).toBeCloseTo(0.369, 3);

    // The two renderings pick DIFFERENT y-centres: the policy is identical, the rendering
    // is not — this is the documented describe-vs-query gap, not a relaxed resolver.
    const openY = (open.node!.bounds.y1 + open.node!.bounds.y2) / 2;
    expect(Math.abs(b1.yNorm - openY)).toBeGreaterThan(0.1);
  });

  it("'Airplane mode' (settings-network navTarget) resolves cleanly in BOTH renderings", () => {
    expect(pickUniqueNode(openNodes, { text: "Airplane mode" }).node?.text).toBe("Airplane mode");
    const b1 = parseDescribeLocate(b1Describe, { text: "Airplane mode" });
    expect(b1.found).toBe(true);
    expect(b1.yNorm).toBeCloseTo(0.73, 3);
  });
});
