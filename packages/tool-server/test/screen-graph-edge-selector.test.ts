import { describe, expect, it } from "vitest";
import { ScreenGraphStore } from "../src/screen-graph/store";
import { recordObservation } from "../src/screen-graph/recorder";
import { plan, planToSelector } from "../src/screen-graph/plan";
import { resolveTapPoint } from "../src/tools/navigate-to";
import type { CanonicalAction, EdgeSelector } from "../src/screen-graph/types";

const NOW = 1_700_000_000_000;
function store(): ScreenGraphStore {
  return new ScreenGraphStore({ packageName: "com.test", versionCode: "1", now: () => NOW });
}

const rowSel: EdgeSelector = {
  resourceId: "title",
  text: "Network & internet",
  className: "StaticText",
  indexInParent: 3,
  boundsBucket: { x: 2, y: 5 },
};

describe("phase D §2 — edges carry the acted element's selector", () => {
  it("store.observe records the selector on the edge", () => {
    const s = store();
    const action: CanonicalAction = { kind: "tap", target: { text: "Network & internet" } };
    s.observe("rootId", action, "netId", { selector: rowSel });
    const edge = s.edges.find((e) => e.from === "rootId" && e.to === "netId");
    expect(edge?.selector).toEqual(rowSel);
  });

  it("a later observation refreshes the selector; weight is per (from, selector)", () => {
    const s = store();
    const action: CanonicalAction = { kind: "tap", target: { text: "Network & internet" } };
    s.observe("rootId", action, "netId", { selector: rowSel, success: true });
    const refreshed: EdgeSelector = { ...rowSel, text: "Network & internet ✓" };
    s.observe("rootId", action, "netId", { selector: refreshed, success: true });
    const edge = s.edges.find((e) => e.from === "rootId");
    expect(edge?.count).toBe(2);
    expect(edge?.successes).toBe(2);
    expect(edge?.selector?.text).toBe("Network & internet ✓");
  });

  it("plan carries the edge selector onto each PlanStep", () => {
    const s = store();
    s.observe("rootId", { kind: "tap", target: { text: "Network & internet" } }, "netId", { selector: rowSel });
    const graph = { edges: s.edges, nodes: s.nodes };
    const p = plan(graph, "rootId", "netId", NOW);
    expect(p?.steps[0]?.selector).toEqual(rowSel);
  });
});

describe("phase D §1/§2 — recorder keys by H_id and records the selector + structural H", () => {
  it("keys the node/edge by the identity hash and stores H as a diagnostic", async () => {
    const s = store();
    await recordObservation({
      store: s,
      action: { kind: "tap", target: { text: "Network & internet" } },
      before: { hash: "rootIdHash" },
      after: { hash: "netIdHash", stateHash: "netTextHash", structuralHash: "netStructuralH" },
      selector: rowSel,
      fetchScreen: async () => ({ compact: "…", stateHash: "netTextHash", index: {}, resourceIds: ["title"] }),
    });
    // Node keyed by H_id, structural H kept as a field.
    expect(s.hasNode("netIdHash")).toBe(true);
    expect(s.hasNode("netStructuralH")).toBe(false);
    expect(s.getNode("netIdHash")?.structuralHash).toBe("netStructuralH");
    // Edge keyed from→to on identity hashes, carrying the selector.
    const edge = s.edges.find((e) => e.from === "rootIdHash" && e.to === "netIdHash");
    expect(edge?.selector).toEqual(rowSel);
  });

  it("a known identity refreshes H and bumps the visit exactly once", async () => {
    const s = store();
    s.upsertNode({ hash: "netIdHash", structuralHash: "h1", compact: "c", stateHash: "t" });
    const before = s.getNode("netIdHash")!.visits;
    await recordObservation({
      store: s,
      action: { kind: "tap", target: { text: "x" } },
      before: { hash: "rootIdHash" },
      after: { hash: "netIdHash", stateHash: "t2", structuralHash: "h2" },
    });
    const node = s.getNode("netIdHash")!;
    expect(node.visits).toBe(before + 1);
    expect(node.structuralHash).toBe("h2");
  });
});

