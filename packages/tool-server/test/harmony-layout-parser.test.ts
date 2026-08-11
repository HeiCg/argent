import { describe, it, expect } from "vitest";
import {
  harmonyLabel,
  parseHarmonyBounds,
  parseHarmonyLayout,
} from "../src/tools/describe/platforms/harmony/layout-parser";
import type { HarmonyLayoutNode } from "../src/utils/harmony-uitest";

const SCREEN = { width: 1216, height: 2688 };

/** Build a dump node with `uitest`'s string-valued attributes. */
function node(
  attrs: Record<string, string>,
  children: HarmonyLayoutNode[] = []
): HarmonyLayoutNode {
  return { attributes: attrs, children };
}

/** The synthetic root `uitest` emits: no attributes but the display bounds. */
function root(windows: HarmonyLayoutNode[]): HarmonyLayoutNode {
  return node({ bounds: "[0,0][1216,2688]" }, windows);
}

function flatten(n: { role: string; children: { role: string }[] }): string[] {
  return [n.role, ...n.children.flatMap((c) => flatten(c as never))];
}

describe("parseHarmonyBounds", () => {
  it("reads the [l,t][r,b] pixel form", () => {
    expect(parseHarmonyBounds("[55,1387][292,1624]")).toEqual({ x: 55, y: 1387, w: 237, h: 237 });
  });

  it("reads negative coordinates, which a list emits for items scrolled off", () => {
    expect(parseHarmonyBounds("[-40,-10][60,90]")).toEqual({ x: -40, y: -10, w: 100, h: 100 });
  });

  it("returns null for anything else", () => {
    expect(parseHarmonyBounds("")).toBeNull();
    expect(parseHarmonyBounds("55,1387")).toBeNull();
  });
});

describe("harmonyLabel", () => {
  it("prefers the accessibility description over the visible text", () => {
    expect(harmonyLabel({ description: "Delete", text: "x" })).toBe("Delete");
  });

  it("treats a whitespace-only description as absent", () => {
    // The calculator labels every keypad Button `" "`. Without the trim each one
    // becomes a blank-labelled node that reads like a real, empty label.
    expect(harmonyLabel({ description: " ", text: "7" })).toBe("7");
  });

  it("falls back to the placeholder of an empty field", () => {
    expect(harmonyLabel({ description: "", text: "", hint: "Search" })).toBe("Search");
  });

  it("returns empty when the node carries nothing", () => {
    expect(harmonyLabel({})).toBe("");
  });
});

