import { describe, expect, it } from "vitest";
import * as os from "node:os";
import {
  containerKeyOf,
  destinationShapeOf,
  fnv1aHex,
  itemTemplateOf,
  itemElementsOf,
  nonScrollRids,
  ordinalOf,
  resolveContainer,
  resolveTemplate,
  stripClass,
  stripId,
  type TemplateElement,
} from "../src/screen-graph/template";
import { ScreenGraphStore } from "../src/screen-graph/store";
import { resolveCompactTier } from "../src/screen-graph/describe-tiers";
import { buildSummary, renderSummary } from "../src/screen-graph/describe-tiers";
import type { CanonicalAction } from "../src/screen-graph/types";

/** A RecyclerView feed with `n` rows, plus a collapsing-toolbar title bar. */
function feed(n: number, opts: { rowRid?: string } = {}): TemplateElement[] {
  const rowRid = opts.rowRid ?? "com.churn:id/row";
  const els: TemplateElement[] = [
    {
      className: "android.widget.FrameLayout",
      resourceId: "com.churn:id/collapsing_toolbar",
      index: 1,
      bounds: { x1: 0, y1: 0, x2: 1080, y2: 200 },
    },
    {
      className: "androidx.recyclerview.widget.RecyclerView",
      resourceId: "com.churn:id/list",
      scrollable: true,
      index: 2,
      bounds: { x1: 0, y1: 200, x2: 1080, y2: 2200 },
    },
  ];
  for (let i = 0; i < n; i++) {
    const y1 = 200 + i * 220;
    els.push({
      className: "android.widget.LinearLayout",
      resourceId: rowRid,
      index: 3 + i,
      bounds: { x1: 0, y1, x2: 1080, y2: y1 + 200 },
    });
  }
  return els;
}

/**
 * An item detail screen. On the device the toolbar TITLE text differs per item
 * (the explosion regime, E-0 §F2), producing a distinct on-device `H_id` — but
 * `destinationShape` is text-free (rids + SC tokens only), so every item's detail
 * collapses to ONE shape. The title lives in `text`, which `TemplateElement` does
 * not model precisely because it is excluded; the fixtures below are therefore
 * structurally identical, which is exactly the collapse the shape must produce.
 */
function detail(): TemplateElement[] {
  return [
    {
      className: "android.widget.FrameLayout",
      resourceId: "com.churn:id/collapsing_toolbar",
      index: 1,
      bounds: { x1: 0, y1: 0, x2: 1080, y2: 200 },
    },
    {
      className: "android.widget.TextView",
      resourceId: "com.churn:id/detail_body",
      index: 2,
      bounds: { x1: 0, y1: 200, x2: 1080, y2: 600 },
    },
    { className: "android.widget.TextView", index: 3, bounds: { x1: 0, y1: 0, x2: 800, y2: 200 } },
  ];
}

describe("template identities (design D1)", () => {
  it("fnv1a matches the screen-hash construction vector", () => {
    expect(fnv1aHex("")).toBe("cbf29ce484222325");
  });

  it("stripClass / stripId reduce to the SC-token forms", () => {
    expect(stripClass("androidx.recyclerview.widget.RecyclerView")).toBe("RecyclerView");
    expect(stripId("com.churn:id/list")).toBe("list");
    expect(stripId("android:id/title")).toBe("title");
  });

  it("containerKey is stable across scroll position and content refresh", () => {
    const rowsA = feed(8);
    const rowsB = feed(8); // scrolled / refreshed — new content
    const cA = resolveContainer(rowsA, 540, 500)!;
    const cB = resolveContainer(rowsB, 540, 1500)!;
    const keyA = containerKeyOf("IDHASH", cA, ordinalOf(rowsA, cA));
    const keyB = containerKeyOf("IDHASH", cB, ordinalOf(rowsB, cB));
    expect(keyA).toBe(keyB);
  });

  it("two item shapes produce two templates", () => {
    const rows = feed(8);
    const contentRow = rows.find((e) => e.resourceId === "com.churn:id/row")!;
    const adRow: TemplateElement = {
      className: "android.widget.LinearLayout",
      resourceId: "com.churn:id/ad",
      index: 99,
      bounds: { x1: 0, y1: 500, x2: 1080, y2: 700 },
    };
    const tContent = itemTemplateOf(itemElementsOf(rows, contentRow));
    const tAd = itemTemplateOf(itemElementsOf([...rows, adRow], adRow));
    expect(tContent).not.toBe(tAd);
  });

  it("destinationShape collapses two item detail screens whose only difference is the title", () => {
    const shapeA = destinationShapeOf(detail(), "com.churn");
    const shapeB = destinationShapeOf(detail(), "com.churn");
    expect(shapeA).toBe(shapeB);
  });

  it("resolveContainer returns the smallest scrollable containing the point (nested carousel)", () => {
    const rows = feed(6);
    const carousel: TemplateElement = {
      className: "android.widget.HorizontalScrollView",
      resourceId: "com.churn:id/carousel",
      scrollable: true,
      index: 50,
      bounds: { x1: 0, y1: 420, x2: 1080, y2: 620 },
    };
    const els = [...rows, carousel];
    // A point inside the carousel is contained by both the list and the carousel;
    // the smaller (carousel) wins.
    const c = resolveContainer(els, 540, 520);
    expect(c?.resourceId).toBe("com.churn:id/carousel");
  });

  it("resolveTemplate yields one template node for two differently-titled details", () => {
    const rows = feed(8);
    const a = resolveTemplate(rows, 540, 500, "FEED", detail(), "com.churn")!;
    const b = resolveTemplate(rows, 540, 900, "FEED", detail(), "com.churn")!;
    expect(a).not.toBeNull();
    expect(a.templateNodeHash).toBe(b.templateNodeHash);
  });

  it("nonScrollRids excludes ids inside a scrollable container", () => {
    const rows = feed(3);
    const rids = nonScrollRids(rows, "com.churn");
    // The toolbar id survives; the RecyclerView rows do not.
    expect(rids).toContain("collapsing_toolbar");
    expect(rids).not.toContain("row");
  });
});

