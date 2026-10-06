// boot-device × simslim (`ios.simslim.profile`): where the simslim calls sit in
// the iOS boot sequence, and that the feature costs nothing when unset. The
// process boundary is `execFile` (mocked), so one call log shows simslim and
// simctl interleaved in the real order. No simulator is booted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";

type ExecFileCallback = (error: Error | null, result?: unknown) => void;

const mockExecFile = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => mockExecFile(...args) };
});

const DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const isXcodePath = (p: string) => p.startsWith("/Applications/Xcode.app/");
  return {
    ...actual,
    existsSync: (p: string) => (isXcodePath(p) ? false : actual.existsSync(p)),
    realpathSync: (p: string) => (isXcodePath(p) ? p : actual.realpathSync(p)),
  };
});

const listIosSimulatorsMock = vi.fn();
vi.mock("../src/utils/ios-devices", () => ({
  listIosSimulators: (...args: unknown[]) => listIosSimulatorsMock(...args),
}));

vi.mock("../src/blueprints/ax-service", () => ({
  setAccessibilityPrefsPreBoot: vi.fn(async () => undefined),
  ensureAutomationEnabled: vi.fn(async () => undefined),
  isEntitlementBypassActive: vi.fn(async () => true),
}));

const deviceSetForUdidMock = vi.fn(async (): Promise<string | null> => null);
vi.mock("../src/utils/ios-device-sets", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-device-sets")>(
    "../src/utils/ios-device-sets"
  );
  return { ...actual, deviceSetForUdid: () => deviceSetForUdidMock() };
});

vi.mock("../src/utils/sim-remote", async () => ({
  ...(await vi.importActual<object>("../src/utils/sim-remote")),
  simctlBoot: vi.fn(async () => undefined),
  simctlBootstatus: vi.fn(async () => undefined),
  simctlListDevices: vi.fn(async () => ({ devices: {} })),
  simctlShutdown: vi.fn(async () => undefined),
}));

const profileMock = vi.fn((): string | null => null);
const binaryMock = vi.fn((): string | null => null);
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return {
    ...actual,
    getIosSimslimProfile: () => profileMock(),
    getIosSimslimBinary: () => binaryMock(),
  };
});

import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

const UDID = "11111111-1111-1111-1111-111111111111";
const PROFILE = "/repo/.github/simslim/ci.json";
const STATUS = { managedDisabled: 168, managedTotal: 171, verdict: "slim" };

function registry(): Registry {
  return {
    resolveService: vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    })),
    disposeService: vi.fn(async () => undefined),
  } as unknown as Registry;
}

function answer(file: string, args: string[]): { stdout: string; stderr: string } {
  if (file === "xcode-select") return { stdout: `${DEVELOPER_DIR}\n`, stderr: "" };
  if (file === "simslim" && args[0] === "--version")
    return { stdout: "simslim v0.11.0\n", stderr: "" };
  if (file === "simslim" && args[0] === "verify")
    return { stdout: JSON.stringify({ udid: UDID, ok: true }), stderr: "" };
  if (file === "simslim" && args[0] === "status")
    return { stdout: JSON.stringify(STATUS), stderr: "" };
  return { stdout: "", stderr: "" };
}

const calls = () =>
  mockExecFile.mock.calls.map(([file, args]) => [file, (args as string[]).slice(0, 2)] as const);

