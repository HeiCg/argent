/**
 * Artemis A2 §B — the `index` describe tier rendering: `buildIndexElements` picks
 * the actionable elements in document order and assigns the per-screen index;
 * `renderIndexTier` emits `[i] label (role)` with a version header the agent
 * echoes in `target`.
 */
import { describe, it, expect } from "vitest";
import {
  buildIndexElements,
  renderIndexTier,
  type IndexElement,
} from "../src/tools/describe/platforms/android/index-tier";
import type { OpenServerElement } from "../src/tools/describe/platforms/android/open-server-tree";

const el = (
  index: number,
  bounds: OpenServerElement["bounds"],
  extra: Partial<OpenServerElement> = {}
): OpenServerElement => ({ index, className: "android.widget.TextView", bounds, ...extra });

describe("buildIndexElements", () => {
  it("indexes clickable, scrollable and labelled nodes in document order; drops bare scaffolding", () => {
    const tree: OpenServerElement[] = [
      el(1, { x1: 0, y1: 0, x2: 100, y2: 100 }, { className: "android.widget.FrameLayout" }), // bare, dropped
      el(2, { x1: 0, y1: 100, x2: 100, y2: 200 }, { text: "Network & internet", clickable: true }),
      el(
        3,
        { x1: 0, y1: 200, x2: 100, y2: 300 },
        { contentDesc: "Search", className: "android.widget.Button" }
      ),
      el(
        4,
        { x1: 0, y1: 300, x2: 100, y2: 900 },
        { scrollable: true, className: "android.widget.ScrollView" }
      ),
    ];
    const els: IndexElement[] = buildIndexElements(tree);
    expect(els.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(els[0]).toMatchObject({ index: 0, label: "Network & internet" });
    // content-desc wins the label.
    expect(els[1]).toMatchObject({ index: 1, label: "Search" });
    // scrollable-but-unlabelled is kept (actionable) with an empty label.
    expect(els[2]).toMatchObject({ index: 2, label: "" });
  });

  it("gives a stable index that a target can address back", () => {
    const tree: OpenServerElement[] = [
      el(1, { x1: 0, y1: 0, x2: 100, y2: 100 }, { text: "A", clickable: true }),
      el(2, { x1: 0, y1: 100, x2: 100, y2: 200 }, { text: "B", clickable: true }),
    ];
    const els = buildIndexElements(tree);
    expect(els[1]!.bounds).toEqual({ x1: 0, y1: 100, x2: 100, y2: 200 });
  });
});

describe("renderIndexTier", () => {
  it("renders [i] label (role) lines with a version header", () => {
    const tree: OpenServerElement[] = [
      el(
        1,
        { x1: 0, y1: 0, x2: 100, y2: 100 },
        { text: "Wi-Fi", clickable: true, className: "android.widget.Button" }
      ),
      el(
        2,
        { x1: 0, y1: 100, x2: 100, y2: 200 },
        { scrollable: true, className: "android.widget.ScrollView" }
      ),
    ];
    const text = renderIndexTier(buildIndexElements(tree), 42);
    const lines = text.split("\n");
    expect(lines[0]).toContain("version 42");
    expect(lines[1]).toBe("[0] Wi-Fi (Button)");
    // an unlabelled actionable node shows its role in the slot, never an empty label.
    expect(lines[2]).toBe("[1] (ScrollView)");
  });

  it("handles an empty screen and an absent version", () => {
    expect(renderIndexTier([], undefined)).toContain("no interactive elements");
    expect(renderIndexTier([], undefined).split("\n")[0]).toContain("index tier");
  });
});
