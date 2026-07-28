import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveDevice } from "./device-info";
import { resolveAndroidBinary } from "./android-binary";

const execFileAsync = promisify(execFile);

/**
 * Shut down a device that Argent Lens booted itself (see
 * `VariantProposalStore.takeOwnedDevices`). Best-effort: every failure is
 * swallowed — a device that's already gone, or a CLI that isn't on PATH, must
 * not break session teardown.
 *
 * iOS → `simctl shutdown`; Android emulator → `adb -s <serial> emu kill`.
 * Chromium / Vega are never owned by `/preview/boot` (the preview only streams
 * iOS / Android), so they're left untouched.
 */
export async function shutdownOwnedDevice(id: string): Promise<void> {
  let device: { platform: string; kind: string };
  try {
    device = resolveDevice(id);
  } catch {
    return;
  }
  const { platform } = device;
  // `kind: "device"` on iOS is a physical iPhone: it is not ours to power off,
  // and `simctl shutdown` only knows simulator UDIDs — same reason the Android
  // arm below is scoped to emulators.
  if (platform === "ios" && device.kind !== "device") {
    await execFileAsync("xcrun", ["simctl", "shutdown", id]).catch(() => {});
  } else if (platform === "android") {
    // Resolve adb like every other android path (SDK fallback off-PATH — on
    // Windows adb usually isn't on PATH at all); bare "adb" as a last resort.
    const adb = (await resolveAndroidBinary("adb")) ?? "adb";
    await execFileAsync(adb, ["-s", id, "emu", "kill"]).catch(() => {});
  }
}

/** Shut down every owned device, in parallel, swallowing individual failures. */
export async function shutdownOwnedDevices(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => shutdownOwnedDevice(id)));
}

export interface ShutdownResult {
  ok: boolean;
  /** Present when ok=false — a human-readable reason to surface in the UI. */
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
      await execFileAsync("xcrun", ["simctl", "shutdown", id]);
      return { ok: true };
    }
    if (device.platform === "android" && device.kind === "emulator") {
      const adb = (await resolveAndroidBinary("adb")) ?? "adb";
      await execFileAsync(adb, ["-s", id, "emu", "kill"]);
      return { ok: true };
    }
    // A physical phone reaches here on either platform. Without the `kind`
    // guard above, an iPhone would run `simctl shutdown <ECID-udid>` and the UI
    // would show simctl's raw "Invalid device" instead of the real reason.
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
