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

import { createGestureSwipeTool } from "../src/tools/gesture-swipe";

const ANDROID_SERIAL = "emulator-5554";

// Screen 1000x2000: a fixed header, a vertical list (#list) and a horizontal
// carousel (#carousel) nested at the top of the list.
const HEADER = { x1: 0, y1: 0, x2: 1000, y2: 300 };
const LIST = { x1: 0, y1: 300, x2: 1000, y2: 1900 };
const CAROUSEL = { x1: 0, y1: 400, x2: 1000, y2: 700 };

function tree() {
  return [
    {
      index: 1,
      className: "LinearLayout",
      resourceId: "header",
      bounds: HEADER,
      scrollable: false,
    },
    { index: 2, className: "RecyclerView", resourceId: "list", bounds: LIST, scrollable: true },
    {
      index: 3,
      className: "RecyclerView",
      resourceId: "carousel",
      bounds: CAROUSEL,
      scrollable: true,
    },
    {
      index: 4,
      className: "TextView",
      text: "Row 3",
      bounds: { x1: 32, y1: 1500, x2: 968, y2: 1560 },
      scrollable: false,
    },
  ];
}

const OUTCOME = {
  before: { version: 1, hash: "aaaa", stateHash: "aaaa" },
  after: { version: 2, hash: "aaaa", stateHash: "cccc" },
  changed: true,
  newScreen: false,
  settled: "quiet",
  firstEventMs: 18,
  idleMs: 20,
};

const TIMING = { deliveredMs: 412, heldMs: 121, injectMs: 412 };

function makeOpenApi(
  scroll: (opts: unknown) => Promise<unknown> = async () => ({
    accepted: true,
    performed: 1,
    stableHash: "s1",
    settledMs: 140,
  })
) {
  return {
    getInfo: vi.fn(async () => ({
      screenWidth: 1000,
      screenHeight: 2000,
      currentPackage: "",
      keyboardVisible: false,
      displayRotation: 0,
    })),
    getScreenSize: vi.fn(async () => ({
      screenWidth: 1000,
      screenHeight: 2000,
      displayRotation: 0,
    })),
    getState: vi.fn(async () => ({ tree: tree() })),
    scrollContainer: vi.fn(scroll),
    swipe: vi.fn(async () => ({ success: true, ...TIMING })),
    swipeWithOutcome: vi.fn(async () => ({ success: true, ...OUTCOME, ...TIMING })),
  };
}

