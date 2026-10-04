import { describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";

// Flag forced ON for every test here: the open iOS server is simulator-only, so a
// physical iPhone must still be refused even when the flag is set.
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => name === "open-ios-device-server" };
});

import { shouldUseIosOpenServer } from "../src/utils/ios-open-server-input";
import { resolveDevice } from "../src/utils/device-info";

const SIMULATOR_UDID = "00000000-0000-0000-0000-000000000000";
// Modern physical-iPhone UDID shape (8 hex, dash, 16 hex).
const PHYSICAL_UDID = "00008110-000978540290401E";

describe("shouldUseIosOpenServer: simulators only", () => {
  it("is true for an iOS simulator with the flag on", () => {
    expect(shouldUseIosOpenServer(resolveDevice(SIMULATOR_UDID))).toBe(true);
  });

  it("is false for a physical iOS device with the flag on (upstream runner owns it)", () => {
    const device = resolveDevice(PHYSICAL_UDID);
    expect(device).toMatchObject({ platform: "ios", kind: "device" });
    expect(shouldUseIosOpenServer(device)).toBe(false);
  });

  it("is false for a non-iOS device", () => {
    expect(shouldUseIosOpenServer({ id: "emulator-5554", platform: "android" } as DeviceInfo)).toBe(
      false
    );
  });
});
