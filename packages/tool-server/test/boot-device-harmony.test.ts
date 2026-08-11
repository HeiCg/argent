import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Registry } from "@argent/registry";

const runHarmonyEmulator = vi.fn();
const listHarmonyInstances = vi.fn();
const listHarmonyHdcTargets = vi.fn();
const resolveHdc = vi.fn();
const ensureDep = vi.fn();

vi.mock("../src/utils/harmony-cli", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/harmony-cli")>(
    "../src/utils/harmony-cli"
  );
  return { ...actual, runHarmonyEmulator: (...a: unknown[]) => runHarmonyEmulator(...a) };
});
vi.mock("../src/utils/harmony-devices", () => ({
  listHarmonyInstances: (...a: unknown[]) => listHarmonyInstances(...a),
  listHarmonyHdcTargets: (...a: unknown[]) => listHarmonyHdcTargets(...a),
}));
vi.mock("../src/utils/harmony-hdc", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/harmony-hdc")>(
    "../src/utils/harmony-hdc"
  );
  return { ...actual, resolveHdc: (...a: unknown[]) => resolveHdc(...a) };
});
vi.mock("../src/utils/check-deps", async () => {
  const actual =
    await vi.importActual<typeof import("../src/utils/check-deps")>("../src/utils/check-deps");
  return { ...actual, ensureDep: (...a: unknown[]) => ensureDep(...a) };
});

import { createBootDeviceTool } from "../src/tools/devices/boot-device";

const registry = {} as Registry;
const INSTANCE = "Phone_1";
/** The USB phone from `hdc list targets -v`, present throughout. */
const PHONE = { connectKey: "025DEK236V035771", connection: "USB", state: "Connected" };
const EMULATOR_KEY = "127.0.0.1:10001";
const emulatorTarget = { connectKey: EMULATOR_KEY, connection: "TCP", state: "Connected" };

function boot(params: Record<string, unknown>) {
  return createBootDeviceTool(registry).execute!({}, { harmonyInstance: INSTANCE, ...params });
}

