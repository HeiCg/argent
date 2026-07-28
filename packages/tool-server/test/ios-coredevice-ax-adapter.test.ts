import { describe, it, expect } from "vitest";
import { adaptCoreDeviceAxToDescribeResult } from "../src/tools/describe/platforms/ios/ios-coredevice-ax-adapter";

interface Node {
  role: string;
  frame: { x: number; y: number; width: number; height: number };
  children: Node[];
  label?: string;
}
function flatten(n: Node, out: Node[] = []): Node[] {
  out.push(n);
  for (const c of n.children) flatten(c, out);
  return out;
}
const center = (f: Node["frame"]) => ({ x: f.x + f.width / 2, y: f.y + f.height / 2 });

// FORWARD-COMPATIBILITY fixture only. The sim-server does NOT send geometry
// today — its payload is captions + reading order, with no `screen` and no
// per-element `rect` (pinned on the producer side by radon's
// `ax_tree_payload_carries_no_geometry`). This fixture exists so the adapter's
// real-rect path keeps working if a geometry source is ever added; the
// no-geometry suite below is what actually runs in production.
const AXTREE = {
  screen: { w: 393, h: 852 },
  elements: [
    { caption: "Settings, Button", id: "a1", rect: "{{318, 63}, {55, 36}}" },
    { caption: "Wi-Fi, Header", id: "a2", rect: "{{32, 168}, {55, 26}}" },
    { caption: "Wi-Fi, 1, Button, Toggle", id: "a3" }, // no rect -> interpolated
    { caption: "Other…, Button", id: "a4", rect: "{{16, 553}, {361, 52}}" },
    { caption: "Known networks will be joined automatically.", id: "a5" }, // static text
  ],
};

// What `/api/ax-tree` actually returns today: captions + reading order only.
const AXTREE_NO_GEOMETRY = {
  elements: [
    { caption: "Settings, Button", id: "a1" },
    { caption: "Wi-Fi, Header", id: "a2" },
    { caption: "Wi-Fi, 1, Button, Toggle", id: "a3" },
    { caption: "Other…, Button", id: "a4" },
    { caption: "Known networks will be joined automatically.", id: "a5" },
  ],
};

describe("adaptCoreDeviceAxToDescribeResult (production payload: no geometry)", () => {
  const tree = adaptCoreDeviceAxToDescribeResult(AXTREE_NO_GEOMETRY);
  const nodes = flatten(tree as Node).slice(1); // drop the synthetic AXGroup root

  it("still parses roles and labels from the captions", () => {
    expect(nodes.map((n) => n.role)).toEqual([
      "AXButton",
      "AXHeader",
      "AXButton",
      "AXButton",
      "AXStaticText",
    ]);
    expect(nodes[1].label).toBe("Wi-Fi");
  });

  it("interpolates EVERY frame: full-width rows, strictly ordered top to bottom", () => {
    for (const n of nodes) {
      // approxFrame is full-width with a symmetric margin, never a real rect.
      expect(n.frame.x).toBeCloseTo(0.04, 6);
      expect(n.frame.width).toBeCloseTo(0.92, 6);
    }
    const ys = nodes.map((n) => center(n.frame).y);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeGreaterThan(ys[i - 1]);
    }
  });

  it("keeps every interpolated frame inside the normalized [0,1] box", () => {
    for (const n of nodes) {
      expect(n.frame.y).toBeGreaterThanOrEqual(0);
      expect(n.frame.y + n.frame.height).toBeLessThanOrEqual(1.0001);
    }
  });
});

describe("adaptCoreDeviceAxToDescribeResult (forward-compat: payload with geometry)", () => {
  const tree = adaptCoreDeviceAxToDescribeResult(AXTREE);
  const nodes = flatten(tree as Node);
  const byLabel = (l: string) => nodes.find((n) => n.label === l);

  it("parses roles from caption traits and strips them from the label", () => {
    expect(byLabel("Settings")?.role).toBe("AXButton");
    expect(byLabel("Wi-Fi")?.role).toBe("AXHeader");
    // Button trait wins the role; trailing Button/Toggle stripped from the label.
    expect(byLabel("Wi-Fi, 1")?.role).toBe("AXButton");
    // No trait -> static text, full caption kept as label.
    const stat = nodes.find((n) => n.label?.startsWith("Known networks"));
    expect(stat?.role).toBe("AXStaticText");
  });

  it("normalizes an audited rect (points) into a [0,1] frame", () => {
    const other = byLabel("Other…")!;
    // {{16, 553}, {361, 52}} on 393x852
    expect(other.frame.x).toBeCloseTo(16 / 393, 3);
    expect(other.frame.y).toBeCloseTo(553 / 852, 3);
    expect(other.frame.width).toBeCloseTo(361 / 393, 3);
  });

  it("interpolates a rect-less element between its neighbours (reading order)", () => {
    const wifiHeader = center(byLabel("Wi-Fi")!.frame).y; // ~168/852
    const other = center(byLabel("Other…")!.frame).y; // ~553/852
    const toggle = center(byLabel("Wi-Fi, 1")!.frame).y; // no rect, between the two
    expect(toggle).toBeGreaterThan(wifiHeader);
    expect(toggle).toBeLessThan(other);
  });

  it("keeps every frame within the normalized [0,1] box", () => {
    for (const n of nodes) {
      const { x, y, width, height } = n.frame;
      for (const v of [x, y, width, height]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(x + width).toBeLessThanOrEqual(1.0001);
      expect(y + height).toBeLessThanOrEqual(1.0001);
    }
  });

  it("does not throw on an empty / screen-less tree", () => {
    expect(() => adaptCoreDeviceAxToDescribeResult({ elements: [] })).not.toThrow();
    expect(() =>
      adaptCoreDeviceAxToDescribeResult({
        elements: [{ caption: "x", id: "1" }],
      })
    ).not.toThrow();
  });
});
