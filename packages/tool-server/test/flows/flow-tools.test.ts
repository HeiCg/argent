import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";

import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import {
  createRunFlowTool,
  type FlowRunResult,
  type FlowPrerequisiteNotice,
} from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import {
  __resetRecordingsForTesting,
  getRecordingSession,
  parseFlow,
  serializeFlow,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

// ── Helpers ──────────────────────────────────────────────────────────

function assertFlowRunResult(
  r: FlowRunResult | FlowPrerequisiteNotice
): asserts r is FlowRunResult {
  if (!("steps" in r)) {
    throw new Error(`expected FlowRunResult, got prerequisite notice: ${r.notice}`);
  }
}

let tmpDir: string;
// A second project root. Recordings are keyed by <project_root>/<name>, so it
// is what the cross-project cases address: same flow name, different project.
let otherDir: string;

function createMockRegistry(
  tools: Record<string, { result: unknown; outputHint?: string; throws?: boolean }> = {}
) {
  return {
    invokeTool: vi.fn(async (id: string) => {
      const entry = tools[id];
      if (!entry) throw new Error(`Tool "${id}" not found`);
      if (entry.throws) throw new Error(`Tool "${id}" failed`);
      return entry.result;
    }),
    getTool: vi.fn((id: string) => {
      const entry = tools[id];
      if (!entry) return undefined;
      return { outputHint: entry.outputHint };
    }),
  } as unknown as Registry;
}

async function readFlowFile(name: string, projectRoot: string = tmpDir): Promise<string> {
  return fs.readFile(path.join(projectRoot, ".argent", "flows", `${name}.yaml`), "utf8");
}

const PREREQ = "App on home screen";

// ── Setup / teardown ─────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-test-"));
  otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-test-other-"));
  __resetRecordingsForTesting();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(otherDir, { recursive: true, force: true });
});

// ── flow-start-recording ─────────────────────────────────────────────

describe("flow-start-recording", () => {
  it("creates the .argent/flows dir and a .yaml file with header", async () => {
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "test-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    expect(result.message).toContain("test-flow");

    const content = await readFlowFile("test-flow");
    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe(PREREQ);
    expect(flow.steps).toEqual([]);
  });

  it("opens a recording addressable by name + project_root", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "my-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowInsertEchoTool.execute(
      {},
      { name: "my-flow", project_root: tmpDir, message: "test" }
    );
    expect(result.message).toContain("my-flow");
  });

  it("overwrites an existing flow file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "overwrite", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "overwrite", project_root: tmpDir, message: "line1" }
    );

    // Start again with same name — should reset
    await flowStartRecordingTool.execute(
      {},
      { name: "overwrite", project_root: tmpDir, executionPrerequisite: "Different prereq" }
    );
    const content = await readFlowFile("overwrite");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
    expect(flow.executionPrerequisite).toBe("Different prereq");
  });

  it("rejects a relative project_root", async () => {
    await expect(
      flowStartRecordingTool.execute(
        {},
        { name: "relative", project_root: "./not-absolute", executionPrerequisite: PREREQ }
      )
    ).rejects.toThrow("project_root must be an absolute path");
  });
});

// ── flow-start-recording edge cases ──────────────────────────────────

