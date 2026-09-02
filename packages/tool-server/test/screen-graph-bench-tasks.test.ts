import { describe, expect, it } from "vitest";
import {
  ALL_TASKS,
  CHROME_TASKS,
  SETTINGS_TASKS,
  validateTasks,
} from "../src/screen-graph/bench/tasks";
import type { BenchTask } from "../src/screen-graph/bench/types";

describe("screen-graph bench tasks", () => {
  it("has 10 Settings + 5 Chrome tasks, 15 total", () => {
    expect(SETTINGS_TASKS).toHaveLength(10);
    expect(CHROME_TASKS).toHaveLength(5);
    expect(ALL_TASKS).toHaveLength(15);
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
