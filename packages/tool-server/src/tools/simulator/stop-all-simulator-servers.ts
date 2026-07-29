import { z } from "zod";
import { ServiceState, isLiveServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { DEVICE_OWNED_NAMESPACES, deviceIdOwningUrn, isDeviceServiceUrn } from "./device-services";

const zodSchema = z
  .object({
    devices: z
      .array(z.string())
      .optional()
      .describe(
        "Device ids (iOS UDID / Android serial / Chromium id) to scope the teardown to — pass the devices THIS session actually used. Omit only for a deliberate machine-wide cleanup: one tool-server serves every agent using this argent install, so an unscoped stop also kills devices another agent is mid-session on."
      ),
  })
  // `.strict()` because omitting `devices` is the machine-wide sweep, so a
  // misspelled key must not be silently stripped down to it. `udids` is the
  // natural slip — every sibling tool in this directory spells the device
  // parameter `udid`, and this is the only one that spells it `devices` — and
  // under a stripping schema that typo tears down every other agent's devices
  // while the caller believes it scoped, with `unmatched` unreachable on that
  // path so nothing in the response says otherwise. Strict makes it a
  // validation error instead, matching `stop-simulator-server`, where the same
  // typo already fails loudly because `udid` is required. This also puts
  // `additionalProperties: false` in the schema advertised by `GET /tools`, so
  // MCP, `argent run` and raw HTTP callers all get the rejection.
  .strict();

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
      completedMsg: ({ result }) => {
        const n = result.stopped.length;
        const base = `Stopped ${n} simulator ${n === 1 ? "server" : "servers"}`;
        // `unmatched` is the whole point of the scoped stop: a mistyped id must
        // not read as a clean machine. Omitting it here would report exactly
        // that — "Stopped 0 simulator servers" for a teardown that reaped
        // nothing because every id was wrong.
        const unmatched = result.unmatched;
        return unmatched?.length
          ? `${base} (${unmatched.length} supplied ${unmatched.length === 1 ? "id" : "ids"} matched no service)`
          : base;
      },
      failedMsg: ({ failureSignal }) =>
        `Failed to stop simulator servers: ${failureSignal.error_code}`,
    },
    description: `Stop the services a device owns - simulator-server processes (iOS + Android), native devtools, the iOS accessibility service, TV-control daemons, Chromium CDP sessions, screen recordings, native profiler sessions, and JS-runtime debugger sessions along with the network inspectors and React profiler sessions that ride on them - freeing their spawned processes, sockets and ports. Call this when your session ends or the user says they are done.
PASS \`devices\` with the device ids this session used — one tool-server serves every agent, subagent and CLI call using this argent install, and an unscoped call tears down THEIR devices too (a mid-recording devtools teardown degrades another agent's flow to brittle coordinate taps; that agent is warned, but its recorded steps are already the worse kind). Omit \`devices\` only when a machine-wide cleanup is what you actually want. Passing an EMPTY array scopes to nothing and stops nothing - it is not a way to ask for the machine-wide sweep.
Returns { stopped } - the URNs of the services that were actually live and got shut down; an ERROR node is disposed too but never appears there, so an empty \`stopped\` only means nothing was still running. { unmatched } lists supplied ids that own no service here, so a mistyped id - or a device NAME passed where an id was expected - does not read as a clean machine. It is NOT proof the id is wrong: a Vega device is driven through CLI/adb shell-outs, so one you only booted and drove with the remote registers no service and always lands here — as does a real device of any platform this session never started anything on. Present ONLY when \`devices\` was supplied AND at least one id matched nothing - absent on an unscoped call and when every id matched. Stopping the same device twice does not report it unmatched: ownership counts regardless of service state. Never throws.`,
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
        const matchedId = scoped
          ? deviceIdOwningUrn(urn, DEVICE_OWNED_NAMESPACES, devices)
          : undefined;
        const matches = scoped
          ? matchedId !== undefined
          : isDeviceServiceUrn(urn, DEVICE_OWNED_NAMESPACES);
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
      // a clean machine unless we say so — and when that id is a typo, or a
      // device NAME passed where an id belongs, its simulator-server, devtools
      // and (on tvOS) two --timeout 3600 daemons are being left running.
      // Compared AND de-duplicated case-insensitively, to match the lookup: two
      // spellings of one id are one mistake, reported in the caller's first
      // spelling.
      const seen = new Set<string>();
      const unmatched = devices.filter((id) => {
        const key = id.toLowerCase();
        if (matchedIds.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return unmatched.length > 0 ? { stopped, unmatched } : { stopped };
    },
  };
}
