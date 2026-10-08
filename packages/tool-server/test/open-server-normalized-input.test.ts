import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Normalized input (APK versionCode 31): the host sends the 0–1 point as is and the
// device converts it with its live display metrics and rotation, so no gesture pays
// the `getScreenSize` RPC first (1.3–1.6 ms of the +2.1 ms tap gap in ABBA run
// 37824312091). A server below 31 keeps the old wire: host-side pixels after a
// `getScreenSize` read.

let flagEnabledMock: (name: string) => boolean;
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => flagEnabledMock(name) };
});

import type { DeviceInfo, Registry } from "@argent/registry";
import {
  openServerGesture,
  openServerSequence,
  openServerSwipe,
  openServerSwipeWithOutcomeTimed,
  openServerTap,
  openServerTapWithOutcome,
  openServerVerifiedTap,
  setOpenServerTapTiming,
  takeOpenServerTapStages,
  __resetOpenServerScreenSizeCache,
} from "../src/utils/open-server-input";

const device = { id: "emulator-5554", platform: "android" } as unknown as DeviceInfo;

const OUTCOME = {
  before: { version: 1, hash: "a", stateHash: "a" },
  after: { version: 2, hash: "b", stateHash: "b" },
  changed: true,
  newScreen: true,
  idleMs: 0,
};

function makeServer(installedVersionCode?: number) {
  return {
    ...(installedVersionCode !== undefined ? { installedVersionCode } : {}),
    getScreenSize: vi.fn(async () => ({
      screenWidth: 1000,
      screenHeight: 2000,
      displayRotation: 0,
    })),
    getState: vi.fn(async () => ({ tree: [], version: 3 })),
    tap: vi.fn(async () => ({ success: true })),
    tapWithOutcome: vi.fn(async () => ({ success: true, ...OUTCOME })),
    swipe: vi.fn(async () => ({ success: true })),
    swipeWithOutcome: vi.fn(async () => ({ success: true, ...OUTCOME })),
    gesture: vi.fn(async () => ({ success: true })),
    query: vi.fn(async () => ({
      version: 3,
      nodes: [{ text: "OK", bounds: { x1: 100, y1: 200, x2: 300, y2: 400 } }],
    })),
    batch: vi.fn(async (actions: unknown[]) => ({
      results: actions.map(() => ({ success: true, ms: 1 })),
    })),
  };
}

function makeRegistry(server: unknown): Registry {
  return { resolveService: vi.fn(async () => server) } as unknown as Registry;
}

const GRAPH_OFF = (n: string) => n === "open-device-server";
const GRAPH_ON = (n: string) => n === "open-device-server" || n === "screen-graph";

beforeEach(() => {
  flagEnabledMock = GRAPH_OFF;
  __resetOpenServerScreenSizeCache();
  setOpenServerTapTiming(false);
  takeOpenServerTapStages(device.id);
});
afterEach(() => setOpenServerTapTiming(false));

describe("tap: server v31 converts on the device", () => {
  it("sends the normalized point and makes no getScreenSize RPC", async () => {
    const server = makeServer(31);
    await openServerTap(makeRegistry(server), device, 0.25, 0.75, 1);

    expect(server.getScreenSize).not.toHaveBeenCalled();
    expect(server.tap).toHaveBeenCalledTimes(1);
    expect(server.tap).toHaveBeenCalledWith(
      0.25,
      0.75,
      expect.objectContaining({ normalized: true, clickCount: 1, holdMs: 50 })
    );
  });

  it("clamps to [0, 1] on the host as the pixel path did", async () => {
    const server = makeServer(31);
    await openServerTap(makeRegistry(server), device, 1.2, -0.1, 1);

    const [x, y] = server.tap.mock.calls[0]! as unknown as [number, number];
    expect([x, y]).toEqual([1, 0]);
  });

  it("F21: a mid-session rotation needs nothing from the host, the device converts", async () => {
    const server = makeServer(31);
    await openServerTap(makeRegistry(server), device, 0.5, 0.25, 1);
    // The display rotates here; the host has no geometry to refresh.
    await openServerTap(makeRegistry(server), device, 0.5, 0.25, 1);

    expect(server.getScreenSize).not.toHaveBeenCalled();
    for (const call of server.tap.mock.calls) {
      const [x, y, opts] = call as unknown as [number, number, { normalized?: boolean }];
      expect([x, y, opts.normalized]).toEqual([0.5, 0.25, true]);
    }
  });

  it("timing on: the screen-size stage is 0", async () => {
    setOpenServerTapTiming(true);
    const server = makeServer(31);
    await openServerTap(makeRegistry(server), device, 0.5, 0.5, 1);

    expect(server.getScreenSize).not.toHaveBeenCalled();
    expect(takeOpenServerTapStages(device.id)?.screenSizeMs).toBe(0);
  });
});

