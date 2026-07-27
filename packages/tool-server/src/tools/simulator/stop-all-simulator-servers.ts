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
 * Which entry of `deviceIds` owns `urn`, if any. Every URN in {@link PREFIXES}
 * is `<Namespace>:<device.id>`, optionally with a trailing transport
 * discriminator (`NativeDevtools:<udid>:tcp`). Device ids can themselves contain
 * a colon (a wireless-adb serial is `192.168.1.5:5555`), so the tail is compared
 * whole rather than split on ":".
 *
 * Returns the caller's spelling of the id so the tool can report which requested
 * ids matched nothing.
 */
function matchingDeviceId(urn: string, deviceIds: string[]): string | undefined {
  const prefix = PREFIXES.find((p) => urn.startsWith(p));
  if (!prefix) return undefined;
  // Case-insensitive: iOS UDIDs are conventionally upper-case but agents pass
  // through whatever they were given, and a case mismatch must not silently
  // widen a scoped stop into a no-op. No two distinct devices can differ only
  // by case in any id space we support (UUID, emulator-N, chromium-cdp-N).
  const tail = urn.slice(prefix.length).toLowerCase();
  return deviceIds.find((id) => {
    const lower = id.toLowerCase();
    return tail === lower || tail.startsWith(`${lower}:`);
  });
}

export function createStopAllSimulatorServersTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, { stopped: string[]; unmatched?: string[] }> {
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
Returns { stopped } - the URNs of the services that were actually live and got shut down; ERROR/TERMINATING nodes are disposed too but never appear there, so an empty \`stopped\` only means nothing was still running. { unmatched } is present ONLY when \`devices\` was supplied AND at least one of its ids owns no service at all in these namespaces - absent on an unscoped call and when every id matched - so a mistyped id, or a device NAME passed where an id was expected, does not read as a clean machine. Stopping the same device twice does not report it unmatched: ownership counts regardless of service state. Never throws.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const devices = params.devices;
      // Present-but-empty scopes to nothing rather than falling back to the
      // machine-wide sweep: a caller that computed a device list and got none
      // must not accidentally tear down every other agent's services.
      const scoped = devices !== undefined;
      const snapshot = registry.getSnapshot();
      const stopped: string[] = [];
      const matchedIds = new Set<string>();
      for (const [urn, entry] of snapshot.services) {
        const matchedId = scoped ? matchingDeviceId(urn, devices) : undefined;
        const matches = scoped ? matchedId !== undefined : PREFIXES.some((p) => urn.startsWith(p));
        // Ownership is recorded regardless of state. `disposeService` moves a
        // node to IDLE without removing it, so a device this session already
        // stopped would otherwise be reported as unmatched by the next scoped
        // call — turning the routine "stop one, then stop the rest" sequence
        // into a false alarm about a mistyped id.
        if (matchedId !== undefined) matchedIds.add(matchedId.toLowerCase());
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
      if (!scoped) return { stopped };
      // A scoped stop that named an id owning nothing is indistinguishable from
      // a clean machine unless we say so — and that id is usually a typo, or a
      // device NAME passed where an id belongs, in which case its
      // simulator-server, devtools and (on tvOS) two --timeout 3600 daemons are
      // being left running. Compared case-insensitively to match the lookup,
      // and de-duplicated so a repeated id is reported once.
      const unmatched = [...new Set(devices)].filter((id) => !matchedIds.has(id.toLowerCase()));
      return unmatched.length > 0 ? { stopped, unmatched } : { stopped };
    },
  };
}
