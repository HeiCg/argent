import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Ticket A1 — verified tap / swipe (`verify: { selector }`) on the Android open
// path, plus the byte-identical default-path proof: when `verify` is ABSENT no
// `query` RPC leaves the host and the plain `tap`/`swipe` RPC is unchanged (the
// latency floors depend on this).

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
import { createGestureSwipeTool } from "../src/tools/gesture-swipe";
import { __resetOpenServerScreenSizeCache } from "../src/utils/open-server-input";
import { __resetIncidents, getIncident } from "../src/utils/open-server-incident";
import { sendCommand } from "../src/utils/simulator-client";

const ANDROID_SERIAL = "emulator-5554";

const OUTCOME_CHANGED = {
  before: { version: 1, hash: "aaaa", stateHash: "aaaa" },
  after: { version: 2, hash: "bbbb", stateHash: "cccc" },
  changed: true,
  newScreen: true,
  settled: "quiet" as const,
  firstEventMs: 5,
  idleMs: 10,
};
const OUTCOME_UNCHANGED = {
  before: { version: 5, hash: "aaaa", stateHash: "aaaa" },
  after: { version: 5, hash: "aaaa", stateHash: "aaaa" },
  changed: false,
  newScreen: false,
  settled: "no-event" as const,
  firstEventMs: -1,
  idleMs: 0,
};

// One row centered at pixel (500, 300) on a 1000×2000 screen.
const ROW = {
  id: "android:id/title",
  text: "Network & internet",
  cd: "",
  class: "android.widget.TextView",
  bounds: { x1: 100, y1: 200, x2: 900, y2: 400 },
  flags: 0,
  path: [0, 3],
};

function makeApi(opts: { nodes?: unknown[]; changed?: boolean } = {}) {
  const nodes = opts.nodes ?? [ROW];
  const outcome = opts.changed === false ? OUTCOME_UNCHANGED : OUTCOME_CHANGED;
  return {
    getScreenSize: vi.fn(async () => ({
      screenWidth: 1000,
      screenHeight: 2000,
      displayRotation: 0,
    })),
    getState: vi.fn(async () => ({ tree: [] })),
    query: vi.fn(async () => ({
      version: 42,
      hash: "H",
      stateHash: "S",
      idHash: "I",
      nodes,
    })),
    tap: vi.fn(async () => ({ success: true })),
    tapWithOutcome: vi.fn(async () => ({ success: true, ...outcome })),
    swipe: vi.fn(async () => ({ success: true })),
    swipeWithOutcome: vi.fn(async () => ({ success: true, ...OUTCOME_CHANGED })),
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

beforeEach(() => {
  flagEnabledMock = GRAPH_OFF;
  __resetOpenServerScreenSizeCache();
  __resetIncidents();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("default path (no verify) — no query RPC, plain tap unchanged", () => {
  it("gesture-tap without verify sends NO query and a plain tap", async () => {
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));
    const result = await tool.execute({} as never, { udid: ANDROID_SERIAL, x: 0.5, y: 0.15 });

    expect(api.query).not.toHaveBeenCalled();
    expect(api.tap).toHaveBeenCalledTimes(1);
    expect(api.tap).toHaveBeenCalledWith(500, 300, {
      clickCount: 1,
      holdMs: 50,
      inject: "input-manager",
    });
    expect(result.tapped).toBe(true);
    expect(Object.hasOwn(result, "verified")).toBe(false);
  });

  it("gesture-swipe without verify sends NO query and a plain swipe", async () => {
    const api = makeApi();
    const tool = createGestureSwipeTool(makeRegistry(api));
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      fromX: 0.5,
      fromY: 0.7,
      toX: 0.5,
      toY: 0.2,
      durationMs: 160,
    });

    expect(api.query).not.toHaveBeenCalled();
    expect(api.swipe).toHaveBeenCalledTimes(1);
    expect((result as { verified?: unknown }).verified).toBeUndefined();
  });
});

