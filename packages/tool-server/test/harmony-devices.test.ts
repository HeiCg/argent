import { describe, it, expect } from "vitest";
import { parseHarmonyInstances, parseHdcTargets } from "../src/utils/harmony-devices";
import {
  HARMONY_EMULATOR_ID_PREFIX,
  HARMONY_ID_PREFIX,
  classifyDevice,
  harmonyConnectKey,
  harmonyDeviceId,
  harmonyEmulatorId,
  harmonyInstanceName,
  resolveDevice,
} from "../src/utils/device-info";

/**
 * Fixtures are verbatim stdout from DevEco Studio 6.1's `Emulator` manager
 * (6.1.1.200) and from `hdc` 3.2.0d talking to a physical HarmonyOS 6.0.1
 * handset, both on macOS.
 */

/** `Emulator -list -details` with nothing deployed. */
const EMULATOR_NO_INSTANCES = "[Empty]\n";

/**
 * Printed once per directory under ~/.Huawei/Emulator/deployed/ that lacks a
 * config.ini — ahead of the JSON body, which is why the parser scans forward to
 * the first bracket instead of parsing from byte zero.
 */
const EMULATOR_CONFIG_NOT_FOUND =
  'Config file not found: "/Users/u/.Huawei/Emulator/deployed/zz_broken/config.ini"\n';

/** One instance, abridged to the keys the parser reads plus a few it ignores. */
const EMULATOR_ONE_INSTANCE = `[
    {
        "deviceName": "argent_probe",
        "deviceType": "Phone",
        "hw.hdc.port": "10000",
        "isRunning": "false",
        "name": "argent_probe",
        "os.apiVersion": "24",
        "os.osVersion": "HarmonyOS 6.1.1(24)"
    }
]
`;

const EMULATOR_TWO_INSTANCES = `[
    {
        "deviceName": "argent_probe",
        "deviceType": "Phone",
        "isRunning": "false",
        "name": "argent_probe",
        "os.osVersion": "HarmonyOS 6.1.1(24)"
    },
    {
        "deviceName": "argent_probe2",
        "deviceType": "TV",
        "isRunning": "true",
        "name": "argent_probe2",
        "os.osVersion": "HarmonyOS 6.1.1(24)"
    }
]
`;

/** `hdc list targets -v` with one phone attached. Note the empty second column. */
const HDC_ONE_DEVICE = "025DEK236V035771\t\tUSB\tConnected\tlocalhost\n";

/** `hdc list targets` (and `-v`) with nothing attached. */
const HDC_NO_DEVICES = "[Empty]\n";

describe("parseHarmonyInstances", () => {
  it("returns no instances for the empty sentinel", () => {
    expect(parseHarmonyInstances(EMULATOR_NO_INSTANCES)).toEqual([]);
  });

  it("reads name, form factor, OS version and running state", () => {
    expect(parseHarmonyInstances(EMULATOR_ONE_INSTANCE)).toEqual([
      {
        name: "argent_probe",
        deviceType: "Phone",
        osVersion: "HarmonyOS 6.1.1(24)",
        running: false,
      },
    ]);
  });

  it("reads isRunning as the string it actually is, not a JSON boolean", () => {
    // The manager emits every value as a string, `isRunning` included. Comparing
    // it as a boolean would make every instance read as stopped, so a booted
    // emulator would be reported as needing a boot.
    const [, tv] = parseHarmonyInstances(EMULATOR_TWO_INSTANCES);
    expect(tv.running).toBe(true);
  });

  it("keeps the instances listed after a config diagnostic", () => {
    expect(
      parseHarmonyInstances(`${EMULATOR_CONFIG_NOT_FOUND}${EMULATOR_ONE_INSTANCE}`).map(
        (i) => i.name
      )
    ).toEqual(["argent_probe"]);
  });

  it("returns both instances when two are deployed", () => {
    expect(parseHarmonyInstances(EMULATOR_TWO_INSTANCES).map((i) => i.name)).toEqual([
      "argent_probe",
      "argent_probe2",
    ]);
  });

  it("returns no instances rather than throwing on unparseable output", () => {
    expect(parseHarmonyInstances("[ this is not json")).toEqual([]);
    expect(parseHarmonyInstances("some future banner line\n")).toEqual([]);
  });
});

