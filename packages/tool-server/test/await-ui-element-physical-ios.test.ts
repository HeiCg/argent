import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import type { DescribeTreeData } from "../src/tools/describe/contract";

// The physical-iOS describe backend, stubbed: a still screen with two buttons
// and no geometry, exactly the shape the CoreDevice adapter produces.
const describeIos = vi.fn(
  async (): Promise<DescribeTreeData> => ({
    source: "coredevice-ax",
    tree: {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "AXButton",
          label: "Loading",
          frame: { x: 0.04, y: 0.2, width: 0.92, height: 0.05 },
          children: [],
        },
        {
          role: "AXButton",
          label: "Done",
          frame: { x: 0.04, y: 0.3, width: 0.92, height: 0.05 },
          children: [],
        },
      ],
    },
  })
);
vi.mock("../src/tools/describe/platforms/ios", () => ({
  describeIos: (...args: unknown[]) => describeIos(...(args as [])),
  iosRequires: [],
}));
vi.mock("../src/utils/ios-devices", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isTvOsSimulator: async () => false,
}));

import { createAwaitUiElementTool } from "../src/tools/await-ui-element";

const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";
const SIM_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

const tool = createAwaitUiElementTool({} as unknown as Registry);

/** Run the tool under fake timers, advancing until it settles. */
async function run(params: Record<string, unknown>) {
  const promise = tool.execute({}, params as never) as Promise<{
    success: boolean;
    elapsed: number;
    note?: string;
  }>;
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  for (let i = 0; i < 400 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(250);
  }
  return promise;
}

beforeEach(() => {
  describeIos.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("await-ui-element on a physical iPhone", () => {
  it("waits the device-sized default, not the 5s simulator one", async () => {
    // A CoreDevice read is a ~2s round trip, so the 5s default fits barely two
    // polls and times out on an element that merely took a moment to appear —
    // the same measurement that gave `await-screen-idle` a device default.
    const physical = await run({
      udid: PHYSICAL_UDID,
      condition: "exists",
      selector: { text: "Never" },
    });
    expect(physical.success).toBe(false);
    expect(physical.elapsed).toBeGreaterThanOrEqual(15_000);

    const sim = await run({ udid: SIM_UDID, condition: "exists", selector: { text: "Never" } });
    expect(sim.success).toBe(false);
    expect(sim.elapsed).toBeLessThan(10_000);
  });

  it("honours an explicit timeoutMs over the device default", async () => {
    const r = await run({
      udid: PHYSICAL_UDID,
      condition: "exists",
      selector: { text: "Never" },
      timeoutMs: 1_000,
    });
    expect(r.elapsed).toBeLessThan(5_000);
  });

  it("says in the answer that visible/hidden/text came from a rotating, geometry-free read", async () => {
    // The README documents the limitation; nothing at the point of use did, so a
    // caller reading `success: true` had no way to know `visible` answered from a
    // synthesised frame or that `text` may inspect a different match next poll.
    const visible = await run({
      udid: PHYSICAL_UDID,
      condition: "visible",
      selector: { text: "Done" },
    });
    expect(visible.success).toBe(true);
    expect(visible.note).toMatch(/no element geometry/i);
    expect(visible.note).toMatch(/rotated by one/i);

    const text = await run({
      udid: PHYSICAL_UDID,
      condition: "text",
      selector: { role: "button" },
      expectedText: "Loading",
    });
    expect(text.note).toMatch(/rotated by one/i);
  });

  it("keeps the condition caveat even when the read's own hint overlaps it", async () => {
    // The timeout note folds in describe's hint, which also mentions the
    // rotation. Suppressing the append on that overlap would drop the half that
    // says what `visible` / `text` MEAN on such a read — the part the verdict is
    // read against — to avoid repeating one clause.
    const withHint = async () => ({
      source: "coredevice-ax" as const,
      hint: "…each call returns the same elements rotated by one; use screenshot for positions.",
      tree: {
        role: "AXGroup",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [
          {
            role: "AXButton",
            label: "Done",
            frame: { x: 0.04, y: 0.3, width: 0.92, height: 0.05 },
            children: [],
          },
        ],
      },
    });
    const original = describeIos.getMockImplementation()!;
    describeIos.mockImplementation(withHint as never);
    try {
      const r = await run({
        udid: PHYSICAL_UDID,
        condition: "visible",
        selector: { text: "Nope" },
        timeoutMs: 1_000,
      });
      expect(r.note, "describe's own hint must survive").toMatch(/use screenshot for positions/);
      expect(r.note, "and so must what the condition means here").toMatch(
        /answer the same as `exists`/
      );
    } finally {
      describeIos.mockImplementation(original);
    }
  });

  it("leaves `exists` and a simulator unannotated", async () => {
    // `exists` asks only whether the selector matched, which neither the missing
    // geometry nor the rotation changes — annotating it would be noise.
    const exists = await run({
      udid: PHYSICAL_UDID,
      condition: "exists",
      selector: { text: "Done" },
    });
    expect(exists.success).toBe(true);
    expect(exists.note).toBeUndefined();

    const sim = await run({ udid: SIM_UDID, condition: "visible", selector: { text: "Done" } });
    expect(sim.success).toBe(true);
    expect(sim.note).toBeUndefined();
  });
});
