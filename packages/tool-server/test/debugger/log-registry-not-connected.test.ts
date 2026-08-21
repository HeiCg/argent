import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  Registry,
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";

vi.mock("@argent/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/telemetry")>();
  return { ...actual, track: vi.fn() };
});

import { track } from "@argent/telemetry";
import {
  jsRuntimeDebuggerBlueprint,
  JS_RUNTIME_DEBUGGER_NAMESPACE,
} from "../../src/blueprints/js-runtime-debugger";
import { createDebuggerLogRegistryTool } from "../../src/tools/debugger/debugger-log-registry";
import type { DebuggerNotConnectedResult } from "../../src/tools/debugger/not-connected";
import {
  recordReapedSession,
  takeReapedSession,
  __resetReapedSessionsForTesting,
} from "../../src/utils/reaped-sessions";
import { freePort, startMockMetroCdp } from "./metro-cdp-harness";
import { scopeTempHome } from "../helpers/temp-home";

// The JS-runtime-debugger / network blueprints build a real LogFileWriter,
// whose constructor mkdir -p's os.homedir()/.argent/tmp. Keep that out of the
// developer's real home.
scopeTempHome("argent-log-registry-nc-home-");

const mockTrack = vi.mocked(track);
const outcomeCalls = () =>
  mockTrack.mock.calls.filter(([event]) => event === "debugger:tool_outcome");

const INVOCATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

interface MockServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * Metro that reports a target whose CDP WebSocket is unreachable — the
 * discovery succeeds but the connect fails, which must classify as
 * cdp_unreachable rather than failing the tool.
 */
async function startMetroWithDeadCdp(deadWsPort: number): Promise<MockServer> {
  const server = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.end("packager-status:running");
      return;
    }
    if (req.url === "/json/list") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify([
          {
            id: "page-1",
            title: "React Native (mock)",
            description: "",
            webSocketDebuggerUrl: `ws://127.0.0.1:${deadWsPort}/inspector/debug?device=0&page=1`,
            deviceName: "MockDevice",
            reactNative: { capabilities: { prefersFuseboxFrontend: true } },
          },
        ])
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface Setup {
  registry: Registry;
  completed: string[];
  failed: string[];
  invoke: (params: Record<string, unknown>) => Promise<unknown>;
}

function makeSetup(blueprint: ServiceBlueprint): Setup {
  const registry = new Registry();
  registry.registerBlueprint(blueprint);
  registry.registerTool(createDebuggerLogRegistryTool(registry));
  const completed: string[] = [];
  const failed: string[] = [];
  registry.events.on("toolCompleted", (id) => completed.push(id));
  registry.events.on("toolFailed", (id) => failed.push(id));
  return {
    registry,
    completed,
    failed,
    invoke: (params) =>
      registry.invokeTool("debugger-log-registry", params, { toolInvocationId: INVOCATION_ID }),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  mockTrack.mockClear();
  vi.restoreAllMocks();
});

