import { describe, expect, it } from "vitest";
import { pickUniqueNode, normLc, type QueryNodeLite } from "../src/screen-graph/bench/locate";
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
