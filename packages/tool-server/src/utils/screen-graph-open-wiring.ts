/**
 * Live wiring between the open-device-server action outcomes and the host screen
 * graph (ticket B2, design §2.2). Best-effort and flag-gated by `screen-graph`:
 * every entry point swallows its own errors so a graph failure never changes an
 * action's result. The store, describe rendering and the persisted graph dir are
 * only touched when the flag is on.
 *
 * On-device numbers and the versionCode / package resolution cost land in
 * Phase C; this keeps the seam minimal and one round-trip per *new* screen.
 */
import { isFlagEnabled } from "@argent/configuration-core";
import type { DeviceInfo } from "@argent/registry";
import type { OpenDeviceServerApi, OpenServerActionOutcome } from "../blueprints/android-open-server";
import { adbShell } from "./adb";
import {
  FLAG_CLICKABLE,
  FLAG_ENABLED,
  FLAG_FOCUSED,
  FLAG_SCROLLABLE,
} from "./screen-hash";
import { FLAG_PASSWORD } from "../screen-graph/types";
import { openServerElementsToDescribeNode } from "../tools/describe/platforms/android/open-server-tree";
import { formatDescribeTree } from "../tools/describe/format-tree";
import type { OpenServerElement } from "../tools/describe/platforms/android/open-server-tree";
import {
  ScreenGraphStore,
  canonicalAction,
  deriveLabel,
  recordObservation,
  selectorKeyForId,
  selectorKeyForText,
  type ActionInvocation,
  type CanonicalAction,
  type EdgeSelector,
  type FetchedScreen,
  type ScreenNode,
} from "../screen-graph";

const SCREEN_GRAPH_FLAG = "screen-graph";

/** cache: `${serial}|${pkg}` → resolved versionCode (best-effort). */
const versionCodeCache = new Map<string, string>();
/** cache: `${serial}|${pkg}|${versionCode}` → loaded store. */
const storeCache = new Map<string, Promise<ScreenGraphStore>>();

async function resolveVersionCode(serial: string, pkg: string): Promise<string> {
  const key = `${serial}|${pkg}`;
  const cached = versionCodeCache.get(key);
  if (cached !== undefined) return cached;
  let versionCode = "0";
  try {
    const out = await adbShell(serial, `cmd package list packages --show-versioncode ${pkg}`, {
      timeoutMs: 5_000,
    });
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^package:([^\s]+)(?:\s+versionCode:(\d+))?$/);
      if (m && m[1] === pkg && m[2]) {
        versionCode = m[2];
        break;
      }
    }
  } catch {
    /* older API / adb miss — key the graph by "0" */
  }
  versionCodeCache.set(key, versionCode);
  return versionCode;
}

/** Resolve (and cache) the graph store for the app currently in the foreground. */
export async function resolveStoreForCurrentApp(
  serial: string,
  server: OpenDeviceServerApi
): Promise<{ store: ScreenGraphStore; packageName: string; versionCode: string }> {
  const info = await server.getInfo();
  const pkg = info.currentPackage || "unknown";
  const versionCode = await resolveVersionCode(serial, pkg);
  const store = await getStore(serial, pkg, versionCode);
  return { store, packageName: pkg, versionCode };
}

function getStore(serial: string, pkg: string, versionCode: string): Promise<ScreenGraphStore> {
  const key = `${serial}|${pkg}|${versionCode}`;
  let store = storeCache.get(key);
  if (!store) {
    store = ScreenGraphStore.load({ packageName: pkg, versionCode });
    storeCache.set(key, store);
  }
  return store;
}

function flagsOfElement(el: OpenServerElement): number {
  let f = 0;
  if (el.clickable) f |= FLAG_CLICKABLE;
  if (el.scrollable) f |= FLAG_SCROLLABLE;
  if (el.enabled) f |= FLAG_ENABLED;
  if (el.focused) f |= FLAG_FOCUSED;
  // Phase B leftover B1: honour the device's password bit so a node carrying a
  // password field is redacted on persist (nodeHoldsSecret).
  if (el.isPassword) f |= FLAG_PASSWORD;
  return f;
}

