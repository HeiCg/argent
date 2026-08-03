import { FAILURE_CODES, getFailureSignal, type DeviceInfo, type Registry } from "@argent/registry";
import {
  buildAppStateMessage,
  isInjectableBundleId,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
} from "../../blueprints/native-devtools";
import {
  resolveNativeTargetApp,
  type ResolvedNativeTargetApp,
} from "../../utils/native-target-app";
import { flattenHoisting, type FlatNode } from "./flow-tree-flatten";
import {
  type DescribeFrame,
  type DescribeNode,
  type DescribeTreeData,
  parseDescribeResult,
} from "../describe/contract";

/**
 * Flow-owned iOS tree source (see `flow-tree.ts` for the per-platform dispatch).
 *
 * On iOS, flows resolve selectors against the native UIView hierarchy
 * (`ViewHierarchy.getFullHierarchy`) rather than the AX tree the agent-facing
 * `describe` uses. Unlike the AX tree and `describeScreen` — both of which walk
 * the *accessibility* tree and collapse an `accessible` container into a single
 * leaf (VoiceOver semantics) — the full hierarchy walks the raw UIView tree and
 * carries every view's `accessibilityIdentifier` (React Native `testID`). That
 * lets a flow address a container by its testID *and* its children
 * independently, with no `accessible` prop required.
 *
 * This lives under flows/ (not the describe layer) on purpose: it's a flow-only
 * concern, and the describe path is untouched. When native-devtools is
 * unavailable it throws rather than letting the caller degrade to the AX tree —
 * see `fetchFlowTree` for why a silent fallback would flip flow outcomes.
 */

// ── getFullHierarchy → DescribeNode adapter ──────────────────────────────────

