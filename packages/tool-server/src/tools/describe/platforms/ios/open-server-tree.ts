import type { DescribeFrame, DescribeNode } from "../../contract";
import type { IosOpenServerNode } from "../../../../utils/ios-open-server-client";

/**
 * Lower the open iOS server's nested accessibility tree (screen-point bounds,
 * `children` arrays) to the `DescribeNode` contract, the iOS counterpart of the
 * Android `openServerNestedToDescribeNode`. Bounds are normalized against the
 * screen size in points (from `getInfo` / `getScreenSize`), never against the
 * app frame.
 *
 * The XCTest element-type → AX-role map and the scroll-container set are carried
 * over verbatim from base B's `ios-device.ts`, and the Swift↔TS lockstep test
 * pins them against the runner's `scrollContainerTypes` list so they never drift.
 */

/**
 * XCTest element types mapped to the AX-style roles the describe formatter emits.
 * Unmapped types keep their XCTest name. (Base B `RUNNER_TYPE_TO_ROLE`.)
 */
export const RUNNER_TYPE_TO_ROLE: Record<string, string> = {
  Button: "AXButton",
  CheckBox: "AXButton",
  MenuItem: "AXButton",
  Cell: "AXButton",
  StaticText: "AXStaticText",
  Image: "AXImage",
  Link: "AXLink",
  TextField: "AXTextField",
  SecureTextField: "AXTextField",
  SearchField: "AXTextField",
  TextView: "AXTextField",
  TabBar: "AXTabBar",
  Switch: "AXAdjustable",
  Toggle: "AXAdjustable",
  Slider: "AXAdjustable",
  Stepper: "AXAdjustable",
  DatePicker: "AXAdjustable",
  Picker: "AXAdjustable",
  PickerWheel: "AXAdjustable",
};

/**
 * Scroll container types kept in lockstep with the Swift runner
 * `scrollContainerTypes` list. They carry no content role and stay emitted via
 * the `scrollable` flag. (Base B `SCROLL_CONTAINER_TYPES`.)
 */
export const SCROLL_CONTAINER_TYPES = new Set(["ScrollView", "Table", "CollectionView", "WebView"]);

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function lowerNode(node: IosOpenServerNode, screenW: number, screenH: number): DescribeNode {
  const w = screenW > 0 ? screenW : 1;
  const h = screenH > 0 ? screenH : 1;
  const b = node.bounds;
  const x = clamp01(b.x1 / w);
  const y = clamp01(b.y1 / h);
  const frame: DescribeFrame = {
    x,
    y,
    width: clamp01(b.x2 / w) - x,
    height: clamp01(b.y2 / h) - y,
  };

  const out: DescribeNode = {
    role: RUNNER_TYPE_TO_ROLE[node.type] ?? node.type,
    frame,
    children: node.children.map((c) => lowerNode(c, screenW, screenH)),
  };
  if (node.label) out.label = node.label;
  if (node.identifier) out.identifier = node.identifier;
  if (node.value != null && node.value !== "") out.value = String(node.value);
  if (node.focused) out.focused = true;
  if (node.selected) out.selected = true;
  if (node.enabled === false) out.disabled = true;
  if (SCROLL_CONTAINER_TYPES.has(node.type)) out.scrollable = true;
  return out;
}

/**
 * Lower the runner's nested roots to a single `DescribeNode`. The runner emits
 * one root (the Application element); when it emits more than one, they are hung
 * under a synthetic `Screen` root covering the whole screen.
 */
export function openServerIosNestedToDescribeNode(
  roots: IosOpenServerNode[],
  screenW: number,
  screenH: number
): DescribeNode {
  if (roots.length === 1) {
    return lowerNode(roots[0]!, screenW, screenH);
  }
  return {
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: roots.map((r) => lowerNode(r, screenW, screenH)),
  };
}
