import { describe, expect, it, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import {
  openServerTap,
  openServerSwipe,
  openServerGesture,
} from "../src/utils/open-server-input";

const device = { id: "emulator-5554", platform: "android" } as unknown as DeviceInfo;

function makeRegistry(server: unknown): Registry {
  return {
    resolveService: vi.fn(async () => server),
  } as unknown as Registry;
}

const okSize = { screenWidth: 1080, screenHeight: 2400, displayRotation: 0 };

describe("open-server input drop surfacing (R1, phase 3g)", () => {
  it("openServerTap resolves when the server reports success and no drop", async () => {
    const server = {
      getScreenSize: vi.fn(async () => okSize),
      tap: vi.fn(async () => ({ success: true })),
    };
    await expect(openServerTap(makeRegistry(server), device, 0.5, 0.5, 1)).resolves.toBeUndefined();
    expect(server.tap).toHaveBeenCalledTimes(1);
  });

  it("openServerTap throws when the on-device tap was dropped", async () => {
    const server = {
      getScreenSize: vi.fn(async () => okSize),
      tap: vi.fn(async () => ({ success: false, dropped: true })),
    };
    await expect(openServerTap(makeRegistry(server), device, 0.5, 0.5, 1)).rejects.toThrow(
      /dropped by the input dispatcher/
    );
  });

  it("openServerTap throws on a bare success:false too (defensive)", async () => {
    const server = {
      getScreenSize: vi.fn(async () => okSize),
      tap: vi.fn(async () => ({ success: false })),
    };
    await expect(openServerTap(makeRegistry(server), device, 0.5, 0.5, 1)).rejects.toThrow(
      /dropped by the input dispatcher/
    );
  });

  it("openServerSwipe throws when the swipe was dropped", async () => {
    const server = {
      getScreenSize: vi.fn(async () => okSize),
      swipe: vi.fn(async () => ({ success: false, dropped: true })),
    };
    await expect(
      openServerSwipe(makeRegistry(server), device, 0.1, 0.1, 0.1, 0.9, 10)
    ).rejects.toThrow(/swipe was dropped/);
  });

  it("openServerGesture throws when the gesture was dropped", async () => {
    const server = {
      getScreenSize: vi.fn(async () => okSize),
      gesture: vi.fn(async () => ({ success: false, dropped: true })),
    };
    await expect(
      openServerGesture(makeRegistry(server), device, [
        { points: [{ x: 0.1, y: 0.1, tMs: 0 }, { x: 0.2, y: 0.2, tMs: 16 }] },
      ])
    ).rejects.toThrow(/gesture was dropped/);
  });
});
