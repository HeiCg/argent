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
      const hash = state.hash ?? "";
      const stateHash = state.stateHash ?? "";
      const info = await server.getInfo();

      const renderFresh = (): string => {
        const payload = buildScreenPayload(
          state.tree,
          state.info.screenWidth,
          state.info.screenHeight,
          info.currentActivity,
          stateHash
        );
        store.upsertNode({
          hash,
          compact: payload.compact,
          stateHash: payload.stateHash,
          index: payload.index,
          ...(payload.label !== undefined ? { label: payload.label } : {}),
        });
        return payload.compact;
      };

      if (tier === "summary") {
        if (!store.hasNode(hash)) renderFresh();
        const node = store.getNode(hash)!;
        const summary = buildSummary(node, store.outgoingEdges(hash), store.nodes);
        return { description: renderSummary(summary), source: "open-device-server" as const };
      }

      // tier === "compact"
      const node = store.getNode(hash);
      if (!node) {
        return { description: renderFresh(), source: "open-device-server" as const };
      }
      const { text } = await resolveCompactTier(
        node,
        { hash, stateHash },
        {
          // The keyed device `diff` needs a stored version to patch against
          // (Phase C); until then the "only text changed" case refreshes too.
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
