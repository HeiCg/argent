import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { ANDROID_DEVTOOLS_NAMESPACE } from "../../blueprints/android-devtools";
import { CHROMIUM_CDP_NAMESPACE } from "../../blueprints/chromium-cdp";
import { TV_CONTROL_NAMESPACE } from "../../blueprints/tv-control";
import { ANDROID_TV_CONTROL_NAMESPACE } from "../../blueprints/android-tv-control";
import { AX_SERVICE_NAMESPACE } from "../../blueprints/ax-service";

/**
 * Which services one device id owns — the single definition of that mapping,
 * shared by `stop-simulator-server` (one device, transport scope) and
 * `stop-all-simulator-servers` (every device-owned service). Two independent
 * matchers drifted apart once before: one was case-sensitive and blind to the
 * `:tcp` suffix, so the same udid reaped different services depending on which
 * tool the agent reached for.
 */

/**
 * Every discriminator a device-scoped URN appends after the device id
 * (`NativeDevtools:<udid>:tcp` and `AXService:<udid>:tcp`; every other URN in
 * {@link DEVICE_OWNED_NAMESPACES} is a bare `<Namespace>:<device.id>`).
 * Enumerated rather than matched as "anything after a colon", because a device
 * id can itself end in `:<something>`: an adb serial over wifi is
 * `192.168.1.5:5555`, so a suffix wildcard would let the bare `192.168.1.5`
 * claim every device at that address and tear down another agent's — while
 * reporting nothing unmatched.
 */
export const URN_SUFFIXES = ["", ":tcp"] as const;

/**
 * Every namespace whose service belongs to exactly one device, and whose
 * `dispose()` frees something worth freeing. A device owning none of these is
 * not a bad id — Vega is driven entirely by CLI/adb shell-outs and registers no
 * service at all.
 *
 * `AXService` is here because its `dispose()` is the only thing that reaps the
 * in-sim ax daemon (spawned `--timeout 3600`) and unlinks its socket; nothing
 * cascades from `SimulatorServer`, so an iOS session that only ran
 * boot/launch/describe owns this and nothing else. `TvControl` likewise owns two
 * spawned `--timeout 3600` daemons. (`AndroidTvControl` is stateless adb
 * shell-outs with a no-op dispose, but is included for symmetry so the snapshot
 * is fully drained.)
 */
export const DEVICE_OWNED_NAMESPACES: readonly string[] = [
  SIMULATOR_SERVER_NAMESPACE,
  NATIVE_DEVTOOLS_NAMESPACE,
  ANDROID_DEVTOOLS_NAMESPACE,
  CHROMIUM_CDP_NAMESPACE,
  TV_CONTROL_NAMESPACE,
  ANDROID_TV_CONTROL_NAMESPACE,
  AX_SERVICE_NAMESPACE,
];

/**
 * The subset `stop-simulator-server` disposes: the device's transport session,
 * plus the TV-control daemons a tvOS udid may own alongside it.
 *
 * Deliberately narrower than {@link DEVICE_OWNED_NAMESPACES}. That tool is also
 * the documented recovery for a wedged transport ("stop it and retry"), and
 * widening it to devtools/AX would make a routine retry silently drop the
 * native-devtools connection another agent's in-progress recording depends on —
 * degrading that flow to coordinate taps, which is the exact hazard
 * `stop-all-simulator-servers`' `devices` scope exists to prevent. Agents
 * finishing a session call `stop-all-simulator-servers` instead, which drains
 * everything.
 */
export function transportNamespacesForPlatform(platform: string): readonly string[] {
  if (platform === "chromium") return [CHROMIUM_CDP_NAMESPACE];
  if (platform === "android") return [SIMULATOR_SERVER_NAMESPACE, ANDROID_TV_CONTROL_NAMESPACE];
  // A tvOS UDID is iOS-shaped and can't be told apart from a phone here without
  // an async probe, so cover both.
  return [SIMULATOR_SERVER_NAMESPACE, TV_CONTROL_NAMESPACE];
}

/**
 * Which entry of `deviceIds` owns `urn` within `namespaces`, if any. The tail
 * after the namespace is compared whole (never split on ":", see
 * {@link URN_SUFFIXES}).
 *
 * Matching is case-insensitive: iOS UDIDs are conventionally upper-case but
 * agents pass through whatever they were given, and a case mismatch must not
 * silently turn a scoped stop into a no-op. No two distinct devices can differ
 * only by case in any id space we support (UUID, emulator-N, chromium-cdp-N).
 *
 * Returns the caller's spelling of the id, so a tool can report which of the
 * ids it was given matched nothing.
 */
export function deviceIdOwningUrn(
  urn: string,
  namespaces: readonly string[],
  deviceIds: readonly string[]
): string | undefined {
  const namespace = namespaces.find((ns) => urn.startsWith(`${ns}:`));
  if (namespace === undefined) return undefined;
  const tail = urn.slice(namespace.length + 1).toLowerCase();
  return deviceIds.find((id) => {
    const lower = id.toLowerCase();
    return URN_SUFFIXES.some((suffix) => tail === `${lower}${suffix}`);
  });
}

/** Whether `urn` belongs to any of `namespaces`, regardless of which device. */
export function isDeviceServiceUrn(urn: string, namespaces: readonly string[]): boolean {
  return namespaces.some((ns) => urn.startsWith(`${ns}:`));
}
