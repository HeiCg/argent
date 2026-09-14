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
  openServerTypeText,
  openServerTypeTextWithOutcome,
} from "../../../utils/open-server-input";
import { screenGraphRecordingEnabled } from "../../../utils/screen-graph-open-wiring";
import {
  isClipboardUnsupported,
  recordClipboardOutcome,
} from "../../../utils/open-server-clipboard-cache";
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
          // R3 (phase 3e): the clipboard write is silently dropped for a background
          // instrumentation on API 35, so once a device has proven it does not
          // round-trip we skip the wasted `setClipboard` RPC on every later paste
          // and go straight to typing. Only a `false` round-trip (not a transport
          // error) marks the device unsupported.
          if (!isClipboardUnsupported(device.id)) {
            const clip = await openServerSetClipboard(registry, device, params.text);
            if (clip.success) {
              recordClipboardOutcome(device.id, "ok");
              await injectAndroidKeycode(device.id, KEYCODE_PASTE);
              return { pasted: true };
            }
            // A false that carried an on-device `error` is transient — never mark
            // unsupported on it. A clean (no-error) false is the API-level clipboard
            // drop; only two CONSECUTIVE of those mark the device (R3, phase 3g), so
            // a single blip still re-probes the genuine clipboard next paste.
            recordClipboardOutcome(device.id, clip.error ? "transient" : "definitive-false");
          }
          // Clipboard unavailable from instrumentation → type it if it's typeable.
          // `assertTypeableAndroidText` throws for emoji / newlines, dropping to the
          // proprietary path (which sets the emulator clipboard over gRPC). The
          // typed fallback carries the Screen-graph Phase A before/after outcome, and
          // `secretsUsed` (set by the paste tool when the text came from a
          // `{{secret:…}}` placeholder) redacts the recorded graph node live.
          assertTypeableAndroidText(params.text);
          // Default (screen-graph off): plain `typeText` — no `outcome` request
          // leaves the host, so `runAction` is the pass-through and the typed
          // paste pays no per-action settle. The before/after outcome (and its
          // live secret redaction of the recorded node) only matters when the
          // graph is being recorded, which `screenGraphRecordingEnabled()` gates.
          if (!screenGraphRecordingEnabled()) {
            await openServerTypeText(registry, device, params.text);
            return { pasted: true };
          }
          const secretsUsed = (params as { secretsUsed?: boolean }).secretsUsed === true;
          const outcome = await openServerTypeTextWithOutcome(registry, device, params.text, {
            secretsUsed,
          });
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
