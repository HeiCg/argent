import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Registry } from "@argent/registry";

const runHarmonyEmulator = vi.fn();
const resolveHarmonyEmulator = vi.fn();
const listHarmonyInstances = vi.fn();
const listHarmonyHdcTargets = vi.fn();
const resolveHdc = vi.fn();
const ensureDep = vi.fn();
const spawnMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: (...a: unknown[]) => spawnMock(...a) };
});
vi.mock("../src/utils/harmony-cli", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/harmony-cli")>(
    "../src/utils/harmony-cli"
  );
  return {
    ...actual,
    runHarmonyEmulator: (...a: unknown[]) => runHarmonyEmulator(...a),
    resolveHarmonyEmulator: (...a: unknown[]) => resolveHarmonyEmulator(...a),
  };
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
import { createDescribeTool } from "../src/tools/describe";
import { assertSupported } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";

const registry = {} as Registry;
const INSTANCE = "Phone_1";
/** The USB phone from `hdc list targets -v`, present throughout. */
const PHONE = { connectKey: "025DEK236V035771", connection: "USB", state: "Connected" };
/** What a booted emulator registers as, measured on a HarmonyOS 6.1.1 phone image. */
const EMULATOR_KEY = "127.0.0.1:5555";
const emulatorTarget = { connectKey: EMULATOR_KEY, connection: "TCP", state: "Connected" };
const logPath = join(tmpdir(), `argent-harmony-${INSTANCE}.log`);

/** Stands in for the detached `Emulator -start`, which normally never exits. */
class FakeEmulator extends EventEmitter {
  unref = vi.fn();
  /** The manager dying early, having printed `output` to its log. */
  die(output: string, code = 0) {
    writeFileSync(logPath, output);
    this.emit("exit", code, null);
  }
}
let child: FakeEmulator;

function boot(params: Record<string, unknown>) {
  return createBootDeviceTool(registry).execute!({}, { harmonyInstance: INSTANCE, ...params });
}

/** A row of `hdc list targets -v`; `connection` is null without that flag. */
interface HdcTargetRow {
  connectKey: string;
  connection: string | null;
  state: string;
}

