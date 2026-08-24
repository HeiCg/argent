import { describe, it, expect, vi } from "vitest";

/**
 * The tool description promises that an additional-CoreSimulator-set simulator
 * (e.g. created by Radon IDE) is tagged with its owning `deviceSet` path. The
 * hand-enumerated iOS mapping must keep carrying that optional field — a
 * literal that forgets it drops the tag silently while `listIosSimulators()`
 * still returns it, which only a tool-result-level assertion can catch.
 */
vi.mock("../src/utils/ios-devices", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listIosSimulators: vi.fn(async () => [
    {
      udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      name: "iPhone 16",
      state: "Booted",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      runtimeKind: "mobile",
    },
    {
      udid: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
      name: "iPhone Air (Radon)",
      state: "Shutdown",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      runtimeKind: "mobile",
      deviceSet: "/Users/dev/Library/Caches/com.swmansion.radon-ide/Devices/iOS",
    },
  ]),
  listIosDevices: vi.fn(async () => []),
}));
vi.mock("../src/utils/adb", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listAndroidDevices: vi.fn(async () => []),
  listAvds: vi.fn(async () => []),
}));
vi.mock("../src/utils/vega-process", () => ({
  listRunningVvdConsolePorts: vi.fn(async () => new Set<number>()),
}));
vi.mock("../src/utils/sim-remote", () => ({
  simctlListDevices: vi.fn(async () => ({ devices: [] })),
}));
vi.mock("../src/utils/chromium-discovery", () => ({
  discoverChromiumDevices: vi.fn(async () => []),
}));
vi.mock("../src/utils/vega-devices", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listVegaDevices: vi.fn(async () => []),
}));

import { listDevicesTool } from "../src/tools/devices/list-devices";

describe("list-devices keeps the promised deviceSet tag on iOS entries", () => {
  it("tags an additional-set simulator with its owning device set", async () => {
    const { devices } = await listDevicesTool.execute({} as never, {} as never);
    const radon = devices.find((d) => d.platform === "ios" && d.udid.startsWith("BBBB"));
    expect(radon).toBeDefined();
    expect((radon as { deviceSet?: string }).deviceSet).toBe(
      "/Users/dev/Library/Caches/com.swmansion.radon-ide/Devices/iOS"
    );
    const defaultSet = devices.find((d) => d.platform === "ios" && d.udid.startsWith("AAAA"));
    expect((defaultSet as { deviceSet?: string }).deviceSet).toBeUndefined();
  });
});
