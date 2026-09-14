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

    it("defaults to input-manager when unset/unknown (phase 3n.1 flip)", () => {
      delete process.env[ENV_KEY];
      expect(resolveInjectStrategy()).toBe("input-manager");
      process.env[ENV_KEY] = "bogus";
      expect(resolveInjectStrategy()).toBe("input-manager");
      process.env[ENV_KEY] = "";
      expect(resolveInjectStrategy()).toBe("input-manager");
    });

    it("the `default`/`uia` sentinel selects the pre-3n.1 Kotlin DEFAULT (no inject)", () => {
      process.env[ENV_KEY] = "default";
      expect(resolveInjectStrategy()).toBeUndefined();
      process.env[ENV_KEY] = "uia";
      expect(resolveInjectStrategy()).toBeUndefined();
    });

    // Phase 3n.2 (3N1-H1): guard the fling-harness contract so a future default flip
    // cannot silently re-break the uia control arms. `bench-fling-fidelity.ts` now
    // PINS `default` on the uia arms (never deletes the env — an unset env resolves
    // to `input-manager` post-flip) and `input-manager` on the input-manager arm.
    // Assert the resolved strategy the harness's two writes produce: the uia arm
    // never resolves to `input-manager` (no `inject` on the wire), the im arm does.
    it("fling-harness contract: uia arm pins `default` (→ no inject), im arm pins `input-manager`", () => {
      // What the harness writes for a `uia-A`/`uia-B` visit:
      process.env[ENV_KEY] = "default";
      expect(resolveInjectStrategy()).toBeUndefined();
      expect(resolveInjectStrategy()).not.toBe("input-manager");
      // What the harness writes for the `input-manager` visit:
      process.env[ENV_KEY] = "input-manager";
      expect(resolveInjectStrategy()).toBe("input-manager");
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

  it("phase 3n.1: the default path sends inject:input-manager on every RPC", async () => {
    delete process.env[ENV_KEY];
    const server = {
      getScreenSize: vi.fn(async () => okSize),
      tap: vi.fn(async (..._args: unknown[]) => ({ success: true, strategy: "input-manager" })),
      swipe: vi.fn(async (..._args: unknown[]) => ({ success: true, strategy: "input-manager" })),
      gesture: vi.fn(async (..._args: unknown[]) => ({ success: true, strategy: "input-manager" })),
    };
    const reg = makeRegistry(server);
    await openServerTap(reg, device, 0.5, 0.5, 1);
    await openServerSwipe(reg, device, 0.1, 0.1, 0.1, 0.9, 10);
    await openServerGesture(reg, device, [
      { points: [{ x: 0.1, y: 0.1, tMs: 0 }, { x: 0.2, y: 0.2, tMs: 16 }] },
    ]);
    expect(server.tap.mock.calls[0]![2]).toMatchObject({ inject: "input-manager" });
    expect(server.swipe.mock.calls[0]![6]).toEqual({ inject: "input-manager" });
    expect(server.gesture.mock.calls[0]![1]).toEqual({ inject: "input-manager" });
  });

  it("the `default` sentinel omits inject entirely (pre-3n.1 Kotlin DEFAULT control block)", async () => {
    process.env[ENV_KEY] = "default";
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
