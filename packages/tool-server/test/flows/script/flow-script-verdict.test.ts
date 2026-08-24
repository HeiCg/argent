import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import type {
  FlowScriptFailureKind,
  FlowScriptResult,
} from "../../../src/tools/flows/script/flow-script-executor";

/**
 * The translation from an executor outcome to a step verdict.
 *
 * The executor is mocked here, and only here. Four of its twelve failure kinds
 * are reachable from a real script (it threw, it exited, it ran long, the run
 * was cancelled) and are covered against real processes in
 * flow-script-step-run.test.ts. The other eight need a host in trouble — a
 * process that will not start, a heap ceiling, a full queue, a runner that
 * broke its own protocol — so the seam is what makes the whole table testable
 * rather than a third of it.
 */

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../../src/tools/flows/script/flow-script-executor", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/tools/flows/script/flow-script-executor")>();
  return { ...actual, flowScriptExecutor: () => ({ execute: executeMock }) };
});

let root: string;

function outcome(over: Partial<FlowScriptResult>): FlowScriptResult {
  return {
    ok: false,
    log: "",
    logTruncated: false,
    durationMs: 1,
    queuedMs: 0,
    notes: [],
    ...over,
  };
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async () => ({ devices: [] })),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({})),
  } as unknown as Registry;
}

async function runScript(): Promise<FlowRunResult["steps"][number]> {
  const result = (await createRunFlowTool(mockRegistry()).execute({}, {
    name: "verdict",
    project_root: root,
  } as never)) as FlowRunResult;
  return result.steps[0]!;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-verdict-"));
  await fs.mkdir(path.join(root, ".argent", "flows"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  // A real file, because the step checks the path itself before it ever calls
  // the executor. Its contents never run.
  await fs.writeFile(path.join(root, "scripts", "seed.mjs"), "");
  await fs.writeFile(
    path.join(root, ".argent", "flows", "verdict.yaml"),
    "steps:\n  - script: { path: ../../scripts/seed.mjs }\n",
    "utf8"
  );
  executeMock.mockReset();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * Every failure kind and the verdict it takes, forced complete BY THE COMPILER:
 * `Record` over the union rejects a missing kind and an extra one alike, so a
 * kind added to the executor without a row here fails `typecheck:tests`.
 */
const VERDICTS: Record<FlowScriptFailureKind, "fail" | "error"> = {
  // The script's own answer.
  load: "fail",
  runtime: "fail",
  output: "fail",
  exit: "fail",
  // Everything the runner did to it.
  protocol: "error",
  timeout: "error",
  cancelled: "error",
  signal: "error",
  heap: "error",
  spawn: "error",
  queue: "error",
  invalid: "error",
};

describe("which side of the fail/error line a script failure lands on", () => {
  it.each(Object.entries(VERDICTS))("reports a %s failure as %s", async (kind, status) => {
    executeMock.mockResolvedValue(
      outcome({ failure: { kind: kind as FlowScriptFailureKind, message: `the ${kind} message` } })
    );

    expect(await runScript()).toMatchObject({
      kind: "script",
      status,
      reason: `the ${kind} message`,
    });
  });

  it("errors, rather than blaming the flow, for a result carrying no failure at all", async () => {
    // A shape `FlowScriptResult`'s own contract forbids (`failure` is present
    // exactly when `ok` is false). The default still has to be the safe one:
    // `fail` would blame the flow for something only the host can explain.
    executeMock.mockResolvedValue(outcome({ ok: false }));

    expect(await runScript()).toMatchObject({
      status: "error",
      reason: "The script produced no verdict.",
    });
  });
});

describe("an executor note on the step report", () => {
  it("rides into the reason of a step that PASSED", async () => {
    // Notes are how the executor says a time limit was clamped to the host's
    // maximum, or that the working directory it was given did not exist — and a
    // script that silently ran somewhere else is exactly the pass that must not
    // stay silent.
    executeMock.mockResolvedValue(
      outcome({
        ok: true,
        output: {},
        notes: ["timeout clamped to 300000ms.", "project_root did not exist."],
      })
    );

    expect(await runScript()).toMatchObject({
      status: "pass",
      reason: "timeout clamped to 300000ms. project_root did not exist.",
    });
  });

  it("leaves a quiet pass with no reason at all", async () => {
    executeMock.mockResolvedValue(outcome({ ok: true, output: {} }));

    const step = await runScript();
    expect(step).toMatchObject({ status: "pass" });
    expect(step).not.toHaveProperty("reason");
  });

  it("follows the failure message rather than replacing it", async () => {
    executeMock.mockResolvedValue(
      outcome({
        failure: { kind: "timeout", message: "The script ran past its 1000ms limit." },
        notes: ["timeout clamped to 1000ms."],
      })
    );

    expect(await runScript()).toMatchObject({
      status: "error",
      reason: "The script ran past its 1000ms limit. timeout clamped to 1000ms.",
    });
  });
});
