import { describe, it, expect, vi } from "vitest";
import type { Registry } from "@argent/registry";
import { createRunOnDevicesTool } from "../../src/tools/run-on-devices";
import { createRegistry } from "../../src/utils/setup-registry";

// Android-shaped serials: `resolveDevice` classifies them by shape only, so no
// real device is touched. The stub registry declares no capability, so the
// per-step capability gate is skipped.
const A = "emulator-5554";
const B = "emulator-5556";
const C = "emulator-5558";

type Call = {
  tool: string;
  udid: string;
  args: Record<string, unknown>;
  start: number;
  end: number;
};

/**
 * A registry stub at the device boundary: each invocation takes `stepMs` of
 * wall time (the latency of a real device round-trip) and is recorded with its
 * start and end, so a test can see which calls overlapped.
 */
function fakeDevices(opts: {
  stepMs?: number;
  stepMsByUdid?: Record<string, number>;
  fail?: (call: { tool: string; udid: string; index: number }) => string | undefined;
  screenshot?: (udid: string) => unknown;
}) {
  const calls: Call[] = [];
  const perUdidIndex = new Map<string, number>();
  const registry = {
    getTool: vi.fn(() => undefined),
    invokeTool: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      const udid = String(args.udid);
      const index = perUdidIndex.get(udid) ?? 0;
      perUdidIndex.set(udid, index + 1);
      const start = performance.now();
      const ms = opts.stepMsByUdid?.[udid] ?? opts.stepMs ?? 30;
      await new Promise((r) => setTimeout(r, ms));
      const end = performance.now();
      calls.push({ tool, udid, args, start, end });
      if (tool === "screenshot") return opts.screenshot?.(udid) ?? { image: `frame-of-${udid}` };
      const failure = opts.fail?.({ tool, udid, index });
      if (failure) throw new Error(failure);
      return { ok: true, udid };
    }),
  } as unknown as Registry;
  return { registry, calls };
}

const twoTaps = [
  { tool: "gesture-tap", args: { x: 0.5, y: 0.3 }, delayMs: 0 },
  { tool: "gesture-tap", args: { x: 0.5, y: 0.6 }, delayMs: 0 },
];

function overlaps(a: Call, b: Call): boolean {
  return a.start < b.end && b.start < a.end;
}

