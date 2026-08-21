import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import type { LogStats, MessageCluster } from "../../utils/debugger/log-file-writer";
import { DEBUGGER_TOOL_CAPABILITY } from "./debugger-service-ref";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { describeReapedSession, takeReapedSession } from "../../utils/reaped-sessions";
import {
  buildNotConnected,
  classifyNotConnected,
  resolveDebuggerService,
  trackDebuggerOutcome,
  type DebuggerNotConnectedResult,
} from "./not-connected";

interface LogRegistryResponse extends LogStats {
  status: "connected";
  clusters: MessageCluster[];
  deviceName: string;
  appName: string;
  logicalDeviceId: string | undefined;
  /**
   * Why this registry is empty when it should not be — present only when the
   * previous debugger session for this device was torn down with console
   * history captured, whether by a `stop-all-simulator-servers` or by the JS
   * runtime dying. Without it an empty registry reads as "the app logged
   * nothing", which is the wrong conclusion to hand an agent debugging a silent
   * app. Names the old log file when that teardown left it on disk, which a
   * runtime death does.
   */
  note?: string;
}

/**
 * Consume the breadcrumb the previous session's dispose left, under whichever
 * of this device's ids is known here. The store files one teardown under every
 * id it answers to and spends them together, so the first hit is the answer.
 */
function takeReapedNote(ids: Array<string | undefined>): string | undefined {
  for (const id of new Set(ids.filter((id): id is string => id !== undefined))) {
    const entry = takeReapedSession("js-runtime-debugger", id);
    if (entry) return describeReapedSession(entry, "JS-runtime debugger session");
  }
  return undefined;
}

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port (ignored for Chromium)"),
  device_id: z
    .string()
    .describe(
      "Device id from list-devices — the SAME id you passed to debugger-connect (iOS simulator UDID, Android serial, Vega serial, or Chromium device id). The logicalDeviceId debugger-connect returns also resolves here, but prefer the stable list-devices id."
    ),
});

export function createDebuggerLogRegistryTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, LogRegistryResponse | DebuggerNotConnectedResult> {
  return {
    id: "debugger-log-registry",
    interaction: {
      startedMsg: () => "Reading app logs",
      completedMsg: ({ result }) =>
        result.status === "connected" ? "Read app logs" : "JavaScript debugger is not connected",
      failedMsg: ({ failureSignal }) => `Failed to read app logs: ${failureSignal.error_code}`,
    },
    description: `Get a summary of all console logs captured from the app's JS runtime.
Returns the log file path, entry counts by level, and message clusters (grouped by similarity). Works against Hermes (iOS / Android / Vega) and V8 (Chromium).
Use when investigating warnings, errors, or unexpected output — call this first for an overview, then read the returned file for details. Returns empty stats if no log data has been captured yet — but check { note }, which is present only when the stats are empty BECAUSE the previous debugger session for this device was torn down while holding captured logs, either by a stop-all-simulator-servers or by the app's JS runtime dying. When that teardown left the old log file on disk (a crash or force-quit does) the note names its path — read that file for the pre-crash logs. Absent the note, empty really does mean the app has logged nothing.
When the debugger cannot be reached, this tool does not fail: it returns { status: "not_connected", reason, detail, guidance } and no log file of its own — follow the guidance (do not retry in a loop). A crashed app reaches that state too, so check { note } there as well: when the dead session left its log file behind the note names it, and that file is readable even though the debugger is not. A "connected" result's stats may come from a session whose socket has since died — use debugger-status, not this tool, to judge debugger health.`,
    zodSchema,
    capability: DEBUGGER_TOOL_CAPABILITY,
    // Resolved manually in execute so a not-connected precondition becomes a
    // structured result instead of a service-resolution tool failure.
    services: () => ({}),
    async execute(_services, params, ctx) {
      try {
        const api = await resolveDebuggerService(registry, params);
        // Unlike debugger-status, no socket-state gate here: captured logs are
        // readable over a dead socket, and this is the tool that hands out the
        // path to read them from. Disposing the stale service would mint a new
        // session over a new path and reduce this answer to a breadcrumb, which
        // is strictly less than the caller came for.
        const stats = api.logWriter.getStats();
        const clusters = api.logWriter.getClusters(20);

        trackDebuggerOutcome("debugger-log-registry", "connected", params, ctx);
        const response: LogRegistryResponse = {
          status: "connected" as const,
          ...stats,
          clusters,
          deviceName: api.deviceName,
          appName: api.appName,
          logicalDeviceId: api.logicalDeviceId,
        };

        // Resolving the service above silently RECONNECTED if the previous
        // session had been reaped, so an empty registry here is ambiguous: the
        // app has logged nothing, or a teardown took the old log file with it,
        // or the runtime died and left that file on disk. The breadcrumb is what
        // separates the three. Only the empty case is ambiguous — a registry
        // with entries in it is reporting this session's own capture, and
        // consuming a breadcrumb there would attach a stale explanation to a
        // healthy result.
        if (stats.totalEntries === 0) {
          // `forgetDeviceAlias` runs in the same dispose that wrote the
          // breadcrumb, so by now the alias no longer joins this device's two
          // ids: the logical one has to come from the freshly resolved api,
          // which is the only thing that still knows it.
          const note = takeReapedNote([
            canonicalDeviceId(params.device_id),
            params.device_id,
            api.logicalDeviceId,
          ]);
          // The one answer that HAS a registry to account for, so the one that
          // says why this one is empty. `debugger-connect` and the
          // `not_connected` branch below report the same teardown without one.
          if (note) {
            response.note =
              `${note} This registry starts empty because a new session was minted, ` +
              `not because the app logged nothing.`;
          }
        } else if (!api.logWriter.hasFile()) {
          // The counts and clusters above are real — they are held in memory —
          // but `open()` swallows its failure and buffers, so `file` can name a
          // path that has never existed, and the documented next step is to grep
          // it.
          response.note =
            `The log file at ${stats.file} could not be created, so the entries counted here ` +
            `are only in this summary — do not try to read that path. Check that ` +
            `~/.argent/tmp is writable.`;
        }
        return response;
      } catch (err) {
        const reason = classifyNotConnected(err);
        if (!reason) throw err;
        trackDebuggerOutcome("debugger-log-registry", reason, params, ctx);
        // A crash is the ordinary way here: the app drops off Metro's target
        // list, so the resolve above throws and this is the only answer the
        // caller gets. The breadcrumb the dead session left is what names the
        // file it kept — reading it back is the whole point of keeping it, and
        // nothing later in this flow would report it: the guidance sends the
        // agent through restart-app, and a restarted app leaves no trace of the
        // one that died. No `logicalDeviceId` to add here, since resolving is
        // what just failed.
        const note = takeReapedNote([canonicalDeviceId(params.device_id), params.device_id]);
        return { ...buildNotConnected(reason, err, params), ...(note ? { note } : {}) };
      }
    },
  };
}
