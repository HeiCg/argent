import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock adb transport so the install gate can be driven without a device.
// vi.hoisted so the fns exist when the hoisted vi.mock factory runs.
const { runAdb, adbShell } = vi.hoisted(() => ({ runAdb: vi.fn(), adbShell: vi.fn() }));
vi.mock("../src/utils/adb", () => ({ runAdb, adbShell }));

// Mock the server package so no built APK is required in CI.
vi.mock("@argent/android-device-server", () => ({
  serverManifest: () => ({
    packageName: "com.argent.devicecontrol",
    instrumentationRunner: "com.argent.devicecontrol/.DeviceControlInstrumentation",
    versionName: "0.1.0",
    versionCode: 3,
    installFlags: ["-r", "-t"],
  }),
  bundledServerApkPath: () => "/tmp/argent-device-control-0.1.0.apk",
}));
// native-devtools-android is imported by the same module; stub it too.
vi.mock("@argent/native-devtools-android", () => ({
  helperManifest: () => ({
    packageName: "com.argent.androiddevtools",
    instrumentationRunner: "com.argent.androiddevtools/.SnapshotInstrumentation",
    versionName: "0.1.0",
    versionCode: 1,
    installFlags: ["-r", "-t"],
  }),
  bundledHelperApkPath: () => "/tmp/helper.apk",
}));

import {
  ensureOpenDeviceServerInstalled,
  __resetAndroidDevtoolsInstallCache,
} from "../src/utils/android-helper-install";

const SERIAL = "emulator-5554";

beforeEach(() => {
  runAdb.mockReset();
  adbShell.mockReset();
  __resetAndroidDevtoolsInstallCache();
});

describe("ensureOpenDeviceServerInstalled", () => {
  it("skips the install when an equal-or-newer version is already present", async () => {
    adbShell.mockResolvedValue("package:com.argent.devicecontrol versionCode:5\n");
    await ensureOpenDeviceServerInstalled(SERIAL);
    expect(runAdb).not.toHaveBeenCalled();
  });

  it("installs when the package is absent", async () => {
    adbShell.mockResolvedValue("");
    runAdb.mockResolvedValue({ stdout: "Success", stderr: "" });
    await ensureOpenDeviceServerInstalled(SERIAL);
    expect(runAdb).toHaveBeenCalledTimes(1);
    const args = runAdb.mock.calls[0]![0] as string[];
    expect(args).toEqual([
      "-s",
      SERIAL,
      "install",
      "-r",
      "-t",
      "/tmp/argent-device-control-0.1.0.apk",
    ]);
  });

  it("installs when the present version is older than bundled", async () => {
    adbShell.mockResolvedValue("package:com.argent.devicecontrol versionCode:1\n");
    runAdb.mockResolvedValue({ stdout: "Success", stderr: "" });
    await ensureOpenDeviceServerInstalled(SERIAL);
    expect(runAdb).toHaveBeenCalledTimes(1);
  });

  it("uninstalls then reinstalls on a signing-key mismatch", async () => {
    adbShell.mockResolvedValue("");
    runAdb
      .mockRejectedValueOnce(new Error("adb: failed INSTALL_FAILED_UPDATE_INCOMPATIBLE"))
      .mockResolvedValueOnce({ stdout: "Success", stderr: "" }) // uninstall
      .mockResolvedValueOnce({ stdout: "Success", stderr: "" }); // reinstall
    await ensureOpenDeviceServerInstalled(SERIAL);
    expect(runAdb).toHaveBeenCalledTimes(3);
    expect(runAdb.mock.calls[1]![0]).toEqual([
      "-s",
      SERIAL,
      "uninstall",
      "com.argent.devicecontrol",
    ]);
  });

  it("caches a successful install so a second call is a no-op", async () => {
    adbShell.mockResolvedValue("");
    runAdb.mockResolvedValue({ stdout: "Success", stderr: "" });
    await ensureOpenDeviceServerInstalled(SERIAL);
    await ensureOpenDeviceServerInstalled(SERIAL);
    expect(runAdb).toHaveBeenCalledTimes(1);
  });
});
