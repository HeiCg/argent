import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import type { Registry } from "@argent/registry";

import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import {
  clearAllRecordings,
  getRecordingSession,
  listActiveRecordings,
  parseFlow,
  serializeFlow,
  type FlowFile,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

/**
 * Concurrency contract of the recording tools. The tool-server is a host-wide
 * singleton shared by every MCP client, subagent and CLI call on the machine,
 * so several agents can legitimately be recording at the same moment — in one
 * project or across projects. A recording is identified by its
 * (project_root, name) key, and these tests assert the ISOLATION that follows:
 * one recording's steps never land in another's file, addressing a key that
 * isn't live fails loudly (naming the ones that are), replaying a flow
 * elsewhere rebinds nothing, and appends to one session can't lose each other.
 */

const IOS_DEVICE = "00000000-0000-0000-0000-0000000000ab";

// ── Harness ──────────────────────────────────────────────────────────

let roots: string[] = [];

/** A real temp dir standing in for one agent's project root. */
async function makeRoot(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `flow-concurrent-${label}-`));
  roots.push(dir);
  return dir;
}

function createMockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      // Yield a macrotask: flow-add-step runs the step LIVE before it appends,
      // so this is what lets several calls issued without an await in between
      // reach the append phase concurrently (see the lost-update test).
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

const registry = createMockRegistry();
const addStepTool = createFlowAddStepTool(registry);

const flowPath = (root: string, name: string): string =>
  path.join(root, ".argent", "flows", `${name}.yaml`);

function start(root: string, name: string, executionPrerequisite?: string) {
  return flowStartRecordingTool.execute({}, { name, project_root: root, executionPrerequisite });
}

/** Record a `tool` step tagged with `marker`, so its file of origin is provable. */
function addStep(root: string, name: string, marker: string) {
  return addStepTool.execute(
    {},
    {
      name,
      project_root: root,
      command: "keyboard",
      args: JSON.stringify({ text: marker }),
    }
  );
}

function addEcho(root: string, name: string, message: string) {
  return flowInsertEchoTool.execute({}, { name, project_root: root, message });
}

function finish(root: string, name: string) {
  return flowFinishRecordingTool.execute({}, { name, project_root: root });
}

async function writeSavedFlow(root: string, name: string, flow: FlowFile): Promise<void> {
  await fs.mkdir(path.dirname(flowPath(root, name)), { recursive: true });
  await fs.writeFile(flowPath(root, name), serializeFlow(flow), "utf8");
}

/** Collapse steps to their markers so a file's contents read at a glance. */
function markers(steps: FlowStep[]): string[] {
  return steps.map((step) => {
    if (step.kind === "echo") return `echo:${step.message}`;
    if (step.kind === "tool") return `tool:${String(step.args.text)}`;
    return step.kind;
  });
}

async function readMarkers(root: string, name: string): Promise<string[]> {
  return markers(parseFlow(await fs.readFile(flowPath(root, name), "utf8")).steps);
}

beforeEach(() => {
  clearAllRecordings();
  roots = [];
});

afterEach(async () => {
  clearAllRecordings();
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  roots = [];
});

// ── Two recordings, one project ──────────────────────────────────────

describe("two recordings in one project", () => {
  it("keeps interleaved steps on their own files, in order", async () => {
    const root = await makeRoot("one-project");
    await start(root, "alpha");
    await start(root, "beta");

    expect(
      listActiveRecordings()
        .map((r) => r.name)
        .sort()
    ).toEqual(["alpha", "beta"]);

    // Interleave the two recordings the way two agents sharing the server would.
    await addStep(root, "alpha", "a1");
    await addEcho(root, "beta", "b1");
    await addStep(root, "alpha", "a2");
    await addEcho(root, "beta", "b2");

    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1", "tool:a2"]);
    expect(await readMarkers(root, "beta")).toEqual(["echo:b1", "echo:b2"]);
  });

  it("finishing one leaves the other live and still appendable", async () => {
    const root = await makeRoot("one-project-finish");
    await start(root, "alpha");
    await start(root, "beta");
    await addStep(root, "alpha", "a1");
    await addEcho(root, "beta", "b1");

    const finished = await finish(root, "alpha");
    expect(finished.path).toBe(flowPath(root, "alpha"));
    expect(markers(parseFlow(finished.flowFile).steps)).toEqual(["tool:a1"]);
    expect(finished.steps).toBe(1);

    // Only alpha's key was cleared.
    expect(getRecordingSession(root, "alpha")).toBeUndefined();
    expect(getRecordingSession(root, "beta")?.filePath).toBe(flowPath(root, "beta"));

    // beta keeps recording into its own file.
    await addEcho(root, "beta", "b2");
    await addStep(root, "beta", "b3");
    const finishedB = await finish(root, "beta");
    expect(markers(parseFlow(finishedB.flowFile).steps)).toEqual(["echo:b1", "echo:b2", "tool:b3"]);
    expect(await readMarkers(root, "beta")).toEqual(["echo:b1", "echo:b2", "tool:b3"]);
    // alpha was never reopened by beta's appends.
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1"]);
  });
});

