import { describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import { UnsupportedOperationError } from "../src/utils/capability";
import { DependencyMissingError } from "../src/utils/check-deps";
import { vegaImpl } from "../src/tools/keyboard/platforms/vega";

/**
 * Vega injects input over `adb`, so a missing adb must fail with a 424 install
 * hint. But `clear` is refused on Vega whatever the host has installed, and
 * declaring `requires: ["adb"]` had `dispatchByPlatform` preflight that check
 * BEFORE the handler ran — so on a host without adb the documented
 * `UnsupportedOperationError` never happened and the caller was told to install
 * a binary for a capability that will never exist.
 *
 * Its own file because the whole point is an adb that is NOT there, which means
 * mocking the dependency check for every test in the file.
 */
vi.mock("../src/utils/check-deps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/check-deps")>();
  return {
    ...actual,
    ensureDep: vi.fn(async () => {
      throw new actual.DependencyMissingError(["adb"], "Install the Android SDK platform-tools.");
    }),
  };
});

const VEGA: DeviceInfo = { id: "vega-serial", platform: "vega", kind: "vvd" };

describe("keyboard on Vega — the clear refusal outranks the adb preflight", () => {
  it("refuses `clear` with the capability error on a host with no adb", async () => {
    await expect(vegaImpl.handler({}, { udid: VEGA.id, clear: true }, VEGA)).rejects.toBeInstanceOf(
      UnsupportedOperationError
    );
  });

  it("still reports the missing adb for the shapes that DO reach the device", async () => {
    // The positive control: moving the check must not drop it. `text` and `key`
    // both inject over adb, so both keep the 424 install hint.
    await expect(
      vegaImpl.handler({}, { udid: VEGA.id, text: "hello" }, VEGA)
    ).rejects.toBeInstanceOf(DependencyMissingError);
    await expect(
      vegaImpl.handler({}, { udid: VEGA.id, key: "enter" }, VEGA)
    ).rejects.toBeInstanceOf(DependencyMissingError);
  });
});
