import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";
import type { RouteContext, RouteReader } from "../../src/utils/route-identity";

// Serve the flow tree directly (see flow-when.test.ts) — `idle` polls it.
let currentTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: "native-devtools",
      screen: { width: 390, height: 844 },
    })
  ),
}));

// Stub only the debugger attach; the verification loop under test is real.
let routes: Array<RouteContext | null>;
let readerAvailable: boolean;
let connectCalls: number;
vi.mock("../../src/utils/route-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/route-identity")>();
  return {
    ...actual,
    connectRouteReader: vi.fn(async (): Promise<RouteReader | undefined> => {
      connectCalls += 1;
      if (!readerAvailable) return undefined;
      return async () => routes.shift() ?? null;
    }),
  };
});

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { connectRouteReader } from "../../src/utils/route-identity";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

const FULL: DescribeNode["frame"] = { x: 0, y: 0, width: 1, height: 1 };

function screenWith(label: string): DescribeNode {
  return n({
    role: "AXWindow",
    frame: FULL,
    children: [n({ frame: { x: 0, y: 0, width: 1, height: 0.1 }, label })],
  });
}

const route = (path: string[]): RouteContext => ({
  path,
  name: path[path.length - 1]!,
  params: null,
});

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "restart-app") return { restarted: true };
      return { ok: true };
    }),
    getTool: vi.fn(() => undefined),
    // The launch step gates on native devtools being connected before it
    // hands control to the next step (treeSourceGate).
    resolveService: vi.fn(async () => ({ isConnected: () => true })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: string): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), yaml, "utf8");
}

