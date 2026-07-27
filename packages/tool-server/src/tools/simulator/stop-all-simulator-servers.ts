import { z } from "zod";
import { ServiceState, isLiveServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { ANDROID_DEVTOOLS_NAMESPACE } from "../../blueprints/android-devtools";
import { CHROMIUM_CDP_NAMESPACE } from "../../blueprints/chromium-cdp";
import { TV_CONTROL_NAMESPACE } from "../../blueprints/tv-control";
import { ANDROID_TV_CONTROL_NAMESPACE } from "../../blueprints/android-tv-control";

const PREFIXES = [
  `${SIMULATOR_SERVER_NAMESPACE}:`,
  `${NATIVE_DEVTOOLS_NAMESPACE}:`,
  `${ANDROID_DEVTOOLS_NAMESPACE}:`,
  `${CHROMIUM_CDP_NAMESPACE}:`,
  // The Apple TV service owns two spawned daemons (in-sim tvos-ax-service +
  // host-side tvos-hid-daemon, both --timeout 3600); only its dispose() reaps
  // them and unlinks the sockets. Without this prefix a session-end stop leaves
  // them running for up to an hour. (AndroidTvControl is stateless adb shell-outs
  // with a no-op dispose, but include it for symmetry so the snapshot is fully
  // drained.)
  `${TV_CONTROL_NAMESPACE}:`,
  `${ANDROID_TV_CONTROL_NAMESPACE}:`,
];

const zodSchema = z.object({
  devices: z
    .array(z.string())
    .optional()
    .describe(
      "Device ids (iOS UDID / Android serial / Chromium id) to scope the teardown to — pass the devices THIS session actually used. Omit only for a deliberate machine-wide cleanup: the tool-server is shared by every agent on the host, so an unscoped stop also kills devices another agent is mid-session on."
    ),
});

/**
 * Does `urn` belong to `deviceId`? Every URN in {@link PREFIXES} is
 * `<Namespace>:<device.id>`, optionally with a trailing transport discriminator
 * (`NativeDevtools:<udid>:tcp`). Device ids can themselves contain a colon (a
 * wireless-adb serial is `192.168.1.5:5555`), so the tail is compared whole
 * rather than split on ":".
 */
function urnTargetsDevice(urn: string, deviceIds: string[]): boolean {
  const prefix = PREFIXES.find((p) => urn.startsWith(p));
  if (!prefix) return false;
  const tail = urn.slice(prefix.length);
  // Case-insensitive: iOS UDIDs are conventionally upper-case but agents pass
  // through whatever they were given, and a case mismatch must not silently
  // widen a scoped stop into a no-op.
  return deviceIds.some((id) => {
    const lower = id.toLowerCase();
    const t = tail.toLowerCase();
    return t === lower || t.startsWith(`${lower}:`);
  });
}

export function createStopAllSimulatorServersTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, { stopped: string[] }> {
  return {
    id: "stop-all-simulator-servers",
    interaction: {
      // "all" only holds for the unscoped sweep; a scoped call touches just the
      // ids it was given, and saying otherwise would misreport a teardown that
      // deliberately left another agent's devices running.
      startedMsg: ({ params }) => {
        const devices = params?.devices;
        return devices
          ? `Stopping simulator servers for ${devices.length} ${devices.length === 1 ? "device" : "devices"}`
          : "Stopping all simulator servers";
      },
      completedMsg: ({ result }) =>
        `Stopped ${result.stopped.length} simulator ${result.stopped.length === 1 ? "server" : "servers"}`,
      failedMsg: ({ failureSignal }) =>
        `Failed to stop simulator servers: ${failureSignal.error_code}`,
    },
    description: `Stop running simulator-server processes (iOS + Android), native devtools services, and Chromium CDP sessions, freeing their resources. Call this when your session ends or the user says they are done.
PASS \`devices\` with the device ids this session used — the tool-server is a host-wide singleton shared with every other agent and CLI call on the machine, and an unscoped call tears down THEIR devices too (a mid-recording devtools teardown degrades another agent's flow to brittle coordinate taps, silently). Omit \`devices\` only when a machine-wide cleanup is what you actually want.
Returns { stopped } — an array of URNs that were shut down. Fails silently if no matching servers are running.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const devices = params?.devices;
      // Present-but-empty scopes to nothing rather than falling back to the
      // machine-wide sweep: a caller that computed a device list and got none
      // must not accidentally tear down every other agent's services.
      const scoped = devices !== undefined;
      const snapshot = registry.getSnapshot();
      const stopped: string[] = [];
      for (const [urn, entry] of snapshot.services) {
        const matches = scoped
          ? urnTargetsDevice(urn, devices)
          : PREFIXES.some((p) => urn.startsWith(p));
        if (matches && entry.state !== ServiceState.IDLE) {
          // Dispose any non-IDLE node (this also clears ERROR/TERMINATING
          // nodes), but only report the ones that were actually live — an
          // ERROR node (e.g. a tvOS SimulatorServer that refused to start)
          // was never a running server.
          const wasLive = isLiveServiceState(entry.state);
          await registry.disposeService(urn);
          if (wasLive) stopped.push(urn);
        }
      }
      return { stopped };
    },
  };
}
