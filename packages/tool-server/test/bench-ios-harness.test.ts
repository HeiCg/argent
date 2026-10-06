import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "@argent/registry";
import { iosOpenServerBlueprint } from "../src/blueprints/ios-open-server";
import { resolveDevice } from "../src/utils/device-info";
import {
  describeIosViaOpenServer,
  shouldUseIosOpenServer,
} from "../src/utils/ios-open-server-input";
import type { IosOpenServerNode, IosOpenServerState } from "../src/utils/ios-open-server-client";
import {
  FallbackNotes,
  RunnerOracle,
  SETTINGS_BUNDLE_ID,
  gesturePath,
  toolLayerRunner,
  waitForStableFrame,
  watchRunnerLifecycle,
  type OracleRunner,
} from "../scripts/bench-ios-harness";

/**
 * The iOS bench harness repair (2026-10-04, run 37213144359): one XCUITest runner
 * per simulator, a target app before any tree read, the serving path of every
 * gesture, and a stable-frame settle. No simulator, no xcodebuild: `xcodebuild`
 * is a fake `child_process` whose `test-without-building` starts an NDJSON
 * JSON-RPC server on the port the tool layer chose.
 */

const UDID = "DE624B9E-8175-406B-93D4-FC65B7FC39F3";

const h = vi.hoisted(() => ({
  flagOn: false,
  /** argv of every `xcodebuild test-without-building` spawn (= runner launches). */
  launches: [] as string[][],
  /** JSON-RPC methods the fake runner received, in order. */
  rpc: [] as Array<{ method: string; params: Record<string, unknown> }>,
  servers: [] as net.Server[],
}));

vi.mock("@argent/configuration-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/configuration-core")>();
  return {
    ...actual,
    isFlagEnabled: (name: string) => name === "open-ios-device-server" && h.flagOn,
  };
});

function node(label: string, y1: number, children: IosOpenServerNode[] = []): IosOpenServerNode {
  return {
    type: label === "list" ? "Table" : "Cell",
    label,
    bounds: { x1: 0, y1, x2: 390, y2: y1 + 44 },
    enabled: true,
    hittable: true,
    selected: false,
    focused: false,
    children,
  };
}

function nestedState(): IosOpenServerState {
  return {
    tree: [node("list", 100, [node("General", 300), node("Privacy", 344)])],
    truncated: false,
    info: {
      bundleId: SETTINGS_BUNDLE_ID,
      orientation: "portrait",
      keyboardVisible: false,
      screenWidth: 390,
      screenHeight: 844,
      scale: 3,
    },
    version: 1,
    timings: { snapshotMs: 10, serializeMs: 2, encodeMs: 1, captureMs: 13 },
  };
}

/** The fake runner: the NDJSON JSON-RPC surface the tool layer pings and reads. */
function startFakeRunner(port: number): net.Server {
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line) as {
          id: unknown;
          method: string;
          params?: Record<string, unknown>;
        };
        h.rpc.push({ method: req.method, params: req.params ?? {} });
        let result: unknown = {};
        if (req.method === "ping") result = { status: "ok" };
        else if (req.method === "launchApp")
          result = { success: true, bundleId: req.params?.bundleId };
        else if (req.method === "getNestedState") result = nestedState();
        else if (req.method === "getScreenSize")
          result = { screenWidth: 390, screenHeight: 844, scale: 3 };
        else if (req.method === "shutdown") result = { status: "ok" };
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
      }
    });
  });
  server.listen(port, "127.0.0.1");
  h.servers.push(server);
  return server;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { EventEmitter: Emitter } = await import("node:events");
  type Cb = (err: Error | null, value?: { stdout: string; stderr: string }) => void;
  const execFile = (file: string, args: string[], optsOrCb: unknown, maybeCb?: Cb) => {
    const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as Cb;
    if (file !== "xcodebuild") {
      cb(new Error(`unexpected exec ${file}`));
      return;
    }
    if (args[0] === "-version") {
      cb(null, { stdout: "Xcode 26.6\nBuild version 17F113\n", stderr: "" });
      return;
    }
    if (args[0] === "build-for-testing") {
      const derived = args[args.indexOf("-derivedDataPath") + 1]!;
      const products = nodePath.join(derived, "Build", "Products");
      nodeFs.mkdirSync(products, { recursive: true });
      nodeFs.writeFileSync(
        nodePath.join(products, "ArgentRunner_iphonesimulator26.5-arm64.xctestrun"),
        "<plist/>"
      );
      cb(null, { stdout: "** TEST BUILD SUCCEEDED **", stderr: "" });
      return;
    }
    cb(new Error(`unexpected xcodebuild ${args.join(" ")}`));
  };
  const spawn = (cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
    const proc = new Emitter() as InstanceType<typeof Emitter> & {
      kill: () => boolean;
      unref: () => void;
    };
    if (cmd === "xcodebuild" && args[0] === "test-without-building") {
      h.launches.push(args);
      const server = startFakeRunner(Number(opts.env?.TEST_RUNNER_ARGENT_RUNNER_PORT));
      proc.kill = () => {
        server.close();
        return true;
      };
    } else {
      proc.kill = () => true;
    }
    proc.unref = () => undefined;
    return proc;
  };
  return { ...actual, execFile, spawn };
});

