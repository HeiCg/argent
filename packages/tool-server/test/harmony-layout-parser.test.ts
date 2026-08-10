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
});
