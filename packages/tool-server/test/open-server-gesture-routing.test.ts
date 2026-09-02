import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let flagEnabledMock: (name: string) => boolean;
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => flagEnabledMock(name) };
});

// Legacy per-frame dispatch primitives, neutralised so the flag-off / fallback
// paths don't open a real socket.
vi.mock("../src/utils/gesture-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/gesture-utils")>();
  return { ...actual, sendTouchEvent: vi.fn(async () => {}) };
});
vi.mock("../src/utils/simulator-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/simulator-client")>();
  return { ...actual, sendCommand: vi.fn(async () => {}) };
});

import { createGesturePinchTool } from "../src/tools/gesture-pinch";
import { createGestureRotateTool } from "../src/tools/gesture-rotate";
import { createGestureCustomTool } from "../src/tools/gesture-custom";
import { sendTouchEvent } from "../src/utils/gesture-utils";
import { sendCommand } from "../src/utils/simulator-client";

const ANDROID_SERIAL = "emulator-5554";
const SCREEN = { width: 1000, height: 2000 };

function makeOpenApi() {
  return {
    getInfo: vi.fn(async () => ({
      screenWidth: SCREEN.width,
      screenHeight: SCREEN.height,
      currentPackage: "",
      keyboardVisible: false,
      displayRotation: 0,
    })),
    gesture: vi.fn(async () => ({ success: true })),
  };
}

function makeRegistry(openApi: unknown, onSimulatorServer?: () => Promise<unknown>) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      if (urn.startsWith("SimulatorServer:")) {
        return onSimulatorServer ? onSimulatorServer() : {};
      }
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
}

beforeEach(() => {
  flagEnabledMock = () => false;
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("gesture-pinch → open-device-server (T3)", () => {
  const base = {
    udid: ANDROID_SERIAL,
    centerX: 0.5,
    centerY: 0.5,
    startDistance: 0.2,
    endDistance: 0.2,
    durationMs: 16,
  };

  it("flag on: injects one multi-pointer gesture RPC with pixel-converted paths", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    const tool = createGesturePinchTool(makeRegistry(openApi));

    const result = await tool.execute({}, base);

    expect(result.pinched).toBe(true);
    expect(openApi.gesture).toHaveBeenCalledTimes(1);
    const [pointers] = openApi.gesture.mock.calls[0] as unknown as [
      Array<{ id?: number; points: Array<{ x: number; y: number; tMs: number }> }>,
    ];
    expect(pointers).toHaveLength(2);
    // centerX 0.5 ± halfDist 0.1 on width 1000 → 400 / 600; y 0.5 on 2000 → 1000.
    expect(pointers[0]!.points[0]).toEqual({ x: 400, y: 1000, tMs: 0 });
    expect(pointers[1]!.points[0]).toEqual({ x: 600, y: 1000, tMs: 0 });
    // No per-frame simulator-server dispatch on the open path.
    expect(vi.mocked(sendTouchEvent)).not.toHaveBeenCalled();
  });

  it("flag off: never touches the open server, dispatches the per-frame loop", async () => {
    flagEnabledMock = () => false;
    const openApi = makeOpenApi();
    const tool = createGesturePinchTool(makeRegistry(openApi));

    await tool.execute({ simulatorServer: {} } as never, base);

    expect(openApi.gesture).not.toHaveBeenCalled();
    expect(vi.mocked(sendTouchEvent)).toHaveBeenCalled();
  });

  it("open server throws: warns and falls back to the simulator-server", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    openApi.gesture.mockRejectedValueOnce(new Error("open boom"));
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const tool = createGesturePinchTool(makeRegistry(openApi));

    await tool.execute({}, base);

    expect(openApi.gesture).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTouchEvent)).toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("[gesture-pinch] open-device-server"));
  });
});

