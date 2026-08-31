import type { DeviceInfo, Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isAndroidTv } from "../../../utils/adb";
import {
  injectAndroidClear,
  injectAndroidNamedKey,
  injectAndroidText,
} from "../../../utils/android-input";
import { CLEAR_KEY_PAIRS } from "../key-codes";
import type { KeyboardParams, KeyboardResult } from "../types";
import { typeTv } from "./tv";

// Phones / tablets inject over `adb shell input`, not the simulator-server's HID
// transport: the guest silently drops HID key events on `hw.keyboard = no` AVDs
// (routine for CI / headless), so the tool reported success while typing nothing
// (#449). `device.id` is the adb serial.
async function typeAndroidPhone(
  device: DeviceInfo,
  params: KeyboardParams,
  signal?: AbortSignal
): Promise<KeyboardResult> {
  // `clear` empties the field with a fixed key burst rather than typing, so it
  // returns before the `typed`/`keys` arithmetic below: there is nothing typed
  // to count and nothing to echo. `cleared` reports that the burst was SENT —
  // the field is never read back.
  if (params.clear === true) {
    await injectAndroidClear(device.id, signal);
    return { typed: "", keys: CLEAR_KEY_PAIRS * 2, cleared: true };
  }
  let keysPressed = 0;
  // `text`, `key` and `clear` are at-most-one (rejected in ../index.ts), so at
  // most one branch runs and there is no ordering to get right.
  if (params.text) {
    await injectAndroidText(device.id, params.text);
    // `injectAndroidText` rejects non-ASCII, so `.length` is the codepoint count
    // (matching the tv / simulator-server backends).
    keysPressed += params.text.length;
  }
  if (params.key) {
    await injectAndroidNamedKey(device.id, params.key);
    keysPressed++;
  }
  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

// An Android TV emulator classifies as platform "android" by serial shape, and TV
// is a `runtimeKind` rather than a `platform`, so this branch probes the kind at
// runtime and routes a TV target to the focus-driven backend.
export function makeAndroidImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    // Both sub-paths shell out to `adb` (the `isAndroidTv` probe, then `input`
    // either way), so declaring it makes a missing binary fail with
    // `dispatchByPlatform`'s 424 install hint instead of from inside the probe.
    requires: ["adb"],
    handler: async (_services, params, device, options) =>
      (await isAndroidTv(device.id))
        ? typeTv(registry, device, params)
        : typeAndroidPhone(device, params, options?.signal),
  };
}
