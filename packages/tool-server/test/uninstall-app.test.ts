import { describe, it, expect, vi, beforeEach } from "vitest";

// iOS branch shells out to `xcrun simctl uninstall`.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  // promisify(execFile) invokes the callback as the LAST argument whether or not
  // an options object was passed, so resolve it positionally.
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: null, r: { stdout: string; stderr: string }) => void;
    cb(null, { stdout: "", stderr: "" });
  }),
}));

vi.mock("../src/utils/ios-device-sets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device-sets")>()),
  deviceSetForUdid: vi.fn(async () => null),
  simctlPrefix: vi.fn(() => ["simctl"]),
}));

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  runAdb: vi.fn(async () => ({ stdout: "Success\n", stderr: "" })),
}));

vi.mock("../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/sim-remote")>()),
  simctlUninstall: vi.fn(async () => {}),
}));

vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDep: vi.fn(async () => {}),
  ensureDeps: vi.fn(async () => {}),
}));

import { execFile } from "node:child_process";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { uninstallAppTool } from "../src/tools/uninstall-app";
import { runAdb } from "../src/utils/adb";
import { simctlUninstall } from "../src/utils/sim-remote";

const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const androidEmulator = "emulator-5554";
const bundleId = "com.example.app";
const services = {} as never;

function failsWith(code: string): (err: unknown) => boolean {
  return (err) => typeof code === "string" && getFailureSignal(err)?.error_code === code;
}

beforeEach(() => {
  vi.mocked(execFile).mockClear();
  vi.mocked(runAdb).mockClear();
  vi.mocked(simctlUninstall).mockClear();
});

describe("uninstall-app — Android", () => {
  it("removes the package and reports uninstalled: true", async () => {
    await expect(
      uninstallAppTool.execute(services, { udid: androidEmulator, bundleId })
    ).resolves.toEqual({ uninstalled: true, bundleId });

    const [args] = vi.mocked(runAdb).mock.calls[0]!;
    expect(args).toEqual(["-s", androidEmulator, "uninstall", bundleId]);
  });

  it("treats an already-absent package as an idempotent no-op", async () => {
    vi.mocked(runAdb).mockResolvedValueOnce({
      stdout: "Failure [DELETE_FAILED_INTERNAL_ERROR]\n",
      stderr: "",
    });
    await expect(
      uninstallAppTool.execute(services, { udid: androidEmulator, bundleId })
    ).resolves.toEqual({ uninstalled: false, bundleId });
  });

  it("fails on an unexpected adb error", async () => {
    vi.mocked(runAdb).mockResolvedValueOnce({
      stdout: "",
      stderr: "Failure [INSTALL_FAILED_OTHER]\n",
    });
    await expect(
      uninstallAppTool.execute(services, { udid: androidEmulator, bundleId })
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.ANDROID_UNINSTALL_APP_FAILED));
  });

  // Real platform-tools exit non-zero for a missing package, so runAdb throws
  // rather than returning the `Failure […]` line (confirmed live on emulator-5554).
  it("treats a non-zero not-installed exit as a no-op", async () => {
    vi.mocked(runAdb).mockRejectedValueOnce(
      new Error("adb -s emulator-5554 uninstall com.example.app failed: Failure [DELETE_FAILED_INTERNAL_ERROR]")
    );
    await expect(
      uninstallAppTool.execute(services, { udid: androidEmulator, bundleId })
    ).resolves.toEqual({ uninstalled: false, bundleId });
  });

  it("wraps a non-zero exit that is not a missing-package signal", async () => {
    vi.mocked(runAdb).mockRejectedValueOnce(new Error("device offline"));
    await expect(
      uninstallAppTool.execute(services, { udid: androidEmulator, bundleId })
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.ANDROID_UNINSTALL_APP_FAILED));
  });
});

describe("uninstall-app — iOS simulator", () => {
  it("removes via `simctl uninstall <udid> <bundleId>`", async () => {
    await expect(
      uninstallAppTool.execute(services, { udid: iosUdid, bundleId })
    ).resolves.toEqual({ uninstalled: true, bundleId });

    const [bin, args] = vi.mocked(execFile).mock.calls[0]!;
    expect(bin).toBe("xcrun");
    expect(args).toEqual(["simctl", "uninstall", iosUdid, bundleId]);
  });

  it("treats a not-installed app as a no-op", async () => {
    vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: Error) => void;
      cb(new Error("… application com.example.app is not installed"));
    }) as never);
    await expect(
      uninstallAppTool.execute(services, { udid: iosUdid, bundleId })
    ).resolves.toEqual({ uninstalled: false, bundleId });
  });

  it("wraps a real simctl failure", async () => {
    vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: Error) => void;
      cb(new Error("Invalid device state: Shutdown"));
    }) as never);
    await expect(
      uninstallAppTool.execute(services, { udid: iosUdid, bundleId })
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.IOS_UNINSTALL_APP_FAILED));
  });
});

describe("uninstall-app — remote iOS simulator", () => {
  it("removes via sim-remote simctl uninstall", async () => {
    const remoteUdid = `remote:${iosUdid}`;
    await expect(
      uninstallAppTool.execute(services, { udid: remoteUdid, bundleId })
    ).resolves.toEqual({ uninstalled: true, bundleId });
    expect(simctlUninstall).toHaveBeenCalledWith(remoteUdid, bundleId);
    // The local xcrun path must not fire for a remote device.
    expect(execFile).not.toHaveBeenCalled();
  });
});
