import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression guard for the tap/swipe latency regression (docs/open-server/
// 2026-09-14-open-server-outcome-regression.md): after the screen-graph-d merge
// gesture-tap / gesture-swipe / paste called the *WithOutcome open-server
// variants whenever `open-device-server` was on, so every ON action carried an
// `outcome` request and paid the on-device settleAfterAction wait (+800-1000ms).
//
// The fix gates the outcome path on the screen graph being recorded
// (`screenGraphRecordingEnabled()` — the `screen-graph` flag OR the bench's
// `ARGENT_SG_RECORD` record-only mode). With the graph OFF (the default, and the
// latency bench's config) the tool takes the plain path and NO `outcome` key
// leaves the host. These tests spy on the open-server client to prove exactly
// which RPC is sent in each regime.

let flagEnabledMock: (name: string) => boolean;
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => flagEnabledMock(name) };
});
vi.mock("../src/utils/simulator-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/simulator-client")>();
  return {
    ...actual,
    sendCommand: vi.fn(async () => {}),
    setSimulatorClipboardText: vi.fn(async () => {}),
  };
});
vi.mock("../src/utils/check-deps", () => ({ ensureDeps: vi.fn(async () => {}) }));
vi.mock("../src/utils/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/adb")>();
  return { ...actual, isAndroidTv: vi.fn(async () => false) };
});
vi.mock("../src/utils/android-input", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/android-input")>();
  return { ...actual, injectAndroidKeycode: vi.fn(async () => {}) };
});

import { createGestureTapTool } from "../src/tools/gesture-tap";
import { createGestureSwipeTool } from "../src/tools/gesture-swipe";
import { createPasteTool } from "../src/tools/paste";
import { __resetOpenServerScreenSizeCache } from "../src/utils/open-server-input";
import { __resetOpenServerClipboardCache } from "../src/utils/open-server-clipboard-cache";
import { sendCommand } from "../src/utils/simulator-client";

const ANDROID_SERIAL = "emulator-5554";

const TAP_OUTCOME = {
  before: { version: 1, hash: "aaaa", stateHash: "aaaa" },
  after: { version: 2, hash: "bbbb", stateHash: "cccc" },
  changed: true,
  newScreen: true,
  idleMs: 10,
};

function makeGestureApi() {
  return {
    getScreenSize: vi.fn(async () => ({
      screenWidth: 1000,
      screenHeight: 2000,
      displayRotation: 0,
    })),
    getState: vi.fn(async () => ({ tree: [] })),
    tap: vi.fn(async () => ({ success: true })),
    tapWithOutcome: vi.fn(async () => ({ success: true, ...TAP_OUTCOME })),
    swipe: vi.fn(async () => ({ success: true })),
    swipeWithOutcome: vi.fn(async () => ({ success: true, ...TAP_OUTCOME })),
  };
}

function makeRegistry(openApi: unknown) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
}

const GRAPH_OFF = (n: string) => n === "open-device-server";
const GRAPH_ON = (n: string) => n === "open-device-server" || n === "screen-graph";