interface RawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RawViewNode {
  className?: string;
  identifier?: string;
  label?: string;
  frame?: RawRect;
  windowFrame?: RawRect;
  hidden?: boolean;
  alpha?: number;
  firstResponder?: boolean;
  children?: RawViewNode[];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundNormalized(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asRect(v: unknown): RawRect | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const x = finiteNumber(r.x);
  const y = finiteNumber(r.y);
  const width = finiteNumber(r.width);
  const height = finiteNumber(r.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asViewNode(v: unknown): RawViewNode | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const children = Array.isArray(r.children)
    ? r.children.map(asViewNode).filter((n): n is RawViewNode => n !== null)
    : undefined;
  return {
    className: nonEmptyString(r.className),
    identifier: nonEmptyString(r.identifier),
    label: nonEmptyString(r.label),
    frame: asRect(r.frame),
    windowFrame: asRect(r.windowFrame),
    hidden: typeof r.hidden === "boolean" ? r.hidden : undefined,
    alpha: finiteNumber(r.alpha),
    firstResponder: r.firstResponder === true ? true : undefined,
    children,
  };
}

// Best-effort role from the UIView class name (the full hierarchy carries no
// accessibility traits). Selectors lean on text/identifier, so a coarse mapping
// is enough; unknowns fall back to a generic group.
function roleFromClassName(cn: string | undefined): string {
  if (!cn) return "AXGroup";
  if (/Button/i.test(cn)) return "AXButton";
  if (/(TextField|TextView|SearchField)/i.test(cn)) return "AXTextField";
  if (/(Label|Text)/i.test(cn)) return "AXStaticText";
  if (/Image/i.test(cn)) return "AXImage";
  if (/(Slider|Stepper|Switch|ProgressView)/i.test(cn)) return "AXAdjustable";
  if (/(ScrollView|TableView|CollectionView)/i.test(cn)) return "AXScrollArea";
  return "AXGroup";
}

function normalizeFrame(rect: RawRect, screenW: number, screenH: number): DescribeFrame | null {
  if (screenW <= 0 || screenH <= 0) return null;
  const x1 = clamp01(rect.x / screenW);
  const y1 = clamp01(rect.y / screenH);
  const x2 = clamp01((rect.x + rect.width) / screenW);
  const y2 = clamp01((rect.y + rect.height) / screenH);
  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 0 || height <= 0) return null;
  return {
    x: roundNormalized(x1),
    y: roundNormalized(y1),
    width: roundNormalized(width),
    height: roundNormalized(height),
  };
}

/**
 * Project a UIView node for the shared flatten (see `flow-tree-flatten`). A view
 * is emitted as a leaf when it carries an `identifier` (React Native `testID`),
 * a `label`, or a specific semantic role — or is the first responder, which the
 * type directive's focus wait reads — and has an on-screen frame;
 * hidden/transparent subtrees are skipped; an identified node shields its text
 * so hoisting scopes to the nearest identified ancestor. Its own text is just
 * its label.
 */
function projectIosNode(
  node: RawViewNode,
  screenW: number,
  screenH: number
): FlatNode<RawViewNode> {
  // Skip an invisible subtree entirely — its descendants are off-screen too.
  const skip = node.hidden === true || (node.alpha !== undefined && node.alpha < 0.01);
  const role = roleFromClassName(node.className);

  // Scroll-clip inputs (see `flattenHoisting`): a UIScrollView's window frame
  // clips its subtree, so a row it has scrolled out of its viewport — still
  // inside the device screen — is dropped, matching the AX describe path,
  // which never reports scroll-clipped elements. Window-space only: `frame`
  // is parent-local, so falling back to it (as the leaf frame may) would
  // compare rects across coordinate spaces and mis-prune; without a
  // `windowFrame` the node is simply never scroll-pruned and, if a scroller,
  // imposes no clip.
  const win = node.windowFrame;
  const rect = win ? { x: win.x, y: win.y, w: win.width, h: win.height } : null;

  let leaf: DescribeNode | null = null;
  let frame: DescribeFrame | null = null;
  if (!skip && (node.identifier || node.label || role !== "AXGroup" || node.firstResponder)) {
    const leafRect = node.windowFrame ?? node.frame;
    frame = leafRect ? normalizeFrame(leafRect, screenW, screenH) : null;
    if (frame) {
      leaf = {
        role,
        frame,
        children: [],
        label: node.label,
        identifier: node.identifier,
        focused: node.firstResponder || undefined,
      };
    }
  }

  return {
    skip,
    children: node.children ?? [],
    // Text hoists only from on-screen nodes (frame is null when the view is
    // scrolled off or zero-area) — otherwise a text assert against an ancestor
    // would pass on content the screen doesn't show. Every labelled node is
    // leaf-eligible, so `frame` was computed for any node with text.
    ownText: frame ? (node.label ?? "") : "",
    leaf,
    shield: Boolean(node.identifier),
    rect,
    scrolls: role === "AXScrollArea",
  };
}

/**
 * Flatten a `getFullHierarchy` payload into the flat-leaves-under-one-root shape
 * the other describe adapters emit, keeping only views with an `identifier`,
 * `label`, or specific semantic role and an on-screen frame. Pure layout
 * containers are dropped, which keeps the tree comparable in size to the
 * accessibility tree while preserving the children an `accessible` ancestor
 * would otherwise have hidden.
 */
export function adaptFullHierarchyToDescribeResult(raw: unknown): DescribeNode {
  return adaptFullHierarchy(raw).tree;
}

/**
 * Like {@link adaptFullHierarchyToDescribeResult}, but also reports the screen
 * size (points) the frames were normalized against — the rotate directive's
 * physical-circle geometry needs the aspect ratio.
 */
export function adaptFullHierarchy(raw: unknown): {
  tree: DescribeNode;
  screen?: { width: number; height: number };
} {
  const windows =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { windows?: unknown }).windows)
      ? (raw as { windows: unknown[] }).windows
          .map(asViewNode)
          .filter((n): n is RawViewNode => n !== null)
      : [];

  // The screen size is the largest window frame — the key window spans the
  // screen, so its width/height are the normalization denominators.
  let screenW = 0;
  let screenH = 0;
  for (const win of windows) {
    const rect = win.frame ?? win.windowFrame;
    if (rect) {
      screenW = Math.max(screenW, rect.width);
      screenH = Math.max(screenH, rect.height);
    }
  }

  const children: DescribeNode[] = [];
  if (screenW > 0 && screenH > 0) {
    for (const win of windows) {
      flattenHoisting(win, (n) => projectIosNode(n, screenW, screenH), children);
    }
  }

  const tree = parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
  return screenW > 0 && screenH > 0
    ? { tree, screen: { width: screenW, height: screenH } }
    : { tree };
}

// ── Fetch ────────────────────────────────────────────────────────────────────

/** Fields requested from getFullHierarchy — the minimum to flatten + match. */
const FULL_HIERARCHY_FIELDS = [
  "className",
  "identifier",
  "label",
  "frame",
  "windowFrame",
  "hidden",
  "alpha",
  // The type directive's focus wait; an older injected framework ignores the
  // request, which just leaves the wait's poll unconfirmed.
  "firstResponder",
];

