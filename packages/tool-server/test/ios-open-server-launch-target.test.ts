import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import type { IosOpenDeviceServerApi } from "../src/blueprints/ios-open-server";
import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import type { IosOpenServerState } from "../src/utils/ios-open-server-client";

/**
 * The open iOS runner (`open-ios-device-server` flag, simulators only) answers
 * every app-scoped verb with "no target app set" until something names the app.
 * These pin the host side that names it: `launch-app` sets the runner target,
 * `describe` passes its `bundleId` on the read, and a verb that falls back to the
 * proprietary path says so in its result instead of only at `console.debug`.
 * The runner is a fake `IosOpenDeviceServerApi` behind a stub registry: no
 * simulator, no xcodebuild.
 */

const h = vi.hoisted(() => ({
  flagOn: true,
  execFileCalls: [] as Array<{ cmd: string; args: readonly string[] }>,
}));

vi.mock("@argent/configuration-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/configuration-core")>();
  return {
    ...actual,
    isFlagEnabled: (name: string) => name === "open-ios-device-server" && h.flagOn,
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const execFile = (
    cmd: string,
    args: readonly string[],
    opts: unknown,
    cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
  ) => {
    h.execFileCalls.push({ cmd, args });
    const callback = typeof opts === "function" ? opts : cb!;
    callback(null, { stdout: "", stderr: "" });
  };
  return { ...actual, execFile };
});

vi.mock("../src/utils/ios-devices", () => ({
  isTvOsSimulator: vi.fn(async () => false),
}));

vi.mock("../src/tools/keyboard/simulator-server-keys", () => ({
  typeSimulatorServer: vi.fn(async () => ({ typed: "hi", keys: 0 })),
}));

import { createLaunchAppTool } from "../src/tools/launch-app";
import { makeIosImpl as makeKeyboardIosImpl } from "../src/tools/keyboard/platforms/ios";
import { describeIos } from "../src/tools/describe/platforms/ios";
import { describeIosViaOpenServer } from "../src/utils/ios-open-server-input";
import { resolveDevice } from "../src/utils/device-info";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

const UDID = "DE624B9E-8175-406B-93D4-FC65B7FC39F3";
const APP = "com.example.app";

function state(bundleId: string): IosOpenServerState {
  return {
    tree: [
      {
        type: "Button",
        label: "OK",
        bounds: { x1: 0, y1: 0, x2: 100, y2: 44 },
        enabled: true,
        hittable: true,
        selected: false,
        focused: false,
        children: [],
      },
    ],
    truncated: false,
    info: {
      bundleId,
      orientation: "portrait",
      keyboardVisible: false,
      screenWidth: 390,
      screenHeight: 844,
      scale: 3,
    },
    version: 1,
    timings: { snapshotMs: 1, serializeMs: 1, encodeMs: 1, captureMs: 3 },
  };
}

/** A fake runner whose target starts unset, like `ArgentRunnerSession`. */
function fakeRunner(initialTarget = ""): IosOpenDeviceServerApi & { target: string } {
  const runner = {
    target: initialTarget,
    isReady: () => true,
    ping: vi.fn(async () => ({ status: "ok" })),
    getInfo: vi.fn(async () => ({
      bundleId: runner.target,
      orientation: "portrait",
      keyboardVisible: false,
      screenWidth: 390,
      screenHeight: 844,
      scale: 3,
      version: 0,
    })),
    getScreenSize: vi.fn(async () => ({ screenWidth: 390, screenHeight: 844, scale: 3 })),
    getState: vi.fn(),
    getNestedState: vi.fn(async (opts: { bundleId?: string } = {}) => {
      const target = opts.bundleId ?? runner.target;
      if (!target) throw new Error("no target app set; call launchApp first");
      return state(target);
    }),
    tap: vi.fn(),
    longPress: vi.fn(),
    swipe: vi.fn(),
    typeText: vi.fn(async () => {
      if (!runner.target) throw new Error("no target app set; call launchApp first");
      return { success: true, charsTyped: 2 };
    }),
    key: vi.fn(),
    screenshot: vi.fn(),
    launchApp: vi.fn(async (bundleId: string) => {
      runner.target = bundleId;
      return { success: true, bundleId };
    }),
    terminateApp: vi.fn(),
    flushInput: vi.fn(),
  };
  return runner as unknown as IosOpenDeviceServerApi & { target: string };
}

function nativeApi(): NativeDevtoolsApi {
  return {
    isEnvSetup: () => true,
    socketPath: "/tmp/test.sock",
    ensureEnvReady: async () => {},
    reverifyEnv: async () => {},
    armsEnv: true,
    withdrawEnv: async () => {},
    getInitFailure: () => null,
    isConnected: () => false,
    isAppRunning: async () => false,
    listConnectedBundleIds: () => [],
    appConnectionState: async () => "connected",
    activateNetworkInspection: () => {},
    getNetworkLog: () => [],
    clearNetworkLog: () => {},
    getAppState: async () => {
      throw new Error("not implemented");
    },
    detectFrontmostBundleId: async () => null,
    queryViewHierarchy: async () => ({}),
  } as NativeDevtoolsApi;
}

