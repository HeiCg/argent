import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// The recorder must read the SAME tree source the runner resolves selectors
// against at replay (fetchFlowTree), not the trimmed agent-facing describe
// tree — mock it directly so each test controls exactly what capture sees.
let currentTreeData: () => DescribeTreeData;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentTreeData()),
}));

import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { summarizeStep } from "../../src/tools/flows/flow-finish-recording";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000AB"; // iOS UDID shape
const FLOW = "rec";
const PREREQ = "App on home screen";

let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function setTree(children: DescribeNode[], source: DescribeTreeData["source"] = "native-devtools") {
  currentTreeData = () => ({ tree: screen(children), source });
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "gesture-tap") return { tapped: true };
      throw new Error(`Tool "${id}" not found`);
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function recordTap(point: { x: number; y: number }) {
  const tool = createFlowAddStepTool(mockRegistry());
  return tool.execute(
    {},
    {
      name: FLOW,
      project_root: tmpDir,
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...point }),
    }
  );
}

async function recordedSteps() {
  const content = await fs.readFile(path.join(tmpDir, ".argent", "flows", `${FLOW}.yaml`), "utf8");
  return parseFlow(content).steps;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-record-tap-"));
  __resetRecordingsForTesting();
  await flowStartRecordingTool.execute(
    {},
    { name: FLOW, project_root: tmpDir, executionPrerequisite: PREREQ }
  );
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow-add-step tap selector capture", () => {
  it("captures an identifier selector from the flow tree", async () => {
    setTree([
      n({
        identifier: "add-to-cart",
        label: "Add to cart",
        frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 },
      }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.message).not.toContain("—");
    expect(await recordedSteps()).toEqual([
      { kind: "tap", selector: { identifier: "add-to-cart" } },
    ]);
  });

  it("reports the captured selector in the `recorded` line, in the file's spelling", async () => {
    // The coordinates the caller passed are NOT what gets stored, and the
    // recorder no longer returns the YAML per step — so `recorded` is the only
    // thing telling the author their tap became a portable selector. It must
    // also use the FILE's spelling: capture produces `identifier`, which
    // selectorToYaml maps to `id` on the way to disk, so a line quoting
    // `identifier` would not match the YAML the author goes on to hand-edit.
    setTree([
      n({
        identifier: "add-to-cart",
        label: "Add to cart",
        frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 },
      }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.recorded).toBe('1. tap: {"id":"add-to-cart"}');
    expect(result.recorded).toBe(summarizeStep((await recordedSteps())[0], 1));
    expect(result.stepCount).toBe(1);
  });

  it("reports the coordinate fallback in the `recorded` line", async () => {
    // The other half of the same signal: when no stable selector is derivable
    // the step stays a coordinate tap, and `recorded` has to say so — that is
    // how the author knows the brittle form was kept, alongside the warning.
    setTree([]);

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.recorded).toBe("1. tap: (0.5, 0.52)");
    expect(result.recorded).toBe(summarizeStep((await recordedSteps())[0], 1));
  });

  it("captures a strict text selector when the node has no identifier", async () => {
    setTree([n({ label: "Add to cart", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })]);

    await recordTap({ x: 0.5, y: 0.52 });

    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Add to cart" } }]);
  });

  it("records a text selector for a labelled control that also exposes a value", async () => {
    // The label+value join ("Volume 50%") exists on no single node — matchNode
    // compares a text selector against label and value individually — so the
    // derived selector must use the label alone and still pass the re-resolve
    // check instead of degrading to coordinates.
    setTree([
      n({ label: "Volume", value: "50%", frame: { x: 0.2, y: 0.4, width: 0.6, height: 0.08 } }),
    ]);

    const result = await recordTap({ x: 0.5, y: 0.44 });

    expect(result.message).not.toContain("resolves to a different element");
    expect(result.message).not.toContain("matches no element");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Volume" } }]);
  });

  it("carries a recorded clickCount into the tap step's times", async () => {
    // A recorded double-tap must not silently replay as a single tap.
    setTree([n({ label: "Photo", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })]);

    const tool = createFlowAddStepTool(mockRegistry());
    await tool.execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.52, clickCount: 2 }),
      }
    );

    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Photo" }, times: 2 }]);
  });

  it("keeps coordinates when the selector would retarget to another element", async () => {
    // Two "Add" labels: replay's selectorToFrame ranking (exact → smallest
    // frame) elects the smaller node at the top, not the tapped one — so the
    // selector must be rejected in favor of coordinates.
    setTree([
      n({ label: "Add", frame: { x: 0.1, y: 0.1, width: 0.1, height: 0.03 } }),
      n({ label: "Add", frame: { x: 0.1, y: 0.5, width: 0.3, height: 0.05 } }),
    ]);

    const result = await recordTap({ x: 0.2, y: 0.52 });

    expect(result.message).toContain("resolves to a different element");
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.2, y: 0.52 }]);
  });

  it("records the selector with a caveat when captured from the fallback tree source", async () => {
    setTree(
      [n({ label: "Settings", frame: { x: 0.3, y: 0.5, width: 0.4, height: 0.06 } })],
      "ax-service"
    );

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.message).toContain("fallback ax-service tree");
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Settings" } }]);
  });

  it("keeps coordinates with a warning when the tree fetch fails", async () => {
    currentTreeData = () => {
      throw new Error("devtools gone");
    };

    const result = await recordTap({ x: 0.5, y: 0.52 });

    expect(result.message).toContain("selector capture failed");
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.5, y: 0.52 }]);
  });

  it("does not persist a raw point that replay would reject", async () => {
    setTree([]);

    await expect(recordTap({ x: 1.5, y: 0.52 })).rejects.toThrow(/normalized 0–1 fractions/i);
    expect(await recordedSteps()).toEqual([]);
  });
});

