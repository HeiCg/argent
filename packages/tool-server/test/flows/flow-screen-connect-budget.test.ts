import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { RouteContext, RouteReader } from "../../src/utils/route-identity";

// The route reader's CONNECT, as opposed to the route poll that follows it.
// Measured on a real simulator: a React Native app takes ~12.5s to re-register
// with Metro after `restart-app`, so the gate in the position both flow skills
// mandate — `launch:` then `await: { screen: … }` — connects into a window
// where the app is not merely slow to answer but absent from Metro entirely.
// Capping that connect at a few seconds made the gate unreachable, and raising
// the step's `timeout:` did not help because the connect was charged against it.

/** Which attempt (1-based) produces a reader. Replaced per test. */
let connectLands: (attempt: number) => boolean;
/** Wall-clock of every connect attempt — the retry budget is what's under test. */
let attemptTimes: number[];
let routes: Array<RouteContext | null>;
let metroUp: boolean;

// Stub only the debugger attach and the Metro reachability probe; the budget
// arithmetic between them is real.
vi.mock("../../src/utils/route-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/route-identity")>();
  return {
    ...actual,
    connectRouteReader: vi.fn(async (): Promise<RouteReader | undefined> => {
      attemptTimes.push(Date.now());
      if (!connectLands(attemptTimes.length)) return undefined;
      return async () => routes.shift() ?? null;
    }),
  };
});

// `metroServerRunning`, NOT `discoverMetro`. Stubbing discovery here is what
// let the defect below ship: the stub answered "reachable" for a target list of
// `[]`, while the real `discoverMetro` THROWS on an empty list — and an empty
// list is the normal state of a single-app Metro for the seconds after that app
// relaunches, i.e. every post-launch gate. See discovery.metroServerRunning.
vi.mock("../../src/utils/debugger/discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/debugger/discovery")>();
  return {
    ...actual,
    metroServerRunning: vi.fn(async () => metroUp),
  };
});

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const PORT = 59999;

/**
 * Mirrors of the src constants the budget is built from. The retry interval
 * sets what "N attempts" costs in wall-clock; the floor is the budget a step
 * gets when it is NOT in a launch window, and the window is the much larger
 * one it gets when it is.
 */
const RETRY_INTERVAL_MS = 400;
const PLAIN_CONNECT_FLOOR_MS = 2500;
const POST_LAUNCH_WINDOW_MS = 20_000;

let tmpDir: string;

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

/** How long the connect kept retrying, from attempt `from` to the last one. */
function connectSpanMs(from = 0): number {
  return attemptTimes.at(-1)! - attemptTimes[from]!;
}

