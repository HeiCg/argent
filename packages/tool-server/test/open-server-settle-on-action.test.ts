import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Step settle-on-action (review ABBA run 37609765062, Part B): `describe settle:true`
// is a fixed UiAutomator idle cap and never sees a quiet screen, and `settle:false`
// right after a tap reads an empty or pre-transition tree. The oracle is on the
// ACTION: the on-device `runAction` already settles in two phases when the RPC
// carries `outcome { firstEventTimeoutMs, quietMs, idleTimeoutMs }`. These tests fix
// the agent-facing contract: `settle: true` on gesture-tap / button (and
// `settleAfter: true` on gesture-swipe, whose `settle` key is the retired name of
// `momentum`) sends that outcome with 600 / 80 / 1500 on the Android open server and
// returns `settledMs`, `settled` and `screenChanged`. Elsewhere the request is
// ignored with `settleIgnored`, never an error.

let flagEnabledMock: (name: string) => boolean;
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => flagEnabledMock(name) };
});
vi.mock("../src/utils/simulator-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/simulator-client")>();
  return { ...actual, sendCommand: vi.fn(async () => ({})) };
});
vi.mock("../src/utils/android-input", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/android-input")>();
  return { ...actual, injectAndroidKeycode: vi.fn(async () => {}) };
});
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDep: vi.fn(async () => {}),
}));

import { createGestureTapTool } from "../src/tools/gesture-tap";
import { createGestureSwipeTool } from "../src/tools/gesture-swipe";
import { createButtonTool } from "../src/tools/button";
import { __resetOpenServerScreenSizeCache } from "../src/utils/open-server-input";
import { sendCommand } from "../src/utils/simulator-client";
import { injectAndroidKeycode } from "../src/utils/android-input";

const ANDROID_SERIAL = "emulator-5554";
const IOS_SIM = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

/** The bounds the contract fixes: first AX event <= 600 ms, 80 ms quiet, cap 1500 ms. */
const SETTLE_BOUNDS = { firstEventTimeoutMs: 600, quietMs: 80, idleTimeoutMs: 1500 };

const QUIET = {
  before: { version: 1, hash: "aaaa", stateHash: "aaaa", idHash: "i1" },
  after: { version: 4, hash: "bbbb", stateHash: "cccc", idHash: "i2" },
  changed: true,
  newScreen: true,
  settled: "quiet" as const,
  firstEventMs: 42,
  idleMs: 230,
};
const NO_EVENT = {
  before: { version: 1, hash: "aaaa", stateHash: "aaaa", idHash: "i1" },
  after: { version: 1, hash: "aaaa", stateHash: "aaaa", idHash: "i1" },
  changed: false,
  newScreen: false,
  settled: "no-event" as const,
  firstEventMs: -1,
  idleMs: 0,
};

function makeApi(outcome: object = QUIET) {
  return {
    getScreenSize: vi.fn(async () => ({
      screenWidth: 1000,
      screenHeight: 2000,
      displayRotation: 0,
    })),
    getState: vi.fn(async () => ({
      tree: [
        {
          index: 0,
          className: "android.widget.Button",
          text: "Network",
          clickable: true,
          bounds: { x1: 100, y1: 200, x2: 300, y2: 400 },
        },
      ],
      version: 7,
      info: { screenWidth: 1000, screenHeight: 2000 },
    })),
    tap: vi.fn(async () => ({ success: true })),
    tapWithOutcome: vi.fn(async () => ({ success: true, ...outcome })),
    swipe: vi.fn(async () => ({ success: true })),
    swipeWithOutcome: vi.fn(async () => ({ success: true, heldMs: 0, ...outcome })),
    key: vi.fn(async () => ({ success: true })),
    query: vi.fn(async () => ({
      version: 7,
      nodes: [{ text: "Network", bounds: { x1: 100, y1: 200, x2: 300, y2: 400 } }],
    })),
    scrollContainer: vi.fn(async () => ({ accepted: true, performed: 1, settledMs: 140 })),
    keyWithOutcome: vi.fn(async () => ({ success: true, ...outcome })),
  };
}

const simApi = { kind: "sim" };
function makeRegistry(openApi: unknown) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      if (urn.startsWith("SimulatorServer:")) return simApi;
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
}

const OPEN_ONLY = (n: string) => n === "open-device-server";
const OPEN_AND_GRAPH = (n: string) => n === "open-device-server" || n === "screen-graph";
const NOTHING = () => false;