function makeTool(openApi: unknown) {
  const registry = {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
  return createGestureSwipeTool(registry);
}

// Start inside the list, finger moves up: reveals later rows.
const up = { udid: ANDROID_SERIAL, fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.3, momentum: false };
const action = { ...up, scrollAction: true };

type SwipeResult = {
  swiped: boolean;
  method?: string;
  heldMs?: number;
  injectMs?: number;
  outcome?: { before: { hash: string }; after: { hash: string; stateHash: string } } & Record<
    string,
    unknown
  >;
  scroll?: { accepted: boolean; performed: number; reason?: string };
};

beforeEach(() => {
  flagEnabledMock = (n) => n === "open-device-server";
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("gesture-swipe momentum:false stays a motion swipe (review round 1)", () => {
  it("swipes by motion inside a scrollable, with no tree read and no scroll action", async () => {
    const api = makeOpenApi();
    const result = (await makeTool(api).execute({}, up)) as SwipeResult;
    expect(api.scrollContainer).not.toHaveBeenCalled();
    expect(api.getState).not.toHaveBeenCalled();
    expect(api.swipe).toHaveBeenCalledTimes(1);
    const args = api.swipe.mock.calls[0] as unknown[];
    expect(args[5]).toBeGreaterThan(0); // momentum-free: held before the lift
    expect(result.method).toBe("motion");
  });

  it("keeps a plain (momentum) swipe on the motion path", async () => {
    const api = makeOpenApi();
    const result = (await makeTool(api).execute({}, { ...up, momentum: undefined })) as SwipeResult;
    expect(api.scrollContainer).not.toHaveBeenCalled();
    expect(api.swipe).toHaveBeenCalledTimes(1);
    expect(result.method).toBe("motion");
  });
});

describe("gesture-swipe scrollAction:true scrolls by accessibility action (opt-in)", () => {
  it("scrolls the list forward for a finger moving up, with no touch swipe", async () => {
    const api = makeOpenApi();
    const result = (await makeTool(api).execute({}, action)) as SwipeResult;

    expect(api.scrollContainer).toHaveBeenCalledTimes(1);
    expect(api.scrollContainer).toHaveBeenCalledWith({
      nodeId: "0,300,1000,1900",
      resourceId: "list",
      direction: "forward",
      count: 1,
    });
    expect(api.swipe).not.toHaveBeenCalled();
    expect(api.swipeWithOutcome).not.toHaveBeenCalled();
    expect(result.swiped).toBe(true);
    expect(result.method).toBe("scroll-action");
    expect(result.scroll).toEqual({ accepted: true, performed: 1 });
  });

  it("scrolls backward for a finger moving down", async () => {
    const api = makeOpenApi();
    await makeTool(api).execute({}, { ...action, fromY: 0.5, toY: 0.9 });
    expect(api.scrollContainer).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "list", direction: "backward" })
    );
  });

  it("targets the smallest scrollable under the start point (a nested carousel)", async () => {
    const api = makeOpenApi();
    // y = 0.275 * 2000 = 550: inside the carousel, which sits inside the list.
    await makeTool(api).execute({}, { ...action, fromX: 0.8, fromY: 0.275, toX: 0.2, toY: 0.275 });
    expect(api.scrollContainer).toHaveBeenCalledWith({
      nodeId: "0,400,1000,700",
      resourceId: "carousel",
      direction: "forward",
      count: 1,
    });
  });

  it("takes only the sense of the swipe: a horizontal swipe on a vertical list scrolls it", async () => {
    // The action scrolls the list on its own axis; finger left = forward.
    const api = makeOpenApi();
    await makeTool(api).execute({}, { ...action, fromX: 0.8, fromY: 0.8, toX: 0.2, toY: 0.8 });
    expect(api.scrollContainer).toHaveBeenCalledWith({
      nodeId: "0,300,1000,1900",
      resourceId: "list",
      direction: "forward",
      count: 1,
    });
    expect(api.swipe).not.toHaveBeenCalled();
  });

  it("maps finger right to backward and the dominant component wins", async () => {
    const api = makeOpenApi();
    await makeTool(api).execute({}, { ...action, fromX: 0.2, fromY: 0.8, toX: 0.8, toY: 0.75 });
    expect(api.scrollContainer).toHaveBeenLastCalledWith(
      expect.objectContaining({ direction: "backward" })
    );
    // Mostly vertical, slightly right: up dominates -> forward.
    await makeTool(api).execute({}, { ...action, fromX: 0.4, fromY: 0.8, toX: 0.5, toY: 0.3 });
    expect(api.scrollContainer).toHaveBeenLastCalledWith(
      expect.objectContaining({ direction: "forward" })
    );
  });

  it("scrolls a horizontal carousel with a vertical swipe (no axis check)", async () => {
    const api = makeOpenApi();
    await makeTool(api).execute({}, { ...action, fromX: 0.5, fromY: 0.275, toX: 0.5, toY: 0.05 });
    expect(api.scrollContainer).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "carousel", direction: "forward" })
    );
  });

  it("refuses scrollAction combined with verify, with no input", async () => {
    const api = makeOpenApi();
    await expect(
      makeTool(api).execute({}, { ...action, verify: { selector: { id: "list" } } } as never)
    ).rejects.toThrow(/scrollAction cannot be combined with verify/);
    expect(api.scrollContainer).not.toHaveBeenCalled();
    expect(api.swipe).not.toHaveBeenCalled();
    expect(api.getState).not.toHaveBeenCalled();
  });

  it("refuses a start point in no scrollable", async () => {
    const api = makeOpenApi();
    await expect(makeTool(api).execute({}, { ...action, fromY: 0.1, toY: 0.05 })).rejects.toThrow(
      /no scrollable container/
    );
    expect(api.swipe).not.toHaveBeenCalled();
  });

  it("reports a refused action (list end) without a motion fallback", async () => {
    const api = makeOpenApi(async () => ({
      accepted: false,
      performed: 0,
      stableHash: "s0",
      settledMs: 0,
      reason: "no-change",
    }));
    const result = (await makeTool(api).execute({}, action)) as SwipeResult;
    expect(api.swipe).not.toHaveBeenCalled();
    expect(result.swiped).toBe(false);
    expect(result.method).toBe("scroll-action");
    expect(result.scroll).toEqual({ accepted: false, performed: 0, reason: "no-change" });
  });

  it("fails when the APK has no scrollContainer RPC (no silent motion fallback)", async () => {
    const api = makeOpenApi(async () => {
      throw new Error("Method not found: scrollContainer");
    });
    await expect(makeTool(api).execute({}, action)).rejects.toThrow(/Method not found/);
    expect(api.swipe).not.toHaveBeenCalled();
  });

  it("is refused off the Android open server", async () => {
    const api = makeOpenApi();
    await expect(
      makeTool(api).execute({}, { ...action, udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" })
    ).rejects.toThrow(/scrollAction is Android open-server only/);
    flagEnabledMock = () => false;
    await expect(makeTool(api).execute({}, action)).rejects.toThrow(
      /scrollAction is Android open-server only/
    );
  });

  it("returns the before/after outcome when the screen graph is recording", async () => {
    flagEnabledMock = (n) => n === "open-device-server" || n === "screen-graph";
    const api = makeOpenApi();
    api.getState
      .mockResolvedValueOnce({
        tree: tree(),
        version: 4,
        hash: "h1",
        stateHash: "s1",
        idHash: "id1",
      } as never)
      .mockResolvedValueOnce({
        tree: tree(),
        version: 7,
        hash: "h1",
        stateHash: "s2",
        idHash: "id1",
      } as never);
    const result = (await makeTool(api).execute({}, action)) as SwipeResult;
    expect(api.getState).toHaveBeenCalledWith(expect.objectContaining({ fingerprints: true }));
    expect(result.outcome).toMatchObject({
      before: { version: 4, hash: "h1", stateHash: "s1", idHash: "id1" },
      after: { version: 7, hash: "h1", stateHash: "s2", idHash: "id1" },
      changed: true,
      newScreen: false,
      settled: "quiet",
      idleMs: 140,
    });
  });
});