/** Successive `hdc list targets` results, the last one repeating forever. */
function targets(...rounds: HdcTargetRow[][]) {
  let call = 0;
  listHarmonyHdcTargets.mockImplementation(() =>
    Promise.resolve(rounds[Math.min(call++, rounds.length - 1)])
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  writeFileSync(logPath, "");
  child = new FakeEmulator();
  spawnMock.mockReturnValue(child);
  ensureDep.mockResolvedValue(undefined);
  resolveHarmonyEmulator.mockResolvedValue("/Applications/DevEco-Studio.app/.../Emulator");
  resolveHdc.mockResolvedValue("/Applications/DevEco-Studio.app/.../hdc");
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
    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringContaining("Emulator"),
      ["-start", INSTANCE],
      expect.objectContaining({ detached: true })
    );
    expect(result).toEqual({
      platform: "harmony",
      udid: `harmony-${EMULATOR_KEY}`,
      instanceName: INSTANCE,
      booted: true,
    });
  });

  it("returns while the emulator is still running, rather than awaiting it", async () => {
    // `Emulator -start` is the emulator's supervisor and runs as long as it
    // does. Awaiting it spends the whole boot budget inside the start and then
    // kills the emulator when that budget expires, so the boot has to resolve
    // with the child still alive — which is what this test is, since `child`
    // never emits `exit`.
    targets([PHONE], [PHONE, emulatorTarget]);

    const result = (await boot({})) as { udid: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(child.unref).toHaveBeenCalled();
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
    // A killed emulator leaves its row behind as `Offline` — measured — so a
    // row existing is not the same as a device there is any point driving.
    const offline = { ...emulatorTarget, state: "Offline" };
    targets([PHONE], [PHONE, offline], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({});
    await vi.advanceTimersByTimeAsync(4_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("does not adopt a cable-attached handset that arrives during the boot", async () => {
    // A second HarmonyOS target reaches Connected inside the boot window - a
    // phone plugged in or authorised mid-boot, or a still-settling row flipping
    // from Offline - while the emulator itself never registers. Arrival alone
    // cannot tell the two apart, so adopting the first new key hands back a
    // device this call did not boot.
    const OTHER = { connectKey: "BQR0223A14001199", connection: "USB", state: "Connected" };
    targets([PHONE], [PHONE, OTHER]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).not.toBe(`harmony-${OTHER.connectKey}`);
    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toBeTruthy();
  });

  it("still adopts an arrival whose connection column is absent", async () => {
    // `hdc list targets` without `-v` prints the bare key, so `connection` is
    // null. Treating that as ineligible would refuse a boot that worked, on any
    // image or connector shape not seen here - so the USB exclusion has to fail
    // open rather than allow-list a single spelling.
    const UNTYPED = { connectKey: "127.0.0.1:5555", connection: null, state: "Connected" };
    targets([PHONE], [PHONE, UNTYPED]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("refuses to guess when two targets it could have started both arrive", async () => {
    // A concurrent `boot-device` for a different instance is not coalesced -
    // `inFlightHarmonyBoots` keys on the instance name - so both emulators
    // register inside this call's window and arrival no longer picks one out.
    const OTHER_EMULATOR = { connectKey: "127.0.0.1:5557", connection: "TCP", state: "Connected" };
    targets([PHONE], [PHONE, emulatorTarget, OTHER_EMULATOR]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toBeTruthy();
  });

  it("names the instance and says why when nothing registers within the budget", async () => {
    targets([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(spawnMock).toHaveBeenCalled();
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

  it("fails fast when the manager dies before the instance registers", async () => {
    targets([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 900_000 });
    const settled = expect(pending).rejects.toThrow(/Unable to start the emulator/);
    await vi.advanceTimersByTimeAsync(1_000);
    child.die("Unable to start the emulator", 1);
    await vi.advanceTimersByTimeAsync(3_000);
    await settled;
  });

  it("blames the region when a dead manager reports the image restriction", async () => {
    targets([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 900_000 });
    const settled = expect(pending).rejects.toThrow(/only within mainland China/);
    await vi.advanceTimersByTimeAsync(1_000);
    child.die("Currently, this capability is available only in the Chinese mainland.");
    await vi.advanceTimersByTimeAsync(3_000);
    await settled;
  });

  it("points at creating an instance when the start failed and none exist", async () => {
    listHarmonyInstances.mockResolvedValue([]);
    targets([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 900_000 });
    const settled = expect(pending).rejects.toThrow(/create one in DevEco Studio/);
    await vi.advanceTimersByTimeAsync(1_000);
    child.die(`"${INSTANCE}" is not found. Please create the device(folder): /x`, 1);
    await vi.advanceTimersByTimeAsync(3_000);
    await settled;
  });

  it("does not claim the host has no instances when the listing itself failed", async () => {
    // An unreadable list answers nothing, so it must not be read as "none" —
    // that would send the caller off creating an instance they already have.
    listHarmonyInstances.mockRejectedValue(new Error("Emulator: spawn EACCES"));
    targets([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 900_000 });
    const settled = expect(pending).rejects.toThrow(
      /is not found\. Please create the device(?!.*create one in DevEco Studio)/s
    );
    await vi.advanceTimersByTimeAsync(1_000);
    child.die(`"${INSTANCE}" is not found. Please create the device(folder): /x`, 1);
    await vi.advanceTimersByTimeAsync(3_000);
    await settled;
  });

  it("leaves a running instance alone and says how to reach it", async () => {
    listHarmonyInstances.mockResolvedValue([
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: true },
    ]);

    const result = (await boot({})) as { udid: string; note?: string };

    expect(spawnMock).not.toHaveBeenCalled();
    expect(runHarmonyEmulator).not.toHaveBeenCalled();
    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/already running/);
  });

  it("restarts a running instance on force and resolves the key it comes back on", async () => {
    // `-stop` returns before the emulator is gone, so the restart waits on
    // `isRunning`: reported running for one poll after the stop, then down. The
    // snapshot is taken only once it is, which is what lets a restart that
    // lands on the port it had before still read as an arrival.
    let listed = 0;
    listHarmonyInstances.mockImplementation(() =>
      Promise.resolve([
        { name: INSTANCE, deviceType: "Phone", osVersion: null, running: listed++ < 2 },
      ])
    );
    targets([PHONE], [PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ force: true, bootTimeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(runHarmonyEmulator).toHaveBeenCalledWith(["-stop", INSTANCE]);
    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      ["-start", INSTANCE],
      expect.any(Object)
    );
    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
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
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns an id the interaction tools accept, which the instance id is not", async () => {
    targets([PHONE], [PHONE, emulatorTarget]);

    const { udid } = (await boot({})) as { udid: string };

    // The point of resolving the key at all: what boot-device hands back has to
    // be drivable. Both halves matter — the instance id is rejected by the same
    // gate, so a payload carrying it strands the caller.
    const describe = createDescribeTool({} as Registry);
    expect(() =>
      assertSupported("describe", describe.capability, resolveDevice(udid))
    ).not.toThrow();
    expect(() =>
      assertSupported(
        "describe",
        describe.capability,
        resolveDevice(`harmony-emulator-${INSTANCE}`)
      )
    ).toThrow(/not supported on harmony emulator/);
  });

  it("starts the instance behind a harmony-emulator- udid", async () => {
    targets([PHONE], [PHONE, emulatorTarget]);

    const result = await createBootDeviceTool(registry).execute!(
      {},
      { udid: `harmony-emulator-${INSTANCE}` }
    );

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      ["-start", INSTANCE],
      expect.any(Object)
    );
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

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      ["-start", `harmony-${PHONE.connectKey}`],
      expect.any(Object)
    );
  });
});
