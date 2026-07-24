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

// A realistic axAudit snapshot: some elements carry an audit rect (points on a
// 393x852 screen), others don't (interpolated by the adapter).
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

describe("adaptCoreDeviceAxToDescribeResult", () => {
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
