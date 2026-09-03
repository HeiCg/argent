import { describe, expect, it } from "vitest";
import {
  ALL_TASKS,
  CHROME_TASKS,
  SAME_SCREEN_TASKS,
  SETTINGS_TASKS,
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
