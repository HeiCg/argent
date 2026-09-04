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

describe("phase D §2/§3 — resolveTapPoint prefers the selector and diverges when unresolved", () => {
  const size = { width: 1080, height: 2400 };
  // Minimal OpenDeviceServerApi stub: only `query` is exercised.
  function serverWith(present: Record<string, { x1: number; y1: number; x2: number; y2: number }>): any {
    return {
      query: async (sel: { id?: string; text?: string }) => {
        const key = sel.id ? `id:${sel.id}` : `text:${sel.text}`;
        const b = present[key];
        return { nodes: b ? [{ bounds: b }] : [] };
      },
    };
  }

  it("resolves by resource-id first, tapping the LIVE centre", async () => {
    const server = serverWith({ "id:title": { x1: 100, y1: 200, x2: 300, y2: 260 } });
    const action: CanonicalAction = { kind: "tap", target: { id: "title" } };
    const r = await resolveTapPoint(server, size, action, undefined, rowSel);
    expect(r).toEqual({ cx: 200, cy: 230 });
  });

  it("falls through resource-id → text → contentDescription", async () => {
    const server = serverWith({ "text:Back": { x1: 0, y1: 0, x2: 100, y2: 100 } });
    const sel: EdgeSelector = { resourceId: "gone", contentDescription: "Back" };
    const action: CanonicalAction = { kind: "tap", target: { id: "gone" } };
    const r = await resolveTapPoint(server, size, action, undefined, sel);
    expect(r).toEqual({ cx: 50, cy: 50 });
  });

  it("DIVERGES when a selector was recorded but nothing resolves (edge not taken)", async () => {
    const server = serverWith({}); // nothing present
    const action: CanonicalAction = { kind: "tap", target: { text: "Network & internet" } };
    const r = await resolveTapPoint(server, size, action, undefined, rowSel);
    expect(r).toEqual({ diverge: true });
  });

  it("uses the bucket centre only when the edge carries NO selector", async () => {
    const server = serverWith({});
    const action: CanonicalAction = { kind: "tap", bucket: { x: 8, y: 8 } };
    const r = await resolveTapPoint(server, size, action);
    // bucket 8/16 of each dim, centre of the cell
    expect(r).toEqual({ cx: Math.round((8 + 0.5) * (1080 / 16)), cy: Math.round((8 + 0.5) * (2400 / 16)) });
  });
});
