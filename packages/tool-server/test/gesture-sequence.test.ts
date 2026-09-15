/**
 * Artemis A2 §A/§B — `gesture-sequence` schema, the device `batch` payload shape,
 * skip semantics, and the index `target` resolution (stale-index refusal). All
 * device-free: the pure builders/mappers and the schema are exercised directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createGestureSequenceTool } from "../src/tools/gesture-sequence";
import {
  buildSequenceActions,
  mapSequenceResults,
  resolveIndexTarget,
  IndexTargetError,
  type SequenceStep,
} from "../src/utils/open-server-input";
import type { OpenServerElement } from "../src/tools/describe/platforms/android/open-server-tree";
import type { OpenServerBatchStepResult } from "../src/blueprints/android-open-server";

const registry = {} as never;
const SIZE = { width: 1000, height: 2000 };
// Force the DEFAULT inject strategy off so the asserted action params are clean.
let prevInject: string | undefined;
beforeEach(() => {
  prevInject = process.env.ARGENT_OPEN_INJECT_STRATEGY;
  process.env.ARGENT_OPEN_INJECT_STRATEGY = "default"; // → no `inject` param
});
afterEach(() => {
  if (prevInject === undefined) delete process.env.ARGENT_OPEN_INJECT_STRATEGY;
  else process.env.ARGENT_OPEN_INJECT_STRATEGY = prevInject;
});

const el = (
  index: number,
  bounds: OpenServerElement["bounds"],
  extra: Partial<OpenServerElement> = {}
): OpenServerElement => ({ index, className: "android.widget.Button", bounds, ...extra });

describe("gesture-sequence schema", () => {
  const schema = createGestureSequenceTool(registry).zodSchema!;

  it("accepts a mixed tap/swipe/key/wait burst", () => {
    const parsed = schema.parse({
      udid: "emulator-5554",
      steps: [
        { kind: "tap", x: 0.5, y: 0.9, delayMs: 50 },
        { kind: "wait", waitMs: 120 },
        { kind: "swipe", fromX: 0.5, fromY: 0.7, toX: 0.5, toY: 0.3, momentum: false },
        { kind: "key", key: "enter" },
        { kind: "tap", target: { index: 3, version: 42 } },
      ],
    });
    expect(parsed.steps).toHaveLength(5);
  });

  it("rejects an unknown step kind and an empty burst", () => {
    expect(() => schema.parse({ udid: "x", steps: [{ kind: "pinch" }] })).toThrow();
    expect(() => schema.parse({ udid: "x", steps: [] })).toThrow();
  });
});

describe("buildSequenceActions — device batch payload", () => {
  it("converts normalized taps/swipes to device pixels and threads delays", () => {
    const steps: SequenceStep[] = [
      { kind: "tap", x: 0.5, y: 0.5, delayMs: 40 },
      { kind: "tap", x: 0.25, y: 0.1, clickCount: 2 },
      {
        kind: "swipe",
        fromX: 0.5,
        fromY: 0.7,
        toX: 0.5,
        toY: 0.3,
        momentum: false,
        durationMs: 320,
      },
      { kind: "key", key: "enter" },
      { kind: "wait", waitMs: 150 },
    ];
    const { actions, budgetMs } = buildSequenceActions(steps, SIZE, () => ({ x: 0, y: 0 }));

    expect(actions[0]).toMatchObject({
      method: "tap",
      params: { x: 500, y: 1000, holdMs: 50 },
      delayMs: 40,
    });
    // multi-tap carries gapMs; single tap does not.
    expect(actions[1]).toMatchObject({
      method: "tap",
      params: { x: 250, y: 200, clickCount: 2, gapMs: 100 },
    });
    // swipe: duration 320 → round(320/16)=20 steps; momentum:false → holdEndMs.
    expect(actions[2]).toMatchObject({
      method: "swipe",
      params: { startX: 500, startY: 1400, endX: 500, endY: 600, steps: 20, holdEndMs: 120 },
    });
    expect(actions[3]).toMatchObject({ method: "key", params: { key: "enter" } });
    // wait is a pseudo-method whose delayMs IS the pause.
    expect(actions[4]).toEqual({ method: "wait", delayMs: 150 });
    // budget = base 15000 + 40 (delay) + 150 (wait).
    expect(budgetMs).toBe(15_000 + 40 + 150);
  });

  it("resolves an index target through the injected resolver", () => {
    const steps: SequenceStep[] = [{ kind: "tap", target: { index: 2, version: 7 } }];
    const seen: unknown[] = [];
    const { actions } = buildSequenceActions(steps, SIZE, (t) => {
      seen.push(t);
      return { x: 111, y: 222 };
    });
    expect(seen).toEqual([{ index: 2, version: 7 }]);
    expect(actions[0]).toMatchObject({ method: "tap", params: { x: 111, y: 222 } });
  });
});

describe("mapSequenceResults — skip semantics", () => {
  const steps: SequenceStep[] = [
    { kind: "tap", x: 0.5, y: 0.5 },
    { kind: "tap", x: 0.5, y: 0.5 },
    { kind: "tap", x: 0.5, y: 0.5 },
  ];

  it("stops at the first failure and reports the rest as skipped", () => {
    const results: OpenServerBatchStepResult[] = [
      { success: true, ms: 12 },
      { success: false, ms: 8 }, // failed step
      { skipped: true },
    ];
    const out = mapSequenceResults(steps, results, 99);
    expect(out.completed).toBe(1);
    expect(out.total).toBe(3);
    expect(out.totalMs).toBe(99);
    expect(out.steps[0]).toEqual({ kind: "tap", success: true, ms: 12 });
    expect(out.steps[1]).toMatchObject({ kind: "tap", success: false });
    expect(out.steps[2]).toEqual({ kind: "tap", success: false, skipped: true });
  });

  it("marks a dropped injection as a non-success carrying dropped", () => {
    const results: OpenServerBatchStepResult[] = [
      { success: true, dropped: true, ms: 5 },
      { skipped: true },
      { skipped: true },
    ];
    const out = mapSequenceResults(steps, results, 5);
    expect(out.steps[0]).toMatchObject({ dropped: true });
  });

  it("surfaces an error row as a failed step with its message", () => {
    const results: OpenServerBatchStepResult[] = [
      { error: "Method not found: wat", ms: 1 },
      { skipped: true },
      { skipped: true },
    ];
    const out = mapSequenceResults(steps, results, 1);
    expect(out.steps[0].success).toBe(false);
    expect(out.steps[0].error).toContain("Method not found");
    expect(out.completed).toBe(0);
  });

  it("counts a bare success-less echo as success (e.g. wait)", () => {
    const waitSteps: SequenceStep[] = [{ kind: "wait", waitMs: 10 }];
    const out = mapSequenceResults(waitSteps, [{ success: true, ms: 10 }], 10);
    expect(out.steps[0].success).toBe(true);
  });
});

describe("resolveIndexTarget — stale-index rule", () => {
  const tree: OpenServerElement[] = [
    el(1, { x1: 0, y1: 100, x2: 200, y2: 200 }, { text: "Network & internet", clickable: true }),
    el(2, { x1: 0, y1: 200, x2: 200, y2: 300 }, { text: "Connected devices", clickable: true }),
    el(3, { x1: 0, y1: 300, x2: 200, y2: 400 }, { text: "Apps", clickable: true }),
  ];

  it("taps the element bounds centre when the version still matches", () => {
    expect(resolveIndexTarget(tree, 42, { index: 1, version: 42 })).toEqual({ x: 100, y: 250 });
  });

  it("refuses stale_index when the device version moved", () => {
    try {
      resolveIndexTarget(tree, 43, { index: 1, version: 42 });
      throw new Error("expected stale_index");
    } catch (e) {
      expect(e).toBeInstanceOf(IndexTargetError);
      expect((e as IndexTargetError).code).toBe("stale_index");
      expect((e as Error).message).toMatch(/stale_index/);
    }
  });

  it("refuses index_out_of_range for an index off the screen", () => {
    try {
      resolveIndexTarget(tree, 42, { index: 9, version: 42 });
      throw new Error("expected index_out_of_range");
    } catch (e) {
      expect((e as IndexTargetError).code).toBe("index_out_of_range");
    }
  });

  it("still resolves when the live version is unknown (no fingerprints)", () => {
    expect(resolveIndexTarget(tree, undefined, { index: 0, version: 42 })).toEqual({
      x: 100,
      y: 150,
    });
  });
});
