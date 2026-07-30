import { describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import { resolveFlowDevice } from "../../src/tools/flows/flow-device";

/**
 * A physical iPhone is a listed, reachable device that the flow runner cannot
 * drive: `fetchFlowTree` sends every iOS device to the native view hierarchy,
 * and `nativeDevtoolsBlueprint` refuses `kind: "device"` because the dylib is
 * injected with `simctl spawn`. Without a check at resolution the runner accepts
 * the device and every selector step fails with a devtools error plus a
 * "restart the argent server" hint that cannot help — and auto-detection reaches
 * for the iPhone on its own, so a flow aimed at nothing in particular picks it.
 */
const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";
const SIM_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

function registryListing(devices: unknown[]): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices };
      throw new Error(`unexpected tool ${id}`);
    }),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

const physicalEntry = {
  platform: "ios",
  kind: "device",
  udid: PHYSICAL_UDID,
  state: "connected",
};
const simEntry = { platform: "ios", kind: "simulator", udid: SIM_UDID, state: "Booted" };

describe("flow device resolution rejects a physical iPhone", () => {
  it("rejects it when named explicitly, naming the reason and an alternative", async () => {
    await expect(
      resolveFlowDevice(registryListing([]), undefined, { device: PHYSICAL_UDID })
    ).rejects.toThrow(/physical iPhone/i);
    await expect(
      resolveFlowDevice(registryListing([]), undefined, { device: PHYSICAL_UDID })
    ).rejects.toThrow(/native view hierarchy/i);
  });

  it("rejects it when auto-detection picks it as the only ready device", async () => {
    // The failure mode this guards: `isBooted` counts `state: "connected"`, so a
    // connected iPhone is the single match and the run proceeds to step 1.
    await expect(
      resolveFlowDevice(registryListing([physicalEntry]), undefined, {})
    ).rejects.toThrow(/physical iPhone/i);
  });

  it("still resolves an iOS simulator (the rejection is scoped to hardware)", async () => {
    await expect(
      resolveFlowDevice(registryListing([simEntry]), undefined, { device: SIM_UDID })
    ).resolves.toMatchObject({ id: SIM_UDID, platform: "ios", kind: "simulator" });
    await expect(
      resolveFlowDevice(registryListing([simEntry]), undefined, {})
    ).resolves.toMatchObject({ id: SIM_UDID });
  });
});