describe("flow-add-step on the expo dev-client chooser", () => {
  // The chooser is what an Android dev build shows in place of the app, and an
  // author recording one taps a server row to get past it. At replay the
  // `launch` step performs that tap itself, so a recorded copy is a SECOND tap
  // — fired blind into the app the recovery just opened, and green either way
  // because a coordinate tap reads no tree. Before this was handled, a flow
  // recorded on a dev build ran differently than it was recorded.
  const ANDROID = "emulator-5554";

  /** The chooser as an SDK 57 client draws it: one live row, on a LAN host. */
  function chooser(): DescribeNode[] {
    return [
      n({ label: "devclientprobe", frame: { x: 0.205, y: 0.085, width: 0.272, height: 0.021 } }),
      n({
        label: "Development Build",
        frame: { x: 0.205, y: 0.111, width: 0.282, height: 0.019 },
      }),
      n({
        label: "DEVELOPMENT SERVERS",
        frame: { x: 0.058, y: 0.201, width: 0.334, height: 0.017 },
      }),
      n({
        label: "devclientprobe / http://192.168.0.94:8091 / Chevron",
        frame: { x: 0.058, y: 0.236, width: 0.883, height: 0.077 },
      }),
      n({
        label: "Plus / New development server",
        frame: { x: 0.058, y: 0.322, width: 0.883, height: 0.052 },
      }),
    ];
  }

  function androidRegistry(): Registry {
    return {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "gesture-tap") return { tapped: true };
        if (id === "restart-app") return { restarted: true };
        throw new Error(`Tool "${id}" not found`);
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
  }

  async function record(command: string, args: Record<string, unknown>) {
    return createFlowAddStepTool(androidRegistry()).execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command,
        args: JSON.stringify({ udid: ANDROID, ...args }),
      }
    );
  }

  async function recordLaunch() {
    return record("restart-app", { bundleId: "com.anonymous.devclientprobe" });
  }

  beforeEach(async () => {
    __resetRecordingsForTesting();
    // No executionPrerequisite: an e2e flow, whose first step is the launch
    // that owns the chooser recovery at replay.
    await flowStartRecordingTool.execute({}, { name: FLOW, project_root: tmpDir });
  });

  it("does not record the tap that opens a server row after a launch", async () => {
    await recordLaunch();
    setTree(chooser(), "android-devtools");

    const result = await record("gesture-tap", { x: 0.4995, y: 0.2745 });

    // Dispatched live all the same — the author still has to get past the
    // chooser to record what comes next.
    expect(result.toolResult).toEqual({ tapped: true });
    expect(result.message).toContain("http://192.168.0.94:8091");
    expect(result.message).toContain("metroPort");
    expect(result.stepCount).toBe(1);
    expect(await recordedSteps()).toEqual([
      { kind: "launch", app: "com.anonymous.devclientprobe" },
    ]);
  });

  it("records a tap on the chooser that opens no server", async () => {
    // "New development server" is a real step: it opens a form, and nothing at
    // replay does it for the author. Only the server rows are the launch's.
    await recordLaunch();
    setTree(chooser(), "android-devtools");

    const result = await record("gesture-tap", { x: 0.4995, y: 0.348 });

    expect(result.stepCount).toBe(2);
    expect((await recordedSteps())[1]).toMatchObject({ kind: "tap" });
  });

  it("keeps the tap when no launch precedes it", async () => {
    // A fragment, or a raw `restart-app` carrying an Android activity: nothing
    // at replay dismisses the chooser, so this tap is the step that does.
    setTree(chooser(), "android-devtools");

    const result = await record("gesture-tap", { x: 0.4995, y: 0.2745 });

    expect(result.stepCount).toBe(1);
    expect(await recordedSteps()).toMatchObject([{ kind: "tap" }]);
  });

  it("keeps the tap off Android, where the chooser survives the launch", async () => {
    // `dismissDevLauncher` probes on Android alone, so on an iOS dev build the
    // chooser is still on screen at replay and the tap is what gets past it.
    await createFlowAddStepTool(androidRegistry()).execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "restart-app",
        args: JSON.stringify({ udid: DEVICE, bundleId: "com.anonymous.devclientprobe" }),
      }
    );
    setTree(chooser(), "native-devtools");

    const result = await createFlowAddStepTool(androidRegistry()).execute(
      {},
      {
        name: FLOW,
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: DEVICE, x: 0.4995, y: 0.2745 }),
      }
    );

    expect(result.stepCount).toBe(2);
    expect((await recordedSteps())[1]).toMatchObject({ kind: "tap" });
  });
});