describe("one runner per simulator: the oracle reads the tool layer's runner", () => {
  let tmp: string;
  let reg: Registry;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-ios-harness-"));
    fs.mkdirSync(path.join(tmp, "project"));
    vi.stubEnv("ARGENT_IOS_RUNNER_PROJECT", path.join(tmp, "project", "ArgentRunner.xcodeproj"));
    vi.stubEnv("ARGENT_IOS_RUNNER_DERIVED", path.join(tmp, "derived"));
    h.launches.length = 0;
    h.rpc.length = 0;
    reg = new Registry();
    reg.registerBlueprint(iosOpenServerBlueprint);
  });

  afterEach(async () => {
    await reg.dispose();
    for (const s of h.servers.splice(0)) s.close();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
    h.flagOn = false;
  });

  it("flag ON: the oracle and the product describe share ONE runner launch", async () => {
    h.flagOn = true;
    const device = resolveDevice(UDID);
    expect(shouldUseIosOpenServer(device)).toBe(true);

    const oracle = new RunnerOracle({ runner: () => toolLayerRunner(reg, UDID) });
    await oracle.ensureTarget();
    expect(await oracle.locate("General")).toEqual({ x: 0.5, y: 322 / 844 });

    // The product describe path resolves the SAME registry instance.
    const described = await describeIosViaOpenServer(reg, device);
    expect(described.source).toBe("xcuitest-runner");
    expect(await toolLayerRunner(reg, UDID)).toBe(await toolLayerRunner(reg, UDID));

    expect(h.launches).toHaveLength(1);
  });

  it("flag OFF: the oracle still gets the runner (one launch); measured tools stay proprietary", async () => {
    h.flagOn = false;
    const device = resolveDevice(UDID);
    expect(shouldUseIosOpenServer(device)).toBe(false);

    const oracle = new RunnerOracle({ runner: () => toolLayerRunner(reg, UDID) });
    await oracle.ensureTarget();
    expect(await oracle.locate("General")).not.toBeNull();
    expect(await oracle.screenHeightPoints()).toBe(844);
    await oracle.scrollRegion();

    expect(h.launches).toHaveLength(1);
    expect(h.rpc[0]?.method).toBe("ping");
  });

  it("counts runner starts and mid-block terminations on the registry", async () => {
    const watch = watchRunnerLifecycle(reg, UDID);
    await toolLayerRunner(reg, UDID);
    await toolLayerRunner(reg, UDID);
    expect(watch.starts()).toBe(1);
    expect(watch.terminations()).toEqual([]);
    await reg.dispose();
    expect(watch.terminations()).toEqual(["RUNNING→TERMINATING"]);
    watch.dispose();
  });
});

