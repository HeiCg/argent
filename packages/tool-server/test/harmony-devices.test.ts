import { describe, it, expect } from "vitest";
import { parseHarmonyInstances } from "../src/utils/harmony-devices";
import {
  HARMONY_ID_PREFIX,
  classifyDevice,
  harmonyInstanceName,
  resolveDevice,
} from "../src/utils/device-info";

/**
 * Fixtures are verbatim stdout from DevEco Studio 6.1's `Emulator` manager on
 * macOS (Emulator 6.1.1.200).
 */

/** `Emulator -list` with nothing deployed. */
const EMULATOR_NO_INSTANCES = "[Empty]\n";

/**
 * `Emulator -list` prints this once per directory under ~/.Huawei/Emulator/deployed/
 * that lacks a config.ini, ahead of the listing body.
 */
const EMULATOR_CONFIG_NOT_FOUND =
  'Config file not found: "/Users/ignacylatka/.Huawei/Emulator/deployed/probe_instance/config.ini"\n';

/** The full `Emulator -list` output observed with one such directory and no instances. */
const EMULATOR_LIST_MISSING_CONFIG = `${EMULATOR_CONFIG_NOT_FOUND}[Empty]\n`;

/** `Emulator -imageList`, abridged to two entries. Note `downloaded` is the *string* "false". */
/** Same shape with `downloaded` flipped to the string "true". */
/** `Emulator -imageList -downloaded true` with nothing downloaded — plain prose, not `[Empty]`. */
describe("parseHarmonyInstances", () => {
  it("returns no instances for the empty sentinel", () => {
    expect(parseHarmonyInstances(EMULATOR_NO_INSTANCES)).toEqual([]);
  });

  it("does not read the `Config file not found:` diagnostic as an instance name", () => {
    expect(parseHarmonyInstances(EMULATOR_LIST_MISSING_CONFIG)).toEqual([]);
  });

  it("returns a plain name line as an instance", () => {
    expect(parseHarmonyInstances("Phone_1\n")).toEqual([{ name: "Phone_1" }]);
  });

  it("keeps the real instances listed after a config diagnostic", () => {
    expect(parseHarmonyInstances(`${EMULATOR_CONFIG_NOT_FOUND}Phone_1\nTv_1\n`)).toEqual([
      { name: "Phone_1" },
      { name: "Tv_1" },
    ]);
  });
});

describe("HarmonyOS device ids", () => {
  it("classifies a harmony- prefixed id as harmony", () => {
    expect(classifyDevice("harmony-Phone_1")).toBe("harmony");
  });

  it("does not classify an id without the prefix as harmony", () => {
    // The bare instance name and a name that merely contains "harmony" are an
    // Android serial by shape — only the leading prefix routes to HarmonyOS.
    expect(classifyDevice("Phone_1")).toBe("android");
    expect(classifyDevice("my-harmony-Phone_1")).toBe("android");
    expect(classifyDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toBe("ios");
  });

  it("resolves a harmony id to an emulator", () => {
    const d = resolveDevice("harmony-Phone_1");
    expect(d.platform).toBe("harmony");
    expect(d.kind).toBe("emulator");
    expect(d.id).toBe("harmony-Phone_1");
  });

  it("round-trips the instance name through the id prefix", () => {
    expect(`${HARMONY_ID_PREFIX}Phone_1`).toBe("harmony-Phone_1");
    expect(harmonyInstanceName(`${HARMONY_ID_PREFIX}Phone_1`)).toBe("Phone_1");
  });

  it("leaves an unprefixed name alone", () => {
    expect(harmonyInstanceName("Phone_1")).toBe("Phone_1");
  });

  it("strips only the leading prefix from an instance named after it", () => {
    expect(harmonyInstanceName("harmony-harmony-1")).toBe("harmony-1");
  });
});