beforeEach(() => {
  flagEnabledMock = OPEN_ONLY;
  __resetOpenServerScreenSizeCache();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("gesture-tap settle:true (Android open server)", () => {
  it("sends the tap with outcome 600/80/1500 and returns settledMs, settled, screenChanged", async () => {
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));

    const r = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      x: 0.5,
      y: 0.5,
      settle: true,
    });

    expect(api.tapWithOutcome).toHaveBeenCalledTimes(1);
    expect(api.tap).not.toHaveBeenCalled();
    expect(api.tapWithOutcome).toHaveBeenCalledWith(
      500,
      1000,
      expect.objectContaining({ ...SETTLE_BOUNDS, clickCount: 1, holdMs: 50 })
    );
    expect(r).toMatchObject({
      tapped: true,
      settledMs: 42 + 230,
      settled: "quiet",
      screenChanged: true,
    });
    // Graph off: the full fingerprint delta stays off the reply.
    expect(Object.hasOwn(r, "outcome")).toBe(false);
    expect(Object.hasOwn(r, "settleIgnored")).toBe(false);
  });

  it("no AX event: settled 'no-event', screenChanged false, settledMs = the 600 ms phase-1 cap", async () => {
    const api = makeApi(NO_EVENT);
    const tool = createGestureTapTool(makeRegistry(api));

    const r = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      x: 0.5,
      y: 0.5,
      settle: true,
    });

    expect(r).toMatchObject({ settled: "no-event", screenChanged: false, settledMs: 600 });
  });

  it("settle:false and settle absent keep the plain `tap` RPC with no outcome", async () => {
    for (const settle of [false, undefined]) {
      vi.clearAllMocks();
      const api = makeApi();
      const tool = createGestureTapTool(makeRegistry(api));
      const r = await tool.execute({} as never, {
        udid: ANDROID_SERIAL,
        x: 0.5,
        y: 0.5,
        ...(settle === undefined ? {} : { settle }),
      });
      expect(api.tap).toHaveBeenCalledTimes(1);
      expect(api.tapWithOutcome).not.toHaveBeenCalled();
      for (const k of ["settledMs", "settled", "screenChanged", "settleIgnored"])
        expect(Object.hasOwn(r, k)).toBe(false);
    }
  });

  it("screen-graph recording on + settle:true: ONE tap RPC carries both the record and the settle", async () => {
    flagEnabledMock = OPEN_AND_GRAPH;
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));

    const r = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      x: 0.5,
      y: 0.5,
      settle: true,
    });

    expect(api.tapWithOutcome).toHaveBeenCalledTimes(1);
    expect(api.tap).not.toHaveBeenCalled();
    expect(api.tapWithOutcome).toHaveBeenCalledWith(
      500,
      1000,
      expect.objectContaining(SETTLE_BOUNDS)
    );
    expect(r).toMatchObject({ settled: "quiet", screenChanged: true, settledMs: 272 });
    expect(r.outcome).toMatchObject({ settled: "quiet", newScreen: true });
  });

  it("an index target with settle:true taps the element centre with the same outcome", async () => {
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));

    const r = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      target: { index: 0, version: 7 },
      settle: true,
    });

    expect(api.tapWithOutcome).toHaveBeenCalledTimes(1);
    expect(api.tap).not.toHaveBeenCalled();
    expect(api.tapWithOutcome).toHaveBeenCalledWith(
      200,
      300,
      expect.objectContaining(SETTLE_BOUNDS)
    );
    expect(r).toMatchObject({ tapped: true, targetIndex: 0, settled: "quiet", settledMs: 272 });
  });

  it("a dropped settle tap falls back to the simulator-server and says the settle was not done", async () => {
    const api = makeApi();
    api.tapWithOutcome.mockResolvedValueOnce({ success: false, dropped: true, ...QUIET } as never);
    const tool = createGestureTapTool(makeRegistry(api));

    const r = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      x: 0.5,
      y: 0.5,
      settle: true,
    });

    expect(sendCommand).toHaveBeenCalled();
    expect(r.tapped).toBe(true);
    expect(r.settleIgnored).toMatch(/open server failed/);
    expect(Object.hasOwn(r, "settled")).toBe(false);
  });

  it("verify + settle: the settle is not applied, settleIgnored says so", async () => {
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));

    const r = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      verify: { selector: { text: "Network" } },
      settle: true,
    });

    expect(r).toMatchObject({ tapped: true, verified: true });
    expect(r.settleIgnored).toBe("not applied with verify");
    for (const k of ["settledMs", "settled", "screenChanged"])
      expect(Object.hasOwn(r, k)).toBe(false);
  });

  it("an index tap with settle:true whose tap is dropped fails, no settle fields", async () => {
    const api = makeApi();
    api.tapWithOutcome.mockResolvedValueOnce({ success: false, dropped: true, ...QUIET } as never);
    const tool = createGestureTapTool(makeRegistry(api));

    await expect(
      tool.execute({} as never, {
        udid: ANDROID_SERIAL,
        target: { index: 0, version: 7 },
        settle: true,
      })
    ).rejects.toThrow(/tap was dropped by the input dispatcher/);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("iOS: settle is ignored with settleIgnored, the tap still runs, no error", async () => {
    flagEnabledMock = NOTHING;
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));

    const r = await tool.execute({ simulatorServer: simApi } as never, {
      udid: IOS_SIM,
      x: 0.5,
      y: 0.5,
      settle: true,
    });

    expect(r.tapped).toBe(true);
    expect(r.settleIgnored).toBe("not Android open server");
    expect(api.tapWithOutcome).not.toHaveBeenCalled();
  });

  it("Android with the open-device-server flag off: settleIgnored, the proprietary tap runs", async () => {
    flagEnabledMock = NOTHING;
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));

    const r = await tool.execute({ simulatorServer: simApi } as never, {
      udid: ANDROID_SERIAL,
      x: 0.5,
      y: 0.5,
      settle: true,
    });

    expect(r.settleIgnored).toBe("not Android open server");
    expect(api.tapWithOutcome).not.toHaveBeenCalled();
  });
});

