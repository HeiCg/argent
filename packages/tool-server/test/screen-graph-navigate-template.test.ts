import { describe, expect, it } from "vitest";
import { executeTemplateStep } from "../src/tools/navigate-to";
import { multisetJaccard, planToTemplate } from "../src/screen-graph/plan";
import { nonScrollRids, type TemplateElement } from "../src/screen-graph/template";
import type { Edge, ScreenNode } from "../src/screen-graph/types";

const size = { width: 1080, height: 2400 };

/**
 * A minimal OpenDeviceServerApi stub whose `query` returns `matchesByAttempt[i]`
 * on the i-th call, so a test can make an item appear only after N scrolls.
 */
function fakeServer(matchesByAttempt: Array<Array<{ text: string; bounds: any }>>) {
  const calls = { query: 0, tap: 0, swipe: 0, getState: 0 };
  const server: any = {
    query: async () => {
      const nodes = matchesByAttempt[calls.query] ?? [];
      calls.query += 1;
      return { nodes };
    },
    tapWithOutcome: async () => {
      calls.tap += 1;
      return { after: { idHash: "detail_37" } };
    },
    swipeWithOutcome: async () => {
      calls.swipe += 1;
      return { after: { idHash: "feed" } };
    },
    getState: async () => {
      calls.getState += 1;
      return { idHash: calls.tap > 0 ? "detail_37" : "feed", tree: [] };
    },
  };
  return { server, calls };
}

describe("template-step navigation (design D1)", () => {
  it("resolves the item after scrolling and taps it", async () => {
    const item = [{ text: "Item 37", bounds: { x1: 0, y1: 800, x2: 1080, y2: 1000 } }];
    // Not present for the first two queries, present on the third.
    const { server, calls } = fakeServer([[], [], item]);
    const out = await executeTemplateStep(server, size, "Item 37");
    expect(out.tapped).toBe(true);
    expect(out.afterHash).toBe("detail_37");
    expect(calls.swipe).toBe(2); // scrolled twice before it appeared
    expect(calls.tap).toBe(1);
  });

  it("fails closed (no tap) on an ambiguous live match", async () => {
    const two = [
      { text: "Item 37", bounds: { x1: 0, y1: 800, x2: 1080, y2: 1000 } },
      { text: "Item 37", bounds: { x1: 0, y1: 1200, x2: 1080, y2: 1400 } },
    ];
    const { server, calls } = fakeServer([two]);
    const out = await executeTemplateStep(server, size, "Item 37");
    expect(out.tapped).toBe(false);
    expect(out.reason).toBe("selector ambiguous on live tree");
    expect(calls.tap).toBe(0);
  });

  it("returns a system-decor-free arrival key that matches a template node (Jaccard 1.0)", async () => {
    // The landed detail tree carries decor bars the template node's stored
    // `nonScrollRids` excludes; the arrival key must exclude them too, or the
    // Jaccard drops below 0.9 (run 34957934222 measured 7/9 = 0.78).
    const detail: TemplateElement[] = [
      {
        className: "X",
        resourceId: "com:id/detail_toolbar",
        index: 1,
        bounds: { x1: 0, y1: 0, x2: 1, y2: 1 },
      },
      {
        className: "X",
        resourceId: "com:id/title",
        index: 2,
        bounds: { x1: 0, y1: 0, x2: 1, y2: 1 },
      },
      {
        className: "X",
        resourceId: "com:id/detail_body",
        index: 3,
        bounds: { x1: 0, y1: 0, x2: 1, y2: 1 },
      },
      {
        className: "X",
        resourceId: "android:id/statusBarBackground",
        index: 4,
        bounds: { x1: 0, y1: 0, x2: 1, y2: 1 },
      },
      {
        className: "X",
        resourceId: "android:id/navigationBarBackground",
        index: 5,
        bounds: { x1: 0, y1: 0, x2: 1, y2: 1 },
      },
    ];
    const item = [{ text: "Story 37", bounds: { x1: 0, y1: 800, x2: 1080, y2: 1000 } }];
    const calls = { query: 0, tap: 0 };
    const server: any = {
      query: async () => {
        calls.query += 1;
        return { nodes: item };
      },
      tapWithOutcome: async () => {
        calls.tap += 1;
        return { after: { idHash: "detail" } };
      },
      swipeWithOutcome: async () => ({ after: { idHash: "feed" } }),
      getState: async () => ({ idHash: "detail", tree: detail }),
    };
    const out = await executeTemplateStep(server, size, "Story 37");
    expect(out.tapped).toBe(true);
    expect(out.afterResourceIds).not.toContain("statusBarBackground");
    expect(out.afterResourceIds).not.toContain("navigationBarBackground");
    // A template node stores `nonScrollRids` of the same tree — arrival is exact.
    const templateRids = nonScrollRids(detail, "");
    expect(multisetJaccard(out.afterResourceIds, templateRids)).toBe(1);
  });

  it("gives up after the scroll budget and reports unresolved", async () => {
    const { server, calls } = fakeServer([]); // never matches
    const out = await executeTemplateStep(server, size, "Item 37");
    expect(out.tapped).toBe(false);
    expect(out.reason).toBe("selector unresolved on live tree");
    expect(calls.swipe).toBe(8); // TEMPLATE_MAX_SCROLLS
    expect(calls.tap).toBe(0);
  });
});

describe("planToTemplate routes to the container's template node (design D1)", () => {
  it("returns a plan whose last step carries the template", () => {
    const nodes: Record<string, ScreenNode> = {
      FEED: { hash: "FEED", firstSeen: 0, lastSeen: 0, visits: 3, compact: "", index: {} },
      TPL: {
        hash: "TPL",
        firstSeen: 0,
        lastSeen: 0,
        visits: 1,
        compact: "",
        index: {},
        template: true,
      },
    };
    const edges: Edge[] = [
      {
        from: "FEED",
        action: { kind: "tap", template: { containerKey: "CK", itemTemplate: "IT" } },
        to: "TPL",
        count: 5,
        successes: 5,
        lastSeen: 0,
        template: { containerKey: "CK", itemTemplate: "IT", instances: 3, containerId: "list" },
      },
    ];
    const res = planToTemplate({ nodes, edges }, "FEED", 0);
    expect(res).not.toBeNull();
    expect(res!.templateNode).toBe("TPL");
    expect(res!.steps).toHaveLength(1);
    expect(res!.steps[0]!.template?.containerKey).toBe("CK");
  });

  it("returns null when no template edge exists", () => {
    const nodes: Record<string, ScreenNode> = {
      FEED: { hash: "FEED", firstSeen: 0, lastSeen: 0, visits: 1, compact: "", index: {} },
    };
    expect(planToTemplate({ nodes, edges: [] }, "FEED", 0)).toBeNull();
  });
});
