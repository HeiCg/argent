import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
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
const harmonyDisplay = vi.fn();
const harmonyDumpLayout = vi.fn();

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
vi.mock("../src/utils/harmony-uitest", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/harmony-uitest")>(
    "../src/utils/harmony-uitest"
  );
  return {
    ...actual,
    harmonyDisplay: (...a: unknown[]) => harmonyDisplay(...a),
    harmonyDumpLayout: (...a: unknown[]) => harmonyDumpLayout(...a),
  };
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
/**
 * The row a stopped instance leaves behind. Measured: `-stop` takes the guest
 * down but never removes the row, so `127.0.0.1:5555  TCP  Offline  localhost`
 * survives in `hdc list targets -v` until the daemon is killed — and a restart
 * comes back on that same port.
 */
const staleEmulatorTarget = { connectKey: EMULATOR_KEY, connection: "TCP", state: "Offline" };
/** A second emulator, already up and driveable when this boot starts. */
const foreignTarget = { connectKey: "127.0.0.1:5559", connection: "TCP", state: "Connected" };
/** `hw.lcd.single.width`/`height` of the phone image, echoed by the guest's `render resolution`. */
const PANEL = { width: 1320, height: 2856 };
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
    {
      name: INSTANCE,
      deviceType: "Phone",
      osVersion: "HarmonyOS 6.1.1(24)",
      running: false,
      display: PANEL,
    },
  ]);
  // Every target answers with the instance's own panel unless a case says
  // otherwise, and every guest is driveable as soon as it is Connected.
  harmonyDisplay.mockResolvedValue({ ...PANEL, screenOn: true });
  harmonyDumpLayout.mockResolvedValue({ attributes: {} });
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
    // row existing is not the same as a device there is any point driving. The
    // Offline row and the later Connected one are given DIFFERENT keys on
    // purpose: sharing one key would pass whether the code waited for
    // `Connected` or adopted the `Offline` row on the earlier poll, which is
    // exactly the drift this test exists to catch.
    const offlineOther = { connectKey: "127.0.0.1:5559", connection: "TCP", state: "Offline" };
    targets([PHONE], [PHONE, offlineOther], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({});
    await vi.advanceTimersByTimeAsync(4_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("resolves the key an instance comes back on, though its row never left the listing", async () => {
    // The second boot of any instance this `hdc` daemon has already seen. Its
    // row is still listed — `Offline`, left there by the previous `-stop` — and
    // it re-registers on the same port, so a snapshot that kept every listed key
    // could never see it arrive: measured on the device as a full budget spent
    // and `harmony-emulator-argent_phone` handed back, an id no interaction tool
    // accepts, under a note blaming a boot that had in fact finished in seconds.
    targets([PHONE, staleEmulatorTarget], [PHONE, staleEmulatorTarget], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
  });

  it("declines a fresh arrival whose panel is another device's", async () => {
    // `Offline` is also what a connection blip leaves behind, so a foreign
    // device reconnecting is an arrival by state alone. The instance's
    // configured panel is what separates the two: a wearable answers 466x466
    // where this phone image answers 1320x2856.
    const WEARABLE = { connectKey: "127.0.0.1:5561", connection: "TCP", state: "Connected" };
    harmonyDisplay.mockImplementation((key: string) =>
      Promise.resolve(
        key === WEARABLE.connectKey
          ? { width: 466, height: 466, screenOn: true }
          : { ...PANEL, screenOn: true }
      )
    );
    targets([PHONE], [PHONE, WEARABLE], [PHONE, WEARABLE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
  });

  it("matches the instance's panel whichever way round the guest composites it", async () => {
    // The manager reports the panel as configured, the guest as currently
    // oriented, so a landscape instance would read as a different device if the
    // axes were compared pairwise.
    harmonyDisplay.mockResolvedValue({ width: PANEL.height, height: PANEL.width, screenOn: true });
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("says a target was seen and declined rather than that none registered", async () => {
    // The panel filter's own failure mode. Blaming the budget would be the
    // wrong advice twice over: something did register, and a longer one cannot
    // change what it answered.
    const WEARABLE = { connectKey: "127.0.0.1:5561", connection: "TCP", state: "Connected" };
    harmonyDisplay.mockResolvedValue({ width: 466, height: 466, screenOn: true });
    targets([PHONE], [PHONE, WEARABLE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/not the panel this instance is configured with/);
    expect(result.note).not.toMatch(/bootTimeoutMs/);
  });

  it("leaves a target that cannot be probed yet pending rather than rejecting it", async () => {
    // A row reaches `Connected` before its render service answers. Treating an
    // unreadable probe as a mismatch would reject the instance permanently for
    // being early.
    let probes = 0;
    harmonyDisplay.mockImplementation(() =>
      probes++ < 2
        ? Promise.reject(new Error("[Fail][E001005] Device not found or connected"))
        : Promise.resolve({ ...PANEL, screenOn: true })
    );
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(10_000);

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
    // Truthy is not enough: the note this branch returns must be the
    // two-arrival refusal, not the generic "had not registered before the boot
    // budget ran out" one — both targets DID register, and argent declined to
    // choose. Pointing the caller at `bootTimeoutMs` would misdiagnose it.
    expect(result.note).toMatch(/two|both|more than one|could not tell which/i);
  });

  it("refuses at once rather than spending the budget on a decision already made", async () => {
    // The refusal is settled the moment both are seen. Polling on would bill the
    // caller the whole 3-minute default for it — and would turn the refusal into
    // a guess if one of the two dropped out and left the other alone.
    const OTHER_EMULATOR = { connectKey: "127.0.0.1:5557", connection: "TCP", state: "Connected" };
    targets([PHONE], [PHONE, emulatorTarget, OTHER_EMULATOR]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 180_000 });
    // Two polls' worth, three orders of magnitude short of the budget.
    await vi.advanceTimersByTimeAsync(5_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/More than one/);
  });

  it("keeps refusing after one of the two ambiguous targets drops away", async () => {
    // A still-settling emulator is the likelier of the two to flap, so the
    // survivor is the likelier to be the other device. Once both have been seen
    // the answer cannot be un-made by one leaving.
    const OTHER_EMULATOR = { connectKey: "127.0.0.1:5557", connection: "TCP", state: "Connected" };
    targets([PHONE], [PHONE, emulatorTarget, OTHER_EMULATOR], [PHONE, OTHER_EMULATOR]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/More than one/);
  });

  it("waits for the guest to answer `uitest`, not merely for `hdc` to reach it", async () => {
    // A target reports `Connected` as soon as the daemon is reachable; the
    // window service comes up after it, and until it does every interaction tool
    // fails against an id that looks drivable.
    let probes = 0;
    harmonyDumpLayout.mockImplementation(() =>
      probes++ < 3
        ? Promise.reject(new Error("DumpLayout failed:Get window nodes failed"))
        : Promise.resolve({ attributes: {} })
    );
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(probes).toBeGreaterThan(3);
    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
  });

  it("still hands back the key when the guest never answers, and says so", async () => {
    // The key is the right id either way, so an unresponsive guest is a caveat
    // rather than a failure — but a silent one would put the caller's first
    // interaction failure down to the wrong cause.
    harmonyDumpLayout.mockRejectedValue(new Error("DumpLayout failed:Get window nodes failed"));
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toMatch(/still not answering `uitest`/);
  });

  it("ignores a second emulator that was connected and driveable before the start", async () => {
    // The pre-start snapshot is the only thing standing between this boot and a
    // peer emulator: it is TCP like ours, so the USB filter passes it, and off
    // the same device profile it answers the same panel, so the confirmation
    // passes it too. Every other fixture's pre-existing row is USB or
    // `Offline`, i.e. excluded by something else.
    targets([PHONE, foreignTarget], [PHONE, foreignTarget, emulatorTarget]);

    const result = (await boot({})) as { udid: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("refuses rather than starting blind when the pre-start listing cannot be read", async () => {
    // A failed listing read as an empty one makes every already-connected
    // emulator this boot's arrival. Refused before the spawn, so there is no
    // instance left running behind the error.
    listHarmonyHdcTargets.mockRejectedValue(new Error("[Fail]Connect server failed"));
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    const assertion = expect(pending).rejects.toThrow(/could not have been told apart/);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("takes the snapshot on a retry rather than failing the boot for one bad listing", async () => {
    // The `hdc` daemon restarting after a `-stop` is the likely cause and it
    // clears, so one refusal must not cost the caller the boot.
    let call = 0;
    listHarmonyHdcTargets.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("[Fail]Connect server failed"));
      return Promise.resolve(call <= 2 ? [PHONE] : [PHONE, emulatorTarget]);
    });
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
  });

  it("removes the readiness probe's dump instead of leaving one per boot in tmpdir", async () => {
    // A full `uitest dumpLayout` JSON, and nothing else prunes it.
    const probes: string[] = [];
    harmonyDumpLayout.mockImplementation((_key: unknown, path: string) => {
      probes.push(path);
      writeFileSync(path, "{}");
      return Promise.resolve({ attributes: {} });
    });
    targets([PHONE], [PHONE, emulatorTarget]);

    await boot({});

    expect(probes).toHaveLength(1);
    expect(existsSync(probes[0]!)).toBe(false);
  });

  it("reports the manager's death during the readiness wait, not a slow guest", async () => {
    // The wait for the target polls the exit latch for exactly this reason, and
    // the readiness wait sits in the same window: a dead emulator answers no
    // probe, which is what one still starting its window service looks like.
    // Without the latch the boot spends the rest of the budget on a corpse and
    // then hands back a drivable id telling the caller to retry.
    harmonyDumpLayout.mockImplementation(() => {
      child.die("error: the emulator instance quit unexpectedly (disk image corrupted)");
      return Promise.reject(new Error("DumpLayout failed:Get window nodes failed"));
    });
    targets([PHONE], [PHONE, emulatorTarget]);

    await expect(boot({ bootTimeoutMs: 30_000 })).rejects.toThrow(/disk image corrupted/);
  });

  it("says the key rests on arrival alone when the instance has no panel to check it against", async () => {
    // A multi-display profile keys its LCDs differently, so `display` is null on
    // a perfectly good instance — and the check that separates it from another
    // device reconnecting in the same window has nothing to compare against.
    // Returning the key unremarked is how a later tap lands on that device.
    listHarmonyInstances.mockResolvedValue([
      {
        name: INSTANCE,
        deviceType: "Phone",
        osVersion: "HarmonyOS 6.1.1(24)",
        running: false,
        display: null,
      },
    ]);
    targets([PHONE], [PHONE, emulatorTarget]);

    const result = (await boot({})) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toMatch(/does not describe a single panel/);
    expect(harmonyDisplay).not.toHaveBeenCalled();
  });

  it("re-probes a target that read wrong once instead of disqualifying it for the boot", async () => {
    // A guest mid-boot has not settled: this platform's flagship form factors
    // are foldables, whose resolution changes with the fold. Latching the first
    // reading rejects the instance argent itself started, for the whole budget.
    harmonyDisplay
      .mockResolvedValueOnce({ width: 1080, height: 2340, screenOn: true })
      .mockResolvedValue({ ...PANEL, screenOn: true });
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
    expect(harmonyDisplay.mock.calls.length).toBeGreaterThan(1);
  });

  it("reads a 0x0 panel as a guest that has not composited, not as another device", async () => {
    // The manager side refuses zero as a panel, so reading it as someone else's
    // would have the two sides of the one joining value disagree — and would
    // report a guest that never got as far as compositing as proof that the
    // target belongs to some other device.
    harmonyDisplay.mockResolvedValue({ width: 0, height: 0, screenOn: true });
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.note).toMatch(/never reported its display/);
    expect(result.note).not.toMatch(/is not the panel/);
  });

  it("does not blame `hdc` registration for a target that registered but never reported a panel", async () => {
    // "had not registered with `hdc`" is a plain untruth here, and it sends the
    // caller to raise a budget that was never the problem.
    harmonyDisplay.mockRejectedValue(new Error("hidumper produced no render resolution"));
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/never reported its display/);
    expect(result.note).not.toMatch(/had not registered/);
  });

  it("carries both caveats when the key is neither checked nor answering", async () => {
    // One `note` field, two independent things left unproven. Dropping either
    // for the other has the payload assert something the boot did not establish.
    listHarmonyInstances.mockResolvedValue([
      {
        name: INSTANCE,
        deviceType: "Phone",
        osVersion: "HarmonyOS 6.1.1(24)",
        running: false,
        display: null,
      },
    ]);
    harmonyDumpLayout.mockRejectedValue(new Error("DumpLayout failed:Get window nodes failed"));
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toMatch(/does not describe a single panel/);
    expect(result.note).toMatch(/still not answering `uitest`/);
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
    vi.useFakeTimers();

    const pending = boot({});
    // The arrival wait is skipped outright without `hdc`; what remains is the
    // short grace that watches the manager for an immediate failure, so this
    // advances past that rather than the boot budget.
    await vi.advanceTimersByTimeAsync(4_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/`hdc` was not found/);
  });

  it("does not claim the instance started when the manager already died and hdc is missing", async () => {
    // With no connector the arrival wait is skipped, so nothing else ever
    // consults the manager - and the note it would otherwise return opens with
    // "The instance started", which at that point nothing had checked.
    // The manager dies while the connector is being looked for, which is the
    // real ordering: `Emulator -start` fails in milliseconds, the `hdc` lookup
    // is a filesystem probe.
    resolveHdc.mockResolvedValue(null);
    setTimeout(
      () => child.die("Failed to start emulator: this emulator instance is already running"),
      5
    );

    await expect(boot({})).rejects.toThrow(/already running/);
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
    // A negative LOOKAHEAD anchored on `is not found…` would not catch the
    // no-instances sentence prepended BEFORE the anchor, so this asserts the
    // absence directly.
    const settled = expect(pending).rejects.toThrow(/is not found\. Please create the device/);
    await vi.advanceTimersByTimeAsync(1_000);
    child.die(`"${INSTANCE}" is not found. Please create the device(folder): /x`, 1);
    await vi.advanceTimersByTimeAsync(3_000);
    await settled;
    const msg = await pending.catch((e: unknown) => (e as Error).message);
    expect(msg).not.toContain("create one in DevEco Studio");
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
    // `isRunning` — and for the whole budget, since how long the instance then
    // takes to go down is unpredictable (9s to ~70s measured). Reported running
    // for 40s here, past any fixed grace.
    //
    // The stopped instance is modelled as an `Offline` ROW rather than an absent
    // one, because that is what a device does: `-stop` takes the guest down and
    // leaves `127.0.0.1:5555  TCP  Offline` behind. A fixture where the key
    // vanishes and reappears cannot fail, since the key is then fresh whatever
    // the snapshot kept.
    let listed = 0;
    listHarmonyInstances.mockImplementation(() =>
      Promise.resolve([
        {
          name: INSTANCE,
          deviceType: "Phone",
          osVersion: null,
          running: listed++ < 21,
          display: PANEL,
        },
      ])
    );
    targets([PHONE, staleEmulatorTarget], [PHONE, staleEmulatorTarget], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ force: true, bootTimeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(60_000);
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

  it("does not start an instance the stop never brought down", async () => {
    // One measured `-stop` had still not taken effect three minutes later, so
    // the instance being down is never assumable — and one still up when the
    // budget ends would make `-start` report only that it is already running.
    listHarmonyInstances.mockResolvedValue([
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: true },
    ]);
    vi.useFakeTimers();

    const pending = boot({ force: true, bootTimeoutMs: 60_000 });
    const settled = expect(pending).rejects.toThrow(/still running when the 60s budget ran out/);
    await vi.advanceTimersByTimeAsync(61_000);
    await settled;

    expect(runHarmonyEmulator).toHaveBeenCalledWith(["-stop", INSTANCE]);
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
