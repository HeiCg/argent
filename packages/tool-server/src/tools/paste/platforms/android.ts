import type { DeviceInfo, Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../../blueprints/simulator-server";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { UnsupportedOperationError } from "../../../utils/capability";
import { isAndroidTv } from "../../../utils/adb";
import { injectAndroidKeycode, assertTypeableAndroidText } from "../../../utils/android-input";
import { setSimulatorClipboardText } from "../../../utils/simulator-client";
import {
  shouldUseOpenServer,
  openServerSetClipboard,
  openServerTypeTextWithOutcome,
} from "../../../utils/open-server-input";
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
      // Open-device-server path (F20). Prefer a genuine clipboard paste: set the
      // DEVICE clipboard via the on-device ClipboardManager RPC, then trigger
      // KEYCODE_PASTE — that carries arbitrary Unicode (URLs, emoji) the virtual
      // KeyCharacterMap can't type. ClipboardManager silently drops a background
      // app's write on API 35, so `setClipboard` reports whether it round-tripped;
      // when it didn't, fall back to typing the text (sendStringSync handles
      // printable ASCII — URLs, OTPs — verbatim, verified on API 35). Text that
      // can't be typed (emoji, newlines) and can't be put on the clipboard from
      // instrumentation is left to the proprietary clipboard path below.
      if (shouldUseOpenServer(device)) {
        try {
          const clipSet = await openServerSetClipboard(registry, device, params.text);
          if (clipSet) {
            await injectAndroidKeycode(device.id, KEYCODE_PASTE);
            return { pasted: true };
          }
          // Clipboard unavailable from instrumentation → type it if it's typeable.
          // `assertTypeableAndroidText` throws for emoji / newlines, dropping to the
          // proprietary path (which sets the emulator clipboard over gRPC). The
          // typed fallback carries the Screen-graph Phase A before/after outcome.
          assertTypeableAndroidText(params.text);
          const outcome = await openServerTypeTextWithOutcome(registry, device, params.text);
          return { pasted: true, outcome };
        } catch (err) {
          console.debug(
            `[paste.android] open-device-server paste failed, falling back to simulator-server: ${
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