describe("flow-start-recording edge cases", () => {
  it("starting a differently-named flow leaves the earlier recording live", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "first-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "second-flow", project_root: tmpDir, executionPrerequisite: "Different" }
    );

    // A second recording abandons nothing, so there is no switch to report.
    expect(result.message).toContain("second-flow");
    expect(result.message).not.toContain("first-flow");
    expect(result.restarted).toBeUndefined();
    expect(result.discardedSteps).toBeUndefined();

    // Both recordings still take steps, each addressed by its own name.
    const secondEcho = await flowInsertEchoTool.execute(
      {},
      { name: "second-flow", project_root: tmpDir, message: "goes to second" }
    );
    expect(secondEcho.message).toContain("second-flow");
    const firstEcho = await flowInsertEchoTool.execute(
      {},
      { name: "first-flow", project_root: tmpDir, message: "goes to first" }
    );
    expect(firstEcho.message).toContain("first-flow");

    // …and each file ends up holding only its own steps.
    expect(parseFlow(await readFlowFile("first-flow")).steps).toEqual([
      { kind: "echo", message: "goes to first" },
    ]);
    expect(parseFlow(await readFlowFile("second-flow")).steps).toEqual([
      { kind: "echo", message: "goes to second" },
    ]);
  });

  it("keeps same-named recordings in different projects independent", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "shared-name", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "shared-name", project_root: otherDir, executionPrerequisite: PREREQ }
    );

    // Same name, other project — a different key, so nothing was restarted.
    expect(result.restarted).toBeUndefined();
    expect(result.discardedSteps).toBeUndefined();

    await flowInsertEchoTool.execute(
      {},
      { name: "shared-name", project_root: tmpDir, message: "in first project" }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "shared-name", project_root: otherDir, message: "in second project" }
    );

    expect(parseFlow(await readFlowFile("shared-name")).steps).toEqual([
      { kind: "echo", message: "in first project" },
    ]);
    expect(parseFlow(await readFlowFile("shared-name", otherDir)).steps).toEqual([
      { kind: "echo", message: "in second project" },
    ]);
  });

  it("restarting the same flow reports the discarded steps and resets the file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, message: "will be reset" }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, message: "also reset" }
    );

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, executionPrerequisite: "Updated prereq" }
    );

    expect(result.restarted).toBe(true);
    expect(result.discardedSteps).toBe(2);
    expect(result.message).toContain("same-flow");

    // The earlier take is gone from the file too, prerequisite included.
    const flow = parseFlow(await readFlowFile("same-flow"));
    expect(flow.steps).toEqual([]);
    expect(flow.executionPrerequisite).toBe("Updated prereq");

    // The restarted recording is the live one, and it starts from empty.
    const echo = await flowInsertEchoTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, message: "new take" }
    );
    expect(parseFlow(echo.flowFile).steps).toEqual([{ kind: "echo", message: "new take" }]);
  });

  it("does not report a restart when the flow was not already recording", async () => {
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "fresh-start", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    expect(result.restarted).toBeUndefined();
    expect(result.discardedSteps).toBeUndefined();
  });
});

// ── flow-add-echo ────────────────────────────────────────────────────

describe("flow-add-echo", () => {
  it("appends an echo entry to the flow file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "echo-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowInsertEchoTool.execute(
      {},
      { name: "echo-test", project_root: tmpDir, message: "Hello world" }
    );

    expect(result.message).toContain("echo-test");
    const flow = parseFlow(result.flowFile);
    expect(flow.steps).toEqual([{ kind: "echo", message: "Hello world" }]);
  });

  it("appends multiple echo entries", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "multi-echo", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "multi-echo", project_root: tmpDir, message: "First" }
    );
    const result = await flowInsertEchoTool.execute(
      {},
      { name: "multi-echo", project_root: tmpDir, message: "Second" }
    );

    const flow = parseFlow(result.flowFile);
    expect(flow.steps).toEqual([
      { kind: "echo", message: "First" },
      { kind: "echo", message: "Second" },
    ]);
  });

  it("throws when that flow has no recording in progress", async () => {
    await expect(
      flowInsertEchoTool.execute(
        {},
        { name: "not-recording", project_root: tmpDir, message: "oops" }
      )
    ).rejects.toThrow("No active recording");
  });

  it("throws when the recording is open under a different project root", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "wrong-root", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    // Right name, wrong project — a different key, so no recording is found.
    const err = await flowInsertEchoTool
      .execute({}, { name: "wrong-root", project_root: otherDir, message: "oops" })
      .catch((e: unknown) => e as Error);

    expect(err.message).toContain("No active recording");
    // The error names the key that was asked for, and counts — without naming —
    // the recordings live under other roots, so a wrong project_root is
    // recognizable without disclosing another project's flows.
    expect(err.message).toContain(`No active recording for flow "wrong-root" in ${otherDir}`);
    expect(err.message).toContain("Active recordings: none in this project (plus 1 in other");
    expect(err.message).not.toContain(tmpDir);
  });
});

// ── flow-add-step ────────────────────────────────────────────────────