describe("gesture-swipe exposes the device-measured swipe timing", () => {
  it("returns heldMs and injectMs from the plain swipe RPC", async () => {
    const api = makeOpenApi();
    const result = (await makeTool(api).execute(
      {},
      { ...up, fromY: 0.1, toY: 0.05 }
    )) as SwipeResult;
    expect(result.heldMs).toBe(121);
    expect(result.injectMs).toBe(412);
  });

  it("returns heldMs and injectMs from the outcome swipe, outside the outcome", async () => {
    flagEnabledMock = (n) => n === "open-device-server" || n === "screen-graph";
    const api = makeOpenApi();
    const result = (await makeTool(api).execute(
      {},
      { ...up, fromY: 0.1, toY: 0.05 }
    )) as SwipeResult;
    expect(api.swipeWithOutcome).toHaveBeenCalledTimes(1);
    expect(result.heldMs).toBe(121);
    expect(result.injectMs).toBe(412);
    expect(result.outcome).toEqual(OUTCOME);
  });

  it("omits the timing when the APK does not report it", async () => {
    const api = makeOpenApi();
    api.swipe.mockResolvedValueOnce({ success: true } as never);
    const result = (await makeTool(api).execute(
      {},
      { ...up, fromY: 0.1, toY: 0.05 }
    )) as SwipeResult;
    expect(result).not.toHaveProperty("heldMs");
    expect(result).not.toHaveProperty("injectMs");
  });
});
