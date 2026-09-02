import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let flagEnabledMock: (name: string) => boolean;
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => flagEnabledMock(name) };
});
vi.mock("../src/utils/simulator-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/simulator-client")>();
  return { ...actual, sendCommand: vi.fn(async () => {}) };
});

import { createGestureTapTool } from "../src/tools/gesture-tap";

const ANDROID_SERIAL = "emulator-5554";

// Screen-graph Phase A: the tap's before/after fingerprint delta. Phase A.1 adds
// the two-phase settle report (`settled`, `firstEventMs`).
const OUTCOME = {
  before: { version: 1, hash: "aaaa", stateHash: "aaaa" },
  after: { version: 2, hash: "bbbb", stateHash: "cccc" },
  changed: true,
  newScreen: true,
  settled: "quiet",
  firstEventMs: 12,
  idleMs: 15,
};

function makeOpenApi() {
  return {
    getInfo: vi.fn(async () => ({
      screenWidth: 1000,
      screenHeight: 2000,
      currentPackage: "",
      keyboardVisible: false,
      displayRotation: 0,
    })),
    getScreenSize: vi.fn(async () => ({ screenWidth: 1000, screenHeight: 2000, displayRotation: 0 })),
    tap: vi.fn(async () => ({ success: true })),
    tapWithOutcome: vi.fn(async () => ({ success: true, ...OUTCOME })),
    getState: vi.fn(async () => ({
      tree: [],
      info: { screenWidth: 1000, screenHeight: 2000, currentPackage: "", keyboardVisible: false, displayRotation: 0 },
      screenshot: "",
      waitedMs: 0,
      captureMs: 0,
      version: 1,
      hash: "aaaa",
      stateHash: "aaaa",
    })),
  };
}

function makeTool(openApi: unknown) {
  const registry = {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
  return createGestureTapTool(registry);
}

beforeEach(() => {
  flagEnabledMock = (n) => n === "open-device-server";
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("gesture-tap → open-device-server outcome (Screen-graph Phase A)", () => {
  it("a single tap goes through tapWithOutcome and surfaces the delta additively", async () => {
    const openApi = makeOpenApi();
    const tool = makeTool(openApi);

    const result = await tool.execute({} as never, { udid: ANDROID_SERIAL, x: 0.5, y: 0.5 });

    // ONE tapWithOutcome RPC carrying the timeline (holdMs, clickCount 1, no gap)
    // AND the outcome request.
    expect(openApi.tapWithOutcome).toHaveBeenCalledWith(500, 1000, { clickCount: 1, holdMs: 50 });
    expect(result.tapped).toBe(true);
    expect(result.outcome).toEqual(OUTCOME);
  });

  it("a multi-tap builds the whole timeline in one outcome-bearing RPC", async () => {
    const openApi = makeOpenApi();
    const tool = makeTool(openApi);

    const result = await tool.execute({} as never, { udid: ANDROID_SERIAL, x: 0.5, y: 0.5, clickCount: 3 });

    // The whole multi-tap timeline (clickCount 3, holdMs, gapMs) is built
    // server-side in ONE `tap` RPC that also reports the outcome — no host-side
    // leading-tap loop.
    expect(openApi.tap).not.toHaveBeenCalled();
    expect(openApi.tapWithOutcome).toHaveBeenCalledTimes(1);
    expect(openApi.tapWithOutcome).toHaveBeenCalledWith(500, 1000, {
      clickCount: 3,
      holdMs: 50,
      gapMs: 100,
    });
    expect(result.outcome?.before.hash).toBe("aaaa");
    expect(result.outcome?.after.hash).toBe("bbbb");
    // The settle report is threaded from the outcome-bearing tap.
    expect(result.outcome?.settled).toBe("quiet");
    expect(result.outcome?.firstEventMs).toBe(12);
  });
});
