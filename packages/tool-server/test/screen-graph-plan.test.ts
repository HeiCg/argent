import { describe, expect, it } from "vitest";
import { edgeWeight, plan, planToSelector, type PlanGraph } from "../src/screen-graph/plan";
import { selectorKeyForId, selectorKeyForText, type Edge, type ScreenNode } from "../src/screen-graph/types";

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;

function node(hash: string, index: ScreenNode["index"] = {}): ScreenNode {
  return { hash, firstSeen: NOW, lastSeen: NOW, visits: 1, compact: "", index };
}

function edge(
  from: string,
  to: string,
  over: Partial<Edge> = {}
): Edge {
  return {
    from,
    to,
    action: { kind: "tap", target: { text: `${from}->${to}` } },
    count: 1,
    successes: over.successes ?? 5,
    lastSeen: over.lastSeen ?? NOW,
    ...over,
  };
}

describe("edgeWeight", () => {
  it("is cheaper for more successes and dearer for staleness", () => {
    const fresh = edgeWeight(edge("a", "b", { successes: 9, lastSeen: NOW }), NOW);
    const flaky = edgeWeight(edge("a", "b", { successes: 0, lastSeen: NOW }), NOW);
    const stale = edgeWeight(edge("a", "b", { successes: 9, lastSeen: NOW - 30 * DAY }), NOW);
    expect(fresh).toBeLessThan(flaky);
    expect(fresh).toBeLessThan(stale);
    // 30 days stale adds exactly 1.0 to the weight.
    expect(stale - fresh).toBeCloseTo(1, 6);
  });
});

describe("plan", () => {
  it("finds the shortest weighted path over multiple hops", () => {
    const graph: PlanGraph = {
      nodes: { a: node("a"), b: node("b"), c: node("c"), d: node("d") },
      edges: [edge("a", "b"), edge("b", "d"), edge("a", "c"), edge("c", "d")],
    };
    const result = plan(graph, "a", "d", NOW);
    expect(result).not.toBeNull();
    expect(result!.target).toBe("d");
    expect(result!.steps).toHaveLength(2);
    expect(result!.steps.map((s) => s.to)).toEqual(["b", "d"]);
  });

  it("prefers the higher-success route when hop counts tie", () => {
    const graph: PlanGraph = {
      nodes: { a: node("a"), b: node("b"), c: node("c"), d: node("d") },
      edges: [
        edge("a", "b", { successes: 0 }),
        edge("b", "d", { successes: 0 }),
        edge("a", "c", { successes: 20 }),
        edge("c", "d", { successes: 20 }),
      ],
    };
    const result = plan(graph, "a", "d", NOW);
    expect(result!.steps.map((s) => s.to)).toEqual(["c", "d"]);
  });

  it("returns an empty plan when already at the target", () => {
    const graph: PlanGraph = { nodes: { a: node("a") }, edges: [] };
    expect(plan(graph, "a", "a", NOW)).toEqual({ target: "a", steps: [] });
  });

  it("returns null when the target is unreachable", () => {
    const graph: PlanGraph = {
      nodes: { a: node("a"), b: node("b"), z: node("z") },
      edges: [edge("a", "b")],
    };
    expect(plan(graph, "a", "z", NOW)).toBeNull();
  });

  it("routes around a stale edge in favour of a fresh detour", () => {
    const graph: PlanGraph = {
      nodes: { a: node("a"), b: node("b"), d: node("d") },
      edges: [
        // direct but very stale (adds ~2.0 staleness)
        edge("a", "d", { successes: 9, lastSeen: NOW - 60 * DAY }),
        // two fresh hops (each ~0.1)
        edge("a", "b", { successes: 9, lastSeen: NOW }),
        edge("b", "d", { successes: 9, lastSeen: NOW }),
      ],
    };
    const result = plan(graph, "a", "d", NOW);
    expect(result!.steps.map((s) => s.to)).toEqual(["b", "d"]);
  });
});

describe("planToSelector", () => {
  it("targets the nearest node whose index contains the selector", () => {
    const graph: PlanGraph = {
      nodes: {
        a: node("a"),
        b: node("b", { [selectorKeyForText("Wi-Fi")]: { bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, flags: 0 } }),
        c: node("c", { [selectorKeyForId("com.x:id/save")]: { bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, flags: 0 } }),
      },
      edges: [edge("a", "b"), edge("b", "c")],
    };
    const wifi = planToSelector(graph, "a", { text: "Wi-Fi" }, NOW);
    expect(wifi!.target).toBe("b");
    expect(wifi!.steps).toHaveLength(1);

    const save = planToSelector(graph, "a", { id: "com.x:id/save" }, NOW);
    expect(save!.target).toBe("c");
    expect(save!.steps).toHaveLength(2);
  });

  it("returns null when no node indexes the selector", () => {
    const graph: PlanGraph = { nodes: { a: node("a") }, edges: [] };
    expect(planToSelector(graph, "a", { text: "nope" }, NOW)).toBeNull();
  });
});
