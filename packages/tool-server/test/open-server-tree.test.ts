import { describe, it, expect } from "vitest";
import {
  openServerElementsToDescribeNode,
  type OpenServerElement,
} from "../src/tools/describe/platforms/android/open-server-tree";

const el = (
  over: Partial<OpenServerElement> & { bounds: OpenServerElement["bounds"] }
): OpenServerElement => ({
  index: 1,
  className: "android.widget.TextView",
  ...over,
});

describe("openServerElementsToDescribeNode", () => {
  it("wraps elements in a Screen root with 0..1 frame", () => {
    const tree = openServerElementsToDescribeNode([], 1080, 1920);
    expect(tree.role).toBe("Screen");
    expect(tree.frame).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(tree.children).toEqual([]);
  });

  it("normalizes pixel bounds against the screen size", () => {
    const tree = openServerElementsToDescribeNode(
      [
        el({
          className: "android.widget.Button",
          bounds: { x1: 540, y1: 960, x2: 1080, y2: 1920 },
        }),
      ],
      1080,
      1920
    );
    const node = tree.children[0]!;
    expect(node.frame.x).toBeCloseTo(0.5, 5);
    expect(node.frame.y).toBeCloseTo(0.5, 5);
    expect(node.frame.width).toBeCloseTo(0.5, 5);
    expect(node.frame.height).toBeCloseTo(0.5, 5);
    expect(node.role).toBe("Button");
  });

  it("derives role from className via the shared role map", () => {
    const tree = openServerElementsToDescribeNode(
      [
        el({ className: "android.widget.EditText", bounds: { x1: 0, y1: 0, x2: 100, y2: 50 } }),
        el({ className: "android.widget.ImageView", bounds: { x1: 0, y1: 0, x2: 100, y2: 50 } }),
      ],
      1000,
      1000
    );
    expect(tree.children[0]!.role).toBe("TextField");
    expect(tree.children[1]!.role).toBe("Image");
  });

  it("prefers content-desc as label and exposes a diverging text as value", () => {
    const tree = openServerElementsToDescribeNode(
      [
        el({
          className: "android.widget.EditText",
          contentDesc: "Email",
          text: "me@x.com",
          bounds: { x1: 0, y1: 0, x2: 100, y2: 50 },
        }),
      ],
      1000,
      1000
    );
    const node = tree.children[0]!;
    expect(node.label).toBe("Email");
    expect(node.value).toBe("me@x.com");
  });

  it("uses text as the label when there is no content-desc and sets no value", () => {
    const tree = openServerElementsToDescribeNode(
      [el({ text: "Hello", bounds: { x1: 0, y1: 0, x2: 100, y2: 50 } })],
      1000,
      1000
    );
    const node = tree.children[0]!;
    expect(node.label).toBe("Hello");
    expect(node.value).toBeUndefined();
  });

  it("carries resourceId as identifier and maps interactivity flags", () => {
    const tree = openServerElementsToDescribeNode(
      [
        el({
          className: "android.widget.CheckBox",
          resourceId: "agree",
          clickable: true,
          checked: true,
          enabled: false,
          scrollable: true,
          focused: true,
          selected: true,
          bounds: { x1: 0, y1: 0, x2: 100, y2: 50 },
        }),
      ],
      1000,
      1000
    );
    const node = tree.children[0]!;
    expect(node.identifier).toBe("agree");
    expect(node.clickable).toBe(true);
    expect(node.checked).toBe(true);
    expect(node.disabled).toBe(true);
    expect(node.scrollable).toBe(true);
    expect(node.focused).toBe(true);
    expect(node.selected).toBe(true);
  });

  it("drops elements that clip fully off-screen", () => {
    const tree = openServerElementsToDescribeNode(
      [
        el({ bounds: { x1: 2000, y1: 2000, x2: 2100, y2: 2100 } }), // off-screen
        el({ text: "on", bounds: { x1: 0, y1: 0, x2: 100, y2: 50 } }),
      ],
      1080,
      1920
    );
    expect(tree.children.length).toBe(1);
    expect(tree.children[0]!.label).toBe("on");
  });

  it("clips a partially-off-screen element so x+width stays within 1", () => {
    const tree = openServerElementsToDescribeNode(
      [el({ bounds: { x1: 1000, y1: 0, x2: 1280, y2: 200 } })],
      1080,
      1920
    );
    const f = tree.children[0]!.frame;
    expect(f.x + f.width).toBeLessThanOrEqual(1);
  });
});
