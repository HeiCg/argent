import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import {
  openServerTap,
  openServerSwipe,
  openServerGesture,
  resolveInjectStrategy,
} from "../src/utils/open-server-input";

const device = { id: "emulator-5554", platform: "android" } as unknown as DeviceInfo;

function makeRegistry(server: unknown): Registry {
  return {
    resolveService: vi.fn(async () => server),
  } as unknown as Registry;
}

const okSize = { screenWidth: 1080, screenHeight: 2400, displayRotation: 0 };

const ENV_KEY = "ARGENT_OPEN_INJECT_STRATEGY";

afterEach(() => {
  delete process.env[ENV_KEY];
  vi.restoreAllMocks();
});

describe("open-server inject strategy (phase 3n)", () => {
  describe("resolveInjectStrategy", () => {
    it("returns the strategy for each known value", () => {
      for (const v of ["uia-sync", "uia-async", "input-manager"] as const) {
        process.env[ENV_KEY] = v;
        expect(resolveInjectStrategy()).toBe(v);
      }
    });

    it("returns undefined when unset or unknown (default = current behaviour)", () => {
      delete process.env[ENV_KEY];
      expect(resolveInjectStrategy()).toBeUndefined();
      process.env[ENV_KEY] = "scrcpy";
      expect(resolveInjectStrategy()).toBeUndefined();
      process.env[ENV_KEY] = "";
      expect(resolveInjectStrategy()).toBeUndefined();
    });
  });

  it("threads the active strategy onto the tap RPC", async () => {
    process.env[ENV_KEY] = "input-manager";
    const server = {
      getScreenSize: vi.fn(async () => okSize),
      tap: vi.fn(async (..._args: unknown[]) => ({ success: true, strategy: "input-manager" })),
    };
    await openServerTap(makeRegistry(server), device, 0.5, 0.5, 1);
    expect(server.tap).toHaveBeenCalledTimes(1);
    expect(server.tap.mock.calls[0]![2]).toMatchObject({ inject: "input-manager" });
  });

  it("threads the active strategy onto the swipe RPC (7th arg)", async () => {
    process.env[ENV_KEY] = "uia-async";
    const server = {
      getScreenSize: vi.fn(async () => okSize),
      swipe: vi.fn(async (..._args: unknown[]) => ({ success: true, strategy: "uia-async" })),
    };
    await openServerSwipe(makeRegistry(server), device, 0.1, 0.1, 0.1, 0.9, 10);
    expect(server.swipe).toHaveBeenCalledTimes(1);
    expect(server.swipe.mock.calls[0]![6]).toEqual({ inject: "uia-async" });
  });

  it("threads the active strategy onto the gesture RPC", async () => {
    process.env[ENV_KEY] = "uia-sync";
    const server = {
      getScreenSize: vi.fn(async () => okSize),
      gesture: vi.fn(async (..._args: unknown[]) => ({ success: true, strategy: "uia-sync" })),
    };
    await openServerGesture(makeRegistry(server), device, [
      { points: [{ x: 0.1, y: 0.1, tMs: 0 }, { x: 0.2, y: 0.2, tMs: 16 }] },
    ]);
    expect(server.gesture).toHaveBeenCalledTimes(1);
    expect(server.gesture.mock.calls[0]![1]).toEqual({ inject: "uia-sync" });
  });

  it("omits inject entirely when no strategy is active (default RPC unchanged)", async () => {
    delete process.env[ENV_KEY];
    const server = {
      getScreenSize: vi.fn(async () => okSize),
      tap: vi.fn(async (..._args: unknown[]) => ({ success: true })),
      swipe: vi.fn(async (..._args: unknown[]) => ({ success: true })),
      gesture: vi.fn(async (..._args: unknown[]) => ({ success: true })),
    };
    const reg = makeRegistry(server);
    await openServerTap(reg, device, 0.5, 0.5, 1);
    await openServerSwipe(reg, device, 0.1, 0.1, 0.1, 0.9, 10);
    await openServerGesture(reg, device, [
      { points: [{ x: 0.1, y: 0.1, tMs: 0 }, { x: 0.2, y: 0.2, tMs: 16 }] },
    ]);
    expect(server.tap.mock.calls[0]![2]).not.toHaveProperty("inject");
    expect(server.swipe.mock.calls[0]![6]).not.toHaveProperty("inject");
    expect(server.gesture.mock.calls[0]![1]).not.toHaveProperty("inject");
  });

  it("a hiddenapi fallback (strategy:'unavailable') is not treated as a drop", async () => {
    process.env[ENV_KEY] = "input-manager";
    const server = {
      getScreenSize: vi.fn(async () => okSize),
      tap: vi.fn(async (..._args: unknown[]) => ({
        success: true,
        strategy: "unavailable",
        fellBackTo: "uia-async",
        injectError: "NoSuchMethodException: getInstance",
      })),
    };
    // success:true → openServerTap must resolve even though the strategy was
    // unavailable and fell back to uia-async on-device.
    await expect(openServerTap(makeRegistry(server), device, 0.5, 0.5, 1)).resolves.toBeUndefined();
  });
});