describe("phase D §2/§3 + D.1 Fix A — resolveTapPoint resolves a UNIQUE live match, else diverges", () => {
  const size = { width: 1080, height: 2400 };
  type TreeNode = { id?: string; text?: string; cd?: string; bounds: { x1: number; y1: number; x2: number; y2: number } };
  // OpenDeviceServerApi stub backed by a live tree: `query` matches the
  // case-insensitive CONTAINS matcher resolveTapPoint sends, exactly like the
  // device server; resolveTapPoint then filters to a whole-field EXACT match.
  function serverWithTree(nodes: TreeNode[]): any {
    const val = (m: any): string => (typeof m === "object" && m ? m.contains ?? m.equals ?? "" : m ?? "");
    return {
      query: async (sel: { id?: any; text?: any }, opts?: { limit?: number }) => {
        const idm = val(sel.id).toLowerCase();
        const tm = val(sel.text).toLowerCase();
        const matched = nodes.filter((n) => {
          if (sel.id) return (n.id ?? "").toLowerCase().includes(idm);
          if (sel.text) return (n.text ?? "").toLowerCase().includes(tm) || (n.cd ?? "").toLowerCase().includes(tm);
          return false;
        });
        return { nodes: matched.slice(0, opts?.limit ?? 20) };
      },
      getState: async () => ({ idHash: "live", hash: "liveH" }),
    };
  }

  it("resolves a unique resource-id, tapping the LIVE centre", async () => {
    const server = serverWithTree([{ id: "title", text: "Network & internet", bounds: { x1: 100, y1: 200, x2: 300, y2: 260 } }]);
    const action: CanonicalAction = { kind: "tap", target: { id: "title" } };
    const r = await resolveTapPoint(server, size, action, undefined, rowSel);
    expect(r).toEqual({ cx: 200, cy: 230 });
  });

  it("Fix A: an AMBIGUOUS resource-id (many rows share `title`) is skipped for the unique text", async () => {
    // Two rows share android:id/title; only the text distinguishes them.
    const server = serverWithTree([
      { id: "title", text: "Network & internet", bounds: { x1: 0, y1: 100, x2: 500, y2: 160 } },
      { id: "title", text: "Apps", bounds: { x1: 0, y1: 200, x2: 500, y2: 260 } },
    ]);
    // via="text" was chosen unique at record time.
    const sel: EdgeSelector = { resourceId: "title", text: "Apps", via: "text" };
    const action: CanonicalAction = { kind: "tap", target: { text: "Apps" } };
    const r = await resolveTapPoint(server, size, action, undefined, sel);
    expect(r).toEqual({ cx: 250, cy: 230 }); // the Apps row, NOT the first title
  });

  it("Fix A: without `via`, an ambiguous id falls through to the unique text", async () => {
    const server = serverWithTree([
      { id: "title", text: "Network & internet", bounds: { x1: 0, y1: 100, x2: 500, y2: 160 } },
      { id: "title", text: "Apps", bounds: { x1: 0, y1: 200, x2: 500, y2: 260 } },
    ]);
    const sel: EdgeSelector = { resourceId: "title", text: "Apps" }; // no via (pre-D.1 edge)
    const action: CanonicalAction = { kind: "tap", target: { id: "title" } };
    const r = await resolveTapPoint(server, size, action, undefined, sel);
    expect(r).toEqual({ cx: 250, cy: 230 });
  });

  it("falls through resource-id → text → contentDescription", async () => {
    const server = serverWithTree([{ cd: "Back", bounds: { x1: 0, y1: 0, x2: 100, y2: 100 } }]);
    const sel: EdgeSelector = { resourceId: "gone", contentDescription: "Back" };
    const action: CanonicalAction = { kind: "tap", target: { id: "gone" } };
    const r = await resolveTapPoint(server, size, action, undefined, sel);
    expect(r).toEqual({ cx: 50, cy: 50 });
  });

  it("DIVERGES 'ambiguous' when the only recorded key matches >1 live node", async () => {
    const server = serverWithTree([
      { id: "title", text: "Network & internet", bounds: { x1: 0, y1: 100, x2: 500, y2: 160 } },
      { id: "title", text: "Apps", bounds: { x1: 0, y1: 200, x2: 500, y2: 260 } },
    ]);
    const sel: EdgeSelector = { resourceId: "title" }; // no distinguishing text
    const action: CanonicalAction = { kind: "tap", target: { id: "title" } };
    const r = await resolveTapPoint(server, size, action, undefined, sel);
    expect(r).toEqual({ diverge: true, reason: "selector ambiguous on live tree" });
  });

  it("DIVERGES 'unresolved' when a selector was recorded but nothing matches", async () => {
    const server = serverWithTree([]); // nothing present
    const action: CanonicalAction = { kind: "tap", target: { text: "Network & internet" } };
    const r = await resolveTapPoint(server, size, action, undefined, rowSel);
    expect(r).toEqual({ diverge: true, reason: "selector unresolved on live tree" });
  });

  it("uses the bucket centre only when the edge carries NO selector", async () => {
    const server = serverWithTree([]);
    const action: CanonicalAction = { kind: "tap", bucket: { x: 8, y: 8 } };
    const r = await resolveTapPoint(server, size, action);
    // bucket 8/16 of each dim, centre of the cell
    expect(r).toEqual({ cx: Math.round((8 + 0.5) * (1080 / 16)), cy: Math.round((8 + 0.5) * (2400 / 16)) });
  });
});
