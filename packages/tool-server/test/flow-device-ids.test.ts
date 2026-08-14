import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { Registry } from "@argent/registry";

const invokeSubTool = vi.fn();

vi.mock("../src/utils/sub-invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/sub-invoke")>()),
  invokeSubTool: (...a: unknown[]) => invokeSubTool(...a),
}));

import { resolveFlowDevice } from "../src/tools/flows/flow-device";

/** What `list-devices` emits for a phone on `hdc` — keyed by `udid`, as iOS is. */
const HARMONY_ENTRY = {
  platform: "harmony",
  kind: "device",
  udid: "harmony-127.0.0.1:5555",
  state: "Connected",
};

/** A remote simulator: also keyed by `udid`, and also no platform a flow runs on. */
const IOS_REMOTE_ENTRY = {
  platform: "ios-remote",
  udid: "remote-6DBF83B4-0000-0000-0000-000000000000",
  state: "Shutdown",
};

describe("flow device resolution — ids of platforms no flow runs on", () => {
  it("names each device by the id it is listed under when nothing resolves", async () => {
    // The flow engine has an arm for neither platform, so this host resolves
    // nothing and the error falls back to enumerating what there is. That
    // enumeration exists to name what the caller can pass; rendering a device
    // as `?` leaves them nothing to retry with.
    invokeSubTool.mockResolvedValue({ devices: [HARMONY_ENTRY, IOS_REMOTE_ENTRY] });

    await expect(resolveFlowDevice({} as Registry, undefined, {})).rejects.toThrow(
      "Available devices: harmony-127.0.0.1:5555 (harmony, Connected), " +
        "remote-6DBF83B4-0000-0000-0000-000000000000 (ios-remote, Shutdown)."
    );
  });

  it("still refuses to run on them, rather than adopting one as the booted device", async () => {
    // Naming the id is not support: `isBooted` has an arm for neither, so such
    // an entry is never the single booted device a flow would silently target.
    invokeSubTool.mockResolvedValue({ devices: [HARMONY_ENTRY] });

    await expect(resolveFlowDevice({} as Registry, undefined, {})).rejects.toThrow(
      /No booted device found/
    );
  });
});
