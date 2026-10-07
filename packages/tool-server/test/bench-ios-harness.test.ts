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
import { iosRunnerReadyTimeoutMs } from "../src/utils/ios-open-server-runner";
import {
  FallbackNotes,
  RunnerLease,
  RunnerOracle,
  SETTINGS_BUNDLE_ID,
  decomposeSimInputAck,
  deviceScreenPoints,
  gesturePath,
  landedOn,
  navigationTitles,
  openToolTapPoint,
  proprietaryTapPoint,
  retryLocateOnce,
  screenOf,
  simInputTapPoint,
  toolLayerRunner,
  waitForStableFrame,
  watchRunnerLifecycle,
  type NPoint,
  type OracleRunner,
  type ScreenGeometry,
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
  /** The next N runner launches never listen (a start that misses its ready budget). */
  silentLaunches: 0,
  /** `stdio` of every runner launch. */
  stdio: [] as unknown[],
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
  const spawn = (
    cmd: string,
    args: string[],
    opts: { env?: Record<string, string>; stdio?: unknown }
  ) => {
    const proc = new Emitter() as InstanceType<typeof Emitter> & {
      kill: () => boolean;
      unref: () => void;
    };
    if (cmd === "xcodebuild" && args[0] === "test-without-building") {
      h.launches.push(args);
      h.stdio.push(opts.stdio);
      if (h.silentLaunches > 0) {
        h.silentLaunches--;
        proc.kill = () => true;
      } else {
        const server = startFakeRunner(Number(opts.env?.TEST_RUNNER_ARGENT_RUNNER_PORT));
        proc.kill = () => {
          server.close();
          return true;
        };
      }
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
    h.stdio.length = 0;
    h.silentLaunches = 0;
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
    expect(watch.restartCause()).toBeNull();
    await reg.dispose();
    expect(watch.terminations()).toEqual(["RUNNING→TERMINATING"]);
    expect(watch.restartCause()).toMatch(/terminations=RUNNING→TERMINATING during unattributed/);
    watch.dispose();
  });

  it("a start that misses its ready budget is sticky: the lease never starts a second runner, and the watcher names who did", async () => {
    vi.stubEnv("ARGENT_IOS_RUNNER_READY_TIMEOUT_MS", "300");
    h.silentLaunches = 1;
    let trigger = "prepare";
    const watch = watchRunnerLifecycle(reg, UDID, { trigger: () => trigger });
    const lease = new RunnerLease(() => toolLayerRunner(reg, UDID));

    await expect(lease.ensure()).rejects.toThrow(/did not become ready within 300ms/);
    trigger = "oracle:locate";
    await expect(lease.ensure()).rejects.toThrow(/did not become ready within 300ms/);
    expect(h.launches).toHaveLength(1);
    expect(lease.startFailure()).toMatch(/did not become ready within 300ms/);

    // The product describe (flag on) still goes through the registry, which
    // starts a second runner: the bench cannot prevent it, so it records it.
    h.flagOn = true;
    trigger = "tool:describe";
    await describeIosViaOpenServer(reg, resolveDevice(UDID), SETTINGS_BUNDLE_ID);
    expect(h.launches).toHaveLength(2);
    expect(watch.starts()).toBe(2);
    const cause = watch.restartCause()!;
    expect(cause).toMatch(/2 starts in the block/);
    expect(cause).toMatch(
      /#1 by prepare: error after \d+ ms \(.*did not become ready within 300ms/
    );
    expect(cause).toMatch(/#2 by tool:describe: running after \d+ ms/);
    expect(cause).toMatch(/terminations=none/);
    expect(watch.startLog().map((s) => [s.trigger, s.outcome])).toEqual([
      ["prepare", "error"],
      ["tool:describe", "running"],
    ]);
    watch.dispose();
  });

  it("ARGENT_IOS_RUNNER_LOG_DIR sends the runner's xcodebuild output to a file", async () => {
    const logDir = path.join(tmp, "runner-logs");
    vi.stubEnv("ARGENT_IOS_RUNNER_LOG_DIR", logDir);
    await toolLayerRunner(reg, UDID);
    const files = fs.readdirSync(logDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^xcodebuild-test-${UDID}-\\d+\\.log$`));
    const stdio = h.stdio[0] as unknown[];
    expect(stdio[0]).toBe("ignore");
    expect(typeof stdio[1]).toBe("number");
    expect(stdio[2]).toBe(stdio[1]);
  });
});

describe("runner ready budget", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to 120 s; ARGENT_IOS_RUNNER_READY_TIMEOUT_MS overrides it; junk keeps the default", () => {
    vi.stubEnv("ARGENT_IOS_RUNNER_READY_TIMEOUT_MS", "");
    expect(iosRunnerReadyTimeoutMs()).toBe(120_000);
    vi.stubEnv("ARGENT_IOS_RUNNER_READY_TIMEOUT_MS", "300000");
    expect(iosRunnerReadyTimeoutMs()).toBe(300_000);
    vi.stubEnv("ARGENT_IOS_RUNNER_READY_TIMEOUT_MS", "soon");
    expect(iosRunnerReadyTimeoutMs()).toBe(120_000);
    vi.stubEnv("ARGENT_IOS_RUNNER_READY_TIMEOUT_MS", "-5");
    expect(iosRunnerReadyTimeoutMs()).toBe(120_000);
  });
});

describe("single ensure path (RunnerLease)", () => {
  it("starts once for any number of callers, concurrent or not", async () => {
    let starts = 0;
    const lease = new RunnerLease(async () => {
      starts++;
      return { id: starts };
    });
    const [a, b] = await Promise.all([lease.ensure(), lease.ensure()]);
    expect(a).toBe(b);
    expect(await lease.ensure()).toBe(a);
    expect(starts).toBe(1);
    expect(lease.startFailure()).toBeNull();
  });
});

describe("target app before any tree read (B)", () => {
  function fakeRunner(target = ""): OracleRunner & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      getInfo: async () => {
        calls.push("getInfo");
        return { ...nestedState().info, bundleId: target, version: 1 };
      },
      launchApp: async (bundleId: string) => {
        calls.push(`launchApp:${bundleId}`);
        target = bundleId;
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

    expect(runner.calls.slice(0, 2)).toEqual(["getInfo", `launchApp:${SETTINGS_BUNDLE_ID}`]);
    expect(runner.calls.filter((c) => c.startsWith("launchApp"))).toHaveLength(1);
    // The block's first targeting is not a re-target.
    expect(oracle.retargetsSeen()).toBe(0);
    const reads = runner.calls.filter((c) => c.startsWith("getNestedState"));
    expect(reads).toHaveLength(4);
    for (const r of reads) expect(r).toBe(`getNestedState:${SETTINGS_BUNDLE_ID}`);
    expect(oracle.relaunchesSeen()).toBe(2);
  });

  it("skips launchApp when the runner already targets the app (as the product launch-app does)", async () => {
    const runner = fakeRunner(SETTINGS_BUNDLE_ID);
    const oracle = new RunnerOracle({ runner: async () => runner });
    await oracle.ensureTarget();
    await oracle.locate("General");
    expect(runner.calls).toEqual(["getInfo", `getNestedState:${SETTINGS_BUNDLE_ID}`]);
  });

  it("after a simctl relaunch the next read re-checks the target and relaunches it only when lost (iOS-4 ticket 2)", async () => {
    const runner = fakeRunner(SETTINGS_BUNDLE_ID);
    const oracle = new RunnerOracle({ runner: async () => runner });
    await oracle.ensureTarget();
    oracle.noteRelaunch();
    // Target intact: one getInfo, no launchApp.
    await oracle.ensureTarget();
    expect(runner.calls).toEqual(["getInfo", "getInfo"]);
    expect(oracle.retargetsSeen()).toBe(0);
    // The runner lost its target across the relaunch: launchApp re-targets it.
    oracle.noteRelaunch();
    const lost = runner.getInfo;
    runner.getInfo = async () => ({ ...(await lost()), bundleId: "" });
    await oracle.locate("General");
    expect(runner.calls.slice(2)).toEqual([
      "getInfo",
      `launchApp:${SETTINGS_BUNDLE_ID}`,
      `getNestedState:${SETTINGS_BUNDLE_ID}`,
    ]);
    expect(oracle.retargetsSeen()).toBe(1);
    // No relaunch since: the next read does not re-check.
    await oracle.locate("General");
    expect(runner.calls.filter((c) => c === "getInfo")).toHaveLength(3);
  });

  it("retries a transient connection error on the SAME runner, bounded, without re-resolving it", async () => {
    const runner = fakeRunner(SETTINGS_BUNDLE_ID);
    let failures = 1;
    const read = runner.getNestedState;
    runner.getNestedState = async (opts) => {
      if (failures-- > 0) throw new Error("read ECONNRESET");
      return read(opts);
    };
    let resolves = 0;
    const seen: string[] = [];
    const ops: string[] = [];
    const oracle = new RunnerOracle({
      runner: async () => {
        resolves++;
        return runner;
      },
      onConnectionError: (m) => seen.push(m),
      onCall: (op) => ops.push(op),
      sleep: async () => undefined,
    });
    expect(await oracle.locate("General")).not.toBeNull();
    expect(oracle.transientRetries()).toBe(1);
    expect(seen).toEqual([]);
    expect(ops).toEqual(["getInfo", "locate"]);
    expect(resolves).toBe(2); // one per oracle call, never per attempt

    // Exhausted: 1 + 2 retries, then one report and the error.
    let attempts = 0;
    runner.getNestedState = async () => {
      attempts++;
      throw new Error("socket hang up");
    };
    await expect(oracle.locate("General")).rejects.toThrow(/socket hang up/);
    expect(attempts).toBe(3);
    expect(seen).toEqual(["socket hang up"]);

    // A non-connection error is not retried.
    attempts = 0;
    runner.getNestedState = async () => {
      attempts++;
      throw new Error("no target app set; call launchApp first");
    };
    await expect(oracle.locate("General")).rejects.toThrow(/no target app set/);
    expect(attempts).toBe(1);
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

  it("also records the console.warn fallback lines the tool layer logs since PR #16", () => {
    const forwarded: unknown[][] = [];
    const sink = {
      debug: (...args: unknown[]) => forwarded.push(["debug", ...args]),
      warn: (...args: unknown[]) => forwarded.push(["warn", ...args]),
    };
    const originalWarn = sink.warn;
    const notes = new FallbackNotes();
    const uninstall = notes.install(sink);
    sink.warn(
      "[gesture-tap] open ios-device-server failed, falling back to simulator-server: no target app set"
    );
    sink.warn("[launch-app] open ios-device-server failed, falling back to simctl launch only: x");
    sink.warn("[metro] unrelated warning");
    const taken = notes.take();
    expect(taken).toEqual([
      "[gesture-tap] open ios-device-server failed, falling back to simulator-server: no target app set",
      "[launch-app] open ios-device-server failed, falling back to simctl launch only: x",
    ]);
    expect(gesturePath(true, taken)).toBe("simulator-server");
    expect(forwarded).toHaveLength(3);
    uninstall();
    expect(sink.warn).toBe(originalWarn);
  });

  it("flag ON: a tool result marked proprietary-fallback is simulator-server even with no note", () => {
    expect(gesturePath(true, [], { backend: "proprietary-fallback" })).toBe("simulator-server");
    expect(gesturePath(true, [], {})).toBe("open-device-server");
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

describe("oracle geometry and landing (run 37572773799: 480 pt runner, wrong row counted as landed)", () => {
  function n(
    type: string,
    b: { y1: number; y2: number; x2?: number },
    extra: Partial<IosOpenServerNode> = {},
    children: IosOpenServerNode[] = []
  ): IosOpenServerNode {
    return {
      type,
      bounds: { x1: 0, y1: b.y1, x2: b.x2 ?? 402, y2: b.y2 },
      enabled: true,
      hittable: true,
      selected: false,
      focused: false,
      children,
      ...extra,
    };
  }

  /** Settings root on an iPhone 17 (402×874 pt) whose runner reported `info`. */
  function settingsRoot(info: { w: number; h: number }): IosOpenServerState {
    const general = n("Cell", { y1: 558, y2: 606 }, { label: "General" });
    const list = n("Table", { y1: 100, y2: 874 }, {}, [general]);
    const bar = n("NavigationBar", { y1: 54, y2: 100 }, { identifier: "Settings" });
    return {
      ...nestedState(),
      tree: [n("Application", { y1: 0, y2: 874 }, { label: "Settings" }, [bar, list])],
      info: { ...nestedState().info, screenWidth: info.w, screenHeight: info.h },
    };
  }

  function pushed(title: string): IosOpenServerState {
    const bar = n("NavigationBar", { y1: 54, y2: 100 }, { identifier: title }, [
      n("Button", { y1: 54, y2: 100, x2: 100 }, { label: "Settings" }),
      n("StaticText", { y1: 54, y2: 100 }, { label: title }),
    ]);
    return { ...nestedState(), tree: [n("Application", { y1: 0, y2: 874 }, {}, [bar])] };
  }

  function runnerWith(state: () => IosOpenServerState): OracleRunner {
    return {
      getInfo: async () => ({ ...state().info, version: 1 }),
      launchApp: async (bundleId: string) => ({ success: true, bundleId }),
      getNestedState: async () => state(),
      getScreenSize: async () => ({ screenWidth: 402, screenHeight: 874, scale: 3 }),
    };
  }

  it("normalizes against the target app's frame (402×874), not a compat-mode info size", async () => {
    for (const info of [
      { w: 402, h: 874 },
      { w: 320, h: 480 },
    ]) {
      const oracle = new RunnerOracle({ runner: async () => runnerWith(() => settingsRoot(info)) });
      const p = await oracle.locate("General");
      expect(p).not.toBeNull();
      expect(p!.x).toBeCloseTo(201 / 402, 6);
      expect(p!.y).toBeCloseTo(582 / 874, 6);
      const region = await oracle.scrollRegion();
      expect(region.y1).toBeCloseTo(100 / 874, 6);
      expect(region.y2).toBe(1);
    }
  });

  it("screenOf falls back to info when the tree has no Application root with area", () => {
    const st = { ...nestedState(), tree: [node("list", 100)] };
    expect(screenOf(st)).toEqual({ w: 390, h: 844 });
  });

  it("landedOn: the destination's navigation bar must carry the target title", () => {
    expect(landedOn(pushed("General").tree, "General")).toBe(true);
    // The run's miss: any row navigates, so a pixel diff alone counted this.
    expect(landedOn(pushed("Apple Intelligence & Siri").tree, "General")).toBe(false);
    // Still on the root: the "General" cell is not a destination title.
    expect(landedOn(settingsRoot({ w: 402, h: 874 }).tree, "General")).toBe(false);
    // No navigation bar at all: undecidable, so not landed (fail closed).
    expect(landedOn([n("Application", { y1: 0, y2: 874 })], "General")).toBe(false);
    expect(navigationTitles(pushed("General").tree)).toEqual(["General"]);
  });

  it("oracle.destination reads the tree once and reports the titles it saw", async () => {
    const oracle = new RunnerOracle({
      runner: async () => runnerWith(() => pushed("Apple Intelligence & Siri")),
    });
    expect(await oracle.destination("General")).toEqual({
      landed: false,
      titles: ["Apple Intelligence & Siri"],
    });
  });
});

describe("one located element, one physical point on every arm (run 37595262694)", () => {
  // iPhone 17: 402×874 pt @3 (framebuffer 1206×2622 px). The Settings root's
  // "General" row, in SCREEN points (the space of every node's bounds).
  const SCREEN = { w: 402, h: 874 };
  const FRAMEBUFFER = { width: 1206, height: 2622 };
  const GENERAL = { x1: 16, y1: 382, x2: 386, y2: 432 }; // centre (201, 407)

  function cell(label: string, b: typeof GENERAL): IosOpenServerNode {
    return {
      type: "Cell",
      label,
      bounds: b,
      enabled: true,
      hittable: true,
      selected: false,
      focused: false,
      children: [],
    };
  }

  /** The target app's frame at `origin` (screen points), the row inside it. */
  function appAt(origin: { x: number; y: number }): {
    state: IosOpenServerState;
    runner: OracleRunner;
    geometry: ScreenGeometry;
  } {
    const frame = { w: SCREEN.w - origin.x, h: SCREEN.h - origin.y };
    const state: IosOpenServerState = {
      ...nestedState(),
      tree: [
        {
          ...cell("Settings", {
            x1: origin.x,
            y1: origin.y,
            x2: origin.x + frame.w,
            y2: origin.y + frame.h,
          }),
          type: "Application",
          children: [cell("General", GENERAL)],
        },
      ],
      info: { ...nestedState().info, screenWidth: frame.w, screenHeight: frame.h },
    };
    const runner: OracleRunner = {
      getInfo: async () => ({ ...state.info, version: 1 }),
      launchApp: async (bundleId: string) => ({ success: true, bundleId }),
      getNestedState: async () => state,
      // The runner's getScreenSize is the target app's frame SIZE (no origin).
      getScreenSize: async () => ({ screenWidth: frame.w, screenHeight: frame.h, scale: 3 }),
    };
    return {
      state,
      runner,
      geometry: { screen: deviceScreenPoints(FRAMEBUFFER, 3)!, runner: frame },
    };
  }

  // Where each consumer puts a point on the glass, in screen points:
  //  - simulator-server `touch`: 0..1 of the device screen;
  //  - the open gesture-tap tool: 0..1 × getScreenSize (clamped), sent to the
  //    runner as screen points (`point()` cancels withOffset's app-relative base);
  //  - sim-input: x / screenWidth (clamped) as the digitizer's 0..1 of the screen.
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
  const viaProprietary = (n: NPoint, g: ScreenGeometry) => ({
    x: clamp01(n.x) * g.screen.w,
    y: clamp01(n.y) * g.screen.h,
  });
  const viaOpenTool = (n: NPoint, g: ScreenGeometry) => ({
    x: clamp01(n.x) * g.runner.w,
    y: clamp01(n.y) * g.runner.h,
  });
  const viaSimInput = (p: { x: number; y: number; width: number; height: number }) => ({
    x: clamp01(p.x / p.width) * SCREEN.w,
    y: clamp01(p.y / p.height) * SCREEN.h,
  });

  it("deviceScreenPoints: framebuffer px / scale; null without a usable pair", () => {
    expect(deviceScreenPoints(FRAMEBUFFER, 3)).toEqual(SCREEN);
    expect(deviceScreenPoints(null, 3)).toBeNull();
    expect(deviceScreenPoints(FRAMEBUFFER, null)).toBeNull();
    expect(deviceScreenPoints({ width: NaN, height: NaN }, 3)).toBeNull();
  });

  for (const origin of [
    { x: 0, y: 0 },
    { x: 0, y: 54 },
  ]) {
    it(`app frame origin (${origin.x}, ${origin.y}): the oracle's point lands on the row's centre on all three arms`, async () => {
      const { runner, geometry } = appAt(origin);
      const oracle = new RunnerOracle({ runner: async () => runner });
      oracle.setDeviceScreen(geometry.screen);
      const n = await oracle.locate("General");
      expect(n).not.toBeNull();
      // Canonical: 0..1 of the DEVICE screen, from the row's centre in screen points.
      expect(n!.x).toBeCloseTo(201 / 402, 9);
      expect(n!.y).toBeCloseTo(407 / 874, 9);

      const centre = { x: 201, y: 407 };
      const off = viaProprietary(proprietaryTapPoint(n!, geometry), geometry);
      const open = viaOpenTool(openToolTapPoint(n!, geometry), geometry);
      const sim = viaSimInput(simInputTapPoint(n!, geometry));
      for (const p of [off, open, sim]) {
        expect(p.x).toBeCloseTo(centre.x, 6);
        expect(p.y).toBeCloseTo(centre.y, 6);
      }
    });
  }

  it("without a measured device screen the oracle normalizes by the root frame's extent (origin + size)", async () => {
    const { runner } = appAt({ x: 0, y: 54 });
    const oracle = new RunnerOracle({ runner: async () => runner });
    const n = await oracle.locate("General");
    // Extent 402×874 = the device screen here; the frame SIZE alone (820) was 27 pt off.
    expect(n!.y).toBeCloseTo(407 / 874, 9);
  });

  it("scrollRegion is a fraction of the device screen too", async () => {
    const { state, runner, geometry } = appAt({ x: 0, y: 54 });
    state.tree[0]!.children.push({
      ...cell("list", { x1: 0, y1: 154, x2: 402, y2: 874 }),
      type: "Table",
    });
    const oracle = new RunnerOracle({ runner: async () => runner });
    oracle.setDeviceScreen(geometry.screen);
    const r = await oracle.scrollRegion();
    expect(r.y1).toBeCloseTo(154 / 874, 9);
    expect(r.y2).toBe(1);
  });
});

describe("settled locate (run 37595262694: the root's late banner moved 'General' 87 pt)", () => {
  // Settings inserts "Ready for Apple Intelligence" above General after launch:
  // a read before it has General at y 296..343 (centre 319.5 = 0.3656 of 874),
  // after it at 382..431 (centre 406.5 = 0.4651). A tap at 0.3656 then hit the
  // banner, which opens the Siri page, on every arm.
  function root(general: { y1: number; y2: number }): IosOpenServerState {
    return {
      ...nestedState(),
      tree: [
        {
          type: "Application",
          label: "Settings",
          bounds: { x1: 0, y1: 0, x2: 402, y2: 874 },
          enabled: true,
          hittable: true,
          selected: false,
          focused: false,
          children: [
            {
              type: "Cell",
              label: "General",
              bounds: { x1: 16, y1: general.y1, x2: 386, y2: general.y2 },
              enabled: true,
              hittable: true,
              selected: false,
              focused: false,
              children: [],
            },
          ],
        },
      ],
    };
  }
  const EARLY = root({ y1: 296, y2: 343 });
  const SETTLED = root({ y1: 382, y2: 431 });

  function runnerReading(states: IosOpenServerState[]): OracleRunner & { reads: number } {
    const r = {
      reads: 0,
      getInfo: async () => ({ ...nestedState().info, bundleId: SETTINGS_BUNDLE_ID, version: 1 }),
      launchApp: async (bundleId: string) => ({ success: true, bundleId }),
      getNestedState: async () => states[Math.min(r.reads++, states.length - 1)]!,
      getScreenSize: async () => ({ screenWidth: 402, screenHeight: 874, scale: 3 }),
    };
    return r;
  }

  it("re-reads until two consecutive reads agree, and returns the settled position", async () => {
    const runner = runnerReading([EARLY, SETTLED, SETTLED]);
    const sleeps: number[] = [];
    const oracle = new RunnerOracle({
      runner: async () => runner,
      locateSettle: { stableMs: 1000, maxReads: 5 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const n = await oracle.locate("General");
    expect(n!.y).toBeCloseTo(406.5 / 874, 9);
    expect(runner.reads).toBe(3);
    expect(sleeps).toEqual([1000, 1000]);
    expect(oracle.locateShiftsSeen()).toBe(1);
    expect(oracle.unsettledLocatesSeen()).toBe(0);
  });

  it("two agreeing reads return at once (no shift)", async () => {
    const runner = runnerReading([SETTLED]);
    const oracle = new RunnerOracle({
      runner: async () => runner,
      locateSettle: { stableMs: 1000, maxReads: 5 },
      sleep: async () => undefined,
    });
    expect((await oracle.locate("General"))!.y).toBeCloseTo(406.5 / 874, 9);
    expect(runner.reads).toBe(2);
    expect(oracle.locateShiftsSeen()).toBe(0);
  });

  it("a layout that never settles within maxReads is a miss (null), never a stale point", async () => {
    const runner = runnerReading([EARLY, SETTLED, EARLY, SETTLED]);
    const oracle = new RunnerOracle({
      runner: async () => runner,
      locateSettle: { stableMs: 10, maxReads: 4 },
      sleep: async () => undefined,
    });
    expect(await oracle.locate("General")).toBeNull();
    expect(runner.reads).toBe(4);
    expect(oracle.unsettledLocatesSeen()).toBe(1);
  });

  it("without locateSettle a locate is one read (as before)", async () => {
    const runner = runnerReading([EARLY, SETTLED]);
    const oracle = new RunnerOracle({ runner: async () => runner });
    expect((await oracle.locate("General"))!.y).toBeCloseTo(319.5 / 874, 9);
    expect(runner.reads).toBe(1);
  });
});

describe("sim-input ack decomposition (iOS-4 ticket 1)", () => {
  it("splits host write→ack into receive→first send, per-message sends and last send→ack", () => {
    const sample = decomposeSimInputAck({
      id: 7,
      hostWriteAt: 5000,
      hostAckAt: 5190,
      timing: {
        recvAt: 100,
        sends: [
          { sendStart: 100.5, sendEnd: 167.5 },
          { sendStart: 217.5, sendEnd: 284.5 },
        ],
        ackAt: 285,
      },
    });
    expect(sample).toEqual({
      hostWriteToAck: 190,
      recvToFirstSend: 0.5,
      perMessageSendMs: [67, 67],
      lastSendToAck: 0.5,
      sidecarMs: 185,
      gapsMs: 50,
      hostPipeMs: 5,
    });
  });

  it("a command with no HID message has no send terms; no timing block yields null", () => {
    expect(
      decomposeSimInputAck({
        id: 1,
        hostWriteAt: 0,
        hostAckAt: 2,
        timing: { recvAt: 10, sends: [], ackAt: 10.5 },
      })
    ).toEqual({
      hostWriteToAck: 2,
      recvToFirstSend: null,
      perMessageSendMs: [],
      lastSendToAck: null,
      sidecarMs: 0.5,
      gapsMs: null,
      hostPipeMs: 1.5,
    });
    expect(decomposeSimInputAck({ id: 1, hostWriteAt: 0, hostAckAt: 2, timing: null })).toBeNull();
  });
});

describe("locate retry (M4, run 37584719906: ON-siminput tap+describe locateFailed=1)", () => {
  it("returns the first locate without a retry", async () => {
    let calls = 0;
    const r = await retryLocateOnce(async () => {
      calls++;
      return { x: 0.5, y: 0.6 };
    });
    expect(r).toEqual({ value: { x: 0.5, y: 0.6 }, retried: false });
    expect(calls).toBe(1);
  });

  it("retries a miss (null or a throw) once and reports the retry", async () => {
    const outcomes: Array<() => Promise<NPoint | null>> = [
      async () => {
        throw new Error("connection reset");
      },
      async () => ({ x: 0.5, y: 0.6 }),
    ];
    const r = await retryLocateOnce(() => outcomes.shift()!());
    expect(r).toEqual({ value: { x: 0.5, y: 0.6 }, retried: true });

    let calls = 0;
    const miss = await retryLocateOnce(async () => {
      calls++;
      return null;
    });
    expect(miss).toEqual({ value: null, retried: true });
    expect(calls).toBe(2);
  });
});
