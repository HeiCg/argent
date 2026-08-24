import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { BLOCK_DIRECTIVE_KEYS, type FlowStep } from "../../src/tools/flows/flow-utils";

/**
 * The six switches over a step's kind, and the `never` bindings that make
 * forgetting a kind a build error rather than a silent wrong answer at run
 * time.
 */

const SRC = path.resolve(__dirname, "../../src/tools/flows");
const read = (file: string): string => readFileSync(path.join(SRC, file), "utf8");

/**
 * `Record` over the union rejects a missing key and an extra one alike, so a
 * kind added to `FlowStep` without a row here fails `typecheck:tests` — which
 * is what keeps the coverage assertions below from going stale.
 */
const ALL_STEP_KINDS: Record<FlowStep["kind"], true> = {
  "echo": true,
  "launch": true,
  "run": true,
  "when": true,
  "tool": true,
  "tap": true,
  "long-press": true,
  "type": true,
  "await": true,
  "assert": true,
  "idle": true,
  "wait": true,
  "scroll-to": true,
  "pinch": true,
  "rotate": true,
  "snapshot": true,
  "script": true,
};

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} is missing`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  expect(end, `${signature} has no top-level close`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function handledKinds(body: string): Set<string> {
  return new Set([...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!));
}

/**
 * The kinds {@link execLeafStep} is NOT responsible for: `run:` and the block
 * directives, dispatched before it. Read from the block registry rather than
 * restated, so a new block kind does not have to be remembered here too.
 */
const DISPATCHED_BEFORE_THE_LEAF_SWITCH = new Set<string>(["run", ...BLOCK_DIRECTIVE_KEYS]);

describe("execLeafStep's exhaustiveness guard", () => {
  it("binds `never` in its default arm", () => {
    const body = functionBody(read("flow-run.ts"), "async function execLeafStep(");
    expect(body).toMatch(/default: \{[\s\S]*?const \w+: never = step;/);
  });

  it("has an arm for every leaf step kind", () => {
    const handled = handledKinds(functionBody(read("flow-run.ts"), "async function execLeafStep("));
    for (const kind of Object.keys(ALL_STEP_KINDS)) {
      if (DISPATCHED_BEFORE_THE_LEAF_SWITCH.has(kind)) continue;
      expect(handled, `execLeafStep has no case for "${kind}"`).toContain(kind);
    }
  });

  it("leaves the two dispatched-elsewhere kinds out, rather than as dead arms", () => {
    // Excluded from the parameter type instead, which is what lets the default
    // arm bind `never` honestly.
    const body = functionBody(read("flow-run.ts"), "async function execLeafStep(");
    for (const kind of DISPATCHED_BEFORE_THE_LEAF_SWITCH) {
      expect(handledKinds(body), kind).not.toContain(kind);
    }
  });
});

describe("the other five switches over a step kind", () => {
  it.each([
    ["flow-device.ts", "export function stepRequiresDevice("],
    ["flow-run.ts", "function stepTarget("],
    ["flow-utils.ts", "function toYamlStep("],
    ["flow-utils.ts", "export function precedesLeadingLaunch("],
    ["flow-finish-recording.ts", "export function summarizeStep("],
  ])("%s %s binds `never` in its default arm", (file, signature) => {
    expect(functionBody(read(file), signature)).toMatch(
      /default: ?\{[\s\S]*?const \w+: never = (?:step|kind);/
    );
  });

  it.each([
    ["flow-device.ts", "export function stepRequiresDevice("],
    ["flow-run.ts", "function stepTarget("],
    ["flow-utils.ts", "function toYamlStep("],
    ["flow-utils.ts", "export function precedesLeadingLaunch("],
    ["flow-finish-recording.ts", "export function summarizeStep("],
  ])("%s %s has an arm for every step kind", (file, signature) => {
    const handled = handledKinds(functionBody(read(file), signature));
    for (const kind of Object.keys(ALL_STEP_KINDS)) {
      expect(handled, `${signature} has no case for "${kind}"`).toContain(kind);
    }
  });
});

/**
 * The guard in miniature, checked by `typecheck:tests` rather than at run time:
 * a switch that leaves a kind unhandled binds something other than `never` in
 * its default arm, so `@ts-expect-error` fails the typecheck if that binding
 * ever stops erroring — the proof that the same binding in `execLeafStep` is
 * load bearing.
 */
function _theNeverBindingReallyFires(step: Extract<FlowStep, { kind: "echo" | "wait" }>): void {
  switch (step.kind) {
    case "echo":
      return;
    default: {
      // @ts-expect-error `wait` is left unhandled above, so `step` is not `never`
      const unexecuted: never = step;
      void unexecuted;
    }
  }
}
void _theNeverBindingReallyFires;