describe("debugger-log-registry not-connected results", () => {
  it("metro_not_running: returns the discriminated shape with NO log file, as a success", async () => {
    const port = await freePort();
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(() => setup.registry.dispose());

    const result = (await setup.invoke({
      port,
      device_id: "mock-device",
    })) as DebuggerNotConnectedResult;

    expect(result.status).toBe("not_connected");
    expect(result.connected).toBe(false);
    expect(result.reason).toBe("metro_not_running");
    expect(result.guidance).toContain("Do not retry in a loop");
    // Nothing was reaped here, so nothing is prefixed to it.
    expect(result.guidance).not.toContain("Read this result's note");
    // No fabricated LogStats: agents must not be sent to grep a file that
    // does not exist.
    expect("file" in result).toBe(false);
    expect("totalEntries" in result).toBe(false);

    expect(setup.completed).toEqual(["debugger-log-registry"]);
    expect(setup.failed).toEqual([]);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({
      tool: "debugger-log-registry",
      outcome: "metro_not_running",
      tool_invocation_id: INVOCATION_ID,
    });
  });

  it("cdp_unreachable: Metro lists a target whose CDP socket is dead", async () => {
    const deadWsPort = await freePort();
    const metro = await startMetroWithDeadCdp(deadWsPort);
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(async () => {
      await setup.registry.dispose();
      await metro.close();
    });

    const result = (await setup.invoke({
      port: metro.port,
      device_id: "mock-device",
    })) as DebuggerNotConnectedResult;

    expect(result.status).toBe("not_connected");
    expect(result.reason).toBe("cdp_unreachable");
    expect(result.guidance).toContain("debugger-connect");
    expect(setup.failed).toEqual([]);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({ outcome: "cdp_unreachable" });
  });

  it("leads the guidance with the note when the answer is carrying one", async () => {
    // These strings are shared with the tools that only point AT this one's
    // note, so read from a log-registry answer they send the agent back here
    // for a note this answer is already holding — and that this read has just
    // spent. Four of the six reasons a note can ride on do not mention one at
    // all, and a Chromium crash reaches none of the two that do.
    const port = await freePort();
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(async () => {
      await setup.registry.dispose();
      __resetReapedSessionsForTesting();
    });
    recordReapedSession(
      "js-runtime-debugger",
      "mock-device",
      "The log file is kept at /tmp/kept.log",
      { cause: "runtime-death", keptAt: "/tmp/kept.log", scope: String(port) }
    );

    const result = (await setup.invoke({ port, device_id: "mock-device" })) as Record<
      string,
      string
    >;

    expect(result.reason).toBe("metro_not_running");
    expect(result.note).toContain("/tmp/kept.log");
    expect(result.guidance.startsWith("Read this result's note first")).toBe(true);
    // And the reason's own guidance is still all there behind it.
    expect(result.guidance).toContain("Do not retry in a loop");
  });

  /**
   * A service parked in dispose until it is released in the cleanup below —
   * standing in for the window a real dispose spends in the awaits that follow
   * filing its breadcrumb.
   */
  async function teardownInFlight(deviceId: string) {
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    const slowDisposeBlueprint: ServiceBlueprint<Record<string, never>, string> = {
      namespace: JS_RUNTIME_DEBUGGER_NAMESPACE,
      getURN: (payload) => `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${payload}`,
      factory: async () => ({
        api: {},
        dispose: () => disposeGate,
        events: new TypedEventEmitter<ServiceEvents>(),
      }),
    };
    const setup = makeSetup(slowDisposeBlueprint as ServiceBlueprint);

    const urn = `${JS_RUNTIME_DEBUGGER_NAMESPACE}:8081:${deviceId}`;
    await setup.registry.resolveService(urn);
    const disposing = setup.registry.disposeService(urn);
    cleanups.push(async () => {
      releaseDispose();
      await disposing;
      await setup.registry.dispose();
      __resetReapedSessionsForTesting();
    });
    return setup;
  }

  it("reconnecting: a resolve racing an in-flight teardown maps like debugger-status does", async () => {
    const setup = await teardownInFlight("dev1");

    const result = (await setup.invoke({
      port: 8081,
      device_id: "dev1",
    })) as DebuggerNotConnectedResult;

    expect(result.status).toBe("not_connected");
    expect(result.reason).toBe("reconnecting");
    expect(setup.failed).toEqual([]);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({ outcome: "reconnecting" });
  });

  it("reconnecting: leaves the breadcrumb for the retry its own guidance asks for", async () => {
    // The dispose files the breadcrumb before it awaits anything, so this is
    // the answer a read gets while the crashed session is still winding down.
    // Its guidance is "wait a moment and retry once" — spending the note on an
    // answer that says to ask again leaves the asking again with nothing, and
    // nothing else names the file that session kept.
    const setup = await teardownInFlight("dev2");
    recordReapedSession("js-runtime-debugger", "dev2", "The log file is kept at /tmp/kept.log", {
      cause: "runtime-death",
      keptAt: "/tmp/kept.log",
      scope: "8081",
    });

    const result = (await setup.invoke({ port: 8081, device_id: "dev2" })) as Record<
      string,
      unknown
    >;

    expect(result.reason).toBe("reconnecting");
    expect(result.note).toBeUndefined();
    expect(takeReapedSession("js-runtime-debugger", "dev2", "8081")?.salvage).toContain(
      "/tmp/kept.log"
    );
  });

  it("connected path: returns the LogStats superset — guards against an over-broad catch", async () => {
    const metro = await startMockMetroCdp();
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(async () => {
      await setup.registry.dispose();
      await metro.close();
    });

    const result = (await setup.invoke({ port: metro.port, device_id: "mock-device" })) as Record<
      string,
      unknown
    >;

    expect(result.status).toBe("connected");
    expect(result.file).toMatch(new RegExp(`argent-logs-${metro.port}`));
    expect(typeof result.totalEntries).toBe("number");
    expect(Array.isArray(result.clusters)).toBe(true);
    expect(result.deviceName).toBe("MockDevice");
    expect(result.appName).toBe("React Native (mock)");

    expect(setup.completed).toEqual(["debugger-log-registry"]);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({
      tool: "debugger-log-registry",
      outcome: "connected",
      tool_invocation_id: INVOCATION_ID,
    });
  });

  it("dead-socket asymmetry: NO gate, NO dispose — stats and the on-disk log file survive", async () => {
    // Deliberate asymmetry with debugger-status: captured logs are readable
    // over a dead socket, and a status-style gate would dispose the node —
    // whose dispose ends the session, minting a new writer over a new path —
    // i.e. reduce exactly the post-crash logs the caller came for to a
    // breadcrumb, while also dropping `file` from the result. This pin makes
    // that regression loud.
    const metro = await startMockMetroCdp();
    const factorySpy = vi.fn(jsRuntimeDebuggerBlueprint.factory);
    const setup = makeSetup({ ...jsRuntimeDebuggerBlueprint, factory: factorySpy });
    cleanups.push(async () => {
      await setup.registry.dispose();
      await metro.close();
    });

    const first = (await setup.invoke({ port: metro.port, device_id: "mock-device" })) as Record<
      string,
      unknown
    >;
    expect(first.status).toBe("connected");
    const logFile = first.file as string;
    expect(fs.existsSync(logFile)).toBe(true);

    // Kill the socket state without any close event dispatching.
    const urn = `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${metro.port}:mock-device`;
    const api = await setup.registry.resolveService<{ cdp: { isConnected: () => boolean } }>(urn);
    vi.spyOn(api.cdp, "isConnected").mockReturnValue(false);

    const second = (await setup.invoke({ port: metro.port, device_id: "mock-device" })) as Record<
      string,
      unknown
    >;
    // Still the connected shape — stats plus the route back to the data.
    expect(second.status).toBe("connected");
    expect(second.file).toBe(logFile);
    expect(fs.existsSync(logFile)).toBe(true);
    // And no dispose happened: the cached node was reused as-is.
    expect(factorySpy).toHaveBeenCalledTimes(1);
  });

  it("unexpected error: rethrows (toolFailed, no outcome event, no structured shape)", async () => {
    const brokenBlueprint: ServiceBlueprint<Record<string, never>, string> = {
      namespace: JS_RUNTIME_DEBUGGER_NAMESPACE,
      getURN: (payload) => `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${payload}`,
      factory: async () => {
        throw new Error("disk on fire");
      },
    };
    const setup = makeSetup(brokenBlueprint as ServiceBlueprint);
    cleanups.push(() => setup.registry.dispose());

    await expect(setup.invoke({ port: 8081, device_id: "dev1" })).rejects.toThrow(/disk on fire/);
    expect(setup.failed).toEqual(["debugger-log-registry"]);
    expect(setup.completed).toEqual([]);
    expect(outcomeCalls()).toHaveLength(0);
  });
});
