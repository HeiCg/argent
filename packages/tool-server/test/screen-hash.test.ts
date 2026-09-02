import { describe, it, expect } from "vitest";
import {
  structuralHash,
  stateHash,
  flagsOf,
  isScrollingContainer,
  FLAG_CLICKABLE,
  FLAG_ENABLED,
  type HashNode,
} from "../src/utils/screen-hash";

const W = 1080;
const H = 1920;

function node(over: Partial<HashNode> & { bounds: HashNode["bounds"] }): HashNode {
  return { class: "View", ...over };
}

describe("screen-hash flags", () => {
  it("packs the actionability bitmask in the documented bit order", () => {
    expect(flagsOf(node({ bounds: { x1: 0, y1: 0, x2: 1, y2: 1 } }))).toBe(0);
    expect(
      flagsOf(node({ bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, clickable: true, enabled: true }))
    ).toBe(FLAG_CLICKABLE | FLAG_ENABLED);
  });

  it("treats known scroll containers and the scrollable flag as recyclers", () => {
    expect(isScrollingContainer(node({ class: "RecyclerView", bounds: { x1: 0, y1: 0, x2: 1, y2: 1 } }))).toBe(true);
    expect(isScrollingContainer(node({ class: "ViewPager2", bounds: { x1: 0, y1: 0, x2: 1, y2: 1 } }))).toBe(true);
    expect(
      isScrollingContainer(node({ class: "FrameLayout", scrollable: true, bounds: { x1: 0, y1: 0, x2: 1, y2: 1 } }))
    ).toBe(true);
    expect(isScrollingContainer(node({ class: "FrameLayout", bounds: { x1: 0, y1: 0, x2: 1, y2: 1 } }))).toBe(false);
  });
});

describe("structuralHash / stateHash", () => {
  const tree: HashNode[] = [
    node({
      class: "FrameLayout",
      bounds: { x1: 0, y1: 0, x2: 1080, y2: 1920 },
      children: [
        node({ class: "TextView", text: "Wi-Fi", bounds: { x1: 0, y1: 100, x2: 500, y2: 200 } }),
        node({ class: "Switch", id: "toggle", checkable: true, clickable: true, enabled: true, bounds: { x1: 900, y1: 100, x2: 1000, y2: 200 } }),
      ],
    }),
  ];

  it("is deterministic — same tree, same hash", () => {
    expect(structuralHash(tree, W, H)).toBe(structuralHash(tree, W, H));
    expect(stateHash(tree, W, H)).toBe(stateHash(tree, W, H));
  });

  it("returns 16 lowercase hex chars", () => {
    expect(structuralHash(tree, W, H)).toMatch(/^[0-9a-f]{16}$/);
    expect(stateHash(tree, W, H)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("H excludes text; H_text includes it", () => {
    const changedText: HashNode[] = [
      node({
        class: "FrameLayout",
        bounds: { x1: 0, y1: 0, x2: 1080, y2: 1920 },
        children: [
          node({ class: "TextView", text: "Bluetooth", bounds: { x1: 0, y1: 100, x2: 500, y2: 200 } }),
          node({ class: "Switch", id: "toggle", checkable: true, clickable: true, enabled: true, bounds: { x1: 900, y1: 100, x2: 1000, y2: 200 } }),
        ],
      }),
    ];
    // Only text changed → same screen (H), different state (H_text).
    expect(structuralHash(changedText, W, H)).toBe(structuralHash(tree, W, H));
    expect(stateHash(changedText, W, H)).not.toBe(stateHash(tree, W, H));
  });

  it("flags change the structural hash", () => {
    const noClick: HashNode[] = [
      node({
        class: "FrameLayout",
        bounds: { x1: 0, y1: 0, x2: 1080, y2: 1920 },
        children: [
          node({ class: "TextView", text: "Wi-Fi", bounds: { x1: 0, y1: 100, x2: 500, y2: 200 } }),
          node({ class: "Switch", id: "toggle", checkable: true, clickable: false, enabled: true, bounds: { x1: 900, y1: 100, x2: 1000, y2: 200 } }),
        ],
      }),
    ];
    expect(structuralHash(noClick, W, H)).not.toBe(structuralHash(tree, W, H));
  });

  it("quantizes bounds to 1/32 of screen — small jitter stays in the same bucket", () => {
    const jitter: HashNode[] = [
      node({
        class: "FrameLayout",
        bounds: { x1: 0, y1: 0, x2: 1080, y2: 1920 },
        children: [
          node({ class: "TextView", text: "Wi-Fi", bounds: { x1: 2, y1: 101, x2: 501, y2: 201 } }),
          node({ class: "Switch", id: "toggle", checkable: true, clickable: true, enabled: true, bounds: { x1: 900, y1: 100, x2: 1000, y2: 200 } }),
        ],
      }),
    ];
    // 1080/32 = 33.75px per bucket; a couple of px does not cross a boundary.
    expect(structuralHash(jitter, W, H)).toBe(structuralHash(tree, W, H));
  });

  it("bounds moving across a bucket boundary changes the hash", () => {
    const moved: HashNode[] = [
      node({
        class: "FrameLayout",
        bounds: { x1: 0, y1: 0, x2: 1080, y2: 1920 },
        children: [
          node({ class: "TextView", text: "Wi-Fi", bounds: { x1: 0, y1: 500, x2: 500, y2: 600 } }),
          node({ class: "Switch", id: "toggle", checkable: true, clickable: true, enabled: true, bounds: { x1: 900, y1: 100, x2: 1000, y2: 200 } }),
        ],
      }),
    ];
    expect(structuralHash(moved, W, H)).not.toBe(structuralHash(tree, W, H));
  });

  it("is a stable golden value (regression guard, cross-checks the Kotlin twin's spec)", () => {
    // If this changes, the on-device Kotlin ScreenHash must change identically.
    expect(structuralHash(tree, W, H)).toBe("f713f2ce9fe1e246");
    expect(stateHash(tree, W, H)).toBe("ee2ad35508d70f42");
  });
});

describe("structuralHash recycler rule", () => {
  const list = (itemCount: number, firstClass = "LinearLayout"): HashNode[] => [
    node({
      class: "RecyclerView",
      id: "feed",
      scrollable: true,
      bounds: { x1: 0, y1: 0, x2: 1080, y2: 1920 },
      children: Array.from({ length: itemCount }, (_, i) =>
        node({
          class: i === 0 ? firstClass : "LinearLayout",
          bounds: { x1: 0, y1: i * 100, x2: 1080, y2: (i + 1) * 100 },
          children: [node({ class: "TextView", text: `item ${i}`, bounds: { x1: 0, y1: i * 100, x2: 1080, y2: (i + 1) * 100 } })],
        })
      ),
    }),
  ];

  it("H ignores item count for a recycler (3 vs 8 items hash equal)", () => {
    expect(structuralHash(list(3), W, H)).toBe(structuralHash(list(8), W, H));
  });

  it("H_text still reflects all recycler children (item count changes it)", () => {
    expect(stateHash(list(3), W, H)).not.toBe(stateHash(list(8), W, H));
  });

  it("H changes when the first child's class differs", () => {
    expect(structuralHash(list(5, "CardView"), W, H)).not.toBe(structuralHash(list(5, "LinearLayout"), W, H));
  });
});
