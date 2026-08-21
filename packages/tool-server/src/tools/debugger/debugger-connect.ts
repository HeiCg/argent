import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { DEBUGGER_TOOL_CAPABILITY, debuggerServiceRef } from "./debugger-service-ref";
import { describeReapedSession, takeReapedSession } from "../../utils/reaped-sessions";

const zodSchema = z.object({
  port: z.coerce
    .number()
    .default(8081)
    .describe("Metro server port (ignored for Chromium — its CDP port is encoded in device_id)"),
  device_id: z
    .string()
    .describe(
      "Device id from list-devices: iOS simulator UDID, Android serial, Vega serial (amazon-...), or Chromium device id (chromium-cdp-<port>). Pass this SAME id as device_id to every subsequent debugger-* call to pin them to this device. The returned logicalDeviceId is informational (Metro's own per-connection handle, absent on Vega); you do not switch to it — forwarding it still resolves here, but the list-devices id is the stable one."
    ),
});

export const debuggerConnectTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    port: number;
    projectRoot: string;
    deviceName: string;
    appName: string;
    logicalDeviceId: string | undefined;
    isNewDebugger: boolean;
    connected: boolean;
    /**
     * Present only when the previous session for this device ended with the app
     * itself going away and left its console log on disk — the note names that
     * file. Reported here because this call is the prescribed recovery step
     * after a crash, and it consumes the record that names the file.
     */
    note?: string;
  }
> = {
  id: "debugger-connect",
  interaction: {
    startedMsg: () => "Connecting JavaScript debugger",
    completedMsg: ({ result }) =>
      `Connected JavaScript debugger to ${result.appName || result.deviceName}`,
    failedMsg: ({ failureSignal }) =>
      `Failed to connect JavaScript debugger: ${failureSignal.error_code}`,
  },
  description: `Connect to a JS runtime CDP debugger.
iOS / Android / Vega: connects to Metro's CDP endpoint on the given port. Chromium: re-uses the page CDP session opened by boot-device — port is ignored.
Returns connection info including port, projectRoot (empty on Chromium and on legacy Metro, e.g. Vega), deviceName, appName, logicalDeviceId (absent on Vega), and isNewDebugger. If already connected, returns the existing connection.
Also returns { note } when the PREVIOUS session for this device ended because the app went away (a crash, a force-quit, a restart-app) while holding captured console logs: that teardown left the old log file on disk and the note names its path — read that file for the pre-crash logs, because nothing else reports it.
Use when starting a debug session or before calling other debugger-* tools. Fails if the runtime is unreachable (Metro down, or Chromium CDP terminated).`,
  zodSchema,
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params) => ({
    debugger: debuggerServiceRef(params),
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    // Drop any teardown breadcrumb for this device, the way the screen-recording
    // and native-profiler starts drop theirs. Its only consumer,
    // `debugger-log-registry`, is gated on an EMPTY registry, so one left here
    // survives every read that finds entries — and then attaches "a teardown ate
    // your logs" to some later, unrelated empty read, which the tool description
    // tells the agent to trust. An explicit connect makes it wrong anyway: from
    // here the capture is this session's, so an empty registry honestly means
    // this app has logged nothing since.
    //
    // Report it first when the app went away, because then it is not only an
    // explanation: it carries the path of a log file still on disk, and this
    // call is where the agent arrives holding it. Both `debugger-status`'s
    // stale_connection guidance and the skill's crash row send it here after a
    // restart-app, and the reconnected session stops being empty — the one state
    // `debugger-log-registry` reports a breadcrumb in — as soon as the relaunched
    // app logs its first line. Dropping it silently would leave the file named by
    // nothing until the pruner reclaims it.
    //
    // Not in the blueprint's factory: that runs for an IMPLICIT resolve too —
    // `debugger-log-registry` reconnects through it — and clearing there would
    // consume the breadcrumb one line before the read that exists to report it.
    let note: string | undefined;
    for (const id of new Set(
      [params.device_id, api.logicalDeviceId].filter((v): v is string => v !== undefined)
    )) {
      // Take every id, keep the first hit: the disposer writes one event under
      // both ids this device answers to, and short-circuiting would leave the
      // other behind to explain some later, unrelated read.
      const entry = takeReapedSession("js-runtime-debugger", id);
      if (entry?.cause === "runtime-death") {
        note ??= describeReapedSession(entry, "JS-runtime debugger session");
      }
    }
    return {
      port: api.port,
      projectRoot: api.projectRoot,
      deviceName: api.deviceName,
      appName: api.appName,
      logicalDeviceId: api.logicalDeviceId,
      isNewDebugger: api.isNewDebugger,
      connected: api.cdp.isConnected(),
      ...(note ? { note } : {}),
    };
  },
};
