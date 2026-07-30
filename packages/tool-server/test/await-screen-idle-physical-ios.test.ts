import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import type { DescribeTreeData } from "../src/tools/describe/contract";

/**
 * The CoreDevice read returns at most `PHYSICAL_IOS_AX_LIMIT` elements, starting
 * at the device's VoiceOver cursor and advancing it one step per read. Below the
 * ceiling that is a rotation of one set, which the sorted signature cancels;
 * at or above it, consecutive reads are windows over *different parts* of the
 * screen and no signature can equate them. Left to poll, a screen that never
 * moved burns the whole 15s budget and comes back `settled: false` with nothing
 * said about why.
 */
const LIMIT = 120;
let total = LIMIT + 1;
let cursor = 0;

const describeIos = vi.fn(async (): Promise<DescribeTreeData> => {
  const all = Array.from({ length: total }, (_, i) => `Row ${i}`);
  const size = Math.min(total, LIMIT);
  const window = Array.from({ length: size }, (_, k) => all[(cursor + k) % total]!);
  cursor = (cursor + 1) % total;
  return {
    source: "coredevice-ax",
    tree: {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: window.map((label, i) => ({
        role: "AXButton",
        label,
        frame: { x: 0.04, y: i / size, width: 0.92, height: 0.05 },
        children: [],
      })),
    },
  };
});
vi.mock("../src/tools/describe/platforms/ios", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  describeIos: (...a: unknown[]) => describeIos(...(a as [])),
  iosRequires: [],
}));
vi.mock("../src/utils/ios-devices", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isTvOsSimulator: async () => false,
}));

import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";

const tool = createAwaitScreenIdleTool({} as unknown as Registry);
const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";

async function run(elements: number) {
  total = elements;
  cursor = 0;
  const p = tool.execute({}, { udid: PHYSICAL_UDID } as never) as Promise<{
    settled: boolean;
    waitedMs: number;
    polls: number;
    note?: string;
  }>;
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  return p;
}

beforeEach(() => {
  describeIos.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("await-screen-idle against a still physical-iPhone screen", () => {
  it("settles while the whole screen fits in one read", async () => {
    const r = await run(LIMIT - 1);
    expect(r.settled).toBe(true);
    expect(r.note).toBeUndefined();
  });

  it("says the read is truncated instead of polling out on an unanswerable screen", async () => {
    const r = await run(LIMIT + 1);
    expect(r.settled).toBe(false);
    expect(r.note, "a bare settled:false gives the caller nothing to act on").toMatch(
      /cannot be decided/i
    );
    expect(r.note).toMatch(/screenshot/);
    // And it answers at once rather than burning the 15s device budget on reads
    // that can never agree.
    expect(r.waitedMs).toBeLessThan(2_000);
    expect(r.polls).toBeLessThanOrEqual(2);
  });

  it("leaves a simulator's tree alone, however large", async () => {
    // The ceiling is a property of the CoreDevice read, not of describe: an
    // iOS-simulator tree of the same size must still settle.
    total = LIMIT + 50;
    cursor = 0;
    describeIos.mockImplementationOnce(async () => ({
      source: "ax-service",
      tree: {
        role: "AXGroup",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: Array.from({ length: LIMIT + 50 }, (_, i) => ({
          role: "AXButton",
          label: `Row ${i}`,
          frame: { x: 0.04, y: i / (LIMIT + 50), width: 0.92, height: 0.05 },
          children: [],
        })),
      },
    }));
    const p = tool.execute({}, {
      udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
    } as never) as Promise<{ settled: boolean; note?: string }>;
    let done = false;
    void p.then(() => (done = true));
    for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(250);
    const r = await p;
    expect(r.note).toBeUndefined();
  });
});
