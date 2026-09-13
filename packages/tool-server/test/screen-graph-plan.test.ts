import { describe, expect, it } from "vitest";
import {
  bestNodeByResourceIds,
  edgeWeight,
  isVolatileText,
  localizeFrom,
  multisetJaccard,
  nodeIndexesSelectorTolerant,
  nodeResourceIds,
  plan,
  planToSelector,
  planToSelectorStable,
  type PlanGraph,
} from "../src/screen-graph/plan";
import { selectorKeyForId, selectorKeyForText, type Edge, type ScreenNode } from "../src/screen-graph/types";

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;

function node(
  hash: string,
  index: ScreenNode["index"] = {},
  resourceIds?: string[]
): ScreenNode {
  return { hash, firstSeen: NOW, lastSeen: NOW, visits: 1, compact: "", index, ...(resourceIds ? { resourceIds } : {}) };
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

/* -------------------------------------------------------------------------- */
/* C.4 work item C — the stable (resource-id Jaccard) localizer + matcher.     */
/*                                                                            */
/* Fixture provenance: the resource-id SETS below are the REAL Settings-root   */
/* and Network & internet id sets captured on the API-35 AVD (capture run     */
/* 33767073864, `capture.json`). The per-row multiplicities model the settings */
/* list structure (~19 root rows, ~11 sub-screen rows); the two "root runs"    */
/* differ only by the documented `H` destabilizers that do NOT move the        */
/* resource-id multiset (a bounds-bucket shift, the `focused` flag, one        */
/* volatile contextual card collapsing, one fewer visible row). The C.3 runs   */
/* uploaded no graph store, so two real cross-run roots were not available;    */
/* C.4 uploads the store so future runs can re-ground this fixture.            */
/* -------------------------------------------------------------------------- */

const repeat = (xs: string[], n: number): string[] =>
  Array.from({ length: n }, () => xs).flat();

// Real captured Settings-root containers + a real settings row's id group.
const ROOT_CONTAINERS = [
  "content", "settings_homepage_container", "app_bar", "app_bar_container",
  "homepage_app_bar_regular_phone_view", "account_avatar", "homepage_title",
  "search_bar", "search_action_bar", "search_action_bar_title",
  "main_content_scrollable_container", "homepage_container", "contextual_cards_content",
  "main_content", "container_material", "list_container", "recycler_view", "statusBarBackground",
];
const ROOT_ROW = ["icon_frame", "icon", "text_frame", "title", "summary"];

// Real captured Network & internet containers + its row id group.
const SUB_CONTAINERS = [
  "content", "content_parent", "app_bar", "collapsing_toolbar", "action_bar",
  "content_frame", "main_content", "container_material", "list_container", "recycler_view",
  "widget_frame", "switch_widget",
];
const SUB_ROW = ["icon_frame", "icon", "title", "summary"];

const rootRunA = [...ROOT_CONTAINERS, ...repeat(ROOT_ROW, 19)];
// A different run of the SAME root: a contextual card collapsed (one container
// gone, one fewer row); status bar / focus / bounds changes do not move ids.
const rootRunB = [
  ...ROOT_CONTAINERS.filter((id) => id !== "contextual_cards_content"),
  ...repeat(ROOT_ROW, 18),
];
const subIds = [...SUB_CONTAINERS, ...repeat(SUB_ROW, 11)];

describe("multisetJaccard", () => {
  it("is 1 for identical bags, 0 for disjoint, 0 for two empties", () => {
    expect(multisetJaccard(["a", "a", "b"], ["a", "a", "b"])).toBe(1);
    expect(multisetJaccard(["a"], ["b"])).toBe(0);
    expect(multisetJaccard([], [])).toBe(0);
  });

  it("respects multiplicity (min/max over the union)", () => {
    // {a:2,b:1} vs {a:1,b:1}: inter = 1+1 = 2, union = 2+1 = 3.
    expect(multisetJaccard(["a", "a", "b"], ["a", "b"])).toBeCloseTo(2 / 3, 6);
  });

  it("matches two captured runs of the SAME root ≥ 0.9, and a DIFFERENT screen < 0.9", () => {
    const sameRun = multisetJaccard(rootRunA, rootRunB);
    const diffScreen = multisetJaccard(rootRunA, subIds);
    expect(sameRun).toBeGreaterThanOrEqual(0.9);
    expect(diffScreen).toBeLessThan(0.9);
  });
});

describe("nodeResourceIds", () => {
  it("prefers the stored multiset, else derives ids from the index keys", () => {
    const withIds = node("h", {}, ["a", "a", "b"]);
    expect(nodeResourceIds(withIds)).toEqual(["a", "a", "b"]);
    const fromIndex = node("h", {
      [selectorKeyForId("x")]: { bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, flags: 0 },
      [selectorKeyForText("Wi-Fi")]: { bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, flags: 0 },
    });
    expect(nodeResourceIds(fromIndex)).toEqual(["x"]);
  });
});

describe("bestNodeByResourceIds / localizeFrom", () => {
  const graph: PlanGraph = {
    nodes: {
      root: node("root", {}, rootRunA),
      sub: node("sub", {}, subIds),
    },
    edges: [],
  };

  it("recovers the drifted root by resource-id Jaccard, not the sub-screen", () => {
    const m = bestNodeByResourceIds(graph, rootRunB);
    expect(m?.hash).toBe("root");
    expect(m!.score).toBeGreaterThanOrEqual(0.9);
  });

  it("returns null when nothing clears the threshold", () => {
    expect(bestNodeByResourceIds(graph, ["totally", "unrelated", "ids"])).toBeNull();
    expect(bestNodeByResourceIds(graph, [])).toBeNull();
  });

  it("localizeFrom prefers an exact hash, else Jaccard, else the raw hash", () => {
    expect(localizeFrom(graph, "root", [])).toEqual({ hash: "root", via: "exact" });
    const drifted = localizeFrom(graph, "drifted-root-hash", rootRunB);
    expect(drifted.hash).toBe("root");
    expect(drifted.via).toBe("jaccard");
    const none = localizeFrom(graph, "unknown", ["nope"]);
    expect(none).toEqual({ hash: "unknown", via: "none" });
  });
});

describe("nodeIndexesSelectorTolerant", () => {
  const n = node("h", {
    [selectorKeyForText("Calls & SMS")]: { bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, flags: 0 },
    [selectorKeyForId("com.x:id/save")]: { bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, flags: 0 },
  });
  it("matches text/id case-insensitively", () => {
    expect(nodeIndexesSelectorTolerant(n, { text: "calls & sms" })).toBe(true);
    expect(nodeIndexesSelectorTolerant(n, { id: "COM.X:ID/SAVE" })).toBe(true);
    expect(nodeIndexesSelectorTolerant(n, { text: "SIMs" })).toBe(false);
  });
});

describe("planToSelectorStable", () => {
  // root --tap--> sub; the live root hash has DRIFTED (not a node), so exact
  // planning would find no source. Jaccard localization recovers `root` and the
  // route root->sub is found; the target selector matches case-insensitively.
  const graph: PlanGraph = {
    nodes: {
      root: node("root", {}, rootRunA),
      sub: node(
        "sub",
        { [selectorKeyForText("Internet")]: { bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, flags: 0 } },
        subIds
      ),
    },
    edges: [edge("root", "sub")],
  };

  it("routes from a drifted root via a resource-id match", () => {
    const r = planToSelectorStable(graph, "drifted-root-hash", rootRunB, { text: "internet" }, NOW);
    expect(r).not.toBeNull();
    expect(r!.target).toBe("sub");
    expect(r!.steps.map((s) => s.to)).toEqual(["sub"]);
    expect(r!.fromVia).toBe("jaccard");
  });

  it("uses the exact source when the live hash is a known node", () => {
    const r = planToSelectorStable(graph, "root", rootRunA, { text: "Internet" }, NOW);
    expect(r!.fromVia).toBe("exact");
    expect(r!.target).toBe("sub");
  });

  it("returns null when no node indexes the selector", () => {
    expect(planToSelectorStable(graph, "root", rootRunA, { text: "nope" }, NOW)).toBeNull();
  });
});

describe("isVolatileText", () => {
  it("flags clocks, percentages, counters and dates; not real labels", () => {
    expect(isVolatileText("100%")).toBe(true);
    expect(isVolatileText("36% used")).toBe(false); // has trailing label content
    expect(isVolatileText("12:45")).toBe(true);
    expect(isVolatileText("Sep 3")).toBe(true);
    expect(isVolatileText("Network & internet")).toBe(false);
    expect(isVolatileText("Brightness level")).toBe(false);
  });
});