describe("flow-add-step", () => {
  it("executes the tool and records on success", async () => {
    const registry = createMockRegistry({
      tap: { result: { tapped: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "step-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await tool.execute(
      {},
      {
        name: "step-test",
        project_root: tmpDir,
        command: "tap",
        args: '{"x":0.5,"y":0.3}',
      }
    );

    expect(result.toolResult).toEqual({ tapped: true });
    const flow = parseFlow(result.flowFile);
    expect(flow.steps).toEqual([{ kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } }]);
    expect(registry.invokeTool).toHaveBeenCalledWith("tap", {
      x: 0.5,
      y: 0.3,
    });
  });

  it("propagates the request's telemetry attribution to the recorded sub-tool", async () => {
    const registry = createMockRegistry({ tap: { result: { ok: true } } });
    const tool = createFlowAddStepTool(registry);
    const release = vi.fn();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => release);
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await flowStartRecordingTool.execute(
      {},
      { name: "tele-step", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await tool.execute(
      {},
      { name: "tele-step", project_root: tmpDir, command: "tap", args: '{"x":0.5}' },
      ctx
    );

    expect(recordChildInvocation).toHaveBeenCalledOnce();
    const childId = recordChildInvocation.mock.calls[0]![0];
    // The sub-tool's own args reach the recorder so it can derive the platform.
    expect(recordChildInvocation).toHaveBeenCalledWith(childId, { x: 0.5 });
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "tap",
      { x: 0.5 },
      expect.objectContaining({ toolInvocationId: childId, recordChildInvocation })
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not record when tool fails", async () => {
    const registry = createMockRegistry({
      tap: { result: null, throws: true },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "fail-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute(
        {},
        { name: "fail-test", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
      )
    ).rejects.toThrow('Tool "tap" failed');

    const content = await readFlowFile("fail-test");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });

  it("handles omitted args", async () => {
    const registry = createMockRegistry({
      screenshot: { result: { url: "http://..." } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "no-args", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await tool.execute({}, { name: "no-args", project_root: tmpDir, command: "screenshot" });

    const content = await readFlowFile("no-args");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([{ kind: "tool", name: "screenshot", args: {} }]);
    expect(registry.invokeTool).toHaveBeenCalledWith("screenshot", {});
  });

  it("throws when that flow has no recording in progress", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await expect(
      tool.execute(
        {},
        { name: "not-recording", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
      )
    ).rejects.toThrow("No active recording");
    // The step must not run either — the recording is resolved first.
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("records a restart-app as a portable launch step (device id dropped)", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true, bundleId: "com.acme.app" } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "launch-rewrite", project_root: tmpDir });
    const result = await tool.execute(
      {},
      {
        name: "launch-rewrite",
        project_root: tmpDir,
        command: "restart-app",
        args: '{"udid":"ABC","bundleId":"com.acme.app"}',
      }
    );

    // Ran live with the full args…
    expect(registry.invokeTool).toHaveBeenCalledWith("restart-app", {
      udid: "ABC",
      bundleId: "com.acme.app",
    });
    // …but recorded the launch directive, making this an e2e flow.
    expect(parseFlow(result.flowFile).steps).toEqual([{ kind: "launch", app: "com.acme.app" }]);
  });

  it("keeps a restart-app with extra args (e.g. activity) as a raw tool step", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "launch-activity", project_root: tmpDir });
    const result = await tool.execute(
      {},
      {
        name: "launch-activity",
        project_root: tmpDir,
        command: "restart-app",
        args: '{"udid":"ABC","bundleId":"com.acme.app","activity":".Main"}',
      }
    );

    expect(parseFlow(result.flowFile).steps).toEqual([
      {
        kind: "tool",
        name: "restart-app",
        args: { bundleId: "com.acme.app", activity: ".Main" },
      },
    ]);
  });

  it("rejects a leading launch recorded into a prerequisite-bearing recording", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true } },
    });
    const tool = createFlowAddStepTool(registry);

    // A prerequisite documents a fragment; a leading launch would make it e2e —
    // contradictory, so the append must fail and record nothing.
    await flowStartRecordingTool.execute(
      {},
      { name: "contradiction", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute(
        {},
        {
          name: "contradiction",
          project_root: tmpDir,
          command: "restart-app",
          args: '{"bundleId":"com.acme.app"}',
        }
      )
    ).rejects.toThrow(/must not declare executionPrerequisite/i);

    const flow = parseFlow(await readFlowFile("contradiction"));
    expect(flow.steps).toEqual([]);
  });

  async function writeSiblingFlow(name: string, yaml: string): Promise<void> {
    await fs.writeFile(path.join(tmpDir, ".argent", "flows", `${name}.yaml`), yaml, "utf8");
  }

  it("records a flow-execute of a sibling fragment as a run: directive", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-test", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        name: "compose-test",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({
          name: "login",
          project_root: tmpDir,
          device: "ABC",
          prerequisiteAcknowledged: true,
        }),
      }
    );

    // Ran the fragment live to set up state…
    expect(result.toolResult).toEqual({ ok: true, steps: [] });
    // …but recorded the portable composition directive, not the raw tool call.
    expect(parseFlow(result.flowFile).steps).toEqual([{ kind: "run", flow: "login" }]);
  });

  it("records a run: directive when the target is an e2e flow", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-e2e", project_root: tmpDir });
    await writeSiblingFlow("other-e2e", "steps:\n  - launch: com.acme.app\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        name: "compose-e2e",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "other-e2e", project_root: tmpDir, device: "ABC" }),
      }
    );

    // e2e flows now compose via run: just like fragments — their launch runs inline.
    expect(parseFlow(result.flowFile).steps).toEqual([{ kind: "run", flow: "other-e2e" }]);
  });

  it("keeps the raw flow-execute step when the target is not a sibling", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-missing", project_root: tmpDir });

    const result = await tool.execute(
      {},
      {
        name: "compose-missing",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "elsewhere", project_root: tmpDir }),
      }
    );

    expect(result.message).toMatch(/could not resolve/i);
    expect(parseFlow(result.flowFile).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "elsewhere", project_root: tmpDir } },
    ]);
  });

  it("throws on invalid JSON in args", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "bad-json", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute(
        {},
        { name: "bad-json", project_root: tmpDir, command: "tap", args: "not valid json {{{" }
      )
    ).rejects.toThrow();

    // Flow file should remain unchanged (no step recorded)
    const content = await readFlowFile("bad-json");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });

  it("strips the devices list when recording a scoped teardown (device ids stay off disk)", async () => {
    // stop-all-simulator-servers' `devices` names the recording host's device
    // ids the same way a udid does; a recorded scoped teardown must not bake
    // that host's ids into the flow, or replay on another host stops nothing.
    const registry = createMockRegistry({
      "stop-all-simulator-servers": { result: { stopped: 1 } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "teardown-test", project_root: tmpDir });
    const result = await tool.execute(
      {},
      {
        name: "teardown-test",
        project_root: tmpDir,
        command: "stop-all-simulator-servers",
        args: JSON.stringify({ devices: ["00000000-HOST-DEVICE-ID"] }),
      }
    );

    // Ran live with the real devices to stop…
    expect(registry.invokeTool).toHaveBeenCalledWith("stop-all-simulator-servers", {
      devices: ["00000000-HOST-DEVICE-ID"],
    });
    // …but the recorded step carries no device id, keeping the flow portable.
    expect(parseFlow(result.flowFile).steps).toEqual([
      { kind: "tool", name: "stop-all-simulator-servers", args: {} },
    ]);
  });

  it("propagates error when tool is not registered in the registry", async () => {
    const registry = createMockRegistry({}); // no tools registered
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "missing-tool", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute(
        {},
        { name: "missing-tool", project_root: tmpDir, command: "nonexistent-tool", args: "{}" }
      )
    ).rejects.toThrow('Tool "nonexistent-tool" not found');

    // Flow file should remain unchanged
    const content = await readFlowFile("missing-tool");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });
});

