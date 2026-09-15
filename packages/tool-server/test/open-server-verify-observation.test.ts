import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A1-M8: when the screen graph is recording, a verified tap records the
// observation like `openServerTapWithOutcome`, so the edge is not lost.

let recording = false;
const recordSpy = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../src/utils/screen-graph-open-wiring", () => ({
  screenGraphRecordingEnabled: () => recording,
  recordOpenServerObservation: (...args: unknown[]) => recordSpy(...args),
}));

import { openServerVerifiedTap } from "../src/utils/open-server-input";
import { __resetOpenServerScreenSizeCache } from "../src/utils/open-server-input";
import type { DeviceInfo } from "@argent/registry";

const device: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };

const OUTCOME = {
  before: { version: 1, hash: "a", stateHash: "a" },
  after: { version: 2, hash: "b", stateHash: "c" },
  changed: true,
  newScreen: true,
  settled: "quiet" as const,
  firstEventMs: 5,
  idleMs: 10,
};

function makeApi() {
  return {
    getScreenSize: vi.fn(async () => ({
      screenWidth: 1000,
      screenHeight: 2000,
      displayRotation: 0,
    })),
    query: vi.fn(async () => ({
      version: 7,
      hash: "H",
      stateHash: "S",
      nodes: [{ text: "Row", bounds: { x1: 100, y1: 200, x2: 900, y2: 400 } }],
    })),
    tapWithOutcome: vi.fn(async () => ({ success: true, ...OUTCOME })),
  };
}

function makeRegistry(api: unknown) {
  return {
    resolveService: vi.fn(async () => api),
  } as never;
}

beforeEach(() => {
  __resetOpenServerScreenSizeCache();
  recordSpy.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("verified tap — screen-graph observation", () => {
  it("records the observation when recording is ON", async () => {
    recording = true;
    const api = makeApi();
    const res = await openServerVerifiedTap(makeRegistry(api), device, undefined, undefined, 1, {
      selector: { text: "Row" },
    });
    expect(res.outcome).toBe("tapped");
    expect(recordSpy).toHaveBeenCalledTimes(1);
    // Center of (100,200,900,400) is (500,300); the observation carries it.
    const args = recordSpy.mock.calls[0] as unknown[];
    expect(args[3]).toEqual({ kind: "tap", x: 500, y: 300 });
  });

  it("records NO observation when recording is OFF", async () => {
    recording = false;
    const api = makeApi();
    await openServerVerifiedTap(makeRegistry(api), device, undefined, undefined, 1, {
      selector: { text: "Row" },
    });
    expect(recordSpy).not.toHaveBeenCalled();
  });
});