describe("boot-device — simslim", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.clearAllMocks();
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "sim-remote"]);
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as ExecFileCallback;
      cb(null, answer(args[0] as string, args[1] as string[]));
      return {} as never;
    });
    listIosSimulatorsMock.mockResolvedValue([
      {
        udid: UDID,
        state: "Shutdown",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        runtimeKind: "mobile",
      },
    ]);
    deviceSetForUdidMock.mockResolvedValue(null);
    profileMock.mockReturnValue(null);
    binaryMock.mockReturnValue(null);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("feature off: the exact stock sequence, zero simslim spawns, no extra result keys", async () => {
    const result = await createBootDeviceTool(registry()).execute!({}, { udid: UDID });
    expect(result).toStrictEqual({ platform: "ios", udid: UDID, booted: true });
    expect(mockExecFile.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ["xcrun", ["simctl", "boot", UDID]],
      ["xcrun", ["simctl", "bootstatus", UDID, "-b"]],
      ["defaults", ["write", "com.apple.iphonesimulator", "CurrentDeviceUDID", UDID]],
      ["xcode-select", ["-p"]],
    ]);
  });

  it("profile set: on → simctl boot → bootstatus → verify → status, slim in the result", async () => {
    profileMock.mockReturnValue(PROFILE);
    const result = await createBootDeviceTool(registry()).execute!({}, { udid: UDID });
    expect(calls().slice(0, 6)).toEqual([
      ["simslim", ["--version"]],
      ["simslim", ["on", UDID]],
      ["xcrun", ["simctl", "boot"]],
      ["xcrun", ["simctl", "bootstatus"]],
      ["simslim", ["verify", UDID]],
      ["simslim", ["status", UDID]],
    ]);
    expect(result).toStrictEqual({
      platform: "ios",
      udid: UDID,
      booted: true,
      slim: {
        applied: true,
        verdict: "slim",
        managedDisabled: 168,
        managedTotal: 171,
        profile: PROFILE,
        version: "v0.11.0",
      },
    });
  });

  it("passes the simulator's device set to simslim", async () => {
    profileMock.mockReturnValue(PROFILE);
    deviceSetForUdidMock.mockResolvedValue("/sets/ci");
    await createBootDeviceTool(registry()).execute!({}, { udid: UDID });
    const on = mockExecFile.mock.calls.find(([f, a]) => f === "simslim" && a[0] === "on")!;
    expect(on[1]).toEqual(["on", UDID, "--profile", PROFILE, "--set", "/sets/ci"]);
  });

  it("uses the configured binary", async () => {
    profileMock.mockReturnValue(PROFILE);
    binaryMock.mockReturnValue("/opt/homebrew/bin/simslim");
    await createBootDeviceTool(registry()).execute!({}, { udid: UDID });
    expect(mockExecFile.mock.calls[0]![0]).toBe("/opt/homebrew/bin/simslim");
  });

  it("`on` failing never fails the boot: stock sequence continues, one warning", async () => {
    profileMock.mockReturnValue(PROFILE);
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as ExecFileCallback;
      const [file, a] = [args[0] as string, args[1] as string[]];
      if (file === "simslim" && a[0] === "on") {
        cb(Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr: "boom\n" }));
      } else cb(null, answer(file, a));
      return {} as never;
    });
    const result = (await createBootDeviceTool(registry()).execute!({}, { udid: UDID })) as {
      booted: boolean;
      warning?: string;
    };
    expect(result.booted).toBe(true);
    expect(result.warning).toMatch(/simslim on failed \(exit 1: boom\)/);
    expect(calls()).toContainEqual(["xcrun", ["simctl", "bootstatus"]]);
  });

  it("an already Booted simulator is not slimmed and not rebooted", async () => {
    profileMock.mockReturnValue(PROFILE);
    listIosSimulatorsMock.mockResolvedValue([
      {
        udid: UDID,
        state: "Booted",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        runtimeKind: "mobile",
      },
    ]);
    const result = (await createBootDeviceTool(registry()).execute!({}, { udid: UDID })) as {
      warning?: string;
    };
    expect(mockExecFile.mock.calls.some(([f]) => f === "simslim")).toBe(false);
    expect(result.warning).toMatch(/already booted/);
  });

  it("tvOS: never calls simslim, result unchanged", async () => {
    profileMock.mockReturnValue(PROFILE);
    listIosSimulatorsMock.mockResolvedValue([
      {
        udid: UDID,
        state: "Shutdown",
        runtime: "com.apple.CoreSimulator.SimRuntime.tvOS-26-0",
        runtimeKind: "tv",
      },
    ]);
    const result = await createBootDeviceTool(registry()).execute!({}, { udid: UDID });
    expect(mockExecFile.mock.calls.some(([f]) => f === "simslim")).toBe(false);
    expect(result).toStrictEqual({ platform: "ios", udid: UDID, booted: true });
  });

  it("physical / unlisted iOS udid: never calls simslim", async () => {
    profileMock.mockReturnValue(PROFILE);
    listIosSimulatorsMock.mockResolvedValue([]);
    await createBootDeviceTool(registry()).execute!({}, { udid: UDID });
    expect(mockExecFile.mock.calls.some(([f]) => f === "simslim")).toBe(false);
  });

  it("remote simulator: never calls simslim", async () => {
    profileMock.mockReturnValue(PROFILE);
    const result = await createBootDeviceTool(registry()).execute!({}, { udid: `remote:${UDID}` });
    expect(mockExecFile.mock.calls.some(([f]) => f === "simslim")).toBe(false);
    expect(profileMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ platform: "ios-remote", booted: true });
  });
});
