import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AXServiceApi, AXDescribeResponse } from "../src/blueprints/ax-service";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

// execute() probes the target's form factor (isTvOsSimulator) before polling —
// a real `xcrun simctl list` that never caches for this fake UDID, so it re-runs
// on every test and takes seconds under the parallel suite load. The device here
// is a plain phone shape, so pin the probe to false and keep the rest real.
vi.mock("../src/utils/ios-devices", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-devices")>(
    "../src/utils/ios-devices"
  );
  return { ...actual, isTvOsSimulator: async () => false };
});

// Android locked-device repro: the legacy uiautomator dump reports its failure
// as an in-band `ERROR:` line, which describeAndroid turns into a throwing
// FailureError — the hard, actionable error the tool must not launder into a
// latency diagnosis.
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return {
    ...actual,
    isAndroidTv: async () => false,
    adbExecOutBinary: async () => Buffer.from("ERROR: could not get idle state.", "utf-8"),
  };
});
vi.mock("../src/utils/android-screen", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/android-screen")>(
    "../src/utils/android-screen"
  );
  return { ...actual, getAndroidScreenSize: async () => ({ width: 1080, height: 2400 }) };
});

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const FRAME = { x: 0.1, y: 0.4, width: 0.8, height: 0.05 };

// AX service that walks `responses` one per call, repeating the last — lets a
// test simulate a screen that is blank, then renders, then holds still.
function makeSequencedAXService(responses: AXDescribeResponse[]): AXServiceApi {
  let i = 0;
  return {
    degraded: false,
    describe: async () => responses[Math.min(i++, responses.length - 1)],
    alertCheck: async () => false,
    ping: async () => true,
  };
}

function axResponse(elements: AXDescribeResponse["elements"]): AXDescribeResponse {
  return { alertVisible: false, screenFrame: { width: 440, height: 956 }, elements };
}

function iosRegistry(ax: AXServiceApi) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AXService:")) return ax;
      throw new Error(`unexpected service: ${urn}`);
    }),
  } as any;
}

const content = () => axResponse([{ label: "Settings", frame: FRAME, traits: ["button"] }]);

describe("await-screen-idle tool", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
  });

  it("exposes the await-screen-idle id", () => {
    expect(createAwaitScreenIdleTool(iosRegistry({} as AXServiceApi)).id).toBe("await-screen-idle");
  });

  it("settles once content renders and holds still", async () => {
    // blank, then the same content on every later poll → stable
    const tool = createAwaitScreenIdleTool(
      iosRegistry(makeSequencedAXService([axResponse([]), content()]))
    );

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 2000, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(30);
    expect(result.waitedMs).toBeLessThan(2000);
    expect(result.polls).toBeGreaterThan(1);
  });

  it("does not settle while the screen stays blank (times out)", async () => {
    const tool = createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService([axResponse([])])));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 60, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(60);
  });

  it("does not settle while content keeps changing (times out)", async () => {
    // a different label every poll never holds for minStableMs
    const changing = Array.from({ length: 30 }, (_, i) =>
      axResponse([{ label: `item-${i}`, frame: FRAME, traits: ["button"] }])
    );
    const tool = createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService(changing)));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 80, pollIntervalMs: 5, minStableMs: 40 }
    );

    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(80);
  });

  // A tree slow enough that the budget expires while a read is still in flight
  // never yields the second sample settling requires. Without the note, the
  // `settled: false` that comes back is indistinguishable from the
  // keeps-changing case above — it would assert the screen never went still
  // about a screen that was never sampled twice.
  it("reports a read that outran the budget rather than an unsettled screen", async () => {
    // Each read takes 200ms against a 300ms budget: poll 1 lands at ~200ms and
    // holds a signature, poll 2 starts at ~210ms with only ~90ms left and is
    // still in flight at the deadline.
    const slowAx: AXServiceApi = {
      degraded: false,
      describe: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return content();
      },
      alertCheck: async () => false,
      ping: async () => true,
    };
    const tool = createAwaitScreenIdleTool(iosRegistry(slowAx));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 300, pollIntervalMs: 10, minStableMs: 250 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toBeDefined();
    expect(result.note).toContain("never sampled twice");
    expect(result.note).toContain("300ms");
  });

  // The other half of the same guarantee: a screen that really is churning must
  // still come back as a plain negative, or the note stops meaning anything.
  //
  // Every read here takes real time — a tenth of the budget, so the reads are
  // plainly fast enough — because a describe that resolves within a microtask
  // is not a transport any device has.
  it("omits the note when the screen genuinely keeps changing", async () => {
    let n = 0;
    const churning: AXServiceApi = {
      degraded: false,
      describe: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return axResponse([{ label: `item-${n++}`, frame: FRAME, traits: ["button"] }]);
      },
      alertCheck: async () => false,
      ping: async () => true,
    };
    const tool = createAwaitScreenIdleTool(iosRegistry(churning));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 200, pollIntervalMs: 5, minStableMs: 150 }
    );

    expect(result.settled).toBe(false);
    expect(result.polls).toBeGreaterThan(1);
    expect(result.note).toBeUndefined();
  });

  // A hard, actionable device error (locked screen, missing helper) must reach
  // the agent as itself. Every fetch errors here, so `samples` stays 0 — without
  // an error guard that lands in the same bucket as a tree too slow to read
  // twice, and the note would tell the agent to raise timeoutMs: advice that
  // cannot help and hides the real cause.
  // A hard, actionable device error (locked screen) must reach the agent as
  // itself. Every fetch throws on the Android legacy path here — the exact
  // locked-device trigger from review — so `samples` stays 0 and, without an
  // error guard, that lands in the same bucket as a tree too slow to read twice:
  // the note would tell the agent to raise timeoutMs, advice that cannot help
  // and hides the real cause.
  it("reports a failing tree fetch instead of a slow-read diagnosis", async () => {
    const tool = createAwaitScreenIdleTool({
      resolveService: vi.fn(async () => {
        throw new Error("no android-devtools helper");
      }),
    } as any);

    const result = await tool.execute(
      {},
      { udid: "emulator-5554", timeoutMs: 200, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toContain("last tree fetch failed:");
    expect(result.note).toContain("uiautomator could not capture");
  });

  it("settles on the first non-empty read when minStableMs is 0", async () => {
    const tool = createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService([content()])));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 2000, pollIntervalMs: 50, minStableMs: 0 }
    );

    expect(result.settled).toBe(true);
    expect(result.polls).toBe(1);
  });
});
