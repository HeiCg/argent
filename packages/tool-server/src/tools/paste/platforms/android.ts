import type { DeviceInfo, Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../../blueprints/simulator-server";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { UnsupportedOperationError } from "../../../utils/capability";
import { isAndroidTv } from "../../../utils/adb";
import { injectAndroidKeycode } from "../../../utils/android-input";
import { setSimulatorClipboardText } from "../../../utils/simulator-client";
import { shouldUseOpenServer, openServerTypeText } from "../../../utils/open-server-input";
import type { PasteParams, PasteResult, PasteServices } from "../types";

/** `android.view.KeyEvent.KEYCODE_PASTE`. */
const KEYCODE_PASTE = 279;

/**
 * The paste keystroke goes over `adb shell input`, like the keyboard tool, because
 * the guest drops simulator-server's HID key events on `hw.keyboard = no` AVDs
 * (issue #449).
 */
export function makeAndroidImpl(
  registry: Registry
): PlatformImpl<PasteServices, PasteParams, PasteResult> {
  return {
    requires: ["adb"],
    async handler(_services, params, device: DeviceInfo) {
      // An Android TV emulator is `android` / `emulator` by serial shape, so the
      // capability matrix cannot exclude it.
      if (await isAndroidTv(device.id)) {
        throw new UnsupportedOperationError(
          "paste",
          device,
          "Android TV is focus-driven — type into the focused field with keyboard instead"
        );
      }
      // Open-device-server path: type the text via the on-device server instead
      // of setting the emulator clipboard + injecting KEYCODE_PASTE. Same field
      // result; falls back to the clipboard path on any failure.
      if (shouldUseOpenServer(device)) {
        try {
          await openServerTypeText(registry, device, params.text);
          return { pasted: true };
        } catch (err) {
          console.debug(
            `[paste.android] open-device-server typeText failed, falling back to simulator-server: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      const ref = simulatorServerRef(device);
      const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
      await setSimulatorClipboardText(api, params.text);
      await injectAndroidKeycode(device.id, KEYCODE_PASTE);
      return { pasted: true };
    },
  };
}
