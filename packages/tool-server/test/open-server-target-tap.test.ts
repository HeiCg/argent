import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Artemis A2 §B — `gesture-tap { target }` and the A2-H1 `{ target, verify }`
// precedence: a target taps by element index, and when `verify` is ALSO given the
// verify path runs against the LIVE tree (never silently dropped). A2-M10: off the
// open path the refusal is a STRUCTURED `target_unsupported`, and a successful
// index tap names the element.

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
import { __resetOpenServerScreenSizeCache } from "../src/utils/open-server-input";
import { __resetIncidents } from "../src/utils/open-server-incident";

const ANDROID_SERIAL = "emulator-5554";

// One clickable row centred at pixel (500, 300) on a 1000×2000 screen → index 0.
const ROW_EL = {
  index: 1,
  className: "android.widget.Button",
  text: "Network & internet",
  bounds: { x1: 100, y1: 200, x2: 900, y2: 400 },
  clickable: true,
};
// A second indexable element far away → index 1, centred at (500, 1500).
const ROW_EL_2 = {
  index: 2,
  className: "android.widget.Button",
  text: "Connected devices",
  bounds: { x1: 100, y1: 1400, x2: 900, y2: 1600 },
  clickable: true,
};
// The `query` node shape (compact) the verify path resolves over.
const QUERY_ROW = {
  id: "android:id/title",
  text: "Network & internet",
  cd: "",
  class: "android.widget.Button",
  bounds: { x1: 100, y1: 200, x2: 900, y2: 400 },
  flags: 0,
  path: [0, 3],
};
const OUTCOME = {
  before: { version: 42, hash: "a", stateHash: "a" },
  after: { version: 43, hash: "b", stateHash: "c" },
  changed: true,
  newScreen: true,
  settled: "quiet" as const,
  firstEventMs: 5,
  idleMs: 10,
};

function makeApi(opts: { version?: number; queryNodes?: unknown[] } = {}) {
  return {
    getScreenSize: vi.fn(async () => ({
      screenWidth: 1000,
      screenHeight: 2000,
      displayRotation: 0,
    })),
    getState: vi.fn(async () => ({
      tree: [ROW_EL, ROW_EL_2],
      info: { screenWidth: 1000, screenHeight: 2000 },
      version: opts.version ?? 42,
    })),
    query: vi.fn(async () => ({
      version: 42,
      hash: "H",
      stateHash: "S",
      idHash: "I",
      nodes: opts.queryNodes ?? [QUERY_ROW],
    })),
    tap: vi.fn(async () => ({ success: true })),
    tapWithOutcome: vi.fn(async () => ({ success: true, ...OUTCOME })),
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

const OPEN_ON = (n: string) => n === "open-device-server";

beforeEach(() => {
  flagEnabledMock = OPEN_ON;
  __resetOpenServerScreenSizeCache();
  __resetIncidents();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("target only — taps by index and names the element", () => {
  it("resolves index 0 and taps its centre, returning targetIndex/targetLabel", async () => {
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      target: { index: 0, version: 42 },
    });
    expect(api.tap).toHaveBeenCalledTimes(1);
    expect(api.tap).toHaveBeenCalledWith(500, 300, {
      clickCount: 1,
      holdMs: 50,
      inject: "input-manager",
    });
    expect(result.tapped).toBe(true);
    expect(result.targetIndex).toBe(0);
    expect(result.targetLabel).toBe("Network & internet");
    expect(api.query).not.toHaveBeenCalled();
  });

  it("A2-M6/stale: a moved snapshot refuses with a structured targetCode, no tap", async () => {
    const api = makeApi({ version: 99 }); // live version != target.version
    const tool = createGestureTapTool(makeRegistry(api));
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      target: { index: 0, version: 42 },
    });
    expect(result.tapped).toBe(false);
    expect(result.targetCode).toBe("stale_index");
    expect(api.tap).not.toHaveBeenCalled();
  });
});

describe("A2-M10 — target off the open path", () => {
  it("refuses with a structured target_unsupported (never a thrown Error)", async () => {
    flagEnabledMock = () => false; // open-device-server flag off
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      target: { index: 0, version: 42 },
    });
    expect(result.tapped).toBe(false);
    expect(result.targetCode).toBe("target_unsupported");
  });
});

describe("A2-H1 — { target, verify } runs verify, never drops it", () => {
  it("target resolves the coordinate AND the selector cross-checks on the live tree → verified tap", async () => {
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      target: { index: 0, version: 42 },
      verify: { selector: { text: "Network & internet" } },
    });
    // The verify path MUST run: one query resolving the selector, then a tap at the
    // match centre (500, 300) — the same element the index resolved to.
    expect(api.query).toHaveBeenCalledTimes(1);
    expect(api.query).toHaveBeenCalledWith({ text: "Network & internet" }, { limit: 6 });
    expect(api.tapWithOutcome).toHaveBeenCalledWith(500, 300, {
      clickCount: 1,
      holdMs: 50,
      inject: "input-manager",
    });
    expect(result.verified).toBe(true);
    expect(result.tapped).toBe(true);
    expect(result.targetIndex).toBe(0);
    expect(result.targetLabel).toBe("Network & internet");
  });

  it("verify_mismatch when the index coordinate falls outside the selector's match — no tap", async () => {
    // The selector resolves a node whose bounds do NOT contain the index-0 centre
    // (500, 300): the far row. verify must refuse rather than tap by index blindly.
    const farNode = { ...QUERY_ROW, bounds: { x1: 100, y1: 1400, x2: 900, y2: 1600 } };
    const api = makeApi({ queryNodes: [farNode] });
    const tool = createGestureTapTool(makeRegistry(api));
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      target: { index: 0, version: 42 },
      verify: { selector: { text: "Network & internet" } },
    });
    expect(result.tapped).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.verifyCode).toBe("verify_mismatch");
    // verify was NOT dropped: the query ran and no tap was issued.
    expect(api.query).toHaveBeenCalledTimes(1);
    expect(api.tapWithOutcome).not.toHaveBeenCalled();
    expect(api.tap).not.toHaveBeenCalled();
  });

  it("verify_not_found when the selector matches nothing — verify still runs, no tap", async () => {
    const api = makeApi({ queryNodes: [] });
    const tool = createGestureTapTool(makeRegistry(api));
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      target: { index: 0, version: 42 },
      verify: { selector: { text: "Nope" } },
    });
    expect(result.verified).toBe(false);
    expect(result.verifyCode).toBe("verify_not_found");
    expect(api.tapWithOutcome).not.toHaveBeenCalled();
  });
});