describe("target app before any tree read (B)", () => {
  function fakeRunner(): OracleRunner & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      launchApp: async (bundleId: string) => {
        calls.push(`launchApp:${bundleId}`);
        return { success: true, bundleId };
      },
      getNestedState: async (opts?: { bundleId?: string }) => {
        calls.push(`getNestedState:${opts?.bundleId ?? "(none)"}`);
        return nestedState();
      },
      getScreenSize: async () => {
        calls.push("getScreenSize");
        return { screenWidth: 390, screenHeight: 844, scale: 3 };
      },
    };
  }

  it("launchApp runs before the first tree read, once per block, and every read after a relaunch names the app", async () => {
    const runner = fakeRunner();
    const oracle = new RunnerOracle({ runner: async () => runner });
    // A tree read with no explicit ensureTarget still sets the target first.
    await oracle.locate("General");
    oracle.noteRelaunch(); // simctl terminate + launch between iterations
    await oracle.locate("General");
    oracle.noteRelaunch();
    await oracle.scrollRegion();
    await oracle.stages();

    expect(runner.calls[0]).toBe(`launchApp:${SETTINGS_BUNDLE_ID}`);
    expect(runner.calls.filter((c) => c.startsWith("launchApp"))).toHaveLength(1);
    const reads = runner.calls.filter((c) => c.startsWith("getNestedState"));
    expect(reads).toHaveLength(4);
    for (const r of reads) expect(r).toBe(`getNestedState:${SETTINGS_BUNDLE_ID}`);
    expect(oracle.relaunchesSeen()).toBe(2);
  });

  it("reports a connection-class failure and rethrows it", async () => {
    const seen: string[] = [];
    const oracle = new RunnerOracle({
      runner: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:64039");
      },
      onConnectionError: (m) => seen.push(m),
    });
    await expect(oracle.locate("General")).rejects.toThrow(/ECONNREFUSED/);
    expect(seen).toEqual(["connect ECONNREFUSED 127.0.0.1:64039"]);
  });
});

describe("serving path of a gesture (C.1)", () => {
  it("flag ON: open-device-server unless the tool logged a fallback note", () => {
    expect(gesturePath(true, [])).toBe("open-device-server");
    expect(
      gesturePath(true, [
        "[gesture-swipe] ios open-device-server failed, falling back to simulator-server: no target app set",
      ])
    ).toBe("simulator-server");
    expect(gesturePath(false, [])).toBe("simulator-server");
  });

  it("records the tool layer's fallback notes and still forwards them", () => {
    const forwarded: unknown[][] = [];
    const sink = { debug: (...args: unknown[]) => forwarded.push(args) };
    const notes = new FallbackNotes();
    const uninstall = notes.install(sink);
    sink.debug("[describe-ios] open ios-device-server failed, falling back to ax-service: x");
    sink.debug("[metro] unrelated");
    expect(notes.take()).toEqual([
      "[describe-ios] open ios-device-server failed, falling back to ax-service: x",
    ]);
    expect(notes.take()).toEqual([]);
    expect(forwarded).toHaveLength(2);
    uninstall();
    sink.debug("[gesture-tap] ios open-device-server failed, falling back to simulator-server: y");
    expect(notes.take()).toEqual([]);
  });
});

describe("settle before the swipe 'before' frame (D)", () => {
  function fakeClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it("returns the first frame equal to its predecessor, outside any timed region", async () => {
    const frames = ["blank", "half", "full", "full", "full"];
    const discarded: string[] = [];
    const clock = fakeClock();
    const r = await waitForStableFrame({
      capture: async () => frames.shift()!,
      same: (a, b) => a === b,
      discard: (f) => discarded.push(f),
      intervalMs: 250,
      timeoutMs: 5000,
      clock: clock.now,
      sleep: clock.sleep,
    });
    expect(r).toEqual({ stable: true, frame: "full", frames: 4, waitedMs: 750 });
    expect(discarded).toEqual(["blank", "half", "full"]);
  });

  it("gives up at the bound and reports stable=false with the last frame", async () => {
    let i = 0;
    const clock = fakeClock();
    const r = await waitForStableFrame({
      capture: async () => `frame-${i++}`,
      same: (a, b) => a === b,
      intervalMs: 250,
      timeoutMs: 1000,
      clock: clock.now,
      sleep: clock.sleep,
    });
    expect(r.stable).toBe(false);
    expect(r.frame).toBe("frame-4");
    expect(r.waitedMs).toBe(1000);
    expect(r.frames).toBe(5);
  });
});