describe("gesture-swipe settleAfter:true (Android open server)", () => {
  const base = {
    udid: ANDROID_SERIAL,
    fromX: 0.5,
    fromY: 0.7,
    toX: 0.5,
    toY: 0.2,
    durationMs: 160,
  };

  it("sends the swipe with outcome 600/80/1500 and returns settledMs, settled, screenChanged", async () => {
    const api = makeApi();
    const tool = createGestureSwipeTool(makeRegistry(api));

    const r = await tool.execute({} as never, { ...base, settleAfter: true });

    expect(api.swipeWithOutcome).toHaveBeenCalledTimes(1);
    expect(api.swipe).not.toHaveBeenCalled();
    const args = api.swipeWithOutcome.mock.calls[0] as unknown[];
    expect(args.slice(0, 5)).toEqual([500, 1400, 500, 400, 10]);
    expect(args[6]).toMatchObject(SETTLE_BOUNDS);
    expect(r).toMatchObject({
      swiped: true,
      method: "motion",
      settledMs: 272,
      settled: "quiet",
      screenChanged: true,
    });
    expect(Object.hasOwn(r, "outcome")).toBe(false);
  });

  it("settleAfter absent: plain `swipe` RPC, no outcome", async () => {
    const api = makeApi();
    const tool = createGestureSwipeTool(makeRegistry(api));

    const r = await tool.execute({} as never, base);

    expect(api.swipe).toHaveBeenCalledTimes(1);
    expect(api.swipeWithOutcome).not.toHaveBeenCalled();
    expect(Object.hasOwn(r, "settled")).toBe(false);
  });

  it("screen-graph recording on + settleAfter:true: ONE swipe RPC", async () => {
    flagEnabledMock = OPEN_AND_GRAPH;
    const api = makeApi();
    const tool = createGestureSwipeTool(makeRegistry(api));

    const r = await tool.execute({} as never, { ...base, settleAfter: true });

    expect(api.swipeWithOutcome).toHaveBeenCalledTimes(1);
    expect(api.swipe).not.toHaveBeenCalled();
    expect((api.swipeWithOutcome.mock.calls[0] as unknown[])[6]).toMatchObject(SETTLE_BOUNDS);
    expect(r).toMatchObject({ settled: "quiet", screenChanged: true });
    expect(r.outcome).toBeDefined();
  });

  it("settleAfter + verify: the swipe runs, the settle is not applied", async () => {
    const api = makeApi();
    const tool = createGestureSwipeTool(makeRegistry(api));

    const r = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      toX: 0.5,
      toY: 0.2,
      verify: { selector: { text: "Network" } },
      settleAfter: true,
    });

    expect(r).toMatchObject({ swiped: true, verified: true });
    expect(r.settleIgnored).toBe("not applied with verify");
    expect(api.swipeWithOutcome).not.toHaveBeenCalled();
    expect(Object.hasOwn(r, "settled")).toBe(false);
  });

  it("settleAfter + scrollAction: the scroll runs, the settle is not applied", async () => {
    const api = makeApi();
    api.getState.mockResolvedValue({
      tree: [
        {
          index: 0,
          className: "androidx.recyclerview.widget.RecyclerView",
          scrollable: true,
          bounds: { x1: 0, y1: 300, x2: 1000, y2: 1900 },
        },
      ],
      version: 7,
      info: { screenWidth: 1000, screenHeight: 2000 },
    } as never);
    const tool = createGestureSwipeTool(makeRegistry(api));

    const r = await tool.execute({} as never, { ...base, scrollAction: true, settleAfter: true });

    expect(r).toMatchObject({ swiped: true, method: "scroll-action" });
    expect(r.settleIgnored).toMatch(/scrollAction/);
    expect(api.swipeWithOutcome).not.toHaveBeenCalled();
    expect(Object.hasOwn(r, "settled")).toBe(false);
  });

  it("iOS: settleAfter is ignored with settleIgnored, no error", async () => {
    flagEnabledMock = NOTHING;
    const api = makeApi();
    const tool = createGestureSwipeTool(makeRegistry(api));

    const r = await tool.execute({ simulatorServer: simApi } as never, {
      ...base,
      udid: IOS_SIM,
      settleAfter: true,
    });

    expect(r.swiped).toBe(true);
    expect(r.settleIgnored).toBe("not Android open server");
  });
});

