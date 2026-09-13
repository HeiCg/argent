import { describe, expect, it, vi } from "vitest";

let flagEnabledMock: (name: string) => boolean = () => false;
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => flagEnabledMock(name) };
});

import { Registry, ToolNotFoundError } from "@argent/registry";
import { runNavigation } from "../src/screen-graph/navigate";
import type { PlanStep } from "../src/screen-graph/plan";
import { createNavigateToTool, NAVIGATE_TO_TOOL_ID } from "../src/tools/navigate-to";

const step = (to: string): PlanStep => ({ action: { kind: "tap", target: { text: to } }, to });

describe("runNavigation", () => {
  it("runs the happy path of 3 edges, verifying each hash", async () => {
    const steps = [step("b"), step("c"), step("d")];
    const seen: string[] = [];
    const result = await runNavigation("a", steps, {
      execute: async (action, s) => {
        seen.push(s.to);
        return { afterHash: s.to };
      },
    });
    expect(result).toEqual({ ok: true, completedSteps: 3, finalHash: "d" });
    expect(seen).toEqual(["b", "c", "d"]);
  });

  it("stops and reports divergence at step 2", async () => {
    const steps = [step("b"), step("c"), step("d")];
    let call = 0;
    const result = await runNavigation("a", steps, {
      execute: async () => {
        call += 1;
        return { afterHash: call === 1 ? "b" : "x" }; // step 2 lands on the wrong screen
      },
    });
    expect(result.ok).toBe(false);
    expect(result.completedSteps).toBe(1);
    expect(result.finalHash).toBe("x");
    expect(result.divergence).toEqual({ reachedStep: 2, expected: "c", actual: "x" });
    // No further steps attempted.
    expect(call).toBe(2);
  });

  it("accepts a drifted arrival via the tolerant `matches` predicate (C.4)", async () => {
    // The device lands on a hash that DIFFERS from the plan's `to`, but a tolerant
    // matcher (resource-id Jaccard in the tool) accepts it as the same screen.
    const steps = [step("b"), step("c")];
    const result = await runNavigation("a", steps, {
      execute: async (_action, s) => ({ afterHash: `${s.to}-drifted`, afterResourceIds: [s.to] }),
      matches: (s, outcome) => (outcome.afterResourceIds ?? []).includes(s.to),
    });
    expect(result.ok).toBe(true);
    expect(result.completedSteps).toBe(2);
    expect(result.finalHash).toBe("c-drifted");
  });
});

describe("navigate-to tool flag gating", () => {
  const validParams = { udid: "emulator-5554", target: { screen: "deadbeef" } };

  it("is not invokable when the screen-graph flag is off", async () => {
    const registry = new Registry({ isFlagEnabled: () => false });
    registry.registerTool(createNavigateToTool(registry));
    await expect(registry.invokeTool(NAVIGATE_TO_TOOL_ID, validParams)).rejects.toBeInstanceOf(
      ToolNotFoundError
    );
  });

  it("declares the double gate: screen-graph flag + open-device-server hideWhen", () => {
    const registry = new Registry({ isFlagEnabled: () => true });
    const def = createNavigateToTool(registry);
    expect(def.featureFlag).toBe("screen-graph");
    // hideWhen hides the tool at the HTTP edge while open-device-server is off.
    flagEnabledMock = () => false;
    expect(def.hideWhen?.()).toBe(true);
    flagEnabledMock = () => true;
    expect(def.hideWhen?.()).toBe(false);
  });
});
