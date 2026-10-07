import { describe, expect, it } from "vitest";
import {
  executeTemplateStep,
  planTemplateRoute,
  requestedContainerId,
  sweepContainer,
} from "../src/tools/navigate-to";
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
    const out = await executeTemplateStep(server, size, "Item 37", { settlePauseMs: 0 });
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
    const out = await executeTemplateStep(server, size, "Item 37", { settlePauseMs: 0 });
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
    const out = await executeTemplateStep(server, size, "Story 37", { settlePauseMs: 0 });
    expect(out.tapped).toBe(true);
    expect(out.afterResourceIds).not.toContain("statusBarBackground");
    expect(out.afterResourceIds).not.toContain("navigationBarBackground");
    // A template node stores `nonScrollRids` of the same tree — arrival is exact.
    const templateRids = nonScrollRids(detail, "");
    expect(multisetJaccard(out.afterResourceIds, templateRids)).toBe(1);
  });

  it("gives up after the scroll budget and reports unresolved", async () => {
    const { server, calls } = fakeServer([]); // never matches, the list keeps moving
    const out = await executeTemplateStep(server, size, "Item 37", { settlePauseMs: 0 });
    expect(out.tapped).toBe(false);
    expect(out.reason).toBe("selector unresolved on live tree");
    expect(calls.swipe).toBe(30); // TEMPLATE_MAX_SCROLLS
    expect(out.scrolls).toBe(30);
    expect(calls.tap).toBe(0);
  });

  it("reports how many scrolls it used", async () => {
    const item = [{ text: "Item 37", bounds: { x1: 0, y1: 800, x2: 1080, y2: 1000 } }];
    const { server } = fakeServer([[], [], item]);
    const out = await executeTemplateStep(server, size, "Item 37", { settlePauseMs: 0 });
    expect(out.scrolls).toBe(2);
  });

  it("turns at an end after two swipes that change nothing, and stops when neither way moves", async () => {
    const { server, calls } = fakeServer([]);
    server.swipeWithOutcome = async () => {
      calls.swipe += 1;
      return { changed: false, after: { idHash: "feed" } };
    };
    const out = await executeTemplateStep(server, size, "Item 37", { settlePauseMs: 0 });
    expect(out.tapped).toBe(false);
    expect(out.reason).toBe("selector unresolved on live tree");
    // Two still swipes down (an end), turn, two still swipes up (the other end):
    // a pass from end to end that never moved is a clean sweep.
    expect(calls.swipe).toBe(4);
    expect(out.scrolls).toBe(4);
    expect(out.reversals).toBe(1);
    expect(out.swept).toBe(true);
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
    await executeTemplateStep(server, size, "Item 37", { settlePauseMs: 0 });
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
      const out = await executeTemplateStep(listServer(i), size, `Story ${i}`, {
        settlePauseMs: 0,
      });
      if (!out.tapped) missed.push(i);
      scrolls.push(out.scrolls);
    }
    expect(missed).toEqual([]);
    // Review E-1 finding 9: no pinned per-row counts (CI flings, the model does
    // not). The property: every row is reached within one down pass of the list
    // (9 moving + TEMPLATE_END_UNCHANGED still scrolls), far under the 30 cap.
    expect(Math.max(...scrolls)).toBeLessThanOrEqual(11);
  });
});

/**
 * Run 3 (37572199458) replay: the same 50-row geometry, but the live tree carries
 * the visible row titles (so the step can read the container's window) and the
 * failure modes run 3 points at can be switched on:
 *  - `startOffset`: where the list starts (the bottom = the item is ABOVE);
 *  - `flingDown`: a down-scroll (finger up) still flings, +1700 px, so one swipe
 *    moves past a viewport and rows fall between two windows (the CI injector's
 *    catch-up collapses the 120 ms hold under load);
 *  - `lateAx`: the outcome says `changed:false` although the list moved (the AX
 *    scroll event missed the 600 ms first-event window: `settled:"no-event"`);
 *  - `lag`: the screen trails the list: each swipe queues `lag` reads of the
 *    pre-swipe window, one mid-animation window, then the settled one, and the
 *    queue carries over to the next swipe (a janky UI thread). One read per swipe
 *    falls further behind and sees two "unchanged" windows in a row.
 */