// ── flow-finish-recording ────────────────────────────────────────────

describe("flow-finish-recording", () => {
  it("returns summary with prerequisite and clears that recording", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "finish-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "finish-test", project_root: tmpDir, message: "Step 1" }
    );

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "finish-test", project_root: tmpDir }
    );

    expect(result.message).toContain("finish-test");
    expect(result.executionPrerequisite).toBe(PREREQ);
    expect(result.steps).toBe(1);
    expect(result.summary).toEqual(["1. echo: Step 1"]);

    // The recording is gone — no more steps can be added to it.
    await expect(
      flowInsertEchoTool.execute(
        {},
        { name: "finish-test", project_root: tmpDir, message: "after finish" }
      )
    ).rejects.toThrow("No active recording");
  });

  it("leaves other recordings in progress untouched", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "finish-one", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowStartRecordingTool.execute(
      {},
      { name: "keep-going", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    await flowFinishRecordingTool.execute({}, { name: "finish-one", project_root: tmpDir });

    const result = await flowInsertEchoTool.execute(
      {},
      { name: "keep-going", project_root: tmpDir, message: "still open" }
    );
    expect(result.message).toContain("keep-going");
    expect(parseFlow(await readFlowFile("keep-going")).steps).toEqual([
      { kind: "echo", message: "still open" },
    ]);
  });

  it("throws when that flow has no recording in progress", async () => {
    await expect(
      flowFinishRecordingTool.execute({}, { name: "not-recording", project_root: tmpDir })
    ).rejects.toThrow("No active recording");
  });

  it("handles empty flow", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "empty", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "empty", project_root: tmpDir }
    );

    expect(result.steps).toBe(0);
    expect(result.summary).toEqual([]);
  });

  it("calling finish twice throws on the second call", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "double-finish", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowFinishRecordingTool.execute({}, { name: "double-finish", project_root: tmpDir });

    // Second call should fail — the recording was cleared
    await expect(
      flowFinishRecordingTool.execute({}, { name: "double-finish", project_root: tmpDir })
    ).rejects.toThrow("No active recording");
  });

  it("returns the file path so the agent knows where it was written", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "path-check", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "path-check", project_root: tmpDir }
    );

    expect(result.path).toContain(path.join(".argent", "flows"));
    expect(result.path).toContain("path-check.yaml");
  });

  it("summary includes both echo and tool steps", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const addStep = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "summary-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "summary-test", project_root: tmpDir, message: "Before tap" }
    );
    await addStep.execute(
      {},
      { name: "summary-test", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
    );

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "summary-test", project_root: tmpDir }
    );
    expect(result.summary).toEqual(["1. echo: Before tap", '2. tool: tap {"x":0.5}']);
  });

  it("distinguishes contains, equals, and regex text comparisons in the summary", async () => {
    const name = "text-comparison-summary";
    await flowStartRecordingTool.execute(
      {},
      { name, project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", `${name}.yaml`),
      serializeFlow({
        executionPrerequisite: PREREQ,
        steps: [
          {
            kind: "await",
            condition: "text",
            selector: { identifier: "status" },
            expectedText: 'Ready "now"\nnext',
            textMatch: "contains",
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "status" },
            expectedText: "Ready",
            textMatch: "equals",
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "total" },
            expectedText: "^Total: \\$\\d+\\.\\d{2}$",
            textMatch: "matches",
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "legacy-status" },
            expectedText: "Still running",
          },
        ],
      })
    );

    const result = await flowFinishRecordingTool.execute({}, { name, project_root: tmpDir });

    expect(result.summary).toEqual([
      '1. await: text {"id":"status"} contains "Ready \\"now\\"\\nnext"',
      '2. assert: text {"id":"status"} == "Ready"',
      '3. assert: text {"id":"total"} matches /^Total: \\$\\d+\\.\\d{2}$/',
      '4. assert: text {"id":"legacy-status"} contains "Still running"',
    ]);
  });

  it("renders when text guards with the same comparator spelling as await/assert", async () => {
    const name = "when-text-guard-summary";
    await flowStartRecordingTool.execute(
      {},
      { name, project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const guarded: FlowStep[] = [{ kind: "echo", message: "guarded" }];
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", `${name}.yaml`),
      serializeFlow({
        executionPrerequisite: PREREQ,
        steps: [
          {
            kind: "when",
            condition: {
              kind: "ui",
              condition: "text",
              selector: { identifier: "status" },
              expectedText: 'Ready "now"\nnext',
              textMatch: "contains",
            },
            steps: guarded,
          },
          {
            kind: "when",
            condition: {
              kind: "ui",
              condition: "text",
              selector: { identifier: "status" },
              expectedText: "Ready",
              textMatch: "equals",
            },
            steps: guarded,
          },
          {
            kind: "when",
            condition: {
              kind: "ui",
              condition: "text",
              selector: { identifier: "total" },
              expectedText: "^Total: \\$\\d+\\.\\d{2}$",
              textMatch: "matches",
            },
            steps: [...guarded, { kind: "echo", message: "and again" }],
          },
        ],
      })
    );

    const result = await flowFinishRecordingTool.execute({}, { name, project_root: tmpDir });

    expect(result.summary).toEqual([
      '1. when: text {"id":"status"} contains "Ready \\"now\\"\\nnext" (1 step)',
      '2. when: text {"id":"status"} == "Ready" (1 step)',
      '3. when: text {"id":"total"} matches /^Total: \\$\\d+\\.\\d{2}$/ (2 steps)',
    ]);
  });
});

