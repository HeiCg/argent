import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_TASKS,
  CHROME_TASKS,
  MULTIHOP_TASKS,
  SAME_SCREEN_TASKS,
  SETTINGS_TASKS,
  validateMultihopTasks,
  validateTasks,
} from "../src/screen-graph/bench/tasks";
import type { BenchTask } from "../src/screen-graph/bench/types";

describe("screen-graph bench tasks", () => {
  it("has 10 Settings + 5 Chrome + 5 same-screen tasks, 20 total", () => {
    expect(SETTINGS_TASKS).toHaveLength(10);
    expect(CHROME_TASKS).toHaveLength(5);
    expect(SAME_SCREEN_TASKS).toHaveLength(5);
    expect(ALL_TASKS).toHaveLength(20);
  });

  it("validates the shipped task set", () => {
    expect(() => validateTasks()).not.toThrow();
  });

  it("every task starts with a launch and ends with a usable assertion", () => {
    for (const task of ALL_TASKS) {
      expect(task.steps[0]!.action.kind).toBe("launch");
      expect(Boolean(task.assertion.id || task.assertion.text)).toBe(true);
    }
  });

  it("every same-screen task carries ≥2 sameScreen steps that do not navigate", () => {
    for (const task of SAME_SCREEN_TASKS) {
      const ss = task.steps.filter((s) => s.sameScreen);
      expect(ss.length).toBeGreaterThanOrEqual(2);
      for (const s of ss) {
        expect(s.action.kind === "launch" || s.action.kind === "back").toBe(false);
      }
    }
  });

  it("tapXY coordinates are normalized 0–1", () => {
    for (const task of SAME_SCREEN_TASKS) {
      for (const s of task.steps) {
        if (s.action.kind === "tapXY") {
          expect(s.action.x).toBeGreaterThanOrEqual(0);
          expect(s.action.x).toBeLessThanOrEqual(1);
          expect(s.action.y).toBeGreaterThanOrEqual(0);
          expect(s.action.y).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("rejects an out-of-range tapXY", () => {
    const bad: BenchTask[] = [
      {
        id: "bad",
        app: "settings",
        description: "bad tapXY",
        steps: [
          { action: { kind: "launch" } },
          { action: { kind: "tapXY", x: 1.5, y: 0.5 }, sameScreen: true },
        ],
        assertion: { text: "X" },
      },
    ];
    expect(() => validateTasks(bad)).toThrow(/normalized 0–1/);
  });

  it("rejects a sameScreen launch/back step", () => {
    const bad: BenchTask[] = [
      {
        id: "bad",
        app: "settings",
        description: "sameScreen back",
        steps: [{ action: { kind: "launch" } }, { action: { kind: "back" }, sameScreen: true }],
        assertion: { text: "X" },
      },
    ];
    expect(() => validateTasks(bad)).toThrow(/sameScreen step cannot be a back/);
  });

  it("rejects a duplicate task id", () => {
    const dupe: BenchTask[] = [SETTINGS_TASKS[0]!, SETTINGS_TASKS[0]!];
    expect(() => validateTasks(dupe)).toThrow(/duplicate task id/);
  });

  it("rejects a task that does not start with a launch", () => {
    const bad: BenchTask[] = [
      {
        id: "bad",
        app: "settings",
        description: "no launch",
        steps: [{ action: { kind: "tap", selector: { text: "X" } } }],
        assertion: { text: "X" },
      },
    ];
    expect(() => validateTasks(bad)).toThrow(/must start with a launch/);
  });

  it("no shipped task hands O5 the oracle string: navTarget !== assertion (C.4 work item E)", () => {
    for (const task of ALL_TASKS) {
      if (!task.navTarget) continue;
      const same =
        (task.navTarget.id ?? "") === (task.assertion.id ?? "") &&
        (task.navTarget.text ?? "") === (task.assertion.text ?? "");
      expect(same, `${task.id} navTarget equals its assertion`).toBe(false);
    }
  });

  it("no shipped task's query anchor is the oracle needle (C.4 work item D)", () => {
    for (const task of ALL_TASKS) {
      if (!task.query) continue;
      const same =
        (task.query.id ?? "") === (task.assertion.id ?? "") &&
        (task.query.text ?? "") === (task.assertion.text ?? "");
      expect(same, `${task.id} query equals its assertion`).toBe(false);
    }
  });

  it("rejects a navTarget equal to the assertion", () => {
    const bad: BenchTask[] = [
      {
        id: "bad",
        app: "settings",
        description: "navTarget == assertion",
        steps: [
          { action: { kind: "launch" } },
          { action: { kind: "tap", selector: { text: "X" } } },
        ],
        assertion: { text: "Y" },
        navTarget: { text: "Y" },
      },
    ];
    expect(() => validateTasks(bad)).toThrow(/navTarget must not equal the assertion/);
  });

  it("rejects an empty selector on a tap step", () => {
    const bad: BenchTask[] = [
      {
        id: "bad",
        app: "settings",
        description: "empty selector",
        steps: [{ action: { kind: "launch" } }, { action: { kind: "tap", selector: {} } }],
        assertion: { text: "X" },
      },
    ];
    expect(() => validateTasks(bad)).toThrow(/names neither id nor text/);
  });
});

/**
 * The captured Settings graph (run 33958064084): the root and its depth-1 screens
 * with their text index, and the root edges keyed by the tapped row text. It is
 * the only device capture of these screens in the tree, so hops 1 and 2 of a
 * MULTIHOP route are checked against it; hop 3 and the needle are not captured.
 */
interface FixtureGraph {
  nodes: Record<string, { label?: string; index: Record<string, unknown> }>;
  edges: Array<{ from: string; to: string; action: { kind: string; target?: { text?: string } } }>;
}
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "screen-graph-run-33958064084-settings.json"), "utf8")
) as FixtureGraph;
const ROOT = Object.keys(FIXTURE.nodes).find((h) =>
  FIXTURE.nodes[h]!.label?.startsWith("Settings:")
)!;
const texts = (hash: string): Set<string> =>
  new Set(
    Object.keys(FIXTURE.nodes[hash]!.index)
      .filter((k) => k.startsWith("text\u001f"))
      .map((k) => k.slice(5))
  );
/** The depth-1 screen the root's row `text` led to (first captured edge). */
const childOf = (text: string): string | undefined =>
  FIXTURE.edges.find(
    (e) =>
      e.from === ROOT && e.to !== ROOT && e.action.kind === "tap" && e.action.target?.text === text
  )?.to;
const taps = (task: BenchTask): string[] =>
  task.steps.flatMap((s) => (s.action.kind === "tap" ? [s.action.selector.text ?? ""] : []));

describe("MULTIHOP tasks (multi-hop navigation block)", () => {
  it("ships at least 6 Settings tasks, each at least 3 taps deep, outside the matrix list", () => {
    expect(MULTIHOP_TASKS.length).toBeGreaterThanOrEqual(6);
    for (const task of MULTIHOP_TASKS) {
      expect(task.app).toBe("settings");
      expect(task.steps[0]!.action.kind).toBe("launch");
      expect(taps(task).length, task.id).toBeGreaterThanOrEqual(3);
      expect(ALL_TASKS.some((t) => t.id === task.id)).toBe(false);
    }
  });

  it("validates the shipped MULTIHOP set", () => {
    expect(() => validateMultihopTasks()).not.toThrow();
  });

  it("rejects a task shallower than 3 hops", () => {
    const shallow: BenchTask[] = [
      {
        id: "mh-shallow",
        app: "settings",
        description: "two hops",
        steps: [
          { action: { kind: "launch" } },
          { action: { kind: "tap", selector: { text: "A" } } },
          { action: { kind: "tap", selector: { text: "B" } } },
        ],
        assertion: { text: "Z" },
      },
    ];
    expect(() => validateMultihopTasks(shallow)).toThrow(/at least 3 hops/);
  });

  it("rejects a non-tap step between the launch and the destination", () => {
    const swipe: BenchTask[] = [
      {
        id: "mh-swipe",
        app: "settings",
        description: "swipe in the route",
        steps: [
          { action: { kind: "launch" } },
          { action: { kind: "tap", selector: { text: "A" } } },
          { action: { kind: "swipe", direction: "up" } },
          { action: { kind: "tap", selector: { text: "B" } } },
          { action: { kind: "tap", selector: { text: "C" } } },
        ],
        assertion: { text: "Z" },
      },
    ];
    expect(() => validateMultihopTasks(swipe)).toThrow(/only taps/);
  });

  it("hop 1 is a row of the captured Settings root and hop 2 a row of the screen it opened", () => {
    expect(ROOT).toBeDefined();
    const root = texts(ROOT);
    for (const task of MULTIHOP_TASKS) {
      const [h1, h2] = taps(task);
      expect(root.has(h1!), `${task.id}: hop 1 "${h1}" on the root`).toBe(true);
      const child = childOf(h1!);
      expect(child, `${task.id}: a captured screen behind "${h1}"`).toBeDefined();
      expect(texts(child!).has(h2!), `${task.id}: hop 2 "${h2}" on "${h1}"`).toBe(true);
    }
  });

  it("the needle and the hop-3 row are absent from the root and the hop-1 screen", () => {
    for (const task of MULTIHOP_TASKS) {
      const [h1, , h3] = taps(task);
      const seen = new Set([...texts(ROOT), ...texts(childOf(h1!)!)]);
      const lc = [...seen].map((t) => t.toLowerCase());
      const needle = (task.assertion.text ?? "").toLowerCase();
      expect(
        lc.some((t) => t.includes(needle)),
        `${task.id}: needle "${needle}" on an earlier screen`
      ).toBe(false);
      expect(seen.has(h3!), `${task.id}: hop 3 "${h3}" on an earlier screen`).toBe(false);
    }
  });
});
