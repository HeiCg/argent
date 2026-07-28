import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
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
  __resetRecordingsForTesting,
  getRecordingSession,
  listActiveRecordings,
  parseFlow,
  serializeFlow,
  withFlowFileLock,
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
 *
 * The second half pins the *mutual exclusion* that makes the above hold when
 * the tools genuinely overlap. Every recording tool's critical section straddles
 * an await — a restart's truncate-then-register, a finish's read-then-clear, an
 * append's read-then-write — so each is covered by the per-flow-file lock, and a
 * step that resolved its session before some other tool superseded it must fail
 * rather than write into a file that now belongs to a different take. A finish
 * that fails inside its critical section must also leave the recording live, so
 * the take survives the failure and can be finished on a retry.
 */

const IOS_DEVICE = "00000000-0000-0000-0000-0000000000ab";

/**
 * The concurrent-recording cap is internal to flow-utils, and a copy of it here
 * would silently stop testing the real backstop the day it changes. Read it out
 * of the source instead.
 */
function readMaxRecordings(): number {
  const source = readFileSync(
    path.resolve(__dirname, "../../src/tools/flows/flow-utils.ts"),
    "utf8"
  );
  const match = /^const MAX_RECORDINGS = (\d+);$/m.exec(source);
  if (!match) throw new Error("could not read MAX_RECORDINGS out of flow-utils.ts");
  return Number(match[1]);
}

const MAX_RECORDINGS = readMaxRecordings();

// ── Harness ──────────────────────────────────────────────────────────

let roots: string[] = [];

/** A real temp dir standing in for one agent's project root. */
async function makeRoot(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `flow-concurrent-${label}-`));
  roots.push(dir);
  return dir;
}

/** A promise plus the function that resolves it. */
function openGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

/** Installed by {@link gateNextSubTool}; consumed by the mock registry. */
let subToolGate: (() => Promise<void>) | null = null;

/**
 * Suspend the NEXT live sub-tool execution and report when it is reached.
 *
 * flow-add-step resolves its recording session, runs the step LIVE (which can
 * take minutes on a device), and only then appends. Parking a step inside that
 * window is what puts an append genuinely in flight across a concurrent
 * restart / finish / eviction — deterministically, with no timing guesses.
 */
function gateNextSubTool(): { reached: Promise<void>; release: () => void } {
  const arrived = openGate();
  const held = openGate();
  subToolGate = async () => {
    // One-shot: later calls (including the ones asserting the recording still
    // works afterwards) run straight through.
    subToolGate = null;
    arrived.open();
    await held.promise;
  };
  return { reached: arrived.promise, release: held.open };
}

function createMockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      // Yield a macrotask: flow-add-step runs the step LIVE before it appends,
      // so this is what lets several calls issued without an await in between
      // reach the append phase concurrently (see the lost-update test).
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (subToolGate) await subToolGate();
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

function addRawStep(root: string, name: string, command: string, args: Record<string, unknown>) {
  return addStepTool.execute({}, { name, project_root: root, command, args: JSON.stringify(args) });
}