beforeEach(() => {
  flagEnabledMock = GRAPH_OFF;
  __resetOpenServerScreenSizeCache();
  __resetOpenServerClipboardCache();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("gesture-tap: outcome path gated on the screen graph", () => {
  it("graph OFF (default): plain `tap` RPC, no `outcome` key leaves the host", async () => {
    flagEnabledMock = GRAPH_OFF;
    const api = makeGestureApi();
    const tool = createGestureTapTool(makeRegistry(api));

    const result = await tool.execute({} as never, { udid: ANDROID_SERIAL, x: 0.5, y: 0.5 });

    // Plain `tap` carries the timeline; `tapWithOutcome` (the settle-bearing RPC)
    // is never sent.
    expect(api.tap).toHaveBeenCalledTimes(1);
    // `inject: "input-manager"` is the shipped 3n.1 default (resolveInjectStrategy);
    // gating the graph off changes only the outcome path, not the injection strategy.
    expect(api.tap).toHaveBeenCalledWith(500, 1000, {
      clickCount: 1,
      holdMs: 50,
      inject: "input-manager",
    });
    expect(api.tapWithOutcome).not.toHaveBeenCalled();
    expect(result.tapped).toBe(true);
    // No `outcome` key on the result when the flag is off.
    expect(Object.hasOwn(result, "outcome")).toBe(false);
    expect(result.outcome).toBeUndefined();
  });

  it("graph ON: the `tapWithOutcome` RPC is used and the delta rides back", async () => {
    flagEnabledMock = GRAPH_ON;
    const api = makeGestureApi();
    const tool = createGestureTapTool(makeRegistry(api));

    const result = await tool.execute({} as never, { udid: ANDROID_SERIAL, x: 0.5, y: 0.5 });

    expect(api.tapWithOutcome).toHaveBeenCalledTimes(1);
    expect(api.tap).not.toHaveBeenCalled();
    expect(result.outcome).toEqual(TAP_OUTCOME);
  });

  it("graph OFF: a multi-tap still builds the whole timeline in one plain `tap` RPC", async () => {
    flagEnabledMock = GRAPH_OFF;
    const api = makeGestureApi();
    const tool = createGestureTapTool(makeRegistry(api));

    await tool.execute({} as never, { udid: ANDROID_SERIAL, x: 0.5, y: 0.5, clickCount: 3 });

    expect(api.tap).toHaveBeenCalledTimes(1);
    expect(api.tap).toHaveBeenCalledWith(500, 1000, {
      clickCount: 3,
      holdMs: 50,
      gapMs: 100,
      inject: "input-manager",
    });
    expect(api.tapWithOutcome).not.toHaveBeenCalled();
  });
});

describe("gesture-swipe: outcome path gated on the screen graph", () => {
  const base = {
    udid: ANDROID_SERIAL,
    fromX: 0.5,
    fromY: 0.7,
    toX: 0.5,
    toY: 0.2,
    durationMs: 160,
  };

  it("graph OFF (default): plain `swipe` RPC, no `outcome` key leaves the host", async () => {
    flagEnabledMock = GRAPH_OFF;
    const api = makeGestureApi();
    const tool = createGestureSwipeTool(makeRegistry(api));

    const result = await tool.execute({} as never, base);

    // steps = round(160/16) = 10; plain swipe, no holdEndMs for a plain fling.
    expect(api.swipe).toHaveBeenCalledTimes(1);
    // 7th arg is the inject-options bag; `input-manager` is the shipped 3n.1 default.
    expect(api.swipe).toHaveBeenCalledWith(500, 1400, 500, 400, 10, undefined, {
      inject: "input-manager",
    });
    expect(api.swipeWithOutcome).not.toHaveBeenCalled();
    expect(result.swiped).toBe(true);
    expect(Object.hasOwn(result, "outcome")).toBe(false);
    expect(result.outcome).toBeUndefined();
  });

  it("graph OFF: `momentum: false` still holds before the lift on the plain path", async () => {
    flagEnabledMock = GRAPH_OFF;
    const api = makeGestureApi();
    const tool = createGestureSwipeTool(makeRegistry(api));

    await tool.execute({} as never, { ...base, momentum: false });

    expect(api.swipe).toHaveBeenCalledTimes(1);
    const args = api.swipe.mock.calls[0] as unknown[];
    expect(args.slice(0, 5)).toEqual([500, 1400, 500, 400, 10]);
    // holdEndMs > 0 so the release velocity decays to ~0 (deterministic scroll).
    expect(args[5]).toBeGreaterThan(0);
    expect(api.swipeWithOutcome).not.toHaveBeenCalled();
  });

  it("graph ON: the `swipeWithOutcome` RPC is used and the delta rides back", async () => {
    flagEnabledMock = GRAPH_ON;
    const api = makeGestureApi();
    const tool = createGestureSwipeTool(makeRegistry(api));

    const result = await tool.execute({} as never, base);

    expect(api.swipeWithOutcome).toHaveBeenCalledTimes(1);
    expect(api.swipe).not.toHaveBeenCalled();
    expect((result as { outcome?: unknown }).outcome).toEqual(TAP_OUTCOME);
  });
});

describe("paste (android): typed fallback outcome gated on the screen graph", () => {
  function makePasteApi() {
    return {
      // Force the typed fallback: the clipboard write is definitively dropped.
      setClipboard: vi.fn(async () => ({ success: false, text: "" })),
      typeText: vi.fn(async (text: string) => ({ success: true, charsTyped: text.length })),
      typeTextWithOutcome: vi.fn(async (text: string) => ({
        success: true,
        charsTyped: text.length,
        ...TAP_OUTCOME,
      })),
    };
  }

  const url = "https://example.com/reset?token=abcdef0123456789";

  it("graph OFF (default): plain `typeText`, no `outcome` key leaves the host", async () => {
    flagEnabledMock = GRAPH_OFF;
    const api = makePasteApi();
    const tool = createPasteTool(makeRegistry(api));

    const result = await tool.execute({} as never, { udid: ANDROID_SERIAL, text: url });

    expect(api.typeText).toHaveBeenCalledWith(url);
    expect(api.typeTextWithOutcome).not.toHaveBeenCalled();
    expect(result).toEqual({ pasted: true });
  });

  it("graph ON: the typed paste reports the before/after delta", async () => {
    flagEnabledMock = GRAPH_ON;
    const api = makePasteApi();
    const tool = createPasteTool(makeRegistry(api));

    const result = await tool.execute({} as never, { udid: ANDROID_SERIAL, text: url });

    expect(api.typeTextWithOutcome).toHaveBeenCalledWith(url, undefined);
    expect(api.typeText).not.toHaveBeenCalled();
    expect(result).toEqual({ pasted: true, outcome: TAP_OUTCOME });
  });
});

// Referenced so the mocked simulator-client import is retained under isolated
// module transforms; the open path never falls through to it here.
void sendCommand;