function replayServer(
  target: number,
  opts: { startOffset?: number; flingDown?: boolean; lateAx?: boolean; lag?: number } = {}
) {
  const ROWS = 50;
  const ROW_H = 179;
  const list = { x1: 0, y1: 366, x2: 1080, y2: 2274 };
  const viewport = list.y2 - list.y1;
  const maxOffset = ROWS * ROW_H - viewport;
  const SLOP = 21;
  const FLING = 1700;
  let offset = Math.min(maxOffset, Math.max(0, opts.startOffset ?? 0));
  // Offsets the next reads will show (animation); the last one stays on screen.
  const display: number[] = [offset];
  const shown = (): number => display[0]!;
  const titleBox = (i: number, off: number) => {
    const y1 = i * ROW_H + 40 - off + list.y1;
    return { x1: 32, y1, x2: 1048, y2: y1 + 55 };
  };
  const visibleRows = (off: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < ROWS; i++) {
      const b = titleBox(i, off);
      if (b.y1 >= list.y1 && b.y2 <= list.y2) out.push(i);
    }
    return out;
  };
  const stats = { swipes: 0, down: 0, up: 0 };
  const server: any = {
    query: async () => {
      const off = shown();
      const rows = target >= 0 && target < ROWS ? visibleRows(off).filter((i) => i === target) : [];
      return { nodes: rows.map((i) => ({ text: `Story ${i}`, bounds: titleBox(i, off) })) };
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
      stats.swipes += 1;
      const down = sy > ey; // finger moves up: the list reveals later rows
      if (down) stats.down += 1;
      else stats.up += 1;
      const drag = Math.abs(sy - ey) - SLOP;
      const fling = (holdEndMs && holdEndMs > 0 ? 0 : FLING) + (down && opts.flingDown ? FLING : 0);
      const move = (drag + fling) * (down ? 1 : -1);
      const prev = offset;
      const next = Math.min(maxOffset, Math.max(0, offset + move));
      offset = next;
      const lag = opts.lag ?? 0;
      if (next !== prev && lag > 0) {
        for (let i = 0; i < lag; i++) display.push(prev);
        display.push(Math.round((prev + next) / 2));
      }
      display.push(next);
      if (lag === 0) display.splice(0, display.length - 1);
      return { changed: opts.lateAx ? false : next !== prev };
    },
    getState: async () => {
      const off = shown();
      if (display.length > 1) display.shift();
      return {
        idHash: "feed",
        tree: [
          { className: "android.widget.ListView", resourceId: "x:id/list", bounds: list },
          ...visibleRows(off).map((i) => ({
            className: "android.widget.TextView",
            resourceId: "x:id/row_title",
            text: `Story ${i}`,
            bounds: titleBox(i, off),
          })),
        ],
      };
    },
  };
  return { server, stats, maxOffset };
}

const fast = { settlePauseMs: 0 };