describe("verified tap — unique match taps the bounds center", () => {
  it("query resolves one node -> tapWithOutcome at its center, verified reply", async () => {
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));
    // guard coords (0.5, 0.15) -> px (500, 300), inside ROW bounds.
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      x: 0.5,
      y: 0.15,
      verify: { selector: { text: "Network & internet" } },
    });

    expect(api.query).toHaveBeenCalledTimes(1);
    // limit 6 = 5 candidates + 1 to detect >5 (A1-M3).
    expect(api.query).toHaveBeenCalledWith({ text: "Network & internet" }, { limit: 6 });
    expect(api.tapWithOutcome).toHaveBeenCalledTimes(1);
    expect(api.tapWithOutcome).toHaveBeenCalledWith(500, 300, {
      clickCount: 1,
      holdMs: 50,
      inject: "input-manager",
    });
    expect(result.verified).toBe(true);
    expect(result.tapped).toBe(true);
    expect(result.resolvedBounds).toEqual(ROW.bounds);
    expect(result.version).toBe(42);
    expect(typeof result.verifyMs).toBe("number");
    // A changed tap clears any incident.
    expect(getIncident(ANDROID_SERIAL)).toBeUndefined();
  });

  it("a landed-but-no-effect verified tap records a `no_effect` incident", async () => {
    const api = makeApi({ changed: false });
    const tool = createGestureTapTool(makeRegistry(api));
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      x: 0.5,
      y: 0.15,
      verify: { selector: { text: "Network & internet" } },
    });
    expect(result.verified).toBe(true);
    expect(getIncident(ANDROID_SERIAL)?.code).toBe("no_effect");
  });
});

describe("verified tap — refusals issue no tap and record an incident", () => {
  it("zero matches -> verify_not_found, no tap, no proprietary fallback", async () => {
    const api = makeApi({ nodes: [] });
    const tool = createGestureTapTool(makeRegistry(api));
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      x: 0.5,
      y: 0.15,
      verify: { selector: { text: "Nonexistent" } },
    });
    expect(api.tap).not.toHaveBeenCalled();
    expect(api.tapWithOutcome).not.toHaveBeenCalled();
    expect(result.tapped).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.verifyCode).toBe("verify_not_found");
    expect(result.version).toBe(42);
    expect(getIncident(ANDROID_SERIAL)?.code).toBe("verify_not_found");
  });

  it("several matches -> verify_ambiguous with candidates", async () => {
    const second = { ...ROW, text: "Battery", bounds: { x1: 100, y1: 600, x2: 900, y2: 800 } };
    const api = makeApi({ nodes: [ROW, second] });
    const tool = createGestureTapTool(makeRegistry(api));
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      x: 0.5,
      y: 0.15,
      verify: { selector: { id: "android:id/title" } },
    });
    expect(api.tapWithOutcome).not.toHaveBeenCalled();
    expect(result.verifyCode).toBe("verify_ambiguous");
    expect(result.candidates).toHaveLength(2);
    expect(getIncident(ANDROID_SERIAL)?.code).toBe("verify_ambiguous");
  });

  it("coords off the unique match -> verify_mismatch, returns both", async () => {
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));
    // guard coords (0.5, 0.9) -> px (500, 1800), far below ROW bounds.
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      x: 0.5,
      y: 0.9,
      verify: { selector: { text: "Network & internet" } },
    });
    expect(api.tapWithOutcome).not.toHaveBeenCalled();
    expect(result.verifyCode).toBe("verify_mismatch");
    expect(result.resolvedBounds).toEqual(ROW.bounds);
    expect(result.requestedPx).toEqual({ x: 500, y: 1800 });
    expect(result.mismatchLabel).toBe("Network & internet");
    expect(getIncident(ANDROID_SERIAL)?.code).toBe("verify_mismatch");
  });

  it("tolerancePx widens the accepted band (mismatch -> match)", async () => {
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));
    // px (500, 460) is 60px below the row bottom (400).
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      x: 0.5,
      y: 0.23,
      verify: { selector: { text: "Network & internet" }, tolerancePx: 100 },
    });
    expect(result.verified).toBe(true);
    expect(api.tapWithOutcome).toHaveBeenCalledTimes(1);
  });
});