describe("parseHdcTargets", () => {
  it("returns no targets for the empty sentinel", () => {
    expect(parseHdcTargets(HDC_NO_DEVICES)).toEqual([]);
  });

  it("reads the connect key, transport and state past the empty second column", () => {
    // `-v` leaves column 2 blank, so splitting on single tabs would shift every
    // field one left and report this connected phone's state as "USB" — a value
    // no readiness check matches, hiding a healthy device from the device list.
    expect(parseHdcTargets(HDC_ONE_DEVICE)).toEqual([
      { connectKey: "025DEK236V035771", connection: "USB", state: "Connected" },
    ]);
  });

  it("reads the bare non-verbose form as a connected target", () => {
    expect(parseHdcTargets("025DEK236V035771\n")).toEqual([
      { connectKey: "025DEK236V035771", connection: null, state: "Connected" },
    ]);
  });

  it("reports a non-connected target's real state", () => {
    // Verbatim from `hdc tconn 127.0.0.1:12399` against nothing listening: the
    // target is registered and listed before any handshake succeeds. So a TCP
    // row is the shape a booted emulator takes, and `Offline` is a state it can
    // genuinely be found in — which is why the boot path waits for `Connected`
    // rather than for the row to exist.
    const row = parseHdcTargets("127.0.0.1:12399\t\tTCP\tOffline\tunknown...\n")[0];
    expect(row).toEqual({ connectKey: "127.0.0.1:12399", connection: "TCP", state: "Offline" });
  });
});

describe("HarmonyOS device ids", () => {
  it("classifies both harmony id forms as harmony", () => {
    expect(classifyDevice("harmony-025DEK236V035771")).toBe("harmony");
    expect(classifyDevice("harmony-emulator-Phone_1")).toBe("harmony");
  });

  it("does not classify an id without the prefix as harmony", () => {
    // The bare instance name and a name that merely contains "harmony" are an
    // Android serial by shape — only the leading prefix routes to HarmonyOS.
    expect(classifyDevice("Phone_1")).toBe("android");
    expect(classifyDevice("my-harmony-Phone_1")).toBe("android");
    expect(classifyDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toBe("ios");
  });

  it("resolves an emulator id to kind emulator and a target id to kind device", () => {
    // The two are driven by different CLIs — `Emulator -start` boots an instance,
    // `uitest` over hdc drives a connected target — so the kind decides which
    // tools accept the id at all.
    expect(resolveDevice("harmony-emulator-Phone_1").kind).toBe("emulator");
    expect(resolveDevice("harmony-025DEK236V035771").kind).toBe("device");
  });

  it("round-trips an instance name and a connect key through their ids", () => {
    expect(harmonyEmulatorId("Phone_1")).toBe(`${HARMONY_EMULATOR_ID_PREFIX}Phone_1`);
    expect(harmonyInstanceName(harmonyEmulatorId("Phone_1"))).toBe("Phone_1");
    expect(harmonyDeviceId("025DEK236V035771")).toBe(`${HARMONY_ID_PREFIX}025DEK236V035771`);
    expect(harmonyConnectKey(harmonyDeviceId("025DEK236V035771"))).toBe("025DEK236V035771");
  });

  it("round-trips an instance whose own name looks like the emulator marker", () => {
    // One prefix stripped, not a greedy match: an instance a user named
    // `emulator-1` must not come back as `1` and boot the wrong instance.
    expect(harmonyInstanceName(harmonyEmulatorId("emulator-1"))).toBe("emulator-1");
  });

  it("leaves an unprefixed name alone", () => {
    expect(harmonyInstanceName("Phone_1")).toBe("Phone_1");
    expect(harmonyConnectKey("025DEK236V035771")).toBe("025DEK236V035771");
  });
});