describe("parseHarmonyLayout", () => {
  it("labels each window with the app that owns it", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,107][1216,2688]" }, [
          node({ type: "Text", text: "Hi", bounds: "[0,107][100,207]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].role).toBe("Window");
    // A tree spanning an app and the status bar (always a separate sceneboard
    // window) is unreadable if both are anonymous stacks.
    expect(tree.children[0].label).toBe("com.app");
  });

  it("walks through ArkUI layout scaffolding instead of emitting it", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "Column", bounds: "[0,0][1216,2688]" }, [
            node({ type: "Row", bounds: "[0,0][1216,2688]" }, [
              node({ type: "Stack", bounds: "[0,0][1216,2688]" }, [
                node({ type: "Text", text: "Deep", bounds: "[10,10][110,110]" }),
              ]),
            ]),
          ]),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(flatten(tree)).toEqual(["Screen", "Window", "StaticText"]);
  });

  it("keeps a layout type that is itself clickable", () => {
    // ArkUI builds real buttons out of Stack/Row, so walking through every
    // container by type would delete tap targets.
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "Stack", clickable: "true", id: "tap-me", bounds: "[0,0][100,100]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    const target = tree.children[0].children[0];
    expect(target.identifier).toBe("tap-me");
    expect(target.clickable).toBe(true);
  });

  // ArkUI sets `.id()` and the state flags on the OUTER component, so the
  // wrapper of a same-rect pair is often the only node that knows it. Collapsing
  // it away kept `clickable` and dropped the rest.
  describe("same-rect duplicate layers", () => {
    const wrap = (attrs: Record<string, string>, child: Record<string, string>) =>
      parseHarmonyLayout(
        root([
          node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
            node(attrs, [node(child)]),
          ]),
        ]),
        SCREEN
      ).tree.children[0].children[0];

    it("collapses a wrapper that knows nothing its child does not", () => {
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Stack", clickable: "true", bounds: B },
        {
          type: "Text",
          text: "Submit",
          bounds: B,
        }
      );
      expect(target.role).toBe("StaticText");
      expect(target.label).toBe("Submit");
      expect(target.clickable).toBe(true);
      expect(target.children).toHaveLength(0);
    });

    it("keeps a wrapper that carries the identifier an agent selects on", () => {
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Stack", clickable: "true", id: "tap-me", bounds: B },
        {
          type: "Text",
          text: "Submit",
          bounds: B,
        }
      );
      expect(target.identifier).toBe("tap-me");
      // The child's label stays reachable rather than being traded for the id.
      expect(target.children[0].label).toBe("Submit");
    });

    // Each case below carries ONLY the state under test - no `id` - so it pins
    // that flag specifically. With an identifier present too, any one of these
    // could be dropped from the guard and the case would still pass on the
    // identifier alone.
    it("does not report a disabled control as a plain tappable one", () => {
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Button", clickable: "true", enabled: "false", bounds: B },
        { type: "Text", text: "Submit", bounds: B }
      );
      expect(target.disabled).toBe(true);
      expect(target.role).toBe("Button");
    });

    it("keeps a scroll container that holds a single full-height row", () => {
      const B = "[0,0][1216,1000]";
      const target = wrap(
        { type: "List", bounds: B },
        {
          type: "ListItem",
          text: "only row",
          bounds: B,
        }
      );
      // Without this the agent sees no scrollable region and never swipes.
      expect(target.role).toBe("ScrollView");
      expect(target.scrollable).toBe(true);
    });

    it("keeps a switch's checked state when its image fills the same rect", () => {
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Toggle", clickable: "true", checkable: "true", checked: "true", bounds: B },
        { type: "Image", bounds: B }
      );
      expect(target.role).toBe("Switch");
      expect(target.checkable).toBe(true);
      expect(target.checked).toBe(true);
    });

    it("keeps a long-pressable wrapper", () => {
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Stack", longClickable: "true", bounds: B },
        { type: "Image", bounds: B }
      );
      expect(target.longClickable).toBe(true);
    });

    it("keeps a switch that is off, not only one that is on", () => {
      // `checked` and `checkable` cover for each other on an on-switch, so the
      // off case is what pins `checkable` by itself.
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Toggle", clickable: "true", checkable: "true", bounds: B },
        { type: "Image", bounds: B }
      );
      expect(target.checkable).toBe(true);
      expect(target.checked).toBeUndefined();
    });

    it("keeps a selected wrapper, and a focused one", () => {
      // Not a `Stack`: a layout container carrying neither a label nor one of
      // the interactive flags is hoisted away as scaffolding before the collapse
      // is ever reached, so it cannot exercise this guard.
      const B = "[0,0][200,100]";
      expect(
        wrap({ type: "ListItem", selected: "true", bounds: B }, { type: "Image", bounds: B })
          .selected
      ).toBe(true);
      expect(
        wrap({ type: "ListItem", focused: "true", bounds: B }, { type: "Image", bounds: B }).focused
      ).toBe(true);
    });
  });

  it("drops decoration that can never be a target", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "Divider", bounds: "[0,0][1216,2]" }),
          node({ type: "ScrollBar", bounds: "[1164,0][1216,2688]" }),
          node({ type: "Text", text: "Real", bounds: "[0,10][100,110]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(flatten(tree)).toEqual(["Screen", "Window", "StaticText"]);
  });

  it("normalizes bounds into the [0,1] frame contract", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "Button", id: "b", bounds: "[608,1344][1216,2688]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(tree.children[0].children[0].frame).toEqual({
      x: 0.5,
      y: 0.5,
      width: 0.5,
      height: 0.5,
    });
  });

  it("clamps a frame for content scrolled off the top", () => {
    // A List reports negative bounds for rows above the viewport, and the
    // describe frame contract is closed over [0,1].
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "Button", id: "b", bounds: "[-100,-200][100,200]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    const f = tree.children[0].children[0].frame;
    expect(f.x).toBe(0);
    expect(f.y).toBe(0);
  });

  it("surfaces interactivity and state flags", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({
            type: "Button",
            id: "b",
            bounds: "[0,0][100,100]",
            clickable: "true",
            longClickable: "true",
            checkable: "true",
            checked: "true",
            enabled: "false",
            focused: "true",
            selected: "true",
          }),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(tree.children[0].children[0]).toMatchObject({
      clickable: true,
      longClickable: true,
      checkable: true,
      checked: true,
      disabled: true,
      focused: true,
      selected: true,
    });
  });

  it("treats a node as enabled when `enabled` is absent", () => {
    // Every node carries `enabled`; a missing one means the dump shape changed,
    // and defaulting the other way would grey out the whole screen.
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "Button", id: "b", bounds: "[0,0][100,100]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(tree.children[0].children[0].disabled).toBeUndefined();
  });

  it("marks a List as scrollable by type even without the flag", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "List", bounds: "[0,0][1216,2688]" }, [
            node({ type: "Text", text: "row", bounds: "[0,0][100,100]" }),
          ]),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(tree.children[0].children[0]).toMatchObject({ role: "ScrollView", scrollable: true });
  });

  it("says so when a system overlay hides its own contents", () => {
    // The app-selector / share sheet renders in another process and the dump
    // carries the node with no children. Emitting an empty container would tell
    // an agent the screen is empty when a dialog is covering it.
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.ohos.sceneboard", bounds: "[0,0][1216,2688]" }, [
          node({ type: "UIExtensionComponent", id: "AppSelector", bounds: "[0,0][1216,2688]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    const overlay = tree.children[0].children[0];
    expect(overlay.role).toBe("SystemOverlay");
    expect(overlay.label).toMatch(/another process/);
  });

  it("takes the screen size from the dump's own root, not the caller's", () => {
    // The two are read at different instants; on a foldable that gap is enough
    // for an unfold to normalize every frame against the wrong axis.
    const { screen } = parseHarmonyLayout(node({ bounds: "[0,0][2200,2480]" }, []), SCREEN);
    expect(screen).toEqual({ width: 2200, height: 2480 });
  });

  it("falls back to the queried size when the root reports no bounds", () => {
    const { screen } = parseHarmonyLayout(node({}, []), SCREEN);
    expect(screen).toEqual(SCREEN);
  });

  // A List reports real off-screen bounds for its scrolled rows, so the frame
  // has to be clipped to the screen before it is normalized. Normalizing each
  // component on its own and clamping into [0,1] gave a row at [0,-400][1216,-260]
  // the frame y=0 height=0.052 — a full-width tap target at the top of the
  // screen, with the same frame as the row genuinely straddling that edge.
  describe("off-screen rows", () => {
    const rows = (items: Array<[string, string]>) =>
      parseHarmonyLayout(
        root([
          node({ type: "WindowScene", bundleName: "com.demo.app", bounds: "[0,0][1216,2688]" }, [
            node(
              { type: "List", bounds: "[0,0][1216,2688]", scrollable: "true" },
              items.map(([text, bounds]) =>
                node({ type: "ListItem", text, bounds, clickable: "true" })
              )
            ),
          ]),
        ]),
        SCREEN
      ).tree.children[0].children[0].children;

    it("gives a row scrolled fully off the screen no area, on every edge", () => {
      const [above, below, right] = rows([
        ["ABOVE", "[0,-400][1216,-260]"],
        ["BELOW", "[0,2888][1216,3028]"],
        ["RIGHT", "[1266,400][1456,540]"],
      ]);
      expect(above.frame.height).toBe(0);
      expect(below.frame.height).toBe(0);
      expect(right.frame.width).toBe(0);
    });

    it("keeps only the visible slice of a row straddling an edge", () => {
      // 140px tall, 80px of it on screen — and it must NOT share a frame with
      // the fully-off-screen row above it, which is what the old clamp produced.
      const [above, straddle] = rows([
        ["ABOVE", "[0,-400][1216,-260]"],
        ["STRADDLE", "[0,-60][1216,80]"],
      ]);
      expect(straddle.frame.y).toBe(0);
      expect(straddle.frame.height).toBeCloseTo(80 / 2688, 6);
      expect(straddle.frame).not.toEqual(above.frame);
    });

    it("never lets a frame run past the screen, so a tap centre stays on it", () => {
      for (const row of rows([
        ["ABOVE", "[0,-400][1216,-260]"],
        ["BELOW", "[0,2888][1216,3028]"],
        ["RIGHT", "[1266,400][1456,540]"],
        ["PART-RIGHT", "[1100,400][1456,540]"],
        ["VISIBLE", "[0,1000][1216,1140]"],
      ])) {
        const { x, y, width, height } = row.frame;
        expect(x + width, `${row.label}: x+width`).toBeLessThanOrEqual(1);
        expect(y + height, `${row.label}: y+height`).toBeLessThanOrEqual(1);
      }
    });

    it("leaves a fully on-screen row exactly as measured", () => {
      const [visible] = rows([["VISIBLE", "[0,1000][1216,1140]"]]);
      expect(visible.frame.y).toBeCloseTo(1000 / 2688, 6);
      expect(visible.frame.height).toBeCloseTo(140 / 2688, 6);
      expect(visible.frame.width).toBe(1);
    });
  });
});
