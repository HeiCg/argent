import { describe, it, expect, vi, beforeEach } from "vitest";

// iOS branch shells out to `xcrun simctl location`. Stub the subprocess so the
// test asserts the argv wiring without a booted simulator.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  // promisify(execFile) invokes the callback as the LAST argument whether or not
  // an options object was passed, so resolve it positionally.
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: null, r: { stdout: string; stderr: string }) => void;
    cb(null, { stdout: "", stderr: "" });
  }),
}));

// Device-set resolution reads config off disk; pin it so argv is deterministic.
vi.mock("../src/utils/ios-device-sets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device-sets")>()),
  deviceSetForUdid: vi.fn(async () => null),
  simctlPrefix: vi.fn(() => ["simctl"]),
}));

// Android branch drives the emulator console over adb.
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  runAdb: vi.fn(async () => ({ stdout: "OK\n", stderr: "" })),
}));

// `dispatchByPlatform` preflights each branch's `requires`; CI has neither
// xcrun nor adb, so treat both as present.
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDep: vi.fn(async () => {}),
  ensureDeps: vi.fn(async () => {}),
}));

import { execFile } from "node:child_process";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { setLocationTool } from "../src/tools/set-location";
import { runAdb } from "../src/utils/adb";
import { UnsupportedOperationError } from "../src/utils/capability";

const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const androidEmulator = "emulator-5554";
const services = {} as never;

// FailureError attaches its signal under a non-enumerable symbol, so assert the
// code through the public accessor rather than toMatchObject.
function failsWith(code: string): (err: unknown) => boolean {
  return (err) => typeof code === "string" && getFailureSignal(err)?.error_code === code;
}

beforeEach(() => {
  vi.mocked(execFile).mockClear();
  vi.mocked(runAdb).mockClear();
});

describe("set-location — iOS simulator", () => {
  it("sets the location via `simctl location <udid> set <lat>,<lon>`", async () => {
    await expect(
      setLocationTool.execute(services, { udid: iosUdid, latitude: 37.33, longitude: -122.03 })
    ).resolves.toEqual({ located: true, latitude: 37.33, longitude: -122.03 });

    expect(execFile).toHaveBeenCalledTimes(1);
    const [bin, args] = vi.mocked(execFile).mock.calls[0]!;
    expect(bin).toBe("xcrun");
    // Latitude first for simctl.
    expect(args).toEqual(["simctl", "location", iosUdid, "set", "37.33,-122.03"]);
  });

  it("wraps a simctl failure with IOS_SET_LOCATION_FAILED", async () => {
    vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: Error) => void;
      cb(new Error("Invalid device state: Shutdown"));
    }) as never);

    await expect(
      setLocationTool.execute(services, { udid: iosUdid, latitude: 1, longitude: 2 })
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.IOS_SET_LOCATION_FAILED));
  });
});

describe("set-location — Android emulator", () => {
  it("pushes the fix through the emulator console, longitude first", async () => {
    await expect(
      setLocationTool.execute(services, {
        udid: androidEmulator,
        latitude: 37.33,
        longitude: -122.03,
      })
    ).resolves.toEqual({ located: true, latitude: 37.33, longitude: -122.03 });

    const [args] = vi.mocked(runAdb).mock.calls[0]!;
    // `emu geo fix <longitude> <latitude>` — the reverse order of everything else.
    expect(args).toEqual([
      "-s",
      androidEmulator,
      "emu",
      "geo",
      "fix",
      "-122.03",
      "37.33",
    ]);
  });

  it("fails when the console answers KO", async () => {
    vi.mocked(runAdb).mockResolvedValueOnce({ stdout: "KO: bad lat/long\n", stderr: "" });
    await expect(
      setLocationTool.execute(services, { udid: androidEmulator, latitude: 1, longitude: 2 })
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.ANDROID_SET_LOCATION_FAILED));
  });
});

describe("set-location — capability gate", () => {
  it("rejects a physical Android device (emulators only)", async () => {
    await expect(
      setLocationTool.execute(services, { udid: "ZF524RZBHD", latitude: 1, longitude: 2 })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(runAdb).not.toHaveBeenCalled();
  });

  it("rejects a remote iOS simulator (no host-side override declared)", async () => {
    await expect(
      setLocationTool.execute(services, {
        udid: `remote:${iosUdid}`,
        latitude: 1,
        longitude: 2,
      })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });
});