// ── One name, two project roots ──────────────────────────────────────

describe("the same flow name under two project roots", () => {
  it("records each project's steps into that project's file only", async () => {
    const rootA = await makeRoot("root-a");
    const rootB = await makeRoot("root-b");

    await start(rootA, "checkout", "Cart has one item");
    await start(rootB, "checkout", "Cart is empty");

    await addStep(rootA, "checkout", "a1");
    await addStep(rootB, "checkout", "b1");
    await addEcho(rootA, "checkout", "a2");
    await addStep(rootB, "checkout", "b2");

    expect(await readMarkers(rootA, "checkout")).toEqual(["tool:a1", "echo:a2"]);
    expect(await readMarkers(rootB, "checkout")).toEqual(["tool:b1", "tool:b2"]);

    // Sessions carry their own project root and prerequisite, not the other's.
    expect(getRecordingSession(rootA, "checkout")?.projectRoot).toBe(rootA);
    expect(getRecordingSession(rootB, "checkout")?.projectRoot).toBe(rootB);

    const finishedA = await finish(rootA, "checkout");
    expect(finishedA.path).toBe(flowPath(rootA, "checkout"));
    expect(finishedA.executionPrerequisite).toBe("Cart has one item");

    // B is untouched by A finishing, and still resolves to B's file.
    const finishedB = await finish(rootB, "checkout");
    expect(finishedB.path).toBe(flowPath(rootB, "checkout"));
    expect(finishedB.executionPrerequisite).toBe("Cart is empty");
    expect(markers(parseFlow(finishedB.flowFile).steps)).toEqual(["tool:b1", "tool:b2"]);
  });
});

// ── Addressing a key that isn't live ─────────────────────────────────

describe("addressing an unknown recording key", () => {
  async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error("expected the call to fail");
  }

  it("fails with FLOW_NO_ACTIVE_RECORDING and lists the live recordings", async () => {
    const rootA = await makeRoot("unknown-a");
    const rootB = await makeRoot("unknown-b");
    await start(rootA, "alpha");
    await start(rootB, "beta");

    const err = await captureFailure(addEcho(rootA, "never-started", "x"));

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    const message = (err as Error).message;
    expect(message).toContain('No active recording for flow "never-started"');
    expect(message).toContain(rootA);
    // The live keys are named so the agent can self-correct.
    expect(message).toContain(`"alpha" (${rootA})`);
    expect(message).toContain(`"beta" (${rootB})`);
  });

  it("fails the same way for the right name under the wrong project_root", async () => {
    const rootA = await makeRoot("wrong-root-a");
    const rootB = await makeRoot("wrong-root-b");
    await start(rootA, "alpha");

    const err = await captureFailure(addStep(rootB, "alpha", "stray"));

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect((err as Error).message).toContain(`"alpha" (${rootA})`);

    // The misdirected step was not recorded anywhere.
    expect(await readMarkers(rootA, "alpha")).toEqual([]);
    await expect(fs.stat(flowPath(rootB, "alpha"))).rejects.toThrow();
  });

  it("reports the live recordings as none when nothing is being recorded", async () => {
    const root = await makeRoot("nothing-live");
    const err = await captureFailure(finish(root, "alpha"));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect((err as Error).message).toContain("Active recordings: none.");
  });
});

// ── Concurrent appends to one session ────────────────────────────────

describe("concurrent flow-add-step calls on one recording", () => {
  it("loses no step when several appends are in flight at once", async () => {
    const root = await makeRoot("append-race");
    await start(root, "burst");

    const tags = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"];
    // Fire without awaiting in between: every call is past its live execution
    // and inside the append phase before the first one writes. appendStep is
    // read → await → write, so without the per-session mutex these would all
    // read the same file and the last write would drop the others.
    const inflight = tags.map((tag) => addStep(root, "burst", tag));
    await Promise.all(inflight);

    const recorded = await readMarkers(root, "burst");
    expect(recorded).toHaveLength(tags.length);
    expect([...recorded].sort()).toEqual(tags.map((t) => `tool:${t}`).sort());

    // The in-memory copy the session serves to flow-finish-recording agrees.
    expect(getRecordingSession(root, "burst")?.flow.steps).toHaveLength(tags.length);
    const finished = await finish(root, "burst");
    expect(finished.steps).toBe(tags.length);
  });

  it("does not serialize a second recording behind the first one's appends", async () => {
    const root = await makeRoot("append-race-two");
    await start(root, "alpha");
    await start(root, "beta");

    // Both bursts in flight together — the lock is per session, so neither
    // file may pick up the other's steps.
    await Promise.all([
      ...["a0", "a1", "a2", "a3"].map((tag) => addStep(root, "alpha", tag)),
      ...["b0", "b1", "b2", "b3"].map((tag) => addStep(root, "beta", tag)),
    ]);

    expect([...(await readMarkers(root, "alpha"))].sort()).toEqual([
      "tool:a0",
      "tool:a1",
      "tool:a2",
      "tool:a3",
    ]);
    expect([...(await readMarkers(root, "beta"))].sort()).toEqual([
      "tool:b0",
      "tool:b1",
      "tool:b2",
      "tool:b3",
    ]);
  });
});

