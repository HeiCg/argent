import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import {
  DEBUGGER_TOOL_CAPABILITY,
  debuggerReapedScope,
  debuggerServiceRef,
} from "./debugger-service-ref";
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
     * What became of the previous session's console history, present only when
     * that session ended with the app itself going away. Names the log file the
     * teardown left on disk, says it has since been reclaimed, or — when the
     * writer never got a file to keep — that those entries went with it.
     * Reported here because this call is the prescribed recovery step after a
     * crash, and it consumes the record that names the file.
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
Also returns { note } when the PREVIOUS session for this device ended with its runtime going away (a crash, a force-quit, a restart-app, or Metro being restarted) while holding captured console logs: the note names the log file that teardown left on disk — read it for the pre-crash logs — or says those entries are gone, because the file was reclaimed or never written. debugger-log-registry reports the same thing while its registry is still empty; this is where it surfaces once the relaunched app has logged its first line. Both tools consume the record, so whichever reads it first is the one that reports it.
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
    // restart-app, and by then `debugger-log-registry` has nothing left to
    // report: it reads a breadcrumb only from a session it could resolve and
    // found empty, or from the `not_connected` answer of one it could not
    // resolve at all — and the relaunched app is neither, the moment it logs its
    // first line. Dropping it silently would leave the file named by nothing
    // until the pruner reclaims it.
    //
    // Not in the blueprint's factory: that runs for an IMPLICIT resolve too —
    // `debugger-log-registry` reconnects through it — and clearing there would
    // consume the breadcrumb one line before the read that exists to report it.
    //
    // One lookup, on the id this call names: the store files a teardown under
    // every id its device answered to and spends them all together, and
    // `api.logicalDeviceId` is this session's, which Metro has just reissued.
    const reaped = takeReapedSession(
      "js-runtime-debugger",
      params.device_id,
      debuggerReapedScope(params)
    );
    const note =
      reaped?.cause === "runtime-death"
        ? describeReapedSession(reaped, "JS-runtime debugger session")
        : undefined;
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