describe("tap: an older server keeps the host-side pixels", () => {
  for (const installed of [30, undefined]) {
    it(`installedVersionCode ${installed ?? "unknown"}: getScreenSize then pixels`, async () => {
      const server = makeServer(installed);
      await openServerTap(makeRegistry(server), device, 0.25, 0.75, 1);

      expect(server.getScreenSize).toHaveBeenCalledTimes(1);
      const [x, y, opts] = server.tap.mock.calls[0]! as unknown as [
        number,
        number,
        Record<string, unknown>,
      ];
      expect([x, y]).toEqual([250, 1500]);
      expect("normalized" in opts).toBe(false);
    });
  }
});

describe("tap with outcome (settle-on-action)", () => {
  it("graph off, v31: normalized point, no getScreenSize", async () => {
    const server = makeServer(31);
    await openServerTapWithOutcome(makeRegistry(server), device, 0.5, 0.5, 1, {
      bounds: { idleTimeoutMs: 1500 },
    });

    expect(server.getScreenSize).not.toHaveBeenCalled();
    expect(server.tapWithOutcome).toHaveBeenCalledWith(
      0.5,
      0.5,
      expect.objectContaining({ normalized: true, idleTimeoutMs: 1500 })
    );
  });

  it("graph on, v31: stays on pixels, the recorder needs the tapped pixel", async () => {
    flagEnabledMock = GRAPH_ON;
    const server = makeServer(31);
    await openServerTapWithOutcome(makeRegistry(server), device, 0.5, 0.5, 1);

    expect(server.getScreenSize).toHaveBeenCalledTimes(1);
    const [x, y, opts] = server.tapWithOutcome.mock.calls[0]! as unknown as [
      number,
      number,
      Record<string, unknown>,
    ];
    expect([x, y]).toEqual([500, 1000]);
    expect("normalized" in opts).toBe(false);
  });

  it("graph off, v30: pixels after getScreenSize", async () => {
    const server = makeServer(30);
    await openServerTapWithOutcome(makeRegistry(server), device, 0.5, 0.5, 1);

    expect(server.getScreenSize).toHaveBeenCalledTimes(1);
    expect(server.tapWithOutcome.mock.calls[0]!.slice(0, 2)).toEqual([500, 1000]);
  });
});

describe("swipe", () => {
  it("v31: the four normalized coordinates, no getScreenSize", async () => {
    const server = makeServer(31);
    await openServerSwipe(makeRegistry(server), device, 0.5, 0.7, 0.5, 0.2, 10, 120);

    expect(server.getScreenSize).not.toHaveBeenCalled();
    expect(server.swipe).toHaveBeenCalledWith(
      0.5,
      0.7,
      0.5,
      0.2,
      10,
      120,
      expect.objectContaining({ normalized: true })
    );
  });

  it("v30: pixels after getScreenSize", async () => {
    const server = makeServer(30);
    await openServerSwipe(makeRegistry(server), device, 0.5, 0.7, 0.5, 0.2, 10);

    expect(server.getScreenSize).toHaveBeenCalledTimes(1);
    const args = server.swipe.mock.calls[0]! as unknown as unknown[];
    expect(args.slice(0, 5)).toEqual([500, 1400, 500, 400, 10]);
    expect("normalized" in (args[6] as object)).toBe(false);
  });

  it("with outcome, graph off, v31: normalized", async () => {
    const server = makeServer(31);
    await openServerSwipeWithOutcomeTimed(makeRegistry(server), device, 0.5, 0.7, 0.5, 0.2, 10);

    expect(server.getScreenSize).not.toHaveBeenCalled();
    const args = server.swipeWithOutcome.mock.calls[0]! as unknown as unknown[];
    expect(args.slice(0, 5)).toEqual([0.5, 0.7, 0.5, 0.2, 10]);
    expect(args[6]).toEqual(expect.objectContaining({ normalized: true }));
  });

  it("with outcome, graph on, v31: pixels for the recorder", async () => {
    flagEnabledMock = GRAPH_ON;
    const server = makeServer(31);
    await openServerSwipeWithOutcomeTimed(makeRegistry(server), device, 0.5, 0.7, 0.5, 0.2, 10);

    expect(server.getScreenSize).toHaveBeenCalledTimes(1);
    const args = server.swipeWithOutcome.mock.calls[0]! as unknown as unknown[];
    expect(args.slice(0, 5)).toEqual([500, 1400, 500, 400, 10]);
  });
});

