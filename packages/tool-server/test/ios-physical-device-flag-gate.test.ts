/**
 * Regression tests for the 'ios-physical-devices' routing gate.
 *
 * Before the gate, the flag was read in exactly one functional place (the
 * list-devices discovery branch): a tool call naming a physical-shaped UDID
 * with the flag OFF still built, signed, installed and launched the runner on
 * the phone, because tools resolve `iosDeviceRunnerRef` in `services()` and the
 * registry resolves services before execute. The gate now lives in
 * `resolveDevice`'s physical arm — the narrowest waist every hardware path
 * crosses first — so this suite drives a REAL `Registry` (mirroring
 * flow-feature-flag-gate.test.ts) and proves:
 *
 *   - flag OFF → resolveDevice throws a validation FailureError carrying the
 *     enable hint, AND a stub tool wired like gesture-tap's physical arm never
 *     reaches the runner blueprint factory;
 *   - flag ON  → classification is unchanged and the same invoke goes through.
 *
 * Unit tests see the flag as ON by default (the seam in device-info.ts); each
 * case here flips it explicitly.
 */
import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import {
  FailureError,
  Registry,
  TypedEventEmitter,
  getFailureSignal,
  type DeviceInfo,
  type ServiceRef,
} from "@argent/registry";

import {
  __setIosPhysicalDevicesFlagForTests,
  classifyDevice,
  resolveDevice,
} from "../src/utils/device-info";
import { iosDeviceRunnerRef } from "../src/blueprints/ios-device-runner";

const PHYSICAL_UDID = "00008110-000978540290401E";
const SIM_UDID = "2E35A650-9618-41E1-9E8D-5E4E7CC20929";
const ENABLE_HINT = "Enable it with `argent enable ios-physical-devices`, then retry.";

// Restore the suite-wide default (ON under vitest) so per-file module isolation
// is belt-and-braces, not load-bearing.
afterEach(() => __setIosPhysicalDevicesFlagForTests(true));

/**
 * A real Registry wired like production's physical arm: the stub tool mirrors
 * gesture-tap's `services()` (resolveDevice → iosDeviceRunnerRef), and a probe
 * blueprint under the runner's namespace records whether its factory ran — the
 * observable "hardware side effect", since the real factory builds, signs and
 * installs the runner on the phone.
 */
function buildRegistry(): { registry: Registry; factory: { ran: boolean } } {
  const factory = { ran: false };
  const registry = new Registry();
  registry.registerBlueprint({
    namespace: "ios-device-runner",
    getURN: (udid: string) => `ios-device-runner:${udid}`,
    async factory() {
      factory.ran = true;
      return { api: {}, dispose: async () => {}, events: new TypedEventEmitter() };
    },
  });
  registry.registerTool<{ udid: string }, DeviceInfo>({
    id: "stub-physical-tool",
    zodSchema: z.object({ udid: z.string() }),
    services: (params): Record<string, ServiceRef> => ({
      iosDeviceRunner: iosDeviceRunnerRef(resolveDevice(params.udid)),
    }),
    async execute(_services, params) {
      return resolveDevice(params.udid);
    },
  });
  return { registry, factory };
}

describe("resolveDevice gates physical iOS UDIDs on the ios-physical-devices flag", () => {
  it("flag OFF: throws a validation FailureError with the enable hint", () => {
    __setIosPhysicalDevicesFlagForTests(false);
    let err: unknown;
    try {
      resolveDevice(PHYSICAL_UDID);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FailureError);
    expect((err as Error).message).toContain(`'${PHYSICAL_UDID}' is a physical iOS device`);
    expect((err as Error).message).toContain(ENABLE_HINT);
    expect(getFailureSignal(err)?.error_kind).toBe("validation");
  });

  it("flag OFF: simulator and Android resolution never pay the gate", () => {
    __setIosPhysicalDevicesFlagForTests(false);
    expect(resolveDevice(SIM_UDID)).toEqual({ id: SIM_UDID, platform: "ios", kind: "simulator" });
    expect(resolveDevice("emulator-5554")).toEqual({
      id: "emulator-5554",
      platform: "android",
      kind: "emulator",
    });
    // The predicates stay side-effect-free: classification alone never throws.
    expect(classifyDevice(PHYSICAL_UDID)).toBe("ios");
  });

  it("flag ON: classification is unchanged", () => {
    __setIosPhysicalDevicesFlagForTests(true);
    expect(resolveDevice(PHYSICAL_UDID)).toEqual({
      id: PHYSICAL_UDID,
      platform: "ios",
      kind: "device",
    });
  });

  it("flag OFF: a registry invoke fails at service resolution and the runner factory never runs", async () => {
    __setIosPhysicalDevicesFlagForTests(false);
    const { registry, factory } = buildRegistry();

    const err: unknown = await registry
      .invokeTool("stub-physical-tool", { udid: PHYSICAL_UDID })
      .then(
        () => {
          throw new Error("expected the gated invoke to reject");
        },
        (e: unknown) => e
      );

    // The gate fires inside `services()`, so the throw arrives wrapped but keeps
    // the hint and the validation signal on the cause chain.
    expect((err as Error).message).toContain(ENABLE_HINT);
    expect(getFailureSignal(err)?.error_kind).toBe("validation");
    // The bypass is closed: nothing touched the phone.
    expect(factory.ran).toBe(false);
  });

  it("flag ON: the same invoke resolves the runner service and executes", async () => {
    __setIosPhysicalDevicesFlagForTests(true);
    const { registry, factory } = buildRegistry();

    const result = await registry.invokeTool("stub-physical-tool", { udid: PHYSICAL_UDID });

    expect(result).toEqual({ id: PHYSICAL_UDID, platform: "ios", kind: "device" });
    expect(factory.ran).toBe(true);
  });
});
