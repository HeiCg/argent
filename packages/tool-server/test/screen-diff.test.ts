import { describe, it, expect } from "vitest";
import { flatten, diffTrees, patch } from "../src/utils/screen-diff";
import type { HashNode } from "../src/utils/screen-hash";

function node(over: Partial<HashNode> & { bounds: HashNode["bounds"] }): HashNode {
  return { class: "View", ...over };
}

const screen = (label: string, extra: HashNode[] = []): HashNode[] => [
  node({
    class: "FrameLayout",
    bounds: { x1: 0, y1: 0, x2: 1080, y2: 1920 },
    children: [
      node({ class: "TextView", text: label, bounds: { x1: 0, y1: 0, x2: 500, y2: 100 } }),
      node({ class: "Button", id: "next", clickable: true, enabled: true, bounds: { x1: 0, y1: 200, x2: 300, y2: 300 } }),
      ...extra,
    ],
  }),
];

describe("flatten", () => {
  it("emits DFS pre-order with child-index paths", () => {
    const flat = flatten(screen("A"));
    expect(flat.map((n) => n.path)).toEqual([[0], [0, 0], [0, 1]]);
    expect(flat[1]!.text).toBe("A");
    expect(flat[2]!.id).toBe("next");
  });
});

describe("diffTrees", () => {
  it("reports an added node", () => {
    const a = screen("A");
    const b = screen("A", [node({ class: "TextView", text: "extra", bounds: { x1: 0, y1: 400, x2: 500, y2: 500 } })]);
    const d = diffTrees(a, b);
    expect(d.added.map((n) => n.path)).toEqual([[0, 2]]);
    expect(d.added[0]!.text).toBe("extra");
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it("reports a removed node by path", () => {
    const a = screen("A", [node({ class: "TextView", text: "extra", bounds: { x1: 0, y1: 400, x2: 500, y2: 500 } })]);
    const b = screen("A");
    const d = diffTrees(a, b);
    expect(d.removed).toEqual([[0, 2]]);
    expect(d.added).toEqual([]);
  });

  it("reports changed fields with the new values", () => {
    const a = screen("Pending");
    const b = screen("Done");
    const d = diffTrees(a, b);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]!.path).toEqual([0, 0]);
    expect(d.changed[0]!.changedFields).toEqual({ text: "Done" });
  });

  it("reports a flags change", () => {
    const a = screen("A");
    const b = screen("A");
    b[0]!.children![1]!.enabled = false;
    const d = diffTrees(a, b);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]!.changedFields.flags).toBeDefined();
  });
});

describe("patch(a, diff(a,b)) deep-equals flatten(b)", () => {
  const cases: Array<[string, HashNode[], HashNode[]]> = [
    ["identity", screen("A"), screen("A")],
    ["text change", screen("Pending"), screen("Done")],
    ["add node", screen("A"), screen("A", [node({ class: "TextView", text: "x", bounds: { x1: 0, y1: 400, x2: 9, y2: 500 } })])],
    ["remove node", screen("A", [node({ class: "TextView", text: "x", bounds: { x1: 0, y1: 400, x2: 9, y2: 500 } })]), screen("A")],
    [
      "mixed add/remove/change",
      screen("Pending", [node({ class: "ImageView", id: "old", bounds: { x1: 0, y1: 500, x2: 50, y2: 550 } })]),
      screen("Done", [node({ class: "ProgressBar", id: "new", bounds: { x1: 0, y1: 600, x2: 50, y2: 650 } })]),
    ],
    ["empty to populated", [], screen("Fresh")],
    ["populated to empty", screen("Gone"), []],
  ];

  for (const [name, a, b] of cases) {
    it(name, () => {
      const reconstructed = patch(flatten(a), diffTrees(a, b));
      expect(reconstructed).toEqual(flatten(b));
    });
  }
});