describe("multi-pointer gesture (pinch / rotate / custom)", () => {
  const pointers = [
    {
      id: 0,
      points: [
        { x: 0.45, y: 0.5, tMs: 0 },
        { x: 0.25, y: 0.5, tMs: 300 },
      ],
    },
    {
      id: 1,
      points: [
        { x: 0.55, y: 0.5, tMs: 0 },
        { x: 1.25, y: 0.5, tMs: 300 },
      ],
    },
  ];

  it("v31: normalized points (clamped to [0, 1]), no getScreenSize", async () => {
    const server = makeServer(31);
    await openServerGesture(makeRegistry(server), device, pointers);

    expect(server.getScreenSize).not.toHaveBeenCalled();
    const [sent, opts] = server.gesture.mock.calls[0]! as unknown as [
      Array<{ id?: number; points: Array<{ x: number; y: number; tMs: number }> }>,
      { normalized?: boolean },
    ];
    expect(opts.normalized).toBe(true);
    expect(sent).toEqual([
      {
        id: 0,
        points: [
          { x: 0.45, y: 0.5, tMs: 0 },
          { x: 0.25, y: 0.5, tMs: 300 },
        ],
      },
      {
        id: 1,
        points: [
          { x: 0.55, y: 0.5, tMs: 0 },
          { x: 1, y: 0.5, tMs: 300 },
        ],
      },
    ]);
  });

  it("v30: pixels after getScreenSize", async () => {
    const server = makeServer(30);
    await openServerGesture(makeRegistry(server), device, pointers);

    expect(server.getScreenSize).toHaveBeenCalledTimes(1);
    const [sent, opts] = server.gesture.mock.calls[0]! as unknown as [
      Array<{ points: Array<{ x: number; y: number }> }>,
      Record<string, unknown>,
    ];
    expect(sent[0]!.points[1]).toEqual({ x: 250, y: 1000, tMs: 300 });
    expect(sent[1]!.points[1]).toEqual({ x: 1000, y: 1000, tMs: 300 });
    expect("normalized" in opts).toBe(false);
  });
});

describe("gesture-sequence burst", () => {
  it("v31: taps and swipes carry n* keys, no getScreenSize", async () => {
    const server = makeServer(31);
    await openServerSequence(makeRegistry(server), device, [
      { kind: "tap", x: 0.5, y: 0.25 },
      { kind: "swipe", fromX: 0.5, fromY: 0.7, toX: 0.5, toY: 0.2 },
    ]);

    expect(server.getScreenSize).not.toHaveBeenCalled();
    const [actions] = server.batch.mock.calls[0]! as unknown as [
      Array<{ method: string; params: Record<string, unknown> }>,
    ];
    expect(actions[0]!.params).toMatchObject({ nx: 0.5, ny: 0.25 });
    expect("x" in actions[0]!.params).toBe(false);
    expect(actions[1]!.params).toMatchObject({
      nStartX: 0.5,
      nStartY: 0.7,
      nEndX: 0.5,
      nEndY: 0.2,
    });
    expect("startX" in actions[1]!.params).toBe(false);
  });

  it("v30: pixel keys after getScreenSize", async () => {
    const server = makeServer(30);
    await openServerSequence(makeRegistry(server), device, [{ kind: "tap", x: 0.5, y: 0.25 }]);

    expect(server.getScreenSize).toHaveBeenCalledTimes(1);
    const [actions] = server.batch.mock.calls[0]! as unknown as [
      Array<{ params: Record<string, unknown> }>,
    ];
    expect(actions[0]!.params).toMatchObject({ x: 500, y: 500 });
  });
});

describe("verified tap", () => {
  it("v31 without a coordinate guard and graph off: no getScreenSize, taps the match center", async () => {
    const server = makeServer(31);
    const r = await openServerVerifiedTap(makeRegistry(server), device, undefined, undefined, 1, {
      selector: { text: "OK" },
    });

    expect(r.outcome).toBe("tapped");
    expect(server.getScreenSize).not.toHaveBeenCalled();
    expect(server.tapWithOutcome.mock.calls[0]!.slice(0, 2)).toEqual([200, 300]);
  });

  it("with a coordinate guard: still reads the size to cross-check in pixels", async () => {
    const server = makeServer(31);
    await openServerVerifiedTap(makeRegistry(server), device, 0.2, 0.15, 1, {
      selector: { text: "OK" },
    });

    expect(server.getScreenSize).toHaveBeenCalledTimes(1);
  });
});
