import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { getFailureSignal, type Registry } from "@argent/registry";

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

/**
 * A remote simulator: also keyed by `udid`. Unlike harmony a flow DOES run on
 * one — `flow-pixels` masks its status bar and a `when:` guard folds it to
 * `ios` — it is simply not auto-resolvable, since `isBooted` has no arm for it.
 */
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

  it("refuses an explicitly named harmony device instead of running into the pixel path", async () => {
    // Auto-resolution is not the only way in: an explicit `device` returns
    // before anything is listed. Without a check here the run reached the first
    // step needing pixels and died inside the simulator-server blueprint
    // factory with a bare `Error` — no `error_code`, no `failure_stage`, and
    // advice aimed at whoever wires a tool's `services()`. The invitation ships
    // with the dead end: the id is one `list-devices` hands the agent.
    invokeSubTool.mockClear();
    const err = await resolveFlowDevice({} as Registry, undefined, {
      device: HARMONY_ENTRY.udid,
    }).catch((e: unknown) => e);

    expect(getFailureSignal(err as Error)?.error_code).toBe("FLOW_DEVICE_RESOLUTION");
    expect((err as Error).message).toContain("Flows do not run on harmony devices");
    expect(invokeSubTool).not.toHaveBeenCalled();
  });

  it("does not refuse a remote simulator, which the engine does have an arm for", async () => {
    // The guard must name the platform that has no arm, not every platform
    // `list-devices` reports beside it: `ios-remote` runs a flow through the
    // whole iOS path, and refusing it here would break a supported target.
    await expect(
      resolveFlowDevice({} as Registry, undefined, {
        device: "remote:00000000-0000-0000-0000-0000000000ab",
      })
    ).resolves.toMatchObject({ platform: "ios-remote" });
  });
});
