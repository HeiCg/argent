import { z } from "zod";
import { ServiceState, isLiveServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { deviceIdOwningUrn, transportNamespacesForPlatform } from "./device-services";

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id (iOS UDID, Android serial, or Chromium id) whose transport session to stop"
    ),
});

export function createStopSimulatorServerTool(
  registry: Registry
): ToolDefinition<{ udid: string }, { stopped: boolean; udid: string }> {
  return {
    id: "stop-simulator-server",
    interaction: {
      startedMsg: ({ params }) => `Stopping simulator server for ${params.udid}`,
      completedMsg: ({ params }) => `Stopped simulator server for ${params.udid}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to stop simulator server for ${params.udid}: ${failureSignal.error_code}`,
    },
    description: `Stop the transport session for a specific device (iOS / Android: simulator-server process; Chromium: CDP WebSocket) and free its resources. Use when you are done interacting with one device but want to keep others running. Returns { stopped, udid }. Fails silently if no session is open for the given id.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const udid = (params as { udid: string }).udid;
      // A single device id can back more than one service: the transport
      // (SimulatorServer / ChromiumCdp) and — for a TV target — the focus-driven
      // TvControl daemon, which owns the spawned tvos-ax/tvos-hid processes.
      // Shape narrows the set; see `transportNamespacesForPlatform` for why it
      // stops there rather than draining everything this device owns.
      const platform = resolveDevice(udid).platform;
      const namespaces = transportNamespacesForPlatform(platform);

      const snapshot = registry.getSnapshot();
      let stopped = false;
      // Scanned rather than looked up by exact URN, so this agrees with
      // `stop-all-simulator-servers` on which services a device id owns: the
      // match is case-insensitive and covers the `:tcp` transport suffix, both
      // of which an exact `services.get()` silently missed.
      const urns = [...snapshot.services.keys()].filter(
        (urn) => deviceIdOwningUrn(urn, namespaces, [udid]) !== undefined
      );
      for (const urn of urns) {
        const entry = snapshot.services.get(urn);
        if (!entry || entry.state === ServiceState.IDLE) continue;
        // A non-live node (ERROR / TERMINATING) holds no running process — e.g.
        // a tvOS UDID, where the SimulatorServer blueprint throws on start and
        // the node settles into ERROR. Clean it up, but don't claim we stopped a
        // server that was never running.
        if (isLiveServiceState(entry.state)) stopped = true;
        await registry.disposeService(urn);
      }
      return { stopped, udid };
    },
  };
}
