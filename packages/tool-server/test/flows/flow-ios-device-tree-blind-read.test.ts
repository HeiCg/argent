import { describe, expect, it, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { IosDeviceRunnerApi } from "../../src/blueprints/ios-device-runner";
import type { RunnerSnapshotNode } from "../../src/utils/ios-device/runner-commands";
import { setCurrentIosDeviceApp } from "../../src/utils/ios-device/app-session";
import { describeIosDevice } from "../../src/tools/describe/platforms/ios-device";
import { queryIosDeviceFlowTree } from "../../src/tools/flows/flow-ios-tree";

// The physical-device half of the no-windows contract (see
// flow-ios-tree-no-windows.test.ts for the simulator half): on a zero-node
// runner snapshot describeIosDevice returns a childless Application root plus
// a hint — the right shape for describe/await, which surface the hint. The
// flow tree source must THROW on that shape instead: settleTree reads only
// `.tree`, so two blind reads fingerprint identical and "settle", and the step
// then fails with a misleading offscreen hint while the runner's own hint is
// dropped.

const DEVICE_UDID = "00008110-000978540290401E";
const APP = "com.example.app";

const IOS_DEVICE = {
  id: DEVICE_UDID,
  platform: "ios",
  kind: "device",
} as unknown as DeviceInfo;

function node(
  partial: Partial<RunnerSnapshotNode> & { index: number; depth: number }
): RunnerSnapshotNode {
  return {
    type: "Other",
    label: null,
    identifier: null,
    value: null,
    rect: { x: 0, y: 0, width: 390, height: 844 },
    enabled: true,
    focused: null,
    selected: null,
    parentIndex: null,
    ...partial,
  };
}

function appRoot(): RunnerSnapshotNode {
  return node({ index: 0, depth: 0, type: "Application" });
}

function continueButton(): RunnerSnapshotNode {
  return node({
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: "Button",
    label: "Continue",
    rect: { x: 16, y: 760, width: 358, height: 52 },
  });
}

function registryFor(api: IosDeviceRunnerApi): Registry {
  return { resolveService: async () => api } as unknown as Registry;
}

describe("queryIosDeviceFlowTree — blind (empty runner tree) reads", () => {
  setCurrentIosDeviceApp(DEVICE_UDID, APP);

  it("throws with the runner's own hint when the snapshot has zero nodes", async () => {
    const run = vi.fn(async () => ({ nodes: [], quality: null }));
    const registry = registryFor({ udid: DEVICE_UDID, run });

    // Fake timers ride out describeIosDevice's 1.5s settle-and-retry; the
    // rejection handler is attached before advancing so it is never unhandled.
    vi.useFakeTimers();
    try {
      const outcome = queryIosDeviceFlowTree(registry, IOS_DEVICE).then(
        () => null,
        (err: unknown) => err
      );
      await vi.advanceTimersByTimeAsync(2_000);
      const err = await outcome;
      expect(err).toBeInstanceOf(Error);
      // The runner's hint text travels verbatim — the flow author must see the
      // real cause, not the offscreen "add a scroll-to step" guess.
      expect((err as Error).message).toContain("The runner returned an empty accessibility tree.");
      expect((err as Error).message).toContain("exposes no accessibility elements");
      // The settle-and-retry ran: the throw is a second opinion, not a blip.
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // The scope fence: a degraded-QUALITY hint rides on a NON-empty tree — that
  // read has matchable nodes, so it must resolve (hint intact) rather than throw.
  it("does not throw for a degraded-quality hint on a non-empty tree", async () => {
    const run = vi.fn(async () => ({
      nodes: [appRoot(), continueButton()],
      quality: { state: "degraded", backend: "ax-fallback", reasonCode: "SNAPSHOT_TIMEOUT" },
    }));
    const registry = registryFor({ udid: DEVICE_UDID, run });

    const data = await queryIosDeviceFlowTree(registry, IOS_DEVICE);

    expect(data.source).toBe("xcuitest-runner");
    expect(data.hint).toMatch(/Snapshot quality: degraded/);
    expect(data.tree.children).toHaveLength(1);
    expect(data.tree.children[0].label).toBe("Continue");
  });

  it("passes a healthy non-empty tree through unchanged", async () => {
    const run = vi.fn(async () => ({ nodes: [appRoot(), continueButton()], quality: null }));
    const registry = registryFor({ udid: DEVICE_UDID, run });

    const viaFlow = await queryIosDeviceFlowTree(registry, IOS_DEVICE);
    const viaDescribe = await describeIosDevice(registry, IOS_DEVICE);

    expect(viaFlow).toEqual(viaDescribe);
    expect(viaFlow.hint).toBeUndefined();
    expect(viaFlow.screen).toEqual({ width: 390, height: 844 });
  });
});
