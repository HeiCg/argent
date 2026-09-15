import { describe, it, expect } from "vitest";
import {
  resolveVerify,
  toBenchSelector,
  nodeLabel,
  boundsCenter,
} from "../src/utils/open-server-verify";
import { pickUniqueNode, type QueryNodeLite } from "../src/screen-graph/bench/locate";
import type { OpenServerSelector } from "../src/blueprints/android-open-server";

// Compact `query` nodes the way the server returns them (id / text / cd / bounds).
const bounds = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2 });

const NETWORK_ROW: QueryNodeLite = {
  id: "android:id/title",
  text: "Network & internet",
  bounds: bounds(0, 300, 1080, 400),
};
const DISPLAY_ROW: QueryNodeLite = {
  id: "android:id/title",
  text: "Display",
  bounds: bounds(0, 500, 1080, 600),
};
const BATTERY_ROW: QueryNodeLite = {
  id: "android:id/title",
  text: "Battery",
  bounds: bounds(0, 700, 1080, 800),
};

describe("resolveVerify — unique / none / ambiguous", () => {
  it("exactly one match resolves (match) — bounds carried through", () => {
    const r = resolveVerify([NETWORK_ROW, DISPLAY_ROW], { text: "Network & internet" });
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.bounds).toEqual(NETWORK_ROW.bounds);
  });

  it("zero query matches -> not_found (no node)", () => {
    // Two-stage model: the SERVER `query` already filtered to the selector
    // (bare-string text is EXACT in the ScreenSelector grammar, so "Internet"
    // never returns the "Network & internet" row). When the query returns
    // nothing, pickUniqueNode has no node and no tier -> not_found.
    const r = resolveVerify([], { text: "Internet" });
    expect(r.kind).toBe("not_found");
  });

  it("CONTAINS-tier disambiguation: a single containing node resolves (match)", () => {
    // When the query DID return a superset (e.g. the selector used `contains`),
    // pickUniqueNode's CONTAINS tier resolves the lone containing node.
    const r = resolveVerify([NETWORK_ROW, DISPLAY_ROW], { text: { contains: "internet" } });
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.bounds).toEqual(NETWORK_ROW.bounds);
  });

  it("several matches with no unique tier -> ambiguous, up to 5 candidates", () => {
    // Three rows share the EXACT resource-id, and the text tier is empty, so the
    // id tier has >1 and no tier is unique.
    const nodes = [NETWORK_ROW, DISPLAY_ROW, BATTERY_ROW];
    const r = resolveVerify(nodes, { id: "android:id/title" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates).toHaveLength(3);
      expect(r.candidates[0]).toEqual({ label: "Network & internet", bounds: NETWORK_ROW.bounds });
    }
  });

  it("ambiguous caps candidates at 5", () => {
    const many: QueryNodeLite[] = Array.from({ length: 8 }, (_, i) => ({
      id: "android:id/title",
      text: `Row ${i}`,
      bounds: bounds(0, i * 100, 1080, i * 100 + 100),
    }));
    const r = resolveVerify(many, { id: "android:id/title" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(5);
  });

  it("A1-M6: candidates are the colliding tier, not the whole result set", () => {
    // 2 EXACT-text "Wi-Fi" hits sit inside 4 CONTAINS-"wi" nodes; the ambiguous
    // tier is the 2 exact hits, so only those are listed.
    const wifiA = { text: "Wi-Fi", bounds: bounds(0, 0, 100, 100) };
    const wifiB = { text: "Wi-Fi", bounds: bounds(0, 100, 100, 200) };
    const wide1 = { text: "Wi-Fi calling", bounds: bounds(0, 200, 100, 300) };
    const wide2 = { text: "Wi-Fi Direct", bounds: bounds(0, 300, 100, 400) };
    const r = resolveVerify([wide1, wifiA, wide2, wifiB], { text: "Wi-Fi" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates).toHaveLength(2);
      expect(r.candidates.map((c) => c.bounds)).toEqual([wifiA.bounds, wifiB.bounds]);
    }
  });

  it("EXACT text wins over a CONTAINS toolbar title (D2-H3 precedence)", () => {
    // The collapsing toolbar title "Network & internet" contains "Internet"; the
    // real row's EXACT text "Internet" must win rather than tap the title.
    const title: QueryNodeLite = { text: "Network & internet", bounds: bounds(0, 0, 1080, 100) };
    const row: QueryNodeLite = { text: "Internet", bounds: bounds(0, 300, 1080, 400) };
    const r = resolveVerify([title, row], { text: "Internet" });
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.bounds).toEqual(row.bounds);
  });
});

describe("resolveVerify — coordinate cross-check (mismatch)", () => {
  const nodes = [NETWORK_ROW];

  it("coords inside the match bounds -> match", () => {
    const c = boundsCenter(NETWORK_ROW.bounds);
    const r = resolveVerify(
      nodes,
      { text: "Network & internet" },
      {
        xPx: c.x,
        yPx: c.y,
        tolerancePx: 0,
      }
    );
    expect(r.kind).toBe("match");
  });

  it("coords outside the match bounds -> mismatch, with the hit label", () => {
    const r = resolveVerify(
      nodes,
      { text: "Network & internet" },
      {
        xPx: 540,
        yPx: 1500, // far below the row
        tolerancePx: 0,
      }
    );
    expect(r.kind).toBe("mismatch");
    if (r.kind === "mismatch") {
      expect(r.label).toBe("Network & internet");
      expect(r.bounds).toEqual(NETWORK_ROW.bounds);
    }
  });

  it("tolerance widens the accepted band", () => {
    // 60px below the row bottom (400) — rejected at tol 0, accepted at tol 100.
    const strict = resolveVerify(
      nodes,
      { text: "Network & internet" },
      {
        xPx: 540,
        yPx: 460,
        tolerancePx: 0,
      }
    );
    expect(strict.kind).toBe("mismatch");
    const loose = resolveVerify(
      nodes,
      { text: "Network & internet" },
      {
        xPx: 540,
        yPx: 460,
        tolerancePx: 100,
      }
    );
    expect(loose.kind).toBe("match");
  });
});

