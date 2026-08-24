import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveDevice } from "./device-info";
import { resolveAndroidBinary } from "./android-binary";
import { simctlArgsForUdid } from "./ios-device-sets";

const execFileAsync = promisify(execFile);

/**
 * Shut down a device that Argent Lens booted itself (see
 * `VariantProposalStore.takeOwnedDevices`). Best-effort: a device that's
 * already gone, or a CLI that isn't on PATH, must not break session teardown.
 */
export async function shutdownOwnedDevice(id: string): Promise<void> {
  let device: { platform: string; kind: string };
  try {
    device = resolveDevice(id);
  } catch {
    return;
  }
  const { platform } = device;
  // `kind: "device"` is a physical phone on either platform: argent never booted
  // it, so it is not ours to power off, and neither backend could anyway —
  // `simctl shutdown` only knows simulator UDIDs, and `adb emu kill` only
  // emulator consoles. Same split `shutdownDevice` reports on below.
  if (device.kind === "device") return;
  if (platform === "ios") {
    await execFileAsync("xcrun", await simctlArgsForUdid(id, ["shutdown", id])).catch(() => {});
  } else if (platform === "android") {
    // adb often isn't on PATH (notably on Windows); resolveAndroidBinary falls
    // back to the SDK roots.
    const adb = (await resolveAndroidBinary("adb")) ?? "adb";
    await execFileAsync(adb, ["-s", id, "emu", "kill"]).catch(() => {});
  }
}

export async function shutdownOwnedDevices(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => shutdownOwnedDevice(id)));
}

export interface ShutdownResult {
  ok: boolean;
  /** Present when ok=false — human-readable reason for the UI. */
  error?: string;
}

/**
 * Shut down a running device by id, surfacing the outcome — unlike the
 * best-effort {@link shutdownOwnedDevice}, which swallows every error for
 * session teardown. Backs the preview window's right-click "Shut down" action,
 * so the UI can report why a shutdown failed.
 *
 * iOS simulator → `simctl shutdown`; Android emulator → `adb -s <serial> emu
 * kill`. A physical phone (iOS or Android) can't be shut down remotely, and
 * Chromium / Vega have no equivalent — those are rejected with a reason.
 */
export async function shutdownDevice(id: string): Promise<ShutdownResult> {
  let device: { platform: string; kind: string };
  try {
    device = resolveDevice(id);
  } catch {
    return { ok: false, error: `Unknown device "${id}".` };
  }
  try {
    if (device.platform === "ios" && device.kind !== "device") {
      await execFileAsync("xcrun", await simctlArgsForUdid(id, ["shutdown", id]));
      return { ok: true };
    }
    if (device.platform === "android" && device.kind === "emulator") {
      const adb = (await resolveAndroidBinary("adb")) ?? "adb";
      await execFileAsync(adb, ["-s", id, "emu", "kill"]);
      return { ok: true };
    }
    // A physical phone on either platform. This function is total over what
    // `resolveDevice` can return, so it answers for a hardware udid even though
    // the preview — its only caller — filters those out of the device list it
    // validates against before ever calling here.
    if (device.kind === "device") {
      return {
        ok: false,
        error: `A physical ${device.platform === "ios" ? "iPhone" : "Android device"} can't be shut down remotely.`,
      };
    }
    return { ok: false, error: `Shutting down ${device.platform} devices isn't supported.` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