async function run(name: string): Promise<FlowRunResult> {
  const tool = createRunFlowTool(mockRegistry());
  const result = await tool.execute({}, { name, project_root: tmpDir, device: DEVICE }, undefined);
  if (!("steps" in result)) throw new Error("expected a run result");
  return result;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-screen-"));
  currentTree = () => screenWith("Home");
  routes = [];
  readerAvailable = true;
  connectCalls = 0;
  // `vi.clearAllMocks()` clears recorded calls but NOT implementations, so a
  // test that overrides the connect would otherwise leak it into the next one.
  vi.mocked(connectRouteReader).mockImplementation(async () => {
    connectCalls += 1;
    if (!readerAvailable) return undefined;
    return async () => routes.shift() ?? null;
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// A `screen` gate is the identity half of proving a navigation: it answers
// which screen the app is on, and must never answer "probably".
describe("await: { screen }", () => {
  const FLOW = `executionPrerequisite: ""
steps:
  - launch: com.acme.notes
  - await: { screen: "HomeTab>Profile", metroPort: 59999 }
`;

  it("passes when the focused route matches", async () => {
    routes = [route(["HomeTab", "Profile"])];
    await writeFlow("nav", FLOW);
    const r = await run("nav");
    expect(r.ok).toBe(true);
    expect(r.steps.at(-1)).toMatchObject({ kind: "screen", status: "pass" });
  });

  it("tolerates the transition lag before the route commits", async () => {
    // Two null reads (mid-push), then the destination — the exact shape a
    // fixed `wait:` was previously papering over.
    routes = [null, null, route(["HomeTab", "Profile"])];
    await writeFlow("nav", FLOW);
    expect((await run("nav")).ok).toBe(true);
  });

  it("fails naming the screen the app actually reached", async () => {
    routes = Array.from({ length: 200 }, () => route(["HomeTab", "Feed"]));
    await writeFlow(
      "nav",
      `executionPrerequisite: ""
steps:
  - launch: com.acme.notes
  - await: { screen: "HomeTab>Profile", metroPort: 59999, timeout: 400 }
`
    );
    const r = await run("nav");
    expect(r.ok).toBe(false);
    const step = r.steps.at(-1)!;
    expect(step.status).toBe("fail");
    expect(step.reason).toContain('the app is on "HomeTab>Feed", not "HomeTab>Profile"');
  });

  // A connect that never lands now retries for its whole budget before
  // conceding, so this case legitimately spends several seconds.
  it("reports an unreadable route as unknown identity, never as arrival", async () => {
    readerAvailable = false;
    await writeFlow("nav", FLOW);
    const r = await run("nav");
    expect(r.ok).toBe(false);
    const step = r.steps.at(-1)!;
    expect(step.status).toBe("error");
    // The reason names the cause it can actually CHECK. This fixture points at
    // a dead port (59999), so the honest answer is that no Metro is answering
    // there — not the old blanket "Metro is down, the app is not a debuggable
    // RN build, or the port serves a different app", which asserted three
    // causes and was wrong about at least two of them on every real failure.
    expect(step.reason).toContain("no Metro dev server is answering on port 59999");
    expect(step.reason).toContain("environment failure, not a verdict about the app");
  }, 20_000);

  it("connects the debugger once per run, not once per gate", async () => {
    routes = [route(["Home"]), route(["Home"]), route(["Home"])];
    await writeFlow(
      "nav",
      `executionPrerequisite: ""
steps:
  - launch: com.acme.notes
  - await: { screen: "Home", metroPort: 59999 }
  - await: { screen: "Home", metroPort: 59999 }
  - assert: { screen: "Home", metroPort: 59999 }
`
    );
    expect((await run("nav")).ok).toBe(true);
    expect(connectCalls).toBe(1);
  });

  // R2: the connect used to be memoized INCLUDING its failure, so one gate
  // that raced the app's re-registration with Metro condemned every later
  // gate in the run to an instant, unwaitable failure.
  it("retries a failed connect instead of condemning the rest of the run", async () => {
    // Fail the first two attempts, as a gate firing into the post-launch gap
    // does, then let the app finish registering.
    let attempts = 0;
    readerAvailable = false;
    vi.mocked(connectRouteReader).mockImplementation(async () => {
      connectCalls += 1;
      attempts += 1;
      if (attempts <= 2) return undefined;
      return async () => routes.shift() ?? null;
    });
    routes = [route(["Home"]), route(["Home"])];
    await writeFlow(
      "nav",
      `executionPrerequisite: ""
steps:
  - launch: com.acme.notes
  - await: { screen: "Home", metroPort: 59999 }
  - await: { screen: "Home", metroPort: 59999 }
`
    );
    const r = await run("nav");
    expect(r.ok).toBe(true);
    expect(attempts).toBe(3);
    // And once it lands, the success is memoized: the second gate reuses it.
    expect(r.steps.filter((s) => s.kind === "screen").every((s) => s.status === "pass")).toBe(true);
  });

  // A `launch` terminates the app, taking the JS runtime every reader is
  // attached to with it — and re-arming the retry budget the previous epoch
  // may have spent.
  it("reconnects after a launch instead of probing the dead runtime", async () => {
    routes = [route(["Home"]), route(["Home"])];
    await writeFlow(
      "nav",
      `executionPrerequisite: ""
steps:
  - launch: com.acme.notes
  - await: { screen: "Home", metroPort: 59999 }
  - launch: com.acme.notes
  - await: { screen: "Home", metroPort: 59999 }
`
    );
    expect((await run("nav")).ok).toBe(true);
    expect(connectCalls).toBe(2);
  });

  // The run log prints the step's kind next to its target, so a target that
  // repeats the kind rendered as "screen screen HomeTab>Profile" — and the
  // mode, which the log does NOT print, was the thing actually missing from it.
  it("labels the step with the route alone, and marks the assert form", async () => {
    routes = [route(["HomeTab", "Profile"]), route(["HomeTab", "Profile"])];
    await writeFlow(
      "labelled",
      `executionPrerequisite: ""
steps:
  - launch: com.acme.notes
  - await: { screen: "HomeTab>Profile", metroPort: 59999 }
  - assert: { screen: "HomeTab>Profile", metroPort: 59999 }
`
    );
    const r = await run("labelled");
    expect(r.ok).toBe(true);
    expect(r.steps.filter((s) => s.kind === "screen").map((s) => s.target)).toEqual([
      "HomeTab>Profile",
      "assert HomeTab>Profile",
    ]);
  });

  it("refuses to guess the app when the flow never launched one", async () => {
    await writeFlow(
      "frag",
      `executionPrerequisite: "on Home"
steps:
  - await: { screen: "Home", metroPort: 59999 }
`
    );
    const tool = createRunFlowTool(mockRegistry());
    const result = await tool.execute(
      {},
      { name: "frag", project_root: tmpDir, device: DEVICE, prerequisiteAcknowledged: true },
      undefined
    );
    if (!("steps" in result)) throw new Error("expected a run result");
    expect(result.steps.at(-1)!.reason).toContain("no app to read the route from");
  });
});

// `idle` is the readiness half. Its whole reason to exist is that it FAILS —
// the `await-screen-idle` tool reports `settled: false` softly, which cannot
// carry a regression verdict on an unattended replay.
describe("await: { idle }", () => {
  it("passes once the tree holds still", async () => {
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, minStableMs: 0 }
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(true);
  });

  it("fails when the screen never stops changing", async () => {
    let tick = 0;
    currentTree = () => screenWith(`frame ${tick++}`);
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 600, minStableMs: 300 }
`
    );
    const r = await run("ready");
    expect(r.ok).toBe(false);
    const step = r.steps.at(-1)!;
    expect(step.status).toBe("fail");
    expect(step.reason).toContain("never held still");
  });

  it("distinguishes a screen that never rendered from one that never settled", async () => {
    currentTree = () => n({ role: "AXWindow", frame: FULL, children: [] });
    await writeFlow(
      "ready",
      `executionPrerequisite: ""
steps:
  - await: { idle: true, timeout: 500 }
`
    );
    const r = await run("ready");
    expect(r.steps.at(-1)!.reason).toContain("never rendered content");
  });
});
