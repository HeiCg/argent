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

function fr(x: number, y: number, width: number, height: number): DescribeNode["frame"] {
  return { x, y, width, height };
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

  /**
   * The chooser as an SDK 57 client draws it, captured off an emulator through
   * `fetchFlowTree` — the source the recorder reads — and reproduced leaf for
   * leaf.
   *
   * What matters here is the SHAPE, which a tidier fixture gets wrong in the
   * two ways that hide bugs. The flow tree is FLAT: every leaf is a sibling, so
   * containment is decided by frames alone, and three of those leaves are
   * whole-screen containers (the `ComposeView` the client draws on, the
   * window's content frame, its root layout) that sit under every tap on the
   * screen. And a row is not one labelled leaf: the URL is its own text leaf
   * beside the project name and a chevron, all of them inside an unlabelled
   * `Button`. Row labels of the "name / url / Chevron" form belong to the
   * trimmed agent-facing `describe`, which joins descendant text that way;
   * `flow-android-tree` never produces them.
   *
   * `history` adds the RECENTLY OPENED section a client draws once it has
   * opened a server — the state every recording after the first one meets.
   */
  function chooser(history = false): DescribeNode[] {
    const rows = [
      n({ role: "Image", label: "App Icon", frame: fr(0.058, 0.08, 0.107, 0.048) }),
      n({ role: "StaticText", label: "devbuild", frame: fr(0.205, 0.082, 0.156, 0.021) }),
      n({ role: "StaticText", label: "Development Build", frame: fr(0.205, 0.107, 0.282, 0.019) }),
      n({ role: "View", label: "User", frame: fr(0.859, 0.091, 0.058, 0.026) }),
      n({
        role: "StaticText",
        label: "DEVELOPMENT SERVERS",
        frame: fr(0.058, 0.198, 0.334, 0.017),
      }),
      n({ role: "StaticText", label: "INFO", frame: fr(0.848, 0.18, 0.117, 0.052) }),
      n({ role: "StaticText", label: "devbuild", frame: fr(0.166, 0.25, 0.156, 0.021) }),
      n({
        role: "StaticText",
        label: "http://192.168.0.94:8093",
        frame: fr(0.166, 0.276, 0.32, 0.016),
      }),
      n({ role: "View", label: "Chevron", frame: fr(0.854, 0.26, 0.049, 0.022) }),
      // The row card: unlabelled, and what a press actually lands on.
      n({ role: "Button", label: "", frame: fr(0.058, 0.233, 0.883, 0.077) }),
      n({ role: "View", label: "Plus", frame: fr(0.097, 0.336, 0.039, 0.018) }),
      n({
        role: "StaticText",
        label: "New development server",
        frame: fr(0.156, 0.337, 0.324, 0.016),
      }),
      n({ role: "Button", label: "", frame: fr(0.058, 0.318, 0.883, 0.052) }),
    ];
    if (history) {
      rows.push(
        n({ role: "StaticText", label: "RECENTLY OPENED", frame: fr(0.058, 0.43, 0.278, 0.017) }),
        n({ role: "StaticText", label: "devbuild", frame: fr(0.166, 0.474, 0.156, 0.021) }),
        n({
          role: "StaticText",
          label: "http://192.168.0.94:8093",
          frame: fr(0.166, 0.5, 0.32, 0.016),
        }),
        n({ role: "Button", label: "", frame: fr(0.058, 0.457, 0.883, 0.077) })
      );
    }
    return [
      ...rows,
      n({ role: "ScrollView", label: "", frame: fr(0.058, 0.198, 0.883, history ? 0.44 : 0.217) }),
      // The launcher's own tab bar, well below the list.
      n({ role: "View", label: "Home", frame: fr(0.151, 0.918, 0.058, 0.026) }),
      n({ role: "StaticText", label: "Home", frame: fr(0.141, 0.949, 0.079, 0.016) }),
      n({ role: "View", label: "Settings", frame: fr(0.792, 0.918, 0.058, 0.026) }),
      n({ role: "StaticText", label: "Settings", frame: fr(0.767, 0.949, 0.107, 0.016) }),
      // The whole-screen containers, in the order the dump lists them.
      n({ role: "ComposeView", label: "", frame: fr(0, 0, 1, 1) }),
      n({
        role: "FrameLayout",
        label: "",
        identifier: "android:id/content",
        frame: fr(0, 0, 1, 1),
      }),
      n({ role: "LinearLayout", label: "", frame: fr(0, 0, 1, 1) }),
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
    expect(result.message).toContain("http://192.168.0.94:8093");
    expect(result.message).toContain("metroPort");
    expect(result.stepCount).toBe(1);
    expect(await recordedSteps()).toEqual([
      { kind: "launch", app: "com.anonymous.devclientprobe" },
    ]);
  });

  it("does not record a tap on the row's card, beside the URL it renders", async () => {
    // The URL is one leaf on the row; an author presses the row. Both open the
    // same server, so both belong to the launch.
    await recordLaunch();
    setTree(chooser(), "android-devtools");

    const result = await record("gesture-tap", { x: 0.72, y: 0.245 });

    expect(result.message).toContain("http://192.168.0.94:8093");
    expect(result.stepCount).toBe(1);
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

  // Everything below is on the chooser and opens NO server row. Each was
  // silently dropped while the recorder answered "that opened a server row"
  // off whatever whole-screen container covered the point, so the author's
  // step vanished from the file and the message named a server they had not
  // touched. The chooser is the first screen of every dev-build recording, so
  // this sat on the hot path.
  it.each([
    ["the launcher's own Settings tab, half a screen below the list", { x: 0.82, y: 0.93 }, true],
    ["the empty gap between the header and the list", { x: 0.5, y: 0.16 }, false],
    ["a remembered row, which the launch refuses to open at replay", { x: 0.5, y: 0.5 }, true],
    ["the INFO affordance", { x: 0.9, y: 0.2 }, false],
    ["the DEVELOPMENT SERVERS heading itself", { x: 0.2, y: 0.205 }, false],
  ])("records a tap on %s", async (_what, point, history) => {
    await recordLaunch();
    setTree(chooser(history), "android-devtools");

    const result = await record("gesture-tap", point);

    expect(result.message).not.toContain("Not recorded");
    expect(result.stepCount).toBe(2);
    expect((await recordedSteps())[1]).toMatchObject({ kind: "tap" });
  });

  it("still declines the live row once the chooser has a history section", async () => {
    // The remembered rows carry the run's own port too, on a host that may have
    // stopped answering — so the boundary between the two sections is what
    // decides, not the port.
    await recordLaunch();
    setTree(chooser(true), "android-devtools");

    const result = await record("gesture-tap", { x: 0.4995, y: 0.2745 });

    expect(result.message).toContain("http://192.168.0.94:8093");
    expect(result.stepCount).toBe(1);
  });

  it("records an ordinary tap on the app the launch opened", async () => {
    // The regression guard for the whole feature: once past the chooser, a tap
    // after a launch is an ordinary step.
    await recordLaunch();
    setTree(
      [n({ role: "Button", label: "Sign in", frame: fr(0.3, 0.5, 0.4, 0.06) })],
      "android-devtools"
    );

    const result = await record("gesture-tap", { x: 0.5, y: 0.52 });

    expect(result.stepCount).toBe(2);
    expect((await recordedSteps())[1]).toEqual({ kind: "tap", selector: { text: "Sign in" } });
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