describe("toBenchSelector — ScreenSelector grammar projection", () => {
  it("bare strings pass through", () => {
    expect(toBenchSelector({ id: "search", text: "Wi‑Fi" })).toEqual({
      id: "search",
      text: "Wi‑Fi",
    });
  });
  it("object matchers reduce to their equals/contains literal", () => {
    const sel: OpenServerSelector = {
      text: { contains: "internet", caseInsensitive: true },
      id: { equals: "android:id/title" },
    };
    expect(toBenchSelector(sel)).toEqual({ id: "android:id/title", text: "internet" });
  });
  it("a pure regex matcher yields no bench needle (left to the server match)", () => {
    expect(toBenchSelector({ text: { regex: "Net.*" } })).toEqual({});
  });
});

describe("precedence parity with pickUniqueNode", () => {
  // Where `pickUniqueNode`'s id/text/class tiers engage, the tool resolves the
  // SAME node as the screen-graph harness (they share the one resolver). Only
  // selectors whose projection engages a tier are compared here; the empty-
  // projection extension is covered by "server-count fallback" below.
  const nodes = [NETWORK_ROW, DISPLAY_ROW, BATTERY_ROW];
  const cases: OpenServerSelector[] = [
    { text: "Display" }, // unique via EXACT text
    { text: "Internet" }, // unique via CONTAINS ("Network & internet")
    { id: "android:id/title" }, // ambiguous via EXACT id
  ];
  for (const sel of cases) {
    it(`matches pickUniqueNode for ${JSON.stringify(sel)}`, () => {
      const picked = pickUniqueNode(nodes, toBenchSelector(sel));
      const r = resolveVerify(nodes, sel);
      if (picked.node) {
        expect(r.kind).toBe("match");
        if (r.kind === "match") expect(r.node).toBe(picked.node);
      } else if (picked.ambiguous) {
        expect(r.kind).toBe("ambiguous");
      } else {
        expect(r.kind).toBe("not_found");
      }
    });
  }
});

describe("A1-H1 — every advertised selector field resolves a unique SERVER match", () => {
  // resolveVerify is always fed the server-FILTERED matches, so a field the
  // projection cannot carry (regex/containsDescendant/visible/index) still
  // resolves by count. One case per field, proving a lone server match → match.
  const one = (extra: Partial<QueryNodeLite>): QueryNodeLite => ({
    bounds: bounds(0, 300, 1080, 400),
    ...extra,
  });

  it("class — a lone class match resolves via the class tier", () => {
    const node = one({ class: "android.widget.Switch", text: "Wi-Fi" });
    const r = resolveVerify([node], { class: "android.widget.Switch" });
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.node).toBe(node);
  });

  it("regex (text) — a lone server match resolves via the count fallback", () => {
    const node = one({ text: "Network & internet" });
    const r = resolveVerify([node], { text: { regex: "Net.*" } });
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.node).toBe(node);
  });

  it("containsDescendant — a lone server match resolves", () => {
    const node = one({ text: "Settings container" });
    const r = resolveVerify([node], { containsDescendant: { text: "Wi-Fi" } });
    expect(r.kind).toBe("match");
  });

  it("visible — a lone server match resolves", () => {
    const node = one({ text: "OnlyVisible" });
    const r = resolveVerify([node], { visible: true });
    expect(r.kind).toBe("match");
  });

  it("index — a lone server match resolves", () => {
    const node = one({ text: "Row", class: "android.widget.TextView" });
    const r = resolveVerify([node], { class: { contains: "TextView" }, index: 1 });
    expect(r.kind).toBe("match");
  });

  it("id:{contains} — a lone server match resolves (qualified id contains the needle)", () => {
    const node = one({ id: "com.android.settings:id/title", text: "Display" });
    const r = resolveVerify([node], { id: { contains: "title" } });
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.node).toBe(node);
  });
});

describe("A1-H1 — server-count fallback for an empty projection", () => {
  const a = { text: "A", bounds: bounds(0, 0, 100, 100) };
  const b = { text: "B", bounds: bounds(0, 100, 100, 200) };

  it("no projection + one server node -> match", () => {
    expect(resolveVerify([a], { visible: true }).kind).toBe("match");
  });
  it("no projection + several server nodes -> ambiguous", () => {
    const r = resolveVerify([a, b], { visible: true });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(2);
  });
  it("no projection + zero server nodes -> not_found", () => {
    expect(resolveVerify([], { visible: true }).kind).toBe("not_found");
  });
});

describe("nodeLabel", () => {
  it("prefers text, then content-desc, then id", () => {
    expect(nodeLabel({ text: "T", cd: "C", id: "I", bounds: bounds(0, 0, 1, 1) })).toBe("T");
    expect(nodeLabel({ cd: "C", id: "I", bounds: bounds(0, 0, 1, 1) })).toBe("C");
    expect(nodeLabel({ id: "I", bounds: bounds(0, 0, 1, 1) })).toBe("I");
    expect(nodeLabel({ bounds: bounds(0, 0, 1, 1) })).toBe("");
  });
});
