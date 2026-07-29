import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { ANDROID_DEVTOOLS_NAMESPACE } from "../../blueprints/android-devtools";
import { CHROMIUM_CDP_NAMESPACE } from "../../blueprints/chromium-cdp";
import { CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE } from "../../blueprints/chromium-js-runtime-debugger";
import { TV_CONTROL_NAMESPACE } from "../../blueprints/tv-control";
import { ANDROID_TV_CONTROL_NAMESPACE } from "../../blueprints/android-tv-control";
import { AX_SERVICE_NAMESPACE } from "../../blueprints/ax-service";
import { SCREEN_RECORDING_SESSION_NAMESPACE } from "../../blueprints/screen-recording-session";
import { NATIVE_PROFILER_SESSION_NAMESPACE } from "../../blueprints/native-profiler-session";
import { JS_RUNTIME_DEBUGGER_NAMESPACE } from "../../blueprints/js-runtime-debugger";
import { NETWORK_INSPECTOR_NAMESPACE } from "../../blueprints/network-inspector";
import { REACT_PROFILER_SESSION_NAMESPACE } from "../../blueprints/react-profiler-session";

/**
 * Which services one device id owns — the single definition of that mapping,
 * shared by `stop-simulator-server` (one device, transport scope) and
 * `stop-all-simulator-servers` (every device-owned service). The two tools had
 * two separate matchers that drifted apart: one was case-sensitive and blind to
 * the `:tcp` suffix, so the same udid reaped different services depending on
 * which tool the agent reached for.
 *
 * Note this unifies how a URN is matched, not how a raw id is classified:
 * `stop-simulator-server` still picks its namespace set from
 * `resolveDevice().platform`, whose prefix tests are case-SENSITIVE, so an id
 * spelled in the wrong case can still land on the wrong namespace set there.
 */

/**
 * Every discriminator a device-scoped URN appends AFTER the device id. Only
 * `:tcp` exists, and only two namespaces can ever emit it: `axServiceRef` and
 * `nativeDevtoolsRef` append it for `transport: "tcp"`. No call site passes
 * that option today — including the ios-remote branches, and the remote host's
 * forced-TCP decision is made inside the factory, after the ref has already
 * fixed the URN — so `:tcp` is a shape the refs can mint rather than one
 * production currently produces. Matched anyway so the two stop tools cannot
 * drift apart again the moment a caller does pass it.
 *
 * Enumerated rather than matched as "anything after a colon", because a device
 * id can itself end in `:<something>`: an adb serial over wifi is
 * `192.168.1.5:5555`, so a suffix wildcard would let the bare `192.168.1.5`
 * claim every device at that address and tear down another agent's — while
 * reporting nothing unmatched.
 */
const URN_SUFFIXES = ["", ":tcp"] as const;

/**
 * Namespaces whose URN interposes the Metro port between the namespace and the
 * device id: `<Namespace>:<port>:<deviceId>`. Split off from the plain shape
 * because the tail is not the device id — matching these as if it were would
 * report every debugger session as belonging to no device.
 *
 * Only the FIRST colon is consumed. The remainder is compared whole, so a
 * wireless adb serial (`JsRuntimeDebugger:8081:192.168.1.5:5555`) still
 * resolves to `192.168.1.5:5555` and not to `192.168.1.5`.
 */
const PORT_KEYED_NAMESPACES: readonly string[] = [
  JS_RUNTIME_DEBUGGER_NAMESPACE,
  // Both declare `getDependencies -> JsRuntimeDebugger:<payload>`, so neither
  // can be in a snapshot without it and neither adds any ownership the debugger
  // entry does not already establish. They are listed for what `stopped`
  // reports: a session that had a network inspector or a React profiler open is
  // told those went away by name, rather than inferring it from the debugger
  // line. `ChromiumJsRuntimeDebugger` is listed for the same reason.
  NETWORK_INSPECTOR_NAMESPACE,
  REACT_PROFILER_SESSION_NAMESPACE,
];

/**
 * Every namespace whose service belongs to exactly one device and whose
 * `dispose()` frees something worth freeing. A device owning none of these is
 * not a bad id: Vega is driven by `vega` CLI shell-outs for boot, launch,
 * describe, screenshot and the remote, so a Vega device owns a service only
 * once `debugger-connect` or a network-log tool has run — `DEBUGGER_TOOL_CAPABILITY`
 * declares `vega: { vvd: true }`, and those two namespaces (`JsRuntimeDebugger`,
 * `NetworkInspector`) are the only ones on this list a Vega serial can ever
 * match.
 *
 * Membership is decided by "does dispose() reap a resource that outlives the
 * call", and every namespace that meets that test is listed even when a cascade
 * would already have reached it. Three blueprints declare `getDependencies` —
 * NetworkInspector and ReactProfilerSession on `JsRuntimeDebugger`,
 * ChromiumJsRuntimeDebugger on `ChromiumCdp` — and teardown runs
 * dependency → dependents, so all three can arrive via a cascade. Listing them
 * is about what `stopped` names, not about whether they die: an unlisted
 * dependent is torn down silently, which contradicts what the tool documents
 * `stopped` to be.
 *
 * - `AXService` owns the in-sim ax daemon (spawned `--timeout 3600`) and its
 *   socket, and is the only entry that reaps it. An iOS session that only ran
 *   boot/launch/describe also owns `NativeDevtools` — `bootIos` and
 *   `launch-app`'s iOS handler both resolve it unconditionally — so leaving
 *   `AXService` out would not orphan the device, just that daemon.
 * - `TvControl` owns two spawned `--timeout 3600` daemons.
 * - `ScreenRecordingSession` owns an ffmpeg child, an MJPEG frame stream, and
 *   the touch-visualizer overlay it enabled on the device.
 * - `NativeProfilerSession` owns an xctrace child on iOS, and on Android an
 *   on-device perfetto process plus its trace file.
 * - `JsRuntimeDebugger` owns a bound loopback HTTP/WebSocket server, the CDP
 *   socket to Metro, and a log file handle.
 *
 * (`AndroidTvControl` is stateless adb shell-outs with a no-op dispose, but is
 * included for symmetry so the snapshot is fully drained.)
 */
