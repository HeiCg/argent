/**
 * Screen-graph Phase B describe tiers on the Android open path (ticket B2).
 * `summary` renders the screen graph's label + affordances; `compact` is served
 * from the node cache when the device `stateHash` still matches, else refreshed;
 * `full` and any non-open path fall back to the standard `describeAndroid`.
 *
 * Best-effort: any failure (flag off, open server unreachable, empty graph)
 * falls back to `describeAndroid`, so a tier request never regresses describe.
 */
import type { DeviceInfo, Registry } from "@argent/registry";
import { isFlagEnabled } from "@argent/configuration-core";
import type { DescribeResult } from "../../contract";
import { formatDescribeTree } from "../../format-tree";
import { openDeviceServerRef, type OpenDeviceServerApi } from "../../../../blueprints/android-open-server";
import { openDeviceServerMutex } from "../../../../utils/device-mutex";
import {
  buildScreenPayload,
  bumpSkippedNoIdHash,
  resolveStoreForCurrentApp,
} from "../../../../utils/screen-graph-open-wiring";
import {
  buildSummary,
  renderSummary,
  resolveCompactTier,
  type ScreenGraphStore,
} from "../../../../screen-graph";
import { describeAndroid } from "./index";

export type DescribeTier = "summary" | "compact" | "full";

/**
 * Tier-aware Android describe. `summary` / `compact` consult the screen graph;
 * `full` (and every failure) delegates to `describeAndroid`.
 */
export async function describeAndroidTiered(
  registry: Registry,
  device: DeviceInfo,
  tier: DescribeTier
): Promise<DescribeResult> {
  const fallback = () => describeAndroidResult(registry, device);

  // Only the open path has the hashes the graph is keyed by; `full` never uses it.
  if (tier === "full" || !isFlagEnabled("open-device-server") || !isFlagEnabled("screen-graph")) {
    return fallback();
  }

  try {
    const ref = openDeviceServerRef(device);
    return await openDeviceServerMutex.withDeviceLock(device.id, async () => {
      const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
      const { store } = await resolveStoreForCurrentApp(device.id, server);
      const state = await server.getState({ includeScreenshot: false });
      // Phase D.1 Fix B: the graph is keyed by H_id, NOT the structural hash.
      // Keying the describe tier by `state.hash` (structural) is what created the
      // pollutant duplicate nodes that made a navTarget resolve to two screens.
      const idHash = state.idHash ?? "";
      const structuralHash = state.hash ?? "";
      const stateHash = state.stateHash ?? "";
      const info = await server.getInfo();
      const version = state.version;

      // No identity hash → never key a node by the structural hash. Skip the
      // graph, count it, and serve a fresh render (no cache) this once.
      if (!idHash) {
        bumpSkippedNoIdHash();
        const payload = buildScreenPayload(
          state.tree,
          state.info.screenWidth,
          state.info.screenHeight,
          info.currentActivity,
          stateHash,
          version
        );
        return { description: payload.compact, source: "open-device-server" as const };
      }

      const renderFresh = (): string => {
        const payload = buildScreenPayload(
          state.tree,
          state.info.screenWidth,
          state.info.screenHeight,
          info.currentActivity,
          stateHash,
          version
        );
        store.upsertNode({
          hash: idHash,
          structuralHash,
          compact: payload.compact,
          stateHash: payload.stateHash,
          ...(payload.version !== undefined ? { version: payload.version } : {}),
          index: payload.index,
          ...(payload.resourceIds !== undefined ? { resourceIds: payload.resourceIds } : {}),
          ...(payload.label !== undefined ? { label: payload.label } : {}),
        });
        return payload.compact;
      };

      if (tier === "summary") {
        if (!store.hasNode(idHash)) renderFresh();
        const node = store.getNode(idHash)!;
        // Phase B leftover B1: when this screen was last rendered at a known
        // version but its state has since moved, report how many fields changed.
        // The device diff is prev→current (one retained snapshot), so this is the
        // delta of the most recent transition — exactly a summary shown on
        // arrival wants.
        let changedSince: number | undefined;
        if (node.version !== undefined && node.stateHash !== undefined && node.stateHash !== stateHash) {
          try {
            const d = await server.diff(node.version);
            changedSince = d.added.length + d.removed.length + d.changed.length;
          } catch {
            /* diff unavailable — omit changedSince rather than guess */
          }
        }
        const summary = buildSummary(node, store.outgoingEdges(idHash), store.nodes, {
          ...(changedSince !== undefined ? { changedSince } : {}),
        });
        return { description: renderSummary(summary), source: "open-device-server" as const };
      }

      // tier === "compact"
      const node = store.getNode(idHash);
      if (!node) {
        return { description: renderFresh(), source: "open-device-server" as const };
      }
      const { text } = await resolveCompactTier(
        node,
        { hash: idHash, stateHash },
        {
          // `node.version` is now stored (B1), so the "only text changed" path
          // could serve from a keyed device `diff(node.version)`. This tier
          // already fetched the full tree above (for the hash), so there is no
          // round-trip to save by patching HERE — both render from the in-hand
          // tree. The token-saving hash-only-fetch + diff-patch serve is Phase C.
          patch: async () => renderFresh(),
          refresh: async () => renderFresh(),
        }
      );
      return { description: text, source: "open-device-server" as const };
    });
  } catch (err) {
    console.debug(
      `[describe.android.tier] screen-graph tier failed, falling back: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return fallback();
  }
}

async function describeAndroidResult(registry: Registry, device: DeviceInfo): Promise<DescribeResult> {
  const data = await describeAndroid(registry, device.id, undefined, false);
  const out: DescribeResult = {
    description: formatDescribeTree(data.tree, { source: data.source }),
    source: data.source,
  };
  if (data.hint) out.hint = data.hint;
  if (data.should_restart) out.should_restart = data.should_restart;
  return out;
}