// ── flow-execute ─────────────────────────────────────────────────────

describe("flow-execute", () => {
  // An iOS-shaped id so resolveDevice classifies it without listing devices,
  // and the runner never shells out to a real status bar (no `expect` steps).
  const DEVICE = "00000000-0000-0000-0000-0000000000ab";

  it("executes all steps in order", async () => {
    const registry = createMockRegistry({
      tap: { result: { tapped: true } },
      screenshot: {
        result: { url: "http://img", path: "/tmp/img.png" },
        outputHint: "image",
      },
    });
    const addStep = createFlowAddStepTool(registry);
    const runFlow = createRunFlowTool(registry);

    // Build a flow
    await flowStartRecordingTool.execute(
      {},
      { name: "run-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "run-test", project_root: tmpDir, message: "Tap button" }
    );
    await addStep.execute(
      {},
      { name: "run-test", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "run-test", project_root: tmpDir, message: "Take screenshot" }
    );
    await addStep.execute(
      {},
      { name: "run-test", project_root: tmpDir, command: "screenshot", args: "{}" }
    );
    await flowFinishRecordingTool.execute({}, { name: "run-test", project_root: tmpDir });

    // Reset mock call counts
    vi.mocked(registry.invokeTool).mockClear();

    // Run the flow
    const result = await runFlow.execute(
      {},
      { name: "run-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );
    assertFlowRunResult(result);

    expect(result.flow).toBe("run-test");
    expect(result.executionPrerequisite).toBe(PREREQ);
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(4);

    // Echoes
    expect(result.steps[0]).toMatchObject({ kind: "echo", status: "pass", message: "Tap button" });
    expect(result.steps[2]).toMatchObject({
      kind: "echo",
      status: "pass",
      message: "Take screenshot",
    });

    // Tool calls
    expect(result.steps[1]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "tap",
      result: { tapped: true },
      args: { x: 0.5 },
    });
    expect(result.steps[3]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "screenshot",
      result: { url: "http://img", path: "/tmp/img.png" },
      outputHint: "image",
      args: {},
    });

    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
  });

  it("propagates the request's telemetry attribution to each tool step", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
      swipe: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "tele-run.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [
          { kind: "tool", name: "tap", args: { x: 0.5 } },
          { kind: "echo", message: "between" },
          { kind: "tool", name: "swipe", args: { direction: "up" } },
        ],
      })
    );

    const release = vi.fn();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => release);
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await runFlow.execute({}, { name: "tele-run", project_root: tmpDir, device: DEVICE }, ctx);

    // Only the two tool steps dispatch; the echo step records nothing.
    expect(recordChildInvocation).toHaveBeenCalledTimes(2);
    const ids = recordChildInvocation.mock.calls.map((c) => c[0]);
    expect(new Set(ids).size).toBe(2);
    // Each step's own args reach the recorder so per-step platform can be derived.
    expect(recordChildInvocation).toHaveBeenNthCalledWith(1, ids[0], { x: 0.5 });
    expect(recordChildInvocation).toHaveBeenNthCalledWith(2, ids[1], { direction: "up" });
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      1,
      "tap",
      { x: 0.5 },
      expect.objectContaining({ toolInvocationId: ids[0], recordChildInvocation })
    );
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      2,
      "swipe",
      { direction: "up" },
      expect.objectContaining({ toolInvocationId: ids[1], recordChildInvocation })
    );
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("stops on first error", async () => {
    const registry = createMockRegistry({
      tap: { result: null, throws: true },
    });
    const runFlow = createRunFlowTool(registry);

    // Manually write a flow file in YAML format
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "echo", message: "Should not reach" },
      ],
    });
    await fs.writeFile(path.join(dir, "error-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "error-test", project_root: tmpDir, device: DEVICE }
    );
    assertFlowRunResult(result);

    // tap errors (recorded), the trailing echo is skipped.
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      status: "error",
      tool: "tap",
      reason: expect.stringContaining("failed"),
    });
    expect(result.steps[1]).toMatchObject({ kind: "echo", status: "skip" });
    expect(result.ok).toBe(false);
  });

  it("throws when flow file does not exist", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    await expect(
      runFlow.execute({}, { name: "nonexistent", project_root: tmpDir })
    ).rejects.toThrow();
  });

  it("carries outputHint from tool definition", async () => {
    const registry = createMockRegistry({
      screenshot: {
        result: { url: "http://img" },
        outputHint: "image",
      },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Ready",
      steps: [{ kind: "tool", name: "screenshot", args: { udid: "A" } }],
    });
    await fs.writeFile(path.join(dir, "hint-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "hint-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );
    assertFlowRunResult(result);

    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      outputHint: "image",
    });
  });

  it("returns executionPrerequisite from the flow file", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App freshly reloaded",
      steps: [{ kind: "echo", message: "Start" }],
    });
    await fs.writeFile(path.join(dir, "prereq-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "prereq-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );

    expect(result.executionPrerequisite).toBe("App freshly reloaded");
  });

  it("returns a notice when prerequisite exists but is not acknowledged", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Device unlocked",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "gated.yaml"), content);

    const result = await runFlow.execute({}, { name: "gated", project_root: tmpDir });

    expect(result).toMatchObject({
      flow: "gated",
      notice: expect.stringContaining("prerequisite"),
      executionPrerequisite: "Device unlocked",
    });
    // Should NOT have a steps array — it's a notice, not a run result
    expect(result).not.toHaveProperty("steps");
  });

  it("runs normally when prerequisite exists and is acknowledged", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Device unlocked",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5 } }],
    });
    await fs.writeFile(path.join(dir, "ack-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "ack-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    expect((result as { steps: unknown[] }).steps).toHaveLength(1);
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
  });

  it("runs normally when prerequisite is empty and not acknowledged", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5 } }],
    });
    await fs.writeFile(path.join(dir, "no-gate.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "no-gate", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    expect((result as { steps: unknown[] }).steps).toHaveLength(1);
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
  });

  it("returns notice when prerequisiteAcknowledged is explicitly false", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App on settings page",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "explicit-false.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "explicit-false", project_root: tmpDir, prerequisiteAcknowledged: false }
    );

    expect(result).toMatchObject({
      flow: "explicit-false",
      notice: expect.stringContaining("prerequisite"),
      executionPrerequisite: "App on settings page",
    });
    expect(result).not.toHaveProperty("steps");
  });

  it("executes an empty flow (zero steps) successfully", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [],
    });
    await fs.writeFile(path.join(dir, "empty-flow.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "empty-flow", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    expect((result as { steps: unknown[] }).steps).toEqual([]);
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("executes a flow with only echo steps (no registry calls)", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "First" },
        { kind: "echo", message: "Second" },
        { kind: "echo", message: "Third" },
      ],
    });
    await fs.writeFile(path.join(dir, "echo-only.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "echo-only", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    const steps = (result as { steps: { kind: string; status: string; message?: string }[] }).steps;
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => ({ kind: s.kind, status: s.status, message: s.message }))).toEqual([
      { kind: "echo", status: "pass", message: "First" },
      { kind: "echo", status: "pass", message: "Second" },
      { kind: "echo", status: "pass", message: "Third" },
    ]);
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("error mid-flow reports preceding successful steps", async () => {
    const registry = createMockRegistry({
      tap: { result: { tapped: true } },
      swipe: { result: null, throws: true },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "Start" },
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "tool", name: "swipe", args: { direction: "up" } },
        { kind: "echo", message: "Should not reach" },
      ],
    });
    await fs.writeFile(path.join(dir, "mid-error.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "mid-error", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    const steps = (result as { steps: { kind: string }[] }).steps;
    // echo, tap success, swipe error — then the trailing echo is skipped.
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({ kind: "echo", status: "pass", message: "Start" });
    expect(steps[1]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "tap",
      result: { tapped: true },
    });
    expect(steps[2]).toMatchObject({
      kind: "tool",
      status: "error",
      tool: "swipe",
      reason: expect.stringContaining("failed"),
    });
    expect(steps[3]).toMatchObject({ kind: "echo", status: "skip" });
  });

  it("sleeps the step's delayMs before executing it", async () => {
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    const runFlow = createRunFlowTool(registry);
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    // Small delay: the step's configured delayMs is honored before the tool
    // runs. The magnitude is irrelevant to the regression guard — without the
    // delay this completes in ~0ms, so a 25ms wait still proves the behavior
    // while keeping the test off a real ~300ms sleep.
    const delayMs = 25;
    await fs.writeFile(
      path.join(dir, "pre-delay.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "tool", name: "tap", args: { x: 0.5 }, delayMs }],
      })
    );
    const start = Date.now();
    await runFlow.execute({}, { name: "pre-delay", project_root: tmpDir, device: DEVICE });
    expect(Date.now() - start).toBeGreaterThanOrEqual(delayMs - 5);
  });

  it("does not interfere with active recording state", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);
    const addStep = createFlowAddStepTool(registry);

    // A flow to run in the recording's own project AND one in another project —
    // replay must be inert for the recording either way, and a replay under a
    // different project_root is exactly what a second agent's run looks like.
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.1 } }],
    });
    for (const root of [tmpDir, otherDir]) {
      const dir = path.join(root, ".argent", "flows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "side-effect.yaml"), content);
    }

    // Start recording a different flow
    await flowStartRecordingTool.execute(
      {},
      { name: "recording", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const before = getRecordingSession(tmpDir, "recording");
    expect(before).toBeDefined();

    // Execute saved flows — neither should affect the active recording
    await runFlow.execute({}, { name: "side-effect", project_root: tmpDir, device: DEVICE });
    await runFlow.execute({}, { name: "side-effect", project_root: otherDir, device: DEVICE });

    // The recording still points at the flow it was opened for, in its own
    // project — a replay elsewhere must not rebind name/root/file.
    const after = getRecordingSession(tmpDir, "recording");
    expect(after).toBe(before);
    expect(after).toMatchObject({
      name: "recording",
      projectRoot: tmpDir,
      filePath: path.join(tmpDir, ".argent", "flows", "recording.yaml"),
    });

    // We should still be able to add steps to the recording…
    const result = await flowInsertEchoTool.execute(
      {},
      { name: "recording", project_root: tmpDir, message: "still recording" }
    );
    expect(result.message).toContain("recording");
    await addStep.execute(
      {},
      { name: "recording", project_root: tmpDir, command: "tap", args: '{"x":0.9}' }
    );

    // …and they land in the original flow's file, not the replayed project's.
    expect(parseFlow(await readFlowFile("recording")).steps).toEqual([
      { kind: "echo", message: "still recording" },
      { kind: "tool", name: "tap", args: { x: 0.9 } },
    ]);
    await expect(readFlowFile("recording", otherDir)).rejects.toThrow();
  });
});

// ── flow-read-prerequisite ───────────────────────────────────────────

describe("flow-read-prerequisite", () => {
  it("reads the prerequisite from a saved flow", async () => {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App on home screen",
      steps: [{ kind: "echo", message: "Step 1" }],
    });
    await fs.writeFile(path.join(dir, "read-test.yaml"), content);

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "read-test", project_root: tmpDir }
    );

    expect(result.flow).toBe("read-test");
    expect(result.executionPrerequisite).toBe("App on home screen");
  });

  it("returns empty string when flow has no prerequisite", async () => {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "empty-prereq.yaml"), content);

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "empty-prereq", project_root: tmpDir }
    );

    expect(result.flow).toBe("empty-prereq");
    expect(result.executionPrerequisite).toBe("");
  });

  it("throws when the flow file does not exist", async () => {
    await expect(
      flowReadPrerequisiteTool.execute({}, { name: "nonexistent", project_root: tmpDir })
    ).rejects.toThrow();
  });
});