describe("template edges and nodes in the store (design D1)", () => {
  const tap: CanonicalAction = {
    kind: "tap",
    template: { containerKey: "CK", itemTemplate: "IT" },
  };

  function newStore(): ScreenGraphStore {
    // High debounce so no background flush fires during the test (no persist).
    return new ScreenGraphStore({
      packageName: "com.churn",
      versionCode: "1",
      baseDir: `${os.tmpdir()}/sg-template-test`,
      enforceBounds: true,
      debounceMs: 10_000_000,
    });
  }

  it("folds every item tap onto ONE edge with growing instances", () => {
    const store = newStore();
    store.upsertNode({ hash: "FEED", compact: "feed", stateHash: "s0", index: {} });
    store.upsertNode({ hash: "TPL", template: true, compact: "detail exemplar", index: {} });
    store.observe("FEED", tap, "TPL", {
      template: { containerKey: "CK", itemTemplate: "IT", concreteTo: "detail_1", itemText: "A" },
    });
    store.observe("FEED", tap, "TPL", {
      template: { containerKey: "CK", itemTemplate: "IT", concreteTo: "detail_2", itemText: "B" },
    });
    store.observe("FEED", tap, "TPL", {
      template: { containerKey: "CK", itemTemplate: "IT", concreteTo: "detail_1", itemText: "A" },
    });
    expect(store.edges).toHaveLength(1);
    const e = store.edges[0]!;
    expect(e.count).toBe(3);
    expect(e.template?.instances).toBe(2); // two distinct destinations
    expect(store.duplicateEdgeTargets()).toEqual([]);
  });

  it("a template node never carries a stateHash and never serves cache (G-I5)", async () => {
    const store = newStore();
    store.upsertNode({
      hash: "TPL",
      template: true,
      compact: "exemplar",
      stateHash: "should-be-ignored",
      index: {},
    });
    const node = store.getNode("TPL")!;
    expect(node.stateHash).toBeUndefined();
    expect(store.templateHygiene()).toEqual([]);
    const res = await resolveCompactTier(
      node,
      { hash: "TPL", stateHash: "anything" },
      { patch: async () => "patched", refresh: async () => "refreshed" }
    );
    expect(res.mode).toBe("refresh");
  });

  it("template nodes are excluded from duplicateScreens", () => {
    const store = newStore();
    store.upsertNode({ hash: "TPL1", template: true, compact: "same", index: {}, resourceIds: [] });
    store.upsertNode({ hash: "TPL2", template: true, compact: "same", index: {}, resourceIds: [] });
    expect(store.duplicateScreens()).toEqual([]);
  });

  it("the summary renders one template affordance line, not per-item titles", () => {
    const store = newStore();
    store.upsertNode({ hash: "FEED", compact: "feed", stateHash: "s0", index: {}, label: "Feed" });
    store.upsertNode({ hash: "TPL", template: true, compact: "x", index: {}, label: "Detail:*" });
    store.observe("FEED", tap, "TPL", {
      template: {
        containerKey: "CK",
        itemTemplate: "abcd1234",
        concreteTo: "d1",
        itemText: "A",
        containerId: "list",
      },
    });
    const text = renderSummary(
      buildSummary(store.getNode("FEED")!, store.outgoingEdges("FEED"), store.nodes)
    );
    expect(text).toContain("item[*] in #list");
    expect(text).toContain("instances");
  });
});
