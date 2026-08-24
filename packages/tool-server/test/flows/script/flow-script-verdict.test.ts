import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import { flowStartRecordingTool } from "../../../src/tools/flows/flow-start-recording";
import { flowAddScriptTool } from "../../../src/tools/flows/flow-add-script";
import { scriptVerdict } from "../../../src/tools/flows/flow-script-step";
import { __resetRecordingsForTesting, parseFlow } from "../../../src/tools/flows/flow-utils";
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

async function recordScript(ctx?: ToolContext) {
  await flowStartRecordingTool.execute({}, { name: "recorded", project_root: root });
  return flowAddScriptTool.execute(
    {},
    {
      name: "recorded",
      project_root: root,
      path: "../../scripts/seed.mjs",
    } as never,
    ctx
  );
}

function executedRequest(): Record<string, unknown> {
  return executeMock.mock.calls[0]![0] as Record<string, unknown>;
}

async function recordedSteps() {
  return parseFlow(await fs.readFile(path.join(root, ".argent", "flows", "recorded.yaml"), "utf8"))
    .steps;
}

beforeEach(async () => {
  __resetRecordingsForTesting();
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
  __resetRecordingsForTesting();
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

/**
 * The recorder's verdict and the runner's must never disagree: a step recorded
 * green that replays red is the failure the whole tool exists to prevent, and
 * it would be invisible — the recording reported a pass. There is one
 * {@link scriptVerdict} and one path to it, so this asks the property of the
 * pair rather than restating the table a second time.
 */
describe("the recorder reports the verdict the runner will", () => {
  it.each(Object.keys(VERDICTS) as FlowScriptFailureKind[])(
    "agrees with the runner about a %s failure",
    async (kind) => {
      const result = outcome({ failure: { kind, message: `the ${kind} message` } });
      executeMock.mockResolvedValue(result);

      const replayed = await runScript();
      const recorded = await recordScript();

      expect(recorded.status).toBe(scriptVerdict(result).status);
      expect(recorded.status).toBe(replayed.status);
      expect(recorded.reason).toBe(replayed.reason);
      // No failing verdict, on either side of the fail/error line, puts a step
      // into the flow file.
      expect(await recordedSteps()).toEqual([]);
    }
  );

  it.each([
    ["queue", false],
    ["spawn", false],
    ["invalid", false],
    ["runtime", true],
    ["timeout", true],
    ["cancelled", true],
  ] as [FlowScriptFailureKind, boolean][])(
    "tells the author whether a %s failure left anything behind",
    async (kind, ran) => {
      // The executor answers three of its failures WITHOUT forking anything, so
      // "there is a result" does not mean "something ran", and telling an
      // author to clean up after a queue that was full sends them hunting for
      // state that was never created. `cancelled` counts as ran on purpose: it
      // can land either side of the fork and the result does not say which.
      executeMock.mockResolvedValue(outcome({ failure: { kind, message: `the ${kind} message` } }));

      const recorded = await recordScript();

      expect(recorded.status).not.toBe("pass");
      if (ran) {
        expect(recorded.message).toContain("is still done");
        expect(recorded.message).toContain("failed");
      } else {
        expect(recorded.message).toContain("Nothing ran, so there is nothing to clean up");
        expect(recorded.message).toContain("could not be run");
      }
      expect(await recordedSteps()).toEqual([]);
    }
  );

  it("agrees on a pass, and only then records the step", async () => {
    const result = outcome({ ok: true, output: { order: { id: 7 } }, notes: ["a note."] });
    executeMock.mockResolvedValue(result);

    const replayed = await runScript();
    const recorded = await recordScript();

    expect(recorded.status).toBe("pass");
    expect(recorded.status).toBe(replayed.status);
    expect(recorded.reason).toBe(replayed.reason);
    expect(recorded.outputJson).toBe('{"order":{"id":7}}');
    expect(await recordedSteps()).toEqual([{ kind: "script", path: "../../scripts/seed.mjs" }]);
  });

  it("hands the executor the caller's cancellation signal", async () => {
    // `longRunning` stops the adapter aborting the call, so this forwarding is
    // the only cancellation left — and a caller that gave up must not leave a
    // script holding an executor slot until the step's own time limit.
    executeMock.mockResolvedValue(outcome({ ok: true, output: {} }));
    const controller = new AbortController();

    await recordScript({ signal: controller.signal } as unknown as ToolContext);

    expect(executedRequest().signal).toBe(controller.signal);
  });

  it("passes no signal when the caller has none", async () => {
    executeMock.mockResolvedValue(outcome({ ok: true, output: {} }));

    await recordScript();

    expect("signal" in executedRequest()).toBe(false);
  });
});