// ── Replaying a flow while recordings are live ───────────────────────

describe("running a flow in a third project while two recordings are live", () => {
  it("rebinds neither recording's file path", async () => {
    const rootA = await makeRoot("exec-a");
    const rootB = await makeRoot("exec-b");
    const rootC = await makeRoot("exec-c");

    await start(rootA, "alpha");
    await start(rootB, "beta");
    await addStep(rootA, "alpha", "a1");
    await addEcho(rootB, "beta", "b1");

    // A saved flow belonging to a third project, replayed mid-recording.
    await writeSavedFlow(rootC, "standalone", {
      executionPrerequisite: "App on the home screen",
      steps: [{ kind: "echo", message: "replayed" }],
    });

    const prereq = await flowReadPrerequisiteTool.execute(
      {},
      { name: "standalone", project_root: rootC }
    );
    expect(prereq.executionPrerequisite).toBe("App on the home screen");

    const runResult = await createRunFlowTool(registry).execute(
      {},
      {
        name: "standalone",
        project_root: rootC,
        device: IOS_DEVICE,
        prerequisiteAcknowledged: true,
      }
    );
    expect(runResult).toHaveProperty("ok", true);

    // Both sessions still point at their own files…
    expect(getRecordingSession(rootA, "alpha")?.filePath).toBe(flowPath(rootA, "alpha"));
    expect(getRecordingSession(rootB, "beta")?.filePath).toBe(flowPath(rootB, "beta"));

    // …and subsequent steps still land there.
    await addStep(rootA, "alpha", "a2");
    await addEcho(rootB, "beta", "b2");
    expect(await readMarkers(rootA, "alpha")).toEqual(["tool:a1", "tool:a2"]);
    expect(await readMarkers(rootB, "beta")).toEqual(["echo:b1", "echo:b2"]);

    // Nothing was written into the replayed project, and the replayed flow
    // did not pick up either recording's steps.
    await expect(fs.stat(flowPath(rootC, "alpha"))).rejects.toThrow();
    expect(await readMarkers(rootC, "standalone")).toEqual(["echo:replayed"]);
  });
});

// ── Restarting one recording ─────────────────────────────────────────

describe("restarting a recording on one key", () => {
  it("resets only that flow and leaves a concurrent recording untouched", async () => {
    const root = await makeRoot("restart");

    await start(root, "alpha");
    await addStep(root, "alpha", "a1");
    await addStep(root, "alpha", "a2");

    const startedBeta = await start(root, "beta");
    // Starting a DIFFERENT key abandons nothing — nothing to report.
    expect(startedBeta.restarted).toBeUndefined();
    expect(startedBeta.discardedSteps).toBeUndefined();
    await addEcho(root, "beta", "b1");

    const restarted = await start(root, "alpha");
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(2);
    expect(restarted.message).toContain("alpha");
    expect(await readMarkers(root, "alpha")).toEqual([]);

    // beta neither lost its steps nor its session.
    expect(await readMarkers(root, "beta")).toEqual(["echo:b1"]);
    expect(getRecordingSession(root, "beta")?.flow.steps).toHaveLength(1);
    await addEcho(root, "beta", "b2");
    expect(await readMarkers(root, "beta")).toEqual(["echo:b1", "echo:b2"]);

    // The restarted take records into the reset file.
    await addStep(root, "alpha", "a3");
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a3"]);
  });

  it("does not restart a same-named recording in another project", async () => {
    const rootA = await makeRoot("restart-a");
    const rootB = await makeRoot("restart-b");

    await start(rootA, "alpha");
    await addStep(rootA, "alpha", "a1");
    await start(rootB, "alpha");
    await addStep(rootB, "alpha", "b1");

    // Same name, different root ⇒ a different key ⇒ not a restart.
    const restarted = await start(rootB, "alpha");
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(1);
    expect(await readMarkers(rootB, "alpha")).toEqual([]);

    // The other project's recording kept its step and its session.
    expect(await readMarkers(rootA, "alpha")).toEqual(["tool:a1"]);
    expect(getRecordingSession(rootA, "alpha")?.flow.steps).toHaveLength(1);
  });
});
