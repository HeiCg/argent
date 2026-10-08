import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import {
  openServerTap,
  setOpenServerTapTiming,
  takeOpenServerTapStages,
  __resetOpenServerScreenSizeCache,
} from "../src/utils/open-server-input";

// Step tap-latency (plan close-gaps-2026-10 item 6): the open tap is 1.5 ms slower
// than the official stack (54.4 vs 52.9 ms, CI [1.1, 2.0]) in three runs and was
// never explained. The bench turns tap timing on for its ON blocks and reads the
// stages of each timed tap after the timed window, so the next run can say where the
// 1.5 ms goes: the pre-tap screen-size read, the tap RPC on the wire, or the device.

const device = { id: "emulator-5554", platform: "android" } as unknown as DeviceInfo;
const other = { id: "emulator-5556", platform: "android" } as unknown as DeviceInfo;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeRegistry(server: unknown): Registry {
  return { resolveService: vi.fn(async () => server) } as unknown as Registry;
}

function makeServer(tapReply: Record<string, unknown>, sizeDelayMs = 0) {
  return {
    getScreenSize: vi.fn(async () => {
      if (sizeDelayMs > 0) await sleep(sizeDelayMs);
      return { screenWidth: 1000, screenHeight: 2000, displayRotation: 0 };
    }),
    tap: vi.fn(async () => tapReply),
  };
}

const RPC = {
  sendMs: 0.1,
  sentToFirstByteMs: 51.2,
  firstToLastByteMs: 0,
  roundTripMs: 51.2,
  parseMs: 0.02,
  rpcMs: 51.4,
  wireBytes: 140,
};
const DEVICE_STAGES = { parseMs: 0.2, injectMs: 50.4, injectOverheadMs: 0.4, handleMs: 50.9 };

beforeEach(() => {
  __resetOpenServerScreenSizeCache();
  setOpenServerTapTiming(false);
  takeOpenServerTapStages(device.id);
  takeOpenServerTapStages(other.id);
});
afterEach(() => setOpenServerTapTiming(false));

describe("open tap stage timings", () => {
  it("off by default: the tap RPC carries no `timing` key and nothing is recorded", async () => {
    const server = makeServer({ success: true });
    await openServerTap(makeRegistry(server), device, 0.5, 0.5, 1);

    const [, , opts] = server.tap.mock.calls[0]! as unknown as [
      number,
      number,
      Record<string, unknown>,
    ];
    expect("timing" in opts).toBe(false);
    expect(takeOpenServerTapStages(device.id)).toBeUndefined();
  });

  it("on: asks the device for timing and records the pre-tap, RPC and device stages", async () => {
    setOpenServerTapTiming(true);
    const server = makeServer({ success: true, stages: { rpc: RPC, device: DEVICE_STAGES } }, 5);
    await openServerTap(makeRegistry(server), device, 0.5, 0.5, 1);

    const [x, y, opts] = server.tap.mock.calls[0]! as unknown as [
      number,
      number,
      Record<string, unknown>,
    ];
    expect([x, y]).toEqual([500, 1000]);
    expect(opts.timing).toBe(true);

    const st = takeOpenServerTapStages(device.id)!;
    expect(st).toBeDefined();
    // The screen-size read before every gesture is its own stage (the official tap
    // sends normalized coordinates and reads no geometry).
    expect(st.screenSizeMs).toBeGreaterThanOrEqual(4);
    expect(st.lockWaitMs).toBeGreaterThanOrEqual(0);
    expect(st.resolveMs).toBeGreaterThanOrEqual(0);
    expect(st.rpc).toEqual(RPC);
    expect(st.device).toEqual(DEVICE_STAGES);
    expect(st.totalMs).toBeGreaterThanOrEqual(st.screenSizeMs);
    expect(st.dropped).toBe(false);
    expect(typeof st.seq).toBe("number");
    // Taken once: a second read has nothing until the next tap.
    expect(takeOpenServerTapStages(device.id)).toBeUndefined();
  });

  it("records per device, and a server without stages still yields the host stages", async () => {
    setOpenServerTapTiming(true);
    await openServerTap(makeRegistry(makeServer({ success: true })), other, 0.5, 0.5, 1);

    expect(takeOpenServerTapStages(device.id)).toBeUndefined();
    const st = takeOpenServerTapStages(other.id)!;
    expect(st.screenSizeMs).toBeGreaterThanOrEqual(0);
    expect(st.rpc).toBeUndefined();
    expect(st.device).toBeUndefined();
  });

  it("a dropped tap still throws with timing on, and records its stages", async () => {
    setOpenServerTapTiming(true);
    const server = makeServer({
      success: false,
      dropped: true,
      stages: { rpc: RPC, device: DEVICE_STAGES },
    });
    await expect(openServerTap(makeRegistry(server), device, 0.5, 0.5, 1)).rejects.toThrow(
      /dropped by the input dispatcher/
    );
    const st = takeOpenServerTapStages(device.id)!;
    expect(st.device).toEqual(DEVICE_STAGES);
    expect(st.dropped).toBe(true);
  });

  it("numbers the timed taps, so a stale row is told apart from the sample's own", async () => {
    setOpenServerTapTiming(true);
    const server = makeServer({ success: true });
    await openServerTap(makeRegistry(server), device, 0.5, 0.5, 1);
    const first = takeOpenServerTapStages(device.id)!.seq;
    await openServerTap(makeRegistry(server), device, 0.5, 0.5, 1);
    await openServerTap(makeRegistry(server), device, 0.5, 0.5, 1);
    // Only the last tap is kept, and its number is two past the first.
    expect(takeOpenServerTapStages(device.id)!.seq).toBe(first + 2);
  });
});