describe("gesture-rotate → open-device-server (T3)", () => {
  const base = {
    udid: ANDROID_SERIAL,
    centerX: 0.5,
    centerY: 0.5,
    radius: 0.1,
    startAngle: 0,
    endAngle: 90,
    durationMs: 16,
  };

  it("flag on: injects one multi-pointer gesture RPC", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    const tool = createGestureRotateTool(makeRegistry(openApi));

    const result = await tool.execute({}, base);

    expect(result.rotated).toBe(true);
    expect(openApi.gesture).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTouchEvent)).not.toHaveBeenCalled();
  });

  it("flag off: per-frame loop, open server untouched", async () => {
    flagEnabledMock = () => false;
    const openApi = makeOpenApi();
    const tool = createGestureRotateTool(makeRegistry(openApi));
    await tool.execute({ simulatorServer: {} } as never, base);
    expect(openApi.gesture).not.toHaveBeenCalled();
    expect(vi.mocked(sendTouchEvent)).toHaveBeenCalled();
  });
});

describe("gesture-custom → open-device-server (T3)", () => {
  it("flag on: a clean Down…Up two-finger gesture routes to the gesture RPC", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    const tool = createGestureCustomTool(makeRegistry(openApi));

    await tool.execute(
      {},
      {
        udid: ANDROID_SERIAL,
        events: [
          { type: "Down", x: 0.4, y: 0.5, x2: 0.6, y2: 0.5 },
          { type: "Up", x: 0.2, y: 0.5, x2: 0.8, y2: 0.5, delayMs: 100 },
        ],
      }
    );

    expect(openApi.gesture).toHaveBeenCalledTimes(1);
    const [pointers] = openApi.gesture.mock.calls[0] as unknown as [Array<{ points: unknown[] }>];
    expect(pointers).toHaveLength(2);
    expect(vi.mocked(sendCommand)).not.toHaveBeenCalled();
  });

  it("flag on: a long-press (Down, delayed Up) routes to the gesture RPC", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    const tool = createGestureCustomTool(makeRegistry(openApi));

    await tool.execute(
      {},
      {
        udid: ANDROID_SERIAL,
        events: [
          { type: "Down", x: 0.5, y: 0.5, delayMs: 0 },
          { type: "Up", x: 0.5, y: 0.5, delayMs: 800 },
        ],
      }
    );

    expect(openApi.gesture).toHaveBeenCalledTimes(1);
    const [pointers] = openApi.gesture.mock.calls[0] as unknown as [
      Array<{ points: Array<{ x: number; y: number; tMs: number }> }>,
    ];
    expect(pointers).toHaveLength(1);
    // The 800ms hold survives as the Up frame's timeline offset.
    expect(pointers[0]!.points.at(-1)!.tMs).toBe(800);
  });

  it("flag on: an irregular event train (multiple downs) stays on the simulator-server", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    const tool = createGestureCustomTool(makeRegistry(openApi));

    await tool.execute(
      {},
      {
        udid: ANDROID_SERIAL,
        events: [
          { type: "Down", x: 0.5, y: 0.5 },
          { type: "Up", x: 0.5, y: 0.5 },
          { type: "Down", x: 0.5, y: 0.5 },
          { type: "Up", x: 0.5, y: 0.5 },
        ],
      }
    );

    expect(openApi.gesture).not.toHaveBeenCalled();
    expect(vi.mocked(sendCommand)).toHaveBeenCalled();
  });

  it("flag off: open server untouched, per-event train dispatched", async () => {
    flagEnabledMock = () => false;
    const openApi = makeOpenApi();
    const tool = createGestureCustomTool(makeRegistry(openApi));

    await tool.execute(
      { simulatorServer: {} } as never,
      {
        udid: ANDROID_SERIAL,
        events: [
          { type: "Down", x: 0.5, y: 0.5 },
          { type: "Up", x: 0.5, y: 0.5 },
        ],
      }
    );

    expect(openApi.gesture).not.toHaveBeenCalled();
    expect(vi.mocked(sendCommand)).toHaveBeenCalled();
  });
});