/** Routes the open-server URN to `runner`, the ax-service to a one-node tree, the rest to native-devtools. */
function stubRegistry(runner: IosOpenDeviceServerApi): Registry & { urns: string[] } {
  const urns: string[] = [];
  const resolveService = vi.fn(async (urn: string) => {
    urns.push(urn);
    if (urn.startsWith("IosOpenDeviceServer:")) return runner;
    if (urn.startsWith("AXService")) {
      return {
        degraded: false,
        describe: async () => ({
          elements: [
            {
              role: "AXButton",
              label: "OK",
              frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
            },
          ],
        }),
      };
    }
    return nativeApi();
  });
  return { resolveService, urns } as unknown as Registry & { urns: string[] };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.flagOn = true;
  h.execFileCalls.length = 0;
  __resetDepCacheForTests();
  __primeDepCacheForTests(["xcrun"]);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("launch-app sets the open runner's target (flag on)", () => {
  it("simctl-launches, then calls the runner's launchApp so later verbs have a target", async () => {
    const runner = fakeRunner();
    const tool = createLaunchAppTool(stubRegistry(runner));

    const result = await tool.execute!({}, { udid: UDID, bundleId: APP });

    expect(result).toEqual({ launched: true, bundleId: APP });
    expect(h.execFileCalls.some((c) => c.cmd === "xcrun" && c.args.includes("launch"))).toBe(true);
    expect(runner.launchApp).toHaveBeenCalledWith(APP);
    expect(runner.target).toBe(APP);
  });

  it("skips the runner's launchApp (a relaunch) when the runner already targets the app", async () => {
    const runner = fakeRunner(APP);
    const tool = createLaunchAppTool(stubRegistry(runner));

    await expect(tool.execute!({}, { udid: UDID, bundleId: APP })).resolves.toEqual({
      launched: true,
      bundleId: APP,
    });
    expect(runner.launchApp).not.toHaveBeenCalled();
  });

  it("a runner failure keeps the simctl launch and marks the result as a proprietary fallback", async () => {
    const runner = fakeRunner();
    (runner.launchApp as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("runner unreachable")
    );
    const tool = createLaunchAppTool(stubRegistry(runner));

    const result = await tool.execute!({}, { udid: UDID, bundleId: APP });

    expect(result).toEqual({
      launched: true,
      bundleId: APP,
      backend: "proprietary-fallback",
      fallbackReason: "runner unreachable",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("runner unreachable"));
  });

  it("flag off: no runner is resolved, proprietary behaviour unchanged", async () => {
    h.flagOn = false;
    const runner = fakeRunner();
    const registry = stubRegistry(runner);
    const tool = createLaunchAppTool(registry);

    await expect(tool.execute!({}, { udid: UDID, bundleId: APP })).resolves.toEqual({
      launched: true,
      bundleId: APP,
    });
    expect(registry.urns.some((u) => u.startsWith("IosOpenDeviceServer:"))).toBe(false);
    expect(runner.launchApp).not.toHaveBeenCalled();
  });
});

describe("describe passes its bundleId to the runner", () => {
  it("describeIosViaOpenServer sends bundleId on getNestedState, so no prior launch-app is needed", async () => {
    const runner = fakeRunner();
    const device = resolveDevice(UDID);

    const described = await describeIosViaOpenServer(stubRegistry(runner), device, APP);

    expect(runner.getNestedState).toHaveBeenCalledWith({ bundleId: APP });
    expect(described.source).toBe("xcuitest-runner");
    expect(runner.launchApp).not.toHaveBeenCalled();
  });

  it("without a bundleId the read relies on the runner's own target", async () => {
    const runner = fakeRunner(APP);
    await describeIosViaOpenServer(stubRegistry(runner), resolveDevice(UDID));
    expect(runner.getNestedState).toHaveBeenCalledWith({});
  });

  it("describeIos threads params.bundleId through to the open path", async () => {
    const runner = fakeRunner();
    const described = await describeIos(
      stubRegistry(runner),
      resolveDevice(UDID),
      { bundleId: APP },
      { isTvOs: false }
    );
    expect(runner.getNestedState).toHaveBeenCalledWith({ bundleId: APP });
    expect(described.source).toBe("xcuitest-runner");
    expect(described).not.toHaveProperty("backend");
  });
});

describe("a fallback from the open path is visible", () => {
  it("describe: open path throws -> ax-service result carries the fallback marker", async () => {
    const runner = fakeRunner(); // no target, no bundleId: the runner refuses
    const described = await describeIos(
      stubRegistry(runner),
      resolveDevice(UDID),
      {},
      { isTvOs: false }
    );

    expect(described.source).toBe("ax-service");
    expect(described.backend).toBe("proprietary-fallback");
    expect(described.fallbackReason).toContain("no target app set");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no target app set"));
  });

  it("keyboard: open path throws -> simulator-server result carries the fallback marker", async () => {
    const runner = fakeRunner(); // no target: typeText throws
    const impl = makeKeyboardIosImpl(stubRegistry(runner));
    const device = resolveDevice(UDID);

    const result = await impl.handler({}, { udid: UDID, text: "hi" }, device);

    expect(result).toMatchObject({
      typed: "hi",
      backend: "proprietary-fallback",
      fallbackReason: expect.stringContaining("no target app set"),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[keyboard]"));
  });

  it("keyboard: the open path succeeding carries no marker", async () => {
    const runner = fakeRunner(APP);
    const impl = makeKeyboardIosImpl(stubRegistry(runner));

    // Non-ASCII text goes to the runner directly; printable ASCII would try
    // sim-input first (see ios-open-server-input-routing.test.ts).
    const result = await impl.handler({}, { udid: UDID, text: "hé" }, resolveDevice(UDID));

    expect(result).toEqual({ typed: "hé", keys: 0, inputBackend: "runner" });
    expect(warn).not.toHaveBeenCalled();
  });
});