// Every fixture pins a SMALL `timeout:`. Left at the 7500ms default the step's
// own budget would already cover a multi-second connect, and none of these
// tests would be able to tell the launch window from it.
const AFTER_LAUNCH = `executionPrerequisite: ""
steps:
  - launch: com.acme.notes
  - await: { screen: "Home", metroPort: ${PORT}, timeout: 1000 }
`;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-connect-budget-"));
  connectLands = () => true;
  attemptTimes = [];
  routes = [];
  metroUp = true;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("post-launch route-reader connect budget", () => {
  it("keeps retrying past the plain floor for the gate that follows a launch", async () => {
    // Nine attempts ~400ms apart ≈ 3.2s of connecting — longer than any budget
    // the step's own `timeout:` can buy, and the exact shape of an app still
    // re-registering with Metro.
    connectLands = (attempt) => attempt >= 9;
    routes = [route(["Home"])];
    await writeFlow("cold", AFTER_LAUNCH);

    const r = await run("cold");

    expect(r.ok).toBe(true);
    expect(r.steps.at(-1)).toMatchObject({ kind: "screen", status: "pass" });
    expect(attemptTimes).toHaveLength(9);
    expect(connectSpanMs()).toBeGreaterThan(PLAIN_CONNECT_FLOOR_MS);
  }, 30_000);

  it("spends the launch window only while Metro is reachable", async () => {
    // No Metro at all — a release build, a fully native app. There is nothing
    // to wait for, so the step must not sit out the whole launch window to say
    // what it could say immediately.
    metroUp = false;
    connectLands = () => false;
    await writeFlow("no-metro", AFTER_LAUNCH);

    const r = await run("no-metro");

    expect(r.ok).toBe(false);
    const step = r.steps.at(-1)!;
    // Indeterminate, not a verdict about the app: identity was never read.
    expect(step.status).toBe("error");
    expect(step.reason).toContain(`no Metro dev server is answering on port ${PORT}`);
    expect(connectSpanMs()).toBeLessThan(POST_LAUNCH_WINDOW_MS / 2);
  }, 30_000);

  it("leaves the step's `timeout:` to the route poll, not to the connect", async () => {
    // The connect alone outlasts the 1200ms timeout below. Charged against it,
    // the poll would open with a spent budget: one probe, landing on the first
    // of the two nulls a mid-transition read returns.
    connectLands = (attempt) => attempt >= 5;
    routes = [null, null, route(["Home"])];
    await writeFlow(
      "poll-budget",
      `executionPrerequisite: ""
steps:
  - launch: com.acme.notes
  - await: { screen: "Home", metroPort: ${PORT}, timeout: 1200 }
`
    );

    const r = await run("poll-budget");

    expect(r.ok).toBe(true);
    expect(connectSpanMs()).toBeGreaterThan(1200);
    // All three probes were spent: the poll opened with its full budget rather
    // than the single probe a spent one gets.
    expect(routes).toHaveLength(0);
  }, 30_000);

  it("re-arms the window at the next launch", async () => {
    // The first gate connects instantly, which clears the cold epoch. The
    // second launch terminates the app again, so its gate faces the same cold
    // start as the first one did and must get the same window.
    connectLands = (attempt) => attempt === 1 || attempt >= 10;
    routes = [route(["Home"]), route(["Home"])];
    await writeFlow(
      "relaunch",
      `executionPrerequisite: ""
steps:
  - launch: com.acme.notes
  - await: { screen: "Home", metroPort: ${PORT}, timeout: 1000 }
  - launch: com.acme.notes
  - await: { screen: "Home", metroPort: ${PORT}, timeout: 1000 }
`
    );

    const r = await run("relaunch");

    expect(r.ok).toBe(true);
    expect(attemptTimes).toHaveLength(10);
    // Attempt 2 opens the second epoch; it ran past the plain floor to land.
    expect(connectSpanMs(1)).toBeGreaterThan(PLAIN_CONNECT_FLOOR_MS);
  }, 30_000);

  it("does not buy the window again once a connect has landed in this epoch", async () => {
    // A second gate reading a different runtime reconnects, but the app is
    // long past its cold start by then: it must fail on the plain floor rather
    // than making the run sit out the launch window for an app that will never
    // register.
    connectLands = (attempt) => attempt === 1;
    routes = [route(["Home"])];
    await writeFlow(
      "second-runtime",
      `executionPrerequisite: ""
steps:
  - launch: com.acme.notes
  - await: { screen: "Home", metroPort: ${PORT}, timeout: 1000 }
  - await: { screen: "Home", metroPort: 8082, timeout: 1000 }
`
    );

    const r = await run("second-runtime");

    expect(r.ok).toBe(false);
    const step = r.steps.at(-1)!;
    expect(step.status).toBe("error");
    expect(step.reason).toContain("Metro is running on port 8082");
    expect(connectSpanMs(1)).toBeLessThan(POST_LAUNCH_WINDOW_MS / 2);
    // Retries were still spent — the floor, not a single hopeless attempt.
    expect(attemptTimes.length).toBeGreaterThan(PLAIN_CONNECT_FLOOR_MS / RETRY_INTERVAL_MS);
  }, 30_000);
});