describe("verified swipe — start point resolution", () => {
  it("unique match starts the swipe at the bounds center", async () => {
    const api = makeApi();
    const tool = createGestureSwipeTool(makeRegistry(api));
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      fromX: 0.5,
      fromY: 0.15,
      toX: 0.5,
      toY: 0.05,
      durationMs: 160,
      verify: { selector: { text: "Network & internet" } },
    });
    expect(api.query).toHaveBeenCalledTimes(1);
    expect(api.swipe).toHaveBeenCalledTimes(1);
    const args = api.swipe.mock.calls[0] as unknown[];
    // start at ROW center (500, 300); end at (500, 100).
    expect(args.slice(0, 4)).toEqual([500, 300, 500, 100]);
    expect((result as { verified?: boolean }).verified).toBe(true);
  });

  it("refuses verify_not_found without swiping", async () => {
    const api = makeApi({ nodes: [] });
    const tool = createGestureSwipeTool(makeRegistry(api));
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      fromX: 0.5,
      fromY: 0.15,
      toX: 0.5,
      toY: 0.05,
      durationMs: 160,
      verify: { selector: { text: "Nope" } },
    });
    expect(api.swipe).not.toHaveBeenCalled();
    expect((result as { verifyCode?: string }).verifyCode).toBe("verify_not_found");
  });
});

describe("A1-H3 — x/y optional under verify", () => {
  it("no coordinates + unique match -> taps the center, no requestedPx", async () => {
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));
    const result = await tool.execute(
      {} as never,
      {
        udid: ANDROID_SERIAL,
        verify: { selector: { text: "Network & internet" } },
      } as never
    );
    expect(api.tapWithOutcome).toHaveBeenCalledWith(500, 300, {
      clickCount: 1,
      holdMs: 50,
      inject: "input-manager",
    });
    expect(result.verified).toBe(true);
    expect(result.requestedPx).toBeUndefined();
  });
});

describe("A1-M5 — verify refuses verify_unsupported off the Android open path", () => {
  it("flag off (proprietary Android) -> verify_unsupported, no tap, no query", async () => {
    flagEnabledMock = () => false; // open-device-server OFF -> shouldUseOpenServer false
    const api = makeApi();
    const tool = createGestureTapTool(makeRegistry(api));
    const result = await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      x: 0.5,
      y: 0.15,
      verify: { selector: { text: "Network & internet" } },
    });
    expect(result.tapped).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.verifyCode).toBe("verify_unsupported");
    expect(api.query).not.toHaveBeenCalled();
    expect(api.tap).not.toHaveBeenCalled();
    expect(api.tapWithOutcome).not.toHaveBeenCalled();
  });

  it("gesture-swipe: flag off -> verify_unsupported, no swipe", async () => {
    flagEnabledMock = () => false;
    const api = makeApi();
    const tool = createGestureSwipeTool(makeRegistry(api));
    const result = (await tool.execute({} as never, {
      udid: ANDROID_SERIAL,
      fromX: 0.5,
      fromY: 0.15,
      toX: 0.5,
      toY: 0.05,
      durationMs: 160,
      verify: { selector: { text: "x" } },
    })) as { swiped: boolean; verifyCode?: string };
    expect(result.swiped).toBe(false);
    expect(result.verifyCode).toBe("verify_unsupported");
    expect(api.query).not.toHaveBeenCalled();
    expect(api.swipe).not.toHaveBeenCalled();
  });
});

describe("A1-H2 — a refusal is not narrated as a tap", () => {
  it("gesture-tap completedMsg names the refusal code, not 'Tapped at'", () => {
    const tool = createGestureTapTool(makeRegistry(makeApi()));
    const params = { udid: ANDROID_SERIAL, x: 0.5, y: 0.9, verify: { selector: { text: "x" } } };
    const refusal = {
      tapped: false,
      timestampMs: 0,
      verified: false,
      verifyCode: "verify_mismatch",
    };
    const msg = tool.interaction!.completedMsg!({ params, result: refusal } as never);
    expect(msg).toContain("verify_mismatch");
    expect(msg).not.toMatch(/Tapped at/);
    // A landed tap still reads as a tap.
    const ok = tool.interaction!.completedMsg!({
      params,
      result: { tapped: true, timestampMs: 0, verified: true },
    } as never);
    expect(ok).toMatch(/Tapped/);
  });

  it("gesture-swipe completedMsg names the refusal code, not 'Swiped'", () => {
    const tool = createGestureSwipeTool(makeRegistry(makeApi()));
    const params = { udid: ANDROID_SERIAL, fromX: 0.5, fromY: 0.9, toX: 0.5, toY: 0.1 };
    const refusal = {
      swiped: false,
      timestampMs: 0,
      verified: false,
      verifyCode: "verify_not_found",
    };
    const msg = tool.interaction!.completedMsg!({ params, result: refusal } as never);
    expect(msg).toContain("verify_not_found");
    expect(msg).not.toMatch(/^Swiped/);
  });
});

void sendCommand;