describe("button settle:true (Android open server)", () => {
  it("presses back through the open server `key` RPC with outcome 600/80/1500", async () => {
    const api = makeApi();
    const tool = createButtonTool(makeRegistry(api));

    const r = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      button: "back",
      settle: true,
    });

    expect(api.keyWithOutcome).toHaveBeenCalledTimes(1);
    expect(api.keyWithOutcome).toHaveBeenCalledWith("back", expect.objectContaining(SETTLE_BOUNDS));
    expect(injectAndroidKeycode).not.toHaveBeenCalled();
    expect(r).toEqual({
      pressed: "back",
      settledMs: 272,
      settled: "quiet",
      screenChanged: true,
    });
  });

  it("maps the button names to the device server key names", async () => {
    const api = makeApi();
    const tool = createButtonTool(makeRegistry(api));
    for (const [button, key] of [
      ["home", "home"],
      ["volumeUp", "volume_up"],
      ["volumeDown", "volume_down"],
      ["appSwitch", "recent_apps"],
      ["power", "power"],
    ] as const) {
      api.keyWithOutcome.mockClear();
      await tool.execute({} as never, { udid: ANDROID_SERIAL, button, settle: true });
      expect(api.keyWithOutcome).toHaveBeenCalledWith(key, expect.anything());
    }
  });

  it("settle:false keeps the adb key event and no outcome RPC", async () => {
    const api = makeApi();
    const tool = createButtonTool(makeRegistry(api));

    const r = await tool.execute({} as never, { udid: ANDROID_SERIAL, button: "back" });

    expect(injectAndroidKeycode).toHaveBeenCalledWith(ANDROID_SERIAL, 4);
    expect(api.keyWithOutcome).not.toHaveBeenCalled();
    expect(r).toEqual({ pressed: "back" });
  });

  it("screen-graph recording on + settle:true: ONE key RPC", async () => {
    flagEnabledMock = OPEN_AND_GRAPH;
    const api = makeApi();
    const tool = createButtonTool(makeRegistry(api));

    await tool.execute({} as never, { udid: ANDROID_SERIAL, button: "back", settle: true });

    expect(api.keyWithOutcome).toHaveBeenCalledTimes(1);
    expect(api.key).not.toHaveBeenCalled();
    expect(injectAndroidKeycode).not.toHaveBeenCalled();
  });

  it("a failed key RPC falls back to the adb key event, settleIgnored names the failure", async () => {
    const api = makeApi();
    api.keyWithOutcome.mockRejectedValueOnce(new Error("socket closed"));
    const tool = createButtonTool(makeRegistry(api));

    const r = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      button: "back",
      settle: true,
    });

    expect(injectAndroidKeycode).toHaveBeenCalledWith(ANDROID_SERIAL, 4);
    expect(r.pressed).toBe("back");
    expect(r.settleIgnored).toMatch(/open server failed \(socket closed\)/);
    expect(Object.hasOwn(r, "settled")).toBe(false);
  });

  it("open-device-server flag off: adb press with settleIgnored, no error", async () => {
    flagEnabledMock = NOTHING;
    const api = makeApi();
    const tool = createButtonTool(makeRegistry(api));

    const r = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      button: "back",
      settle: true,
    });

    expect(injectAndroidKeycode).toHaveBeenCalledWith(ANDROID_SERIAL, 4);
    expect(r).toEqual({ pressed: "back", settleIgnored: "not Android open server" });
  });

  it("iOS: settleIgnored, the simulator-server press runs", async () => {
    flagEnabledMock = NOTHING;
    const api = makeApi();
    const tool = createButtonTool(makeRegistry(api));

    const r = await tool.execute({ simulatorServer: simApi } as never, {
      udid: IOS_SIM,
      button: "home",
      settle: true,
    });

    expect(sendCommand).toHaveBeenCalled();
    expect(r).toEqual({ pressed: "home", settleIgnored: "not Android open server" });
  });
});
