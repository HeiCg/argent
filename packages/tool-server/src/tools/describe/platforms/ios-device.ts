import type { DeviceInfo, Registry } from "@argent/registry";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../../blueprints/ios-device-runner";
import { requireCurrentIosDeviceApp } from "../../../utils/ios-device/app-session";
import {
  captureSnapshot,
  type RunnerSnapshotNode,
} from "../../../utils/ios-device/runner-commands";
import type { DescribeNode, DescribeTreeData } from "../contract";

/**
 * Physical-iOS describe: the XCUITest runner's accessibility snapshot, adapted
 * from its flat indexed node list (absolute point rects + parentIndex links)
 * into the describe contract's nested tree with 0-1 normalized frames.
 */
export async function describeIosDevice(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData> {
  const bundleId = requireCurrentIosDeviceApp(device.id);
  const ref = iosDeviceRunnerRef(device);
  const api = await registry.resolveService<IosDeviceRunnerApi>(ref.urn, ref.options);
  let { nodes, quality } = await captureSnapshot(api, bundleId);
  // Right after launch-app, XCTest can attach before the UI is fully built
  // and report a root-only tree. One short settle-and-retry recovers the
  // common case without pushing retry logic onto the agent.
  if (nodes.length <= 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    ({ nodes, quality } = await captureSnapshot(api, bundleId));
  }
  const data = adaptRunnerSnapshot(nodes);
  if (quality?.state && quality.state !== "healthy") {
    data.hint =
      `Snapshot quality: ${quality.state} (backend ${quality.backend ?? "?"}, ` +
      `reason ${quality.reasonCode ?? quality.reason ?? "?"}). The tree may be incomplete; ` +
      "retry after the UI settles, or fall back to the screenshot.";
  } else if (data.tree.children.length === 0) {
    // Downstream blind-read guards (await-ui-element, the flow tree sources)
    // key off this hint, so every childless tree, empty or root-only, carries one.
    data.hint =
      "The runner returned an empty or root-only accessibility tree. The app may still " +
      "be launching, or this screen exposes no accessibility elements.";
  }
  return data;
}

/**
 * XCUITest element types → the AX-style content roles the describe formatter
 * emits unconditionally (see format-tree.ts CONTENT_ROLES). Covers the runner's
 * interactive allowlist so icon-only Cells, compact date pickers, and valueless
 * toggles survive the formatter's content gate. The mapping is grounded in the
 * simulator trait adapter (button-ish traits → AXButton, adjustable →
 * AXAdjustable) and partially confirmed on hardware — Tables render scrollable
 * and toggles emit as AXAdjustable with values; the rest of the widget matrix
 * (icon-only Cells, compact date pickers) is unconfirmed on-device.
 * Unmapped types (Window, Other, NavigationBar, …) keep their XCTest name and
 * surface via the nested renderer's container rules — printed when labeled or
 * when they have printable descendants. SegmentedControl stays unmapped on
 * purpose: its Button children carry the interaction, and the container rule
 * emits the control itself whenever it has children.
 */
const RUNNER_TYPE_TO_ROLE: Record<string, string> = {
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

// Containers whose content scrolls. Mirrors the Swift runner's
// scrollContainerTypes (ArgentRunnerUITests/ArgentRunnerSession+Snapshot.swift)
// — keep the two lists in lockstep. These deliberately get no content role:
// `scrollable` alone keeps them emitted even unlabeled and childless, and puts
// the [scrollable] flag on the rendered line so the agent knows where a swipe
// can reveal more.
const SCROLL_CONTAINER_TYPES = new Set(["ScrollView", "Table", "CollectionView", "WebView"]);

function adaptRunnerSnapshot(nodes: RunnerSnapshotNode[]): DescribeTreeData {
  // A zero-node snapshot has no root rect to normalize against: hand back the
  // same childless Application shape a root-only snapshot adapts to.
  if (nodes.length === 0) {
    return {
      tree: { role: "Application", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] },
      source: "xcuitest-runner",
    };
  }
  // Reference frame: the shallowest node's rect (the Application root, i.e.
  // `XCUIApplication.frame`). Gesture 0-1 is inverted through the runner's
  // `viewport` command, which returns that same rect — they must stay in lockstep.
  // XCTest occasionally reports children a point outside the root, so clamp
  // into [0, 1] to satisfy the contract schema.
  const root = nodes.reduce((a, b) => (b.depth < a.depth ? b : a));
  const refW = root.rect.width > 0 ? root.rect.width : 1;
  const refH = root.rect.height > 0 ? root.rect.height : 1;

  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
  const toDescribe = (node: RunnerSnapshotNode): DescribeNode => {
    const x = clamp01((node.rect.x - root.rect.x) / refW);
    const y = clamp01((node.rect.y - root.rect.y) / refH);
    return {
      role: RUNNER_TYPE_TO_ROLE[node.type] ?? node.type,
      frame: {
        x,
        y,
        width: clamp01((node.rect.x - root.rect.x + node.rect.width) / refW) - x,
        height: clamp01((node.rect.y - root.rect.y + node.rect.height) / refH) - y,
      },
      children: [],
      ...(node.label ? { label: node.label } : {}),
      ...(node.identifier ? { identifier: node.identifier } : {}),
      ...(node.value != null ? { value: String(node.value) } : {}),
      ...(node.focused ? { focused: true } : {}),
      ...(node.selected ? { selected: true } : {}),
      ...(node.enabled === false ? { disabled: true } : {}),
      ...(SCROLL_CONTAINER_TYPES.has(node.type) ? { scrollable: true } : {}),
    };
  };

  const describeByIndex = new Map<number, DescribeNode>();
  for (const node of nodes) describeByIndex.set(node.index, toDescribe(node));
  const rootDescribe = describeByIndex.get(root.index)!;
  for (const node of nodes) {
    if (node.index === root.index) continue;
    const parent =
      (node.parentIndex != null ? describeByIndex.get(node.parentIndex) : undefined) ??
      rootDescribe;
    parent.children.push(describeByIndex.get(node.index)!);
  }

  return {
    tree: rootDescribe,
    source: "xcuitest-runner",
    screen: { width: refW, height: refH },
  };
}