function buildIndex(elements: OpenServerElement[]): ScreenNode["index"] {
  const index: ScreenNode["index"] = {};
  for (const el of elements) {
    const flags = flagsOfElement(el);
    const bounds = el.bounds;
    if (el.resourceId) index[selectorKeyForId(el.resourceId)] = { bounds, flags };
    const text = (el.text ?? "").trim();
    if (text) index[selectorKeyForText(text)] = { bounds, flags };
    // C.4: also index the content-description under a text key when the node has
    // no visible text, so a `navTarget` / selector that lives only in a cd (e.g.
    // an icon-only control) is still routable. A cd never overwrites a real text
    // key of the same string.
    const cd = (el.contentDesc ?? "").trim();
    if (cd && !text) {
      const key = selectorKeyForText(cd);
      if (!(key in index)) index[key] = { bounds, flags };
    }
  }
  return index;
}

/**
 * The screen's resource-id MULTISET (C.4 work item C): one entry per element that
 * carries a resource-id, WITH repeats, in tree order. This is the match key the
 * host uses to re-localize a live screen whose structural hash `H` drifted (see
 * `screen-graph/types.ts` `ScreenNode.resourceIds`).
 */
function buildResourceIds(elements: OpenServerElement[]): string[] {
  const ids: string[] = [];
  for (const el of elements) {
    const id = (el.resourceId ?? "").trim();
    if (id) ids.push(id);
  }
  return ids;
}

/** Render a screen payload (compact text + index + label) from a tree snapshot. */
export function buildScreenPayload(
  elements: OpenServerElement[],
  screenW: number,
  screenH: number,
  activity: string | undefined,
  stateHash: string,
  version?: number
): FetchedScreen {
  const tree = openServerElementsToDescribeNode(elements, screenW, screenH);
  const compact = formatDescribeTree(tree, { source: "open-device-server" });
  const index = buildIndex(elements);
  const resourceIds = buildResourceIds(elements);
  const label = deriveLabel({
    activity,
    nodes: elements.map((el) => ({ id: el.resourceId, text: el.text, bounds: el.bounds })),
    screenHeight: screenH,
  });
  return {
    compact,
    stateHash,
    ...(version !== undefined ? { version } : {}),
    index,
    resourceIds,
    ...(label !== undefined ? { label } : {}),
  };
}

/** Read the current screen and render it for insertion as a new graph node. */
async function fetchScreen(server: OpenDeviceServerApi): Promise<FetchedScreen> {
  const [state, info] = await Promise.all([
    server.getState({ includeScreenshot: false }),
    server.getInfo(),
  ]);
  return buildScreenPayload(
    state.tree,
    state.info.screenWidth,
    state.info.screenHeight,
    info.currentActivity,
    state.stateHash ?? "",
    state.version
  );
}

/**
 * Fold one open-path action outcome into the screen graph. No-op unless the
 * `screen-graph` flag is on. Never throws.
 */
export async function recordOpenServerObservation(
  device: DeviceInfo,
  server: OpenDeviceServerApi,
  size: { width: number; height: number },
  invocation: ActionInvocation,
  outcome: OpenServerActionOutcome,
  opts: { secret?: boolean; actedSelector?: EdgeSelector } = {}
): Promise<void> {
  if (!isFlagEnabled(SCREEN_GRAPH_FLAG)) return;
  try {
    const info = await server.getInfo();
    const pkg = info.currentPackage || "unknown";
    const versionCode = await resolveVersionCode(device.id, pkg);
    const store = await getStore(device.id, pkg, versionCode);
    // The graph keys nodes by H_id (phase D §1); H stays as a diagnostic field.
    const beforeId = outcome.before.idHash ?? outcome.before.hash;
    const afterId = outcome.after.idHash ?? outcome.after.hash;
    // The edge carries the acted element's selector (phase D §2): fold it into the
    // canonical action's target so planning/replay resolve by id/text, and record
    // the full selector on the edge for the content-description fallback.
    const sel = opts.actedSelector;
    const action: CanonicalAction = canonicalAction(invocation, size);
    if (sel && (action.kind === "tap" || action.kind === "longPress") && !action.target) {
      const id = sel.resourceId?.trim();
      const text = sel.text?.trim();
      if (id) action.target = { id };
      else if (text) action.target = { text };
    }
    await recordObservation({
      store,
      action,
      before: { hash: beforeId },
      after: { hash: afterId, stateHash: outcome.after.stateHash, structuralHash: outcome.after.hash },
      success: true,
      ...(sel ? { selector: sel } : {}),
      ...(opts.secret ? { secret: true } : {}),
      fetchScreen: () => fetchScreen(server),
    });
  } catch (err) {
    console.debug(
      `[screen-graph] observation skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Test-only: drop the module-level caches. */
export function __resetScreenGraphWiringForTests(): void {
  versionCodeCache.clear();
  storeCache.clear();
}