export const DEVICE_OWNED_NAMESPACES: readonly string[] = [
  SIMULATOR_SERVER_NAMESPACE,
  NATIVE_DEVTOOLS_NAMESPACE,
  ANDROID_DEVTOOLS_NAMESPACE,
  CHROMIUM_CDP_NAMESPACE,
  CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE,
  TV_CONTROL_NAMESPACE,
  ANDROID_TV_CONTROL_NAMESPACE,
  AX_SERVICE_NAMESPACE,
  SCREEN_RECORDING_SESSION_NAMESPACE,
  NATIVE_PROFILER_SESSION_NAMESPACE,
  ...PORT_KEYED_NAMESPACES,
];

/**
 * The subset `stop-simulator-server` disposes: the device's transport session,
 * plus the TV-control daemons a tvOS udid may own alongside it.
 *
 * Deliberately narrower than {@link DEVICE_OWNED_NAMESPACES}. That tool is also
 * the documented recovery for a wedged transport ("stop it and retry"), and
 * widening it to devtools/AX would make a routine retry silently drop the
 * native-devtools connection another agent's in-progress recording depends on —
 * degrading that flow to coordinate taps, which is the hazard
 * `stop-all-simulator-servers`' `devices` scope exists to prevent. Agents
 * finishing a session call `stop-all-simulator-servers` instead, which drains
 * everything.
 *
 * That narrowness is only as strong as the dependency graph, and on CHROMIUM it
 * does not hold: `ChromiumJsRuntimeDebugger` declares `ChromiumCdp` as a
 * dependency, so disposing the transport tears the debugger down as a dependent
 * along with its captured console history. Nothing here can prevent that
 * without leaving the wedged transport in place, which is the tool's whole
 * purpose; `stop-simulator-server`'s description says so outright instead.
 */
export function transportNamespacesForPlatform(platform: string): readonly string[] {
  if (platform === "chromium") return [CHROMIUM_CDP_NAMESPACE];
  if (platform === "android") return [SIMULATOR_SERVER_NAMESPACE, ANDROID_TV_CONTROL_NAMESPACE];
  // A tvOS UDID is iOS-shaped and can't be told apart from a phone here without
  // an async probe, so cover both.
  return [SIMULATOR_SERVER_NAMESPACE, TV_CONTROL_NAMESPACE];
}

/**
 * The device-id portion of `urn` if it belongs to `namespace`, else undefined.
 * Accounts for the two URN shapes (see {@link PORT_KEYED_NAMESPACES}).
 */
function deviceIdPortion(urn: string, namespace: string): string | undefined {
  if (!urn.startsWith(`${namespace}:`)) return undefined;
  const tail = urn.slice(namespace.length + 1);
  if (!PORT_KEYED_NAMESPACES.includes(namespace)) return tail;
  const afterPort = tail.indexOf(":");
  return afterPort < 0 ? undefined : tail.slice(afterPort + 1);
}

/**
 * Which entry of `deviceIds` owns `urn` within `namespaces`, if any. The device
 * id is compared whole (never split on ":", see {@link URN_SUFFIXES}).
 *
 * Matching is case-insensitive: iOS UDIDs are conventionally upper-case but
 * agents pass through whatever they were given, and a case mismatch must not
 * silently turn a scoped stop into a no-op.
 *
 * That is safe only if no two distinct devices can differ by case alone. Of the
 * id spaces we support, six are structurally case-safe: iOS UDIDs (hex UUID),
 * `emulator-N`, `chromium-cdp-N`, adb-over-wifi `ip:port`, `remote:<UUID>` for
 * ios-remote, and Vega's `amazon-<hex>`. The seventh is an assumption rather
 * than a guarantee: a physical Android serial is `ro.serialno`, which
 * `device-info.ts` notes is vendor-defined and unconstrained, so a vendor could
 * in principle ship two devices differing only in case. Accepted — colliding
 * serials on ONE host would already be indistinguishable to `adb -s`, and the
 * alternative (case-sensitive matching) reintroduces the silent no-op this
 * exists to fix on the id space agents actually mistype, iOS UDIDs.
 *
 * Returns the caller's spelling of the id, so a tool can report which of the
 * ids it was given matched nothing.
 */
export function deviceIdOwningUrn(
  urn: string,
  namespaces: readonly string[],
  deviceIds: readonly string[]
): string | undefined {
  for (const namespace of namespaces) {
    const portion = deviceIdPortion(urn, namespace);
    if (portion === undefined) continue;
    const tail = portion.toLowerCase();
    const owner = deviceIds.find((id) => {
      const lower = id.toLowerCase();
      return URN_SUFFIXES.some((suffix) => tail === `${lower}${suffix}`);
    });
    // No namespace can contain ":", so at most one can prefix a given URN —
    // a miss here is a miss outright, not a reason to keep scanning.
    return owner;
  }
  return undefined;
}

/** Whether `urn` belongs to any of `namespaces`, regardless of which device. */
export function isDeviceServiceUrn(urn: string, namespaces: readonly string[]): boolean {
  return namespaces.some((ns) => urn.startsWith(`${ns}:`));
}