/** Record a `tool` step tagged with `marker`, so its file of origin is provable. */
function addStep(root: string, name: string, marker: string) {
  return addRawStep(root, name, "keyboard", { text: marker });
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

async function readSteps(root: string, name: string): Promise<FlowStep[]> {
  return parseFlow(await fs.readFile(flowPath(root, name), "utf8")).steps;
}

async function readMarkers(root: string, name: string): Promise<string[]> {
  return markers(await readSteps(root, name));
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to fail");
}

/** Let real timers and in-flight fs I/O drain, so "still blocked" means blocked. */
function settle(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve to `label` if `promise` settles in time, else to "timed-out". */
async function within<T>(promise: Promise<T>, label: string, ms = 2000): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), ms);
  });
  try {
    return await Promise.race([promise.then(() => label), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fill the recording table exactly to its cap; returns the names, oldest first. */
async function fillRecordings(root: string): Promise<string[]> {
  const names = Array.from({ length: MAX_RECORDINGS }, (_, i) => `rec-${i}`);
  for (const name of names) await start(root, name);
  return names;
}

beforeEach(() => {
  __resetRecordingsForTesting();
  subToolGate = null;
  roots = [];
});

afterEach(async () => {
  __resetRecordingsForTesting();
  subToolGate = null;
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
  it("fails with FLOW_NO_ACTIVE_RECORDING and names this project's live recordings", async () => {
    const rootA = await makeRoot("unknown-a");
    const rootB = await makeRoot("unknown-b");
    await start(rootA, "alpha");
    await start(rootB, "beta");

    const err = await captureFailure(addEcho(rootA, "never-started", "x"));

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    const message = (err as Error).message;
    expect(message).toContain('No active recording for flow "never-started"');
    expect(message).toContain(rootA);
    // This project's live keys are named so the agent can self-correct…
    expect(message).toContain('Active recordings: "alpha" (plus 1 in other projects)');
    // …while another caller's flow name and project path stay theirs.
    expect(message).not.toContain('"beta"');
    expect(message).not.toContain(rootB);
  });

  it("fails the same way for the right name under the wrong project_root", async () => {
    const rootA = await makeRoot("wrong-root-a");
    const rootB = await makeRoot("wrong-root-b");
    await start(rootA, "alpha");

    const err = await captureFailure(addStep(rootB, "alpha", "stray"));

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    const message = (err as Error).message;
    expect(message).toContain("Active recordings: none in this project (plus 1 in other projects)");
    expect(message).not.toContain(rootA);

    // The misdirected step was not recorded anywhere.
    expect(await readMarkers(rootA, "alpha")).toEqual([]);
    await expect(fs.stat(flowPath(rootB, "alpha"))).rejects.toThrow();
  });

  it("reports the live recordings as none when nothing is being recorded", async () => {
    const root = await makeRoot("nothing-live");
    const err = await captureFailure(finish(root, "alpha"));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    // No parenthetical: there is nothing elsewhere to count either.
    expect((err as Error).message).toContain("Active recordings: none in this project.");
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
    // read → await → write, so without the per-file lock these would all
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

  it("keeps two concurrent bursts on their own files", async () => {
    const root = await makeRoot("append-race-two");
    await start(root, "alpha");
    await start(root, "beta");

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

// ── The lock is per flow file, not one global mutex ──────────────────

describe("the flow-file lock", () => {
  it("lets one recording append while another recording's file is locked", async () => {
    const root = await makeRoot("per-file-lock");
    await start(root, "alpha");
    await start(root, "beta");

    // Hold alpha's file lock — this is exactly the state an alpha append is in
    // while it is mid read-modify-write. Whether beta can make progress *during*
    // that window is the property under test: a single global lock passes any
    // assertion about final file contents, and fails this one.
    const order: string[] = [];
    const alphaLock = openGate();
    const alphaHeld = withFlowFileLock(root, "alpha", () => alphaLock.promise);

    // A second append to alpha must queue behind the holder…
    const alphaAppend = addStep(root, "alpha", "a1").then((r) => {
      order.push("alpha-appended");
      return r;
    });
    const betaAppend = addStep(root, "beta", "b1").then((r) => {
      order.push("beta-appended");
      return r;
    });

    // …while beta's append, on a different file, runs to completion inside it.
    expect(await within(betaAppend, "beta-appended")).toBe("beta-appended");
    await settle();
    expect(order).toEqual(["beta-appended"]);
    expect(await readMarkers(root, "beta")).toEqual(["tool:b1"]);
    expect(await readMarkers(root, "alpha")).toEqual([]);

    order.push("alpha-lock-released");
    alphaLock.open();
    await alphaHeld;
    expect(await within(alphaAppend, "alpha-appended")).toBe("alpha-appended");

    // beta finished strictly inside alpha's critical section — real overlap,
    // not a serialization that happened to be fast.
    expect(order).toEqual(["beta-appended", "alpha-lock-released", "alpha-appended"]);
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1"]);
    expect(await readMarkers(root, "beta")).toEqual(["tool:b1"]);
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

  it("restarts this project's take and leaves the same name elsewhere alone", async () => {
    const rootA = await makeRoot("restart-a");
    const rootB = await makeRoot("restart-b");

    await start(rootA, "alpha");
    await addStep(rootA, "alpha", "a1");
    await start(rootB, "alpha");
    await addStep(rootB, "alpha", "b1");

    // Same name AND same root ⇒ the same key ⇒ this take is restarted…
    const restarted = await start(rootB, "alpha");
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(1);
    expect(await readMarkers(rootB, "alpha")).toEqual([]);

    // …while the same name under the other root — a different key — is not
    // touched: that recording kept its step and its session.
    expect(await readMarkers(rootA, "alpha")).toEqual(["tool:a1"]);
    expect(getRecordingSession(rootA, "alpha")?.flow.steps).toHaveLength(1);
  });
});

// ── A restart landing on top of an in-flight append ──────────────────

describe("a restart that lands while a step is still running", () => {
  it("rejects the in-flight step instead of writing it into the new take", async () => {
    const root = await makeRoot("restart-inflight");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");

    // The step resolves its session, then parks in its LIVE execution.
    const gate = gateNextSubTool();
    const appending = addStep(root, "alpha", "a2");
    await gate.reached;

    // The take that step belongs to is discarded while it is still running.
    const restarted = await start(root, "alpha");
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(1);

    gate.release();
    const err = await captureFailure(appending);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_session_superseded");
    expect((err as Error).message).toContain("restarted while this step was running");
    expect((err as Error).message).toContain("Nothing was recorded");

    // The new take is empty — no step from the discarded one leaked into it.
    expect(await readMarkers(root, "alpha")).toEqual([]);
    expect(getRecordingSession(root, "alpha")?.flow.steps).toHaveLength(0);

    // …and the restarted recording still works.
    await addStep(root, "alpha", "a3");
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a3"]);
    const finished = await finish(root, "alpha");
    expect(finished.steps).toBe(1);
  });

  it("truncates and re-registers only once the flow's lock is free", async () => {
    const root = await makeRoot("restart-lock");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");
    const firstSession = getRecordingSession(root, "alpha");

    // Stand in for an append that is mid read-modify-write on alpha's file.
    const order: string[] = [];
    const lock = openGate();
    const held = withFlowFileLock(root, "alpha", () => lock.promise);

    const restarting = start(root, "alpha").then((r) => {
      order.push("restart-returned");
      return r;
    });

    await settle();
    // The restart is a truncate AND a session swap; neither half may happen
    // while another writer holds the file.
    expect(order).toEqual([]);
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1"]);
    expect(getRecordingSession(root, "alpha")).toBe(firstSession);

    order.push("lock-released");
    lock.open();
    await held;
    const restarted = await restarting;

    expect(order).toEqual(["lock-released", "restart-returned"]);
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(1);
    expect(await readMarkers(root, "alpha")).toEqual([]);
    expect(getRecordingSession(root, "alpha")).not.toBe(firstSession);
  });

  it("keeps a step queued behind the restart out of the new take", async () => {
    const root = await makeRoot("restart-queued-append");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");
    const discarded = getRecordingSession(root, "alpha");

    // Park a holder on alpha's file lock. Everything issued below queues behind
    // it, so the interleaving is fixed by the lock's arrival order rather than
    // by how long any I/O happens to take.
    const holder = openGate();
    const held = withFlowFileLock(root, "alpha", () => holder.promise);

    // Second in the queue: the restart — truncate the file, swap the session.
    const restarting = start(root, "alpha");
    // Third: a step for the take the restart is discarding. flow-add-echo
    // resolves its session and takes the lock in one synchronous block, so this
    // append is bound to the OLD session and enters the lock the instant the
    // restart's critical section ends — the window a truncate that is not fused
    // to the session swap leaves open, onto a file that is already empty.
    const appending = addEcho(root, "alpha", "stray");
    expect(getRecordingSession(root, "alpha")).toBe(discarded);

    holder.open();
    const [restartResult, appendResult] = await Promise.allSettled([restarting, appending]);
    await held;

    if (restartResult.status === "rejected") throw restartResult.reason;
    expect(restartResult.value.restarted).toBe(true);
    expect(restartResult.value.discardedSteps).toBe(1);

    // The step belongs to a take that no longer exists: it must be reported as
    // rejected, never as recorded.
    expect(appendResult.status).toBe("rejected");
    const failure =
      appendResult.status === "rejected" ? getFailureSignal(appendResult.reason) : undefined;
    expect(failure?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect(failure?.failure_stage).toBe("flow_session_superseded");

    // The invariant: the new take's file is what the new take says it is, and
    // carries nothing from the discarded one.
    const session = getRecordingSession(root, "alpha");
    expect(session).toBeDefined();
    expect(session).not.toBe(discarded);
    const onDisk = await readMarkers(root, "alpha");
    expect(onDisk).toEqual(markers(session!.flow.steps));
    expect(onDisk).not.toContain("echo:stray");

    // …and the new take records from there as a fresh recording.
    await addStep(root, "alpha", "a2");
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a2"]);
    const finished = await finish(root, "alpha");
    expect(finished.steps).toBe(1);
  });
});

// ── A finish landing on top of an in-flight append ───────────────────

describe("a finish that lands while a step is still running", () => {
  it("never reports steps, a summary or YAML the file disagrees with", async () => {
    // Vary how far the append has progressed when the finish arrives, so both
    // outcomes are exercised: the append wins the lock (and must be included in
    // what finish reports) or the finish wins it (and the append must fail).
    for (const microtasks of [0, 1, 2, 3, 4, 6, 8]) {
      const root = await makeRoot(`finish-inflight-${microtasks}`);
      await start(root, "alpha");
      await addStep(root, "alpha", "a1");

      const gate = gateNextSubTool();
      const appending = addStep(root, "alpha", "a2");
      await gate.reached;
      gate.release();
      for (let i = 0; i < microtasks; i++) await Promise.resolve();

      const [appended, finished] = await Promise.allSettled([appending, finish(root, "alpha")]);

      if (finished.status === "rejected") throw finished.reason;
      const report = finished.value;
      const onDisk = await readMarkers(root, "alpha");

      // The whole report is one snapshot of one file state.
      expect(markers(parseFlow(report.flowFile).steps)).toEqual(onDisk);
      expect(report.steps).toBe(onDisk.length);
      expect(report.summary).toHaveLength(onDisk.length);
      expect(report.path).toBe(flowPath(root, "alpha"));
      expect(report.savedTo).toBe(flowPath(root, "alpha"));

      if (appended.status === "rejected") {
        expect(getFailureSignal(appended.reason)?.error_code).toBe(
          FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING
        );
        expect(onDisk).toEqual(["tool:a1"]);
      } else {
        expect(onDisk).toEqual(["tool:a1", "tool:a2"]);
      }

      // Either way the recording is gone, and nothing can be appended to it.
      expect(getRecordingSession(root, "alpha")).toBeUndefined();
    }
  });

  it("reads the file back and clears the session only once the lock is free", async () => {
    const root = await makeRoot("finish-lock");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");

    const order: string[] = [];
    const lock = openGate();
    const held = withFlowFileLock(root, "alpha", () => lock.promise);

    const finishing = finish(root, "alpha").then((r) => {
      order.push("finish-returned");
      return r;
    });

    await settle();
    expect(order).toEqual([]);
    // The session is still live: resolve-read-clear is one critical section.
    expect(getRecordingSession(root, "alpha")).toBeDefined();

    order.push("lock-released");
    lock.open();
    await held;
    const finished = await finishing;

    expect(order).toEqual(["lock-released", "finish-returned"]);
    expect(finished.steps).toBe(1);
    expect(markers(parseFlow(finished.flowFile).steps)).toEqual(["tool:a1"]);
    expect(getRecordingSession(root, "alpha")).toBeUndefined();
  });

  it("rejects a step whose recording was already finished", async () => {
    const root = await makeRoot("append-after-finish");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");

    const gate = gateNextSubTool();
    const appending = addStep(root, "alpha", "a2");
    await gate.reached;

    // The finish completes end-to-end before the step comes back.
    const finished = await finish(root, "alpha");
    expect(finished.steps).toBe(1);

    gate.release();
    const err = await captureFailure(appending);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_session_superseded");
    expect((err as Error).message).toContain("no longer active");

    // The finished file is exactly what the finish reported.
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1"]);
    expect(markers(parseFlow(finished.flowFile).steps)).toEqual(["tool:a1"]);
  });
});

// ── A finish whose file a hand-edit broke ────────────────────────────

describe("a finish on a flow file that no longer parses", () => {
  // Hand-editing the .yaml mid-recording is a documented workflow, so parseFlow
  // can legitimately throw inside flow-finish-recording's critical section. The
  // session must survive that: clearing the key first leaves the agent unable to
  // retry the finish after repairing the file — flow-finish-recording answers
  // "No active recording", and the only tool that re-establishes the key,
  // flow-start-recording, truncates the very take it would be recovering.

  /** `steps` present but not a list — a shape parseFlow rejects outright. */
  const NOT_A_LIST = 'executionPrerequisite: ""\nsteps: oops\n';

  it("keeps the recording live and finishable once the file is repaired", async () => {
    const root = await makeRoot("finish-unparseable");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");
    await addEcho(root, "alpha", "a2");
    const session = getRecordingSession(root, "alpha");
    const repaired = await fs.readFile(flowPath(root, "alpha"), "utf8");

    await fs.writeFile(flowPath(root, "alpha"), NOT_A_LIST, "utf8");

    const err = await captureFailure(finish(root, "alpha"));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_file_parse");

    // The finish reads and clears; it never writes — the botched edit is still
    // on disk byte for byte, so the agent can diff it against what it typed.
    expect(await fs.readFile(flowPath(root, "alpha"), "utf8")).toBe(NOT_A_LIST);

    // The take survived the failure, as the same session object.
    expect(getRecordingSession(root, "alpha")).toBe(session);
    expect(session?.flow.steps).toHaveLength(2);

    // A retry while the file is still broken fails the same way — the recording
    // is live (the call got past requireRecordingSession), the FILE is at fault.
    const again = await captureFailure(finish(root, "alpha"));
    expect(getFailureSignal(again)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);

    // Repair the file the way the agent would, then carry on recording…
    await fs.writeFile(flowPath(root, "alpha"), repaired, "utf8");
    await addEcho(root, "alpha", "a3");
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1", "echo:a2", "echo:a3"]);

    // …and the retried finish succeeds, reporting the repaired file.
    const finished = await finish(root, "alpha");
    expect(finished.steps).toBe(3);
    expect(finished.summary).toHaveLength(3);
    expect(markers(parseFlow(finished.flowFile).steps)).toEqual(["tool:a1", "echo:a2", "echo:a3"]);
    expect(getRecordingSession(root, "alpha")).toBeUndefined();
  });

  it("leaves a concurrent recording — and its own key — exactly as they were", async () => {
    const root = await makeRoot("finish-unparseable-step");
    await start(root, "alpha");
    await start(root, "beta");
    await addStep(root, "alpha", "a1");
    await addEcho(root, "beta", "b1");

    // A second botched-edit shape: a step whose directive key is a typo.
    await fs.writeFile(
      flowPath(root, "alpha"),
      'executionPrerequisite: ""\nsteps:\n  - ecko: oops\n',
      "utf8"
    );

    const err = await captureFailure(finish(root, "alpha"));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED);

    // Both keys are still live, each bound to its own file.
    expect(
      listActiveRecordings()
        .map((r) => r.name)
        .sort()
    ).toEqual(["alpha", "beta"]);
    expect(getRecordingSession(root, "alpha")?.filePath).toBe(flowPath(root, "alpha"));

    // beta neither lost its file nor its ability to finish.
    expect(await readMarkers(root, "beta")).toEqual(["echo:b1"]);
    const finishedBeta = await finish(root, "beta");
    expect(markers(parseFlow(finishedBeta.flowFile).steps)).toEqual(["echo:b1"]);

    // alpha outlived beta's finish too, and finishes on the repaired file.
    expect(getRecordingSession(root, "alpha")).toBeDefined();
    await fs.writeFile(
      flowPath(root, "alpha"),
      'executionPrerequisite: ""\nsteps:\n  - echo: repaired\n',
      "utf8"
    );
    const finishedAlpha = await finish(root, "alpha");
    expect(markers(parseFlow(finishedAlpha.flowFile).steps)).toEqual(["echo:repaired"]);
    expect(listActiveRecordings()).toEqual([]);
  });
});

// ── The concurrent-recording cap ─────────────────────────────────────

describe("the concurrent-recording cap", () => {
  it("evicts the least recently touched recording and keeps the rest", async () => {
    const root = await makeRoot("evict");
    const names = await fillRecordings(root);
    expect(listActiveRecordings()).toHaveLength(MAX_RECORDINGS);

    // Touch everything EXCEPT one entry in the middle of the table, so the
    // least-recently-used entry and the first-registered one are different
    // keys: `rec-7` is the only one never touched since it was started, while
    // `rec-0` was registered first but has since been used. An insertion-order
    // eviction would drop `rec-0`, so the assertions below separate the two
    // policies rather than passing under either.
    const untouched = names[7];
    for (const name of names.filter((n) => n !== untouched)) await addEcho(root, name, "touch");

    await start(root, "overflow");

    const live = listActiveRecordings()
      .map((r) => r.name)
      .sort();
    expect(live).toHaveLength(MAX_RECORDINGS);
    expect(live).toEqual([...names.filter((n) => n !== untouched), "overflow"].sort());
    expect(getRecordingSession(root, untouched)).toBeUndefined();
    // The oldest registration survived, because it was still being used.
    expect(getRecordingSession(root, names[0])).toBeDefined();
    // The survivors are still usable — eviction dropped one, not the table.
    await addEcho(root, names[0], "still-live");
    expect(await readMarkers(root, names[0])).toEqual(["echo:touch", "echo:still-live"]);
  });

  it("rejects an append whose recording was evicted while the step ran", async () => {
    const root = await makeRoot("evict-inflight");
    const names = await fillRecordings(root);

    // The step resolves rec-0's session (touching it) and parks.
    const gate = gateNextSubTool();
    const appending = addStep(root, "rec-0", "victim");
    await gate.reached;

    // Every other recording is touched afterwards, so rec-0's use is the oldest
    // one on the table; the next start overflows the cap and drops it out from
    // under the running step.
    for (const name of names.slice(1)) await addEcho(root, name, "touch");
    await start(root, "overflow");
    expect(getRecordingSession(root, "rec-0")).toBeUndefined();

    gate.release();
    const err = await captureFailure(appending);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_session_superseded");
    expect((err as Error).message).toContain("concurrent-recording cap");
    expect(await readMarkers(root, "rec-0")).toEqual([]);

    // A fresh call on the evicted key fails the ordinary not-live way.
    const late = await captureFailure(addEcho(root, "rec-0", "late"));
    expect(getFailureSignal(late)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect(getFailureSignal(late)?.failure_stage).toBe("flow_require_recording");
  });
});

// ── Recording a flow-execute step ────────────────────────────────────

describe("recording a flow-execute step while several projects are in play", () => {
  const fragment: FlowFile = {
    executionPrerequisite: "",
    steps: [{ kind: "echo", message: "helper" }],
  };

  it("keeps the raw step when the target is not a sibling of the RECORDING", async () => {
    const recordingRoot = await makeRoot("run-target-recording");
    const executedRoot = await makeRoot("run-target-executed");

    // The fragment exists in the project the nested flow-execute ran in, but
    // NOT next to the flow being recorded — so `run: helper` would be a
    // dangling reference at replay, which resolves siblings of the recording.
    await writeSavedFlow(executedRoot, "helper", fragment);

    await start(recordingRoot, "wrapper");
    const res = await addRawStep(recordingRoot, "wrapper", "flow-execute", {
      name: "helper",
      project_root: executedRoot,
      udid: IOS_DEVICE,
    });

    expect(res.message).toContain('could not resolve "helper" as a sibling fragment');
    expect(res.message).toContain("kept the raw flow-execute step");
    expect(await readSteps(recordingRoot, "wrapper")).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "helper", project_root: executedRoot } },
    ]);
  });

  it("records run: when the target sits next to the recording", async () => {
    const recordingRoot = await makeRoot("run-target-sibling");
    const executedRoot = await makeRoot("run-target-elsewhere");

    // Mirror image: the fragment is a sibling of the flow being recorded and is
    // absent from the executed project.
    await writeSavedFlow(recordingRoot, "helper", fragment);
    await fs.mkdir(path.join(executedRoot, ".argent", "flows"), { recursive: true });

    await start(recordingRoot, "wrapper");
    const res = await addRawStep(recordingRoot, "wrapper", "flow-execute", {
      name: "helper",
      project_root: executedRoot,
      udid: IOS_DEVICE,
    });

    expect(res.message).not.toContain("kept the raw flow-execute step");
    expect(await readSteps(recordingRoot, "wrapper")).toEqual([{ kind: "run", flow: "helper" }]);
  });
});