describe("run-on-devices", () => {
  // Breaks if the devices run one after the other (a sequential for-await
  // instead of a parallel fan-out): no call on B would start before A's ended.
  it("runs the sequence on every device in parallel and reports each device", async () => {
    const { registry, calls } = fakeDevices({ stepMs: 40 });
    const tool = createRunOnDevicesTool(registry);

    const result = await tool.execute({}, { udids: [A, B], steps: twoTaps });

    expect(result.okCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.results.map((r) => r.udid)).toEqual([A, B]);
    for (const r of result.results) {
      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
      expect(r.steps).toHaveLength(2);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(r).not.toHaveProperty("screenshot");
    }
    // Each step reached the device with that device's own udid injected.
    expect(calls.filter((c) => c.udid === A).map((c) => c.args)).toEqual([
      { x: 0.5, y: 0.3, udid: A },
      { x: 0.5, y: 0.6, udid: A },
    ]);
    const firstA = calls.find((c) => c.udid === A)!;
    const firstB = calls.find((c) => c.udid === B)!;
    expect(overlaps(firstA, firstB)).toBe(true);
  });

  // Breaks if a device failure rejects the whole call (Promise.all instead of
  // allSettled) or if the failed device keeps running its later steps.
  it("a failure on one device skips the rest there and does not stop the other device", async () => {
    const { registry, calls } = fakeDevices({
      fail: ({ udid, index }) => (udid === A && index === 0 ? "boom on A" : undefined),
    });
    const tool = createRunOnDevicesTool(registry);

    const result = await tool.execute({}, { udids: [A, B], steps: twoTaps });

    expect(result.okCount).toBe(1);
    expect(result.failedCount).toBe(1);
    const [ra, rb] = result.results;
    expect(ra!.udid).toBe(A);
    expect(ra!.ok).toBe(false);
    expect(ra!.steps).toHaveLength(1);
    expect(ra!.error).toMatch(/boom on A/);
    expect(rb!.ok).toBe(true);
    expect(rb!.steps).toHaveLength(2);
    expect(calls.filter((c) => c.udid === A)).toHaveLength(1);
    expect(calls.filter((c) => c.udid === B)).toHaveLength(2);
  });

  // Breaks if the duplicate check is removed: the device would get both copies.
  it("rejects a duplicate device id before it runs anything", async () => {
    const { registry, calls } = fakeDevices({});
    const tool = createRunOnDevicesTool(registry);

    await expect(tool.execute({}, { udids: [A, B, A], steps: twoTaps })).rejects.toThrow(
      /duplicate/i
    );
    expect(calls).toHaveLength(0);
  });

  // Breaks if the allow-list is only checked per step while running (as
  // run-sequence does): the first tap would reach both devices.
  it("rejects a step tool outside the run-sequence allow-list before it runs anything", async () => {
    const { registry, calls } = fakeDevices({});
    const tool = createRunOnDevicesTool(registry);

    await expect(
      tool.execute(
        {},
        {
          udids: [A, B],
          steps: [
            { tool: "gesture-tap", args: { x: 0.5, y: 0.5 }, delayMs: 0 },
            { tool: "reinstall-app", args: {}, delayMs: 0 },
          ],
        }
      )
    ).rejects.toThrow(/reinstall-app.*not allowed/);
    expect(calls).toHaveLength(0);
  });

  // Breaks if the per-device lock is removed: two runs that share device A
  // would interleave their steps on A.
  it("keeps the work on one device serial when two runs share that device", async () => {
    const { registry, calls } = fakeDevices({ stepMs: 25 });
    const tool = createRunOnDevicesTool(registry);

    const [r1, r2] = await Promise.all([
      tool.execute({}, { udids: [A, B], steps: twoTaps }),
      tool.execute({}, { udids: [A, C], steps: twoTaps }),
    ]);
    expect(r1.okCount).toBe(2);
    expect(r2.okCount).toBe(2);

    const onA = calls.filter((c) => c.udid === A).sort((x, y) => x.start - y.start);
    expect(onA).toHaveLength(4);
    for (let i = 1; i < onA.length; i++) {
      expect(overlaps(onA[i - 1]!, onA[i]!)).toBe(false);
    }
    // One run's two taps finish on A before the other run's first tap starts.
    expect(onA.map((c) => c.args.y)).toEqual([0.3, 0.6, 0.3, 0.6]);
    // B and C are different devices, so they still overlap.
    const firstB = calls.find((c) => c.udid === B)!;
    const firstC = calls.find((c) => c.udid === C)!;
    expect(overlaps(firstB, firstC)).toBe(true);
  });

  // Breaks if a screenshot is taken without the option, or not attached with it.
  it("captures one final screenshot per device only when screenshots is final", async () => {
    const none = fakeDevices({ stepMs: 5 });
    const noneResult = await createRunOnDevicesTool(none.registry).execute(
      {},
      { udids: [A, B], steps: twoTaps }
    );
    expect(none.calls.filter((c) => c.tool === "screenshot")).toHaveLength(0);
    for (const r of noneResult.results) expect(r).not.toHaveProperty("screenshot");

    const final = fakeDevices({ stepMs: 5 });
    const finalResult = await createRunOnDevicesTool(final.registry).execute(
      {},
      { udids: [A, B], steps: twoTaps, screenshots: "final" }
    );
    const shots = final.calls.filter((c) => c.tool === "screenshot");
    expect(
      shots.map((c) => c.args).sort((x, y) => String(x.udid).localeCompare(String(y.udid)))
    ).toEqual([{ udid: A }, { udid: B }]);
    // The capture is the last call on each device.
    for (const udid of [A, B]) {
      const onDevice = final.calls.filter((c) => c.udid === udid);
      expect(onDevice[onDevice.length - 1]!.tool).toBe("screenshot");
    }
    expect(finalResult.results.map((r) => r.screenshot)).toEqual([
      { image: `frame-of-${A}` },
      { image: `frame-of-${B}` },
    ]);
  });

  // Breaks if the secret check is removed: the capture would show the typed
  // plaintext in a field that is not a secure-entry field.
  it("skips the final screenshot when a step carries a secret placeholder", async () => {
    const { registry, calls } = fakeDevices({ stepMs: 5 });
    const result = await createRunOnDevicesTool(registry).execute(
      {},
      {
        udids: [A, B],
        steps: [{ tool: "keyboard", args: { text: "{{secret:PASSWORD}}" }, delayMs: 0 }],
        screenshots: "final",
      }
    );
    expect(calls.filter((c) => c.tool === "screenshot")).toHaveLength(0);
    for (const r of result.results) {
      expect(r.ok).toBe(true);
      expect(r).not.toHaveProperty("screenshot");
    }
  });

  // Breaks if stopOnFirstFailure is ignored: B would run all three steps.
  it("stopOnFirstFailure stops the other devices before their next step", async () => {
    const { registry, calls } = fakeDevices({
      stepMsByUdid: { [A]: 5, [B]: 60 },
      fail: ({ udid, index }) => (udid === A && index === 0 ? "boom on A" : undefined),
    });
    const tool = createRunOnDevicesTool(registry);

    const result = await tool.execute(
      {},
      {
        udids: [A, B],
        steps: [...twoTaps, { tool: "gesture-tap", args: { x: 0.1, y: 0.1 }, delayMs: 0 }],
        stopOnFirstFailure: true,
      }
    );

    expect(result.okCount).toBe(0);
    expect(result.failedCount).toBe(2);
    const rb = result.results[1]!;
    expect(rb.ok).toBe(false);
    expect(rb.error).toMatch(/stopOnFirstFailure/);
    // B's first step was already in flight when A failed; it finishes, the rest do not run.
    expect(calls.filter((c) => c.udid === B)).toHaveLength(1);
  });

  // Breaks if the min/max bounds are dropped from the schema.
  it("accepts 2 to 8 devices and rejects fewer or more", () => {
    const { registry } = fakeDevices({});
    const schema = createRunOnDevicesTool(registry).zodSchema!;
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `emulator-${5554 + 2 * i}`);
    const parse = (n: number) => schema.safeParse({ udids: ids(n), steps: twoTaps }).success;
    expect(parse(1)).toBe(false);
    expect(parse(2)).toBe(true);
    expect(parse(8)).toBe(true);
    expect(parse(9)).toBe(false);
    expect(schema.safeParse({ udids: [A, A], steps: twoTaps }).success).toBe(false);
  });

  // Breaks if the tool is not registered or is hidden from the MCP catalog.
  it("is registered and visible to MCP clients", () => {
    const def = createRegistry().getTool("run-on-devices");
    expect(def).toBeDefined();
    expect(def!.hideWhen).toBeUndefined();
    expect(def!.featureFlag).toBeUndefined();
    expect(def!.capability).toBeUndefined();
  });
});