/**
 * Why the app a flow launched serves no view hierarchy, for the case where
 * nothing at all is connected.
 *
 * An app that can never load the dylib is terminal and must be said so: no
 * relaunch and no tool-server restart changes it, and the measured states would
 * all offer one of those (the launchd env carrying the bootstrap dylib is
 * simulator-wide, so the process inherits the injection tokens the measurement
 * reads and can score as merely `unregistered`). Selector resolution is the
 * point at which that impossibility actually bites — the launch gate lets these
 * apps through precisely so a coordinate-driven flow still runs — so this is
 * where the flow author is told, with the remedy that exists at flow level.
 *
 * Everything else is measured off the running process, and a rejection degrades
 * to the state that says exactly that, as the other consumers do: the call
 * re-applies the launchd env before it measures anything, so a sim that goes
 * away mid-run rejects here, and a raw simctl subprocess error carries none of
 * the guidance the diagnosis does.
 */
async function unreadableHierarchyReason(
  nativeApi: NativeDevtoolsApi,
  bundleId: string
): Promise<string> {
  if (!isInjectableBundleId(bundleId)) {
    return (
      `${bundleId} is an Apple system app: it is a platform binary with library validation, so ` +
      `argent's native devtools cannot be relied on to inject into it, and without them a flow has ` +
      `no view hierarchy to resolve selectors against. Replace the selector steps with coordinate ` +
      `ones (\`tool: gesture-tap\` with x/y, read off a \`screenshot\`), or target an app argent installs.`
    );
  }
  const state = await nativeApi.appConnectionState(bundleId).catch(() => "indeterminate" as const);
  if (state === "connected") {
    // Measured connected while auto-targeting found nothing: the connection
    // arrived in between. Nothing to diagnose — say what failed and let the
    // caller's retry loop take the next read.
    return `native devtools reported no connected app when this tree was read, though ${bundleId} is connected now — retry.`;
  }
  // The diagnosis already names the corrective action, and for `unregistered`
  // that action is a tool-server restart — telling a flow author to relaunch
  // there sends them round a loop the app cannot exit.
  return `${buildAppStateMessage(bundleId, state)} Flows resolve selectors against the full view hierarchy native devtools serve.`;
}

/**
 * Query the raw UIView tree via native-devtools `getFullHierarchy` and adapt
 * it. Throws — with the reason — when native-devtools is unavailable / not yet
 * connected / errored: flows never degrade to the AX tree (see
 * `fetchFlowTree`), so the caller's retry loop either rides out a transient
 * failure or surfaces this message as the step's failure reason.
 *
 * `launchedBundleId` is the app the run's `launch` step started, when it had
 * one. Auto-targeting cannot name an app that is not connected, and those are
 * exactly the cases worth explaining, so this id is what the explanation is
 * measured for.
 */
export async function queryFullHierarchyTree(
  registry: Registry,
  device: DeviceInfo,
  launchedBundleId?: string
): Promise<DescribeTreeData> {
  let nativeApi: NativeDevtoolsApi;
  try {
    const ndRef = nativeDevtoolsRef(device);
    nativeApi = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
  } catch (err) {
    throw new Error(
      `native devtools is unavailable (${errMsg(err)}) — flows resolve selectors against the full view hierarchy it serves`,
      { cause: err }
    );
  }
  // resolveNativeTargetApp's own errors (ambiguous frontmost, a lone connected
  // app that isn't foreground-like) already carry the actionable next step, so
  // they propagate unwrapped. `NO_CONNECTED_APPS` is the exception, and the
  // only one that can be improved on: auto-targeting draws its candidates from
  // `listConnectedBundleIds`, which is the same map `appConnectionState` reads
  // to answer `connected` — so *every* state that explains a missing connection
  // lands here, and its stock "Launch or restart the app first" is the restart
  // loop this measurement exists to break. A flow that launched an app knows
  // which one, and that id does not come from the connections map, so it
  // survives the disconnection the auto-target could not describe.
  let target: ResolvedNativeTargetApp;
  try {
    target = await resolveNativeTargetApp(nativeApi, undefined);
  } catch (err) {
    if (
      launchedBundleId === undefined ||
      getFailureSignal(err)?.error_code !== FAILURE_CODES.NATIVE_TARGET_NO_CONNECTED_APPS
    ) {
      throw err;
    }
    throw new Error(await unreadableHierarchyReason(nativeApi, launchedBundleId), { cause: err });
  }

  const rawResult = (await nativeApi.queryViewHierarchy(
    target.bundleId,
    "ViewHierarchy.getFullHierarchy",
    {
      fields: FULL_HIERARCHY_FIELDS,
      maxDepth: 40,
    }
  )) as { windows?: unknown[]; error?: string };

  if (rawResult.error) {
    throw new Error(`getFullHierarchy failed for ${target.bundleId}: ${rawResult.error}`);
  }

  const { tree, screen } = adaptFullHierarchy(rawResult);
  return { tree, source: "native-devtools", ...(screen ? { screen } : {}) };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