describe("template-step search is bidirectional and robust to a lying outcome (run 3)", () => {
  it("(a) finds an item ABOVE the viewport when the list starts at the bottom", async () => {
    const missed: number[] = [];
    for (let i = 0; i < 50; i++) {
      const { server } = replayServer(i, { startOffset: 1e9 });
      const out = await executeTemplateStep(server, size, `Story ${i}`, fast);
      if (!out.tapped) missed.push(i);
    }
    expect(missed).toEqual([]);
  });

  it("(a) scrolls back up after a flinging down pass skipped the item", async () => {
    const missed: number[] = [];
    let rescued = 0;
    for (let i = 0; i < 50; i++) {
      const { server } = replayServer(i, { flingDown: true });
      const out = await executeTemplateStep(server, size, `Story ${i}`, fast);
      if (!out.tapped) missed.push(i);
      if (out.tapped && out.reversals > 0) rescued += 1;
    }
    expect(missed).toEqual([]);
    // Some rows fall between two flung windows on the way down and are only
    // reached by the reverse pass (the run 3 9-scroll misses).
    expect(rescued).toBeGreaterThan(0);
  });

  it("(b) does not take a `changed:false` outcome as the end while the list moves", async () => {
    const missed: number[] = [];
    for (let i = 0; i < 50; i++) {
      const { server } = replayServer(i, { lateAx: true });
      const out = await executeTemplateStep(server, size, `Story ${i}`, fast);
      if (!out.tapped) missed.push(i);
      // Never mistook the moving list for an end on the way down.
      expect(out.reversals).toBe(0);
    }
    expect(missed).toEqual([]);
  });

  it("(b) compares settled reads, not a frame caught before the list moved", async () => {
    const missed: number[] = [];
    for (let i = 0; i < 50; i++) {
      const { server } = replayServer(i, { lateAx: true, lag: 2 });
      const out = await executeTemplateStep(server, size, `Story ${i}`, fast);
      if (!out.tapped) missed.push(i);
      expect(out.reversals).toBe(0);
    }
    expect(missed).toEqual([]);
  });

  it("stops after one clean sweep end to end when the item is absent", async () => {
    const { server, stats } = replayServer(77);
    const out = await executeTemplateStep(server, size, "Story 77", fast);
    expect(out.tapped).toBe(false);
    expect(out.reason).toBe("selector unresolved on live tree");
    expect(out.swept).toBe(true);
    expect(out.reversals).toBe(1);
    // One pass down and one back up (symmetric on a held swipe), under the cap.
    expect(stats.down).toBe(stats.up);
    expect(out.scrolls).toBe(stats.down + stats.up);
    expect(out.scrolls).toBeLessThan(30);
  });

  it("does not claim a clean sweep when a pass had a gap between windows", async () => {
    const { server } = replayServer(77, { flingDown: true });
    const out = await executeTemplateStep(server, size, "Story 77", fast);
    expect(out.tapped).toBe(false);
    expect(out.gaps).toBeGreaterThan(0);
    // The flung down pass has gaps; the held up pass that follows is clean.
    expect(out.swept).toBe(true);
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

/**
 * Review E-1 2026-10-07 finding 3 / 9: the churn feed's shape — a fixed title bar,
 * a horizontal carousel (`#carousel`) above a vertical list (`#list`). An exact
 * text match outside the template's container must never be tapped, and a
 * carousel item must never send the step scrolling the vertical list.
 */
const TOOLBAR = { x1: 0, y1: 0, x2: 1080, y2: 200 };
const CAROUSEL = { x1: 0, y1: 200, x2: 1080, y2: 366 };
const LIST = { x1: 0, y1: 366, x2: 1080, y2: 2274 };

function feedTree(): any[] {
  return [
    {
      className: "android.widget.LinearLayout",
      resourceId: "x:id/feed_toolbar",
      index: 1,
      bounds: TOOLBAR,
    },
    {
      className: "android.widget.HorizontalScrollView",
      resourceId: "x:id/carousel",
      index: 2,
      bounds: CAROUSEL,
    },
    {
      className: "android.widget.TextView",
      resourceId: "x:id/carousel_item",
      text: "Card 3",
      index: 3,
      bounds: { x1: 600, y1: 220, x2: 800, y2: 346 },
    },
    { className: "android.widget.ListView", resourceId: "x:id/list", index: 4, bounds: LIST },
    {
      className: "android.widget.TextView",
      resourceId: "x:id/row_title",
      text: "Story 3",
      index: 5,
      bounds: { x1: 32, y1: 900, x2: 1048, y2: 955 },
    },
  ];
}

function feedServer(queryNodes: (call: number) => Array<{ text: string; bounds: any }>) {
  const calls = { query: 0, tap: 0, swipes: [] as number[][] };
  const server: any = {
    query: async () => {
      const nodes = queryNodes(calls.query);
      calls.query += 1;
      return { nodes };
    },
    tapWithOutcome: async () => {
      calls.tap += 1;
      return {};
    },
    swipeWithOutcome: async (...args: number[]) => {
      calls.swipes.push(args);
      return { changed: false, deliveredMs: 281 };
    },
    getState: async () => ({ idHash: "feed", tree: feedTree() }),
  };
  return { server, calls };
}

describe("template step is scoped to the template's container (review E-1 finding 3)", () => {
  it("never taps an exact match that lies outside the template's container", async () => {
    // `Card 3` is an exact match, but it lives in the carousel; the step targets #list.
    const { server, calls } = feedServer(() => [
      { text: "Card 3", bounds: { x1: 600, y1: 220, x2: 800, y2: 346 } },
    ]);
    const out = await executeTemplateStep(server, size, "Card 3", {
      settlePauseMs: 0,
      containerId: "list",
    });
    expect(out.tapped).toBe(false);
    expect(calls.tap).toBe(0);
    expect(out.reason).toBe("selector unresolved on live tree");
    // Every swipe ran vertically inside the list, never in the carousel.
    for (const [sx, sy, ex, ey] of calls.swipes) {
      expect(sx).toBe(ex);
      expect(sy!).toBeGreaterThan(LIST.y1);
      expect(ey!).toBeGreaterThan(LIST.y1);
    }
  });

  it("never taps an exact match outside every scrollable (title bar) when a container exists", async () => {
    const { server, calls } = feedServer(() => [
      { text: "Story 5", bounds: { x1: 32, y1: 60, x2: 400, y2: 140 } },
    ]);
    const out = await executeTemplateStep(server, size, "Story 5", { settlePauseMs: 0 });
    expect(out.tapped).toBe(false);
    expect(calls.tap).toBe(0);
  });

  it("scrolls a carousel template horizontally inside the carousel, not the list", async () => {
    const card7 = { text: "Card 7", bounds: { x1: 300, y1: 220, x2: 500, y2: 346 } };
    const { server, calls } = feedServer((n) => (n >= 1 ? [card7] : []));
    const out = await executeTemplateStep(server, size, "Card 7", {
      settlePauseMs: 0,
      containerId: "carousel",
    });
    expect(out.tapped).toBe(true);
    expect(calls.swipes).toHaveLength(1);
    const [sx, sy, ex, ey] = calls.swipes[0]!;
    expect(sy).toBe(ey); // horizontal
    expect(sx).not.toBe(ex);
    expect(sy!).toBeGreaterThanOrEqual(CAROUSEL.y1);
    expect(sy!).toBeLessThanOrEqual(CAROUSEL.y2);
  });

  it("fails closed without scrolling when the template's container is not on screen", async () => {
    const { server, calls } = feedServer(() => []);
    const out = await executeTemplateStep(server, size, "Story 3", {
      settlePauseMs: 0,
      containerId: "gone",
    });
    expect(out.tapped).toBe(false);
    expect(out.reason).toBe("template container not on live tree");
    expect(calls.swipes).toHaveLength(0);
    expect(calls.tap).toBe(0);
  });
});

describe("template step timing telemetry (review E-1 finding 4)", () => {
  it("records wall time, per-swipe host time and the device-reported DOWN-to-UP span", async () => {
    const { server, calls } = feedServer(() => []);
    const out = await executeTemplateStep(server, size, "Story 99", {
      settlePauseMs: 0,
      containerId: "list",
    });
    expect(out.scrolls).toBe(calls.swipes.length);
    expect(out.swipeMs).toHaveLength(out.scrolls);
    expect(out.deliveredMs).toEqual(Array(out.scrolls).fill(281));
    expect(out.wallMs).toBeGreaterThanOrEqual(0);
  });

  it("omits deliveredMs for a server that does not report it", async () => {
    const { server } = fakeServer([]);
    const out = await executeTemplateStep(server, size, "Item 37", { settlePauseMs: 0 });
    expect(out.deliveredMs).toEqual([]);
    expect(out.swipeMs).toHaveLength(out.scrolls);
  });
});

describe("sweepContainer lists the rows actually on screen (review E-1 finding 5)", () => {
  it("collects every row of the 50-row list in one sweep", async () => {
    const { server } = replayServer(-1);
    const sw = await sweepContainer(server, size, { settlePauseMs: 0, containerId: "list" });
    const stories = [...sw.labels].filter((l) => l.startsWith("Story "));
    expect(stories).toHaveLength(50);
    expect(sw.gaps).toBe(0);
    expect(sw.complete).toBe(true);
  });

  it("is not complete when a pass skipped rows", async () => {
    const { server } = replayServer(-1, { flingDown: true });
    const sw = await sweepContainer(server, size, { settlePauseMs: 0, containerId: "list" });
    expect(sw.gaps).toBeGreaterThan(0);
  });
});

describe("planToTemplate routes by the requested item's container (review E-1 finding 3)", () => {
  const node = (hash: string, template = false): ScreenNode => ({
    hash,
    firstSeen: 0,
    lastSeen: 0,
    visits: 1,
    compact: "",
    index: {},
    ...(template ? { template: true } : {}),
  });
  const tplEdge = (
    to: string,
    containerId: string,
    instances: number,
    lastItemTexts?: string[]
  ): Edge => ({
    from: "FEED",
    action: { kind: "tap", template: { containerKey: `CK_${containerId}`, itemTemplate: "IT" } },
    to,
    count: instances,
    successes: instances,
    lastSeen: 0,
    template: {
      containerKey: `CK_${containerId}`,
      itemTemplate: "IT",
      instances,
      containerId,
      ...(lastItemTexts ? { lastItemTexts } : {}),
    },
  });
  const graph = {
    nodes: { FEED: node("FEED"), TPL_L: node("TPL_L", true), TPL_C: node("TPL_C", true) },
    edges: [tplEdge("TPL_L", "list", 40, ["Story 7"]), tplEdge("TPL_C", "carousel", 1, ["Card 0"])],
  };

  it("routes a carousel item to the carousel template, never the list", () => {
    const res = planToTemplate(graph, "FEED", 0, { containerId: "carousel" });
    expect(res?.templateNode).toBe("TPL_C");
    expect(res?.steps.at(-1)?.template?.containerId).toBe("carousel");
  });

  it("routes by a recorded item text when the item is not on screen", () => {
    expect(planToTemplate(graph, "FEED", 0, { itemText: "card 0" })?.templateNode).toBe("TPL_C");
  });

  it("routes an unknown item to the container with the most recorded items", () => {
    expect(planToTemplate(graph, "FEED", 0, { itemText: "Story 40" })?.templateNode).toBe("TPL_L");
  });

  it("returns null when the item's container has no template edge", () => {
    expect(planToTemplate(graph, "FEED", 0, { containerId: "other" })).toBeNull();
  });

  it("resolves the requested item's container from the live tree", () => {
    const tree = feedTree();
    expect(requestedContainerId(tree, "Card 3")).toBe("carousel");
    expect(requestedContainerId(tree, "story 3")).toBe("list");
    expect(requestedContainerId(tree, "Story 40")).toBeUndefined();
  });

  it("plans a carousel item on the live feed to the carousel template", () => {
    const res = planTemplateRoute(graph, "FEED", "Card 3", feedTree(), true);
    expect(res?.templateNode).toBe("TPL_C");
  });

  it("takes no template route when ARGENT_SG_TEMPLATES is off (review E-1 finding 8)", () => {
    expect(planTemplateRoute(graph, "FEED", "Card 3", feedTree(), false)).toBeNull();
  });
});
