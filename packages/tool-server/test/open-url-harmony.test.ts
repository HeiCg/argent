import { describe, it, expect, vi, beforeEach } from "vitest";
import { FAILURE_CODES, FailureError, type DeviceInfo } from "@argent/registry";

// harmonyImpl's only device work is `openHarmonyUrl`, whose own reading of `aa`
// stdout is covered in harmony-apps.test.ts. Stub it at the module boundary so
// these tests are about what the platform impl builds on top: the note, and the
// arguments it hands down.
const openHarmonyUrlMock = vi.fn();
vi.mock("../src/utils/harmony-apps", async () => {
  const actual = await vi.importActual<object>("../src/utils/harmony-apps");
  return { ...actual, openHarmonyUrl: (...args: unknown[]) => openHarmonyUrlMock(...args) };
});

import { httpDeepLinkNote } from "../src/tools/open-url/deep-link-note";
import { harmonyImpl } from "../src/tools/open-url/platforms/harmony";

// A real handset id: the `harmony-` prefix is the registry's, the serial behind
// it is what `hdc` accepts as a connect key.
const CONNECT_KEY = "025DEK236V035771";
const device = {
  id: `harmony-${CONNECT_KEY}`,
  platform: "harmony",
  kind: "device",
} as unknown as DeviceInfo;

beforeEach(() => {
  openHarmonyUrlMock.mockReset();
  openHarmonyUrlMock.mockResolvedValue(undefined);
});

describe("open-url HarmonyOS handler surfaces the caveat only for web URLs", () => {
  it("attaches note for an https URL, appended to the shared web-URL note", async () => {
    const url = "https://bsky.app/profile/tvpworld.bsky.social";
    const res = await harmonyImpl.handler({}, { udid: device.id, url }, device);

    expect(res.opened).toBe(true);
    expect(res.url).toBe(url);
    // The HarmonyOS caveat extends the shared note rather than replacing it —
    // both halves are load-bearing, and on this platform the caveat is the only
    // signal that `opened: true` may mean nothing happened on screen.
    expect(res.note).toContain(httpDeepLinkNote(url));
    expect(res.note).toMatch(/aa start -U. reports success for a web URL even when nothing opens/);
    expect(res.note?.startsWith(httpDeepLinkNote(url)!)).toBe(true);
    // No stray separator or stringified `undefined` from the composition.
    expect(res.note).not.toMatch(/undefined|^\s|\s\s|\s$/);
    // hdc gets the connect key, not the prefixed registry id, and the URL is
    // handed down unchanged.
    expect(openHarmonyUrlMock).toHaveBeenCalledWith(CONNECT_KEY, url);
  });

  it("omits note for a custom-scheme deep link", async () => {
    const res = await harmonyImpl.handler(
      {},
      { udid: device.id, url: "bluesky://profile/x" },
      device
    );
    expect(res.opened).toBe(true);
    // A custom scheme no app claims fails loudly on HarmonyOS (10103101), so
    // there is nothing here for a caveat to hedge about.
    expect(res.note).toBeUndefined();
  });

  it("propagates a device-side failure instead of resolving with a note", async () => {
    openHarmonyUrlMock.mockRejectedValue(
      new FailureError(
        `HarmonyOS device '${CONNECT_KEY}' could not open 'nope://x': Error Code:10103101 ` +
          `Error Message:Failed to find a matching application for implicit launch.`,
        {
          error_code: FAILURE_CODES.HARMONY_ABILITY_START_FAILED,
          failure_stage: "harmony_open_url",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
      )
    );
    await expect(
      harmonyImpl.handler({}, { udid: device.id, url: "nope://x" }, device)
    ).rejects.toThrow(/10103101/);
  });
});
