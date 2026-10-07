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
    const { server, calls } = fakeServer([]); // never matches, the list keeps moving
    const out = await executeTemplateStep(server, size, "Item 37");
    expect(out.tapped).toBe(false);
    expect(out.reason).toBe("selector unresolved on live tree");
    expect(calls.swipe).toBe(30); // TEMPLATE_MAX_SCROLLS
    expect(out.scrolls).toBe(30);
    expect(calls.tap).toBe(0);
  });

  it("reports how many scrolls it used", async () => {
    const item = [{ text: "Item 37", bounds: { x1: 0, y1: 800, x2: 1080, y2: 1000 } }];
    const { server } = fakeServer([[], [], item]);
    const out = await executeTemplateStep(server, size, "Item 37");
    expect(out.scrolls).toBe(2);
  });

  it("stops at the end of the list after two swipes that change nothing", async () => {
    const { server, calls } = fakeServer([]);
    server.swipeWithOutcome = async () => {
      calls.swipe += 1;
      return { changed: false, after: { idHash: "feed" } };
    };
    const out = await executeTemplateStep(server, size, "Item 37");
    expect(out.tapped).toBe(false);
    expect(out.reason).toBe("selector unresolved on live tree");
    expect(calls.swipe).toBe(2);
    expect(out.scrolls).toBe(2);
  });

  it("scrolls momentum-free, by less than one container height", async () => {
    const list = { x1: 0, y1: 366, x2: 1080, y2: 2274 };
    const swipes: number[][] = [];
    const server: any = {
      query: async () => ({ nodes: [] }),
      tapWithOutcome: async () => ({}),
      swipeWithOutcome: async (...args: number[]) => {
        swipes.push(args);
        return { changed: true };
      },
      getState: async () => ({
        idHash: "feed",
        tree: [{ className: "android.widget.ListView", resourceId: "x:id/list", bounds: list }],
      }),
    };
    await executeTemplateStep(server, size, "Item 37");
    expect(swipes.length).toBeGreaterThan(0);
    const [, sy, , ey, , holdEndMs] = swipes[0]!;
    // A held lift: the OS reads ~0 release velocity, so no fling carries the list
    // past rows the next query never sees.
    expect(holdEndMs).toBeGreaterThan(0);
    expect(sy! - ey!).toBeLessThan(list.y2 - list.y1);
  });
});

/**
 * Run 2 (34970043301) geometry, estimated from the churn app's layout on a
 * pixel_6 AVD (1080x2400, 420 dpi): a 50-row ListView, rows ~179 px, the list
 * viewport y 366..2274 (1908 px). A held swipe moves the list by the drag minus
 * the 8 dp touch slop; a flinging swipe (no hold) also carries ~1700 px of fling,
 * so one swipe moves more than a viewport and rows fall between two queries.
 */
function listServer(target: number) {
  const ROWS = 50;
  const ROW_H = 179;
  const list = { x1: 0, y1: 366, x2: 1080, y2: 2274 };
  const viewport = list.y2 - list.y1;
  const maxOffset = ROWS * ROW_H - viewport;
  const SLOP = 21;
  const FLING = 1700;
  let offset = 0;
  const server: any = {
    query: async () => {
      const titleTop = target * ROW_H + 40 - offset + list.y1;
      const titleBottom = titleTop + 55;
      const visible = titleTop >= list.y1 && titleBottom <= list.y2;
      return {
        nodes: visible
          ? [
              {
                text: `Story ${target}`,
                bounds: { x1: 32, y1: titleTop, x2: 1048, y2: titleBottom },
              },
            ]
          : [],
      };
    },
    tapWithOutcome: async () => ({}),
    swipeWithOutcome: async (
      _sx: number,
      sy: number,
      _ex: number,
      ey: number,
      _steps: number,
      holdEndMs?: number
    ) => {
      const move = sy - ey - SLOP + (holdEndMs && holdEndMs > 0 ? 0 : FLING);
      const next = Math.min(maxOffset, Math.max(0, offset + move));
      const changed = next !== offset;
      offset = next;
      return { changed };
    },
    getState: async () => ({
      idHash: "feed",
      tree: [{ className: "android.widget.ListView", resourceId: "x:id/list", bounds: list }],
    }),
  };
  return server;
}

describe("template-step scroll reaches every row of a 50-row list (run 2 geometry)", () => {
  it("finds Story 0..49 from the top of the feed", async () => {
    const missed: number[] = [];
    const scrolls: number[] = [];
    for (let i = 0; i < 50; i++) {
      const out = await executeTemplateStep(listServer(i), size, `Story ${i}`);
      if (!out.tapped) missed.push(i);
      scrolls.push(out.scrolls);
    }
    expect(missed).toEqual([]);
    // Story 39 (the run 2 tail) needs 7 held scrolls; the last row needs 9.
    expect(scrolls[39]).toBe(7);
    expect(Math.max(...scrolls)).toBe(9);
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