/** Successive `hdc list targets` results, the last one repeating forever. */
function targets(...rounds: (typeof PHONE)[][]) {
  let call = 0;
  listHarmonyHdcTargets.mockImplementation(() =>
    Promise.resolve(rounds[Math.min(call++, rounds.length - 1)])
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureDep.mockResolvedValue(undefined);
  resolveHdc.mockResolvedValue("/Applications/DevEco-Studio.app/Contents/sdk/.../hdc");
  runHarmonyEmulator.mockResolvedValue({ stdout: "", stderr: "" });
  listHarmonyInstances.mockResolvedValue([
    { name: INSTANCE, deviceType: "Phone", osVersion: "HarmonyOS 6.1.1(24)", running: false },
  ]);
  targets([PHONE]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("boot-device — HarmonyOS emulator path", () => {
  it("returns the connect key of the target that appeared, not the instance id", async () => {
    targets([PHONE], [PHONE, emulatorTarget]);

    const result = await boot({});

    expect(ensureDep).toHaveBeenCalledWith("harmony-emulator");
    expect(runHarmonyEmulator).toHaveBeenCalledWith(["-start", INSTANCE], expect.any(Number));
    expect(result).toEqual({
      platform: "harmony",
      udid: `harmony-${EMULATOR_KEY}`,
      instanceName: INSTANCE,
      booted: true,
    });
  });

  it("ignores a target that was already connected before the start", async () => {
    // The phone is connected the whole time and must never be mistaken for the
    // instance just started — arrival is the only thing that identifies it.
    targets([PHONE], [PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({});
    await vi.advanceTimersByTimeAsync(4_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("only counts a target once it is Connected", async () => {
    // A target that has registered but is still Offline cannot be driven, so
    // handing its key back would give the caller an id every later tool fails on.
    const offline = { connectKey: "127.0.0.1:10002", connection: "TCP", state: "Offline" };
    targets([PHONE], [PHONE, offline], [PHONE, offline, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({});
    await vi.advanceTimersByTimeAsync(4_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("names the instance and says why when nothing registers within the budget", async () => {
    targets([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(runHarmonyEmulator).toHaveBeenCalledWith(["-start", INSTANCE], expect.any(Number));
    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/bootTimeoutMs/);
  });

  it("blames the missing connector instead of waiting out the budget for it", async () => {
    resolveHdc.mockResolvedValue(null);

    const result = (await boot({})) as { udid: string; note?: string };

    // No fake timers and no advance: without `hdc` the wait is skipped
    // outright, so a partial DevEco install fails fast and says which half.
    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/`hdc` was not found/);
  });

  it("leaves a running instance alone and says how to reach it", async () => {
    listHarmonyInstances.mockResolvedValue([
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: true },
    ]);

    const result = (await boot({})) as { udid: string; note?: string };

    expect(runHarmonyEmulator).not.toHaveBeenCalled();
    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/already running/);
  });

  it("restarts a running instance on force and resolves the key it comes back on", async () => {
    listHarmonyInstances.mockResolvedValue([
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: true },
    ]);
    // The restart lands on the port it had before, and the target lingers one
    // poll past the stop. That is what makes waiting for it to drop
    // load-bearing: snapshot too early and the key is already known, so its
    // return never reads as an arrival.
    targets(
      [PHONE, emulatorTarget],
      [PHONE, emulatorTarget],
      [PHONE],
      [PHONE],
      [PHONE],
      [PHONE, emulatorTarget]
    );
    vi.useFakeTimers();

    const pending = boot({ force: true, bootTimeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(runHarmonyEmulator.mock.calls.map((c) => (c[0] as string[])[0])).toEqual([
      "-stop",
      "-start",
    ]);
    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
    // The stop and the wait for it come out of the same budget the start then
    // spends, rather than each stage getting the caller's full value.
    const startCall = runHarmonyEmulator.mock.calls.find((c) => (c[0] as string[])[0] === "-start");
    expect(startCall![1]).toBeLessThan(120_000);
  });

  it("does not start the instance when stopping it for a restart failed", async () => {
    listHarmonyInstances.mockResolvedValue([
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: true },
    ]);
    runHarmonyEmulator.mockResolvedValue({
      stdout: `"${INSTANCE}" failed, emulator is not exists`,
      stderr: "",
    });

    await expect(boot({ force: true })).rejects.toThrow(/Failed to stop HarmonyOS emulator/);
    expect(runHarmonyEmulator).toHaveBeenCalledTimes(1);
  });

  it("blames the region when the manager reports the image restriction", async () => {
    runHarmonyEmulator.mockResolvedValue({
      stdout: "Currently, this capability is available only in the Chinese mainland.",
      stderr: "",
    });

    await expect(boot({})).rejects.toThrow(/only within mainland China/);
  });

  it("points at creating an instance when the start failed and none exist", async () => {
    listHarmonyInstances.mockResolvedValue([]);
    runHarmonyEmulator.mockResolvedValue({
      stdout: `"${INSTANCE}" is not found. Please create the device(folder): /x`,
      stderr: "",
    });

    await expect(boot({})).rejects.toThrow(/create one in DevEco Studio/);
  });

  it("does not claim the host has no instances when the listing itself failed", async () => {
    // An unreadable list answers nothing, so it must not be read as "none" —
    // that would send the caller off creating an instance they already have.
    listHarmonyInstances.mockRejectedValue(new Error("Emulator: spawn EACCES"));
    runHarmonyEmulator.mockResolvedValue({
      stdout: `"${INSTANCE}" is not found. Please create the device(folder): /x`,
      stderr: "",
    });

    await expect(boot({})).rejects.toThrow(/is not found\. Please create the device/);
    await expect(boot({})).rejects.not.toThrow(/create one in DevEco Studio/);
  });

  it("starts the instance behind a harmony-emulator- udid", async () => {
    targets([PHONE], [PHONE, emulatorTarget]);

    const result = await createBootDeviceTool(registry).execute!(
      {},
      { udid: `harmony-emulator-${INSTANCE}` }
    );

    expect(runHarmonyEmulator).toHaveBeenCalledWith(["-start", INSTANCE], expect.any(Number));
    expect(result).toMatchObject({ instanceName: INSTANCE, udid: `harmony-${EMULATOR_KEY}` });
  });

  it("does not read a connect-key id as an instance name", async () => {
    vi.useFakeTimers();

    const pending = boot({
      harmonyInstance: `harmony-${PHONE.connectKey}`,
      bootTimeoutMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(31_000);
    await pending;

    expect(runHarmonyEmulator).toHaveBeenCalledWith(
      ["-start", `harmony-${PHONE.connectKey}`],
      expect.any(Number)
    );
  });
});
