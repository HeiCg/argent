import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { harmonyConnectKey } from "../../../utils/device-info";
import { openHarmonyUrl } from "../../../utils/harmony-apps";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "../types";
import { httpDeepLinkNote } from "../deep-link-note";

/**
 * `aa start -U <uri>` is HarmonyOS' implicit open — the system picks the
 * handler, which is exactly what this tool wants (and the one place implicit
 * start is the right verb; see `harmony-apps`).
 *
 * A **custom scheme** with no registered handler is caught: `aa` prints
 * `10103101 Failed to find a matching application for implicit launch`, which
 * `openHarmonyUrl` turns into a throw. (It also leaves a "No options to open
 * with" chooser on the device, which the thrown message says.)
 *
 * A **web URL** is not, and cannot be. Measured on HarmonyOS 6.0.1: `aa start
 * -U https://example.com` prints `start ability successfully.` and the
 * foreground app does not change — no browser opens, no chooser appears, and
 * nothing on the device distinguishes that from a handled link. So the caveat is
 * stated rather than papered over; `opened: true` here means "the system
 * accepted the URI", which on this platform is weaker than it sounds.
 */
const HARMONY_WEB_URL_CAVEAT =
  "On HarmonyOS specifically, `aa start -U` reports success for a web URL even when nothing " +
  "opens it — a device with no browser registered for https shows no chooser and stays on the " +
  "current screen. Confirm with describe or screenshot before treating the link as followed.";

export const harmonyImpl: PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> = {
  requires: ["hdc"],
  handler: async (_services, params, device) => {
    await openHarmonyUrl(harmonyConnectKey(device.id), params.url);
    const shared = httpDeepLinkNote(params.url);
    return {
      opened: true,
      url: params.url,
      note: shared ? `${shared} ${HARMONY_WEB_URL_CAVEAT}` : undefined,
    };
  },
};
