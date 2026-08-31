import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { serverManifest, bundledServerApkPath } from "../src/index";

const BIN_ENV = "ARGENT_ANDROID_DEVICE_SERVER_BIN_DIR";

describe("serverManifest", () => {
  it("reads the committed version contract from assets/manifest.json", () => {
    const m = serverManifest();
    expect(m.packageName).toBe("com.argent.devicecontrol");
    expect(m.instrumentationRunner).toBe("com.argent.devicecontrol/.DeviceControlInstrumentation");
    // instrumentationRunner must name the same package the install gate probes.
    expect(m.instrumentationRunner.startsWith(m.packageName + "/")).toBe(true);
    expect(typeof m.versionCode).toBe("number");
    expect(m.versionName).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.installFlags).toContain("-t");
  });

  it("caches the manifest across calls (same object)", () => {
    expect(serverManifest()).toBe(serverManifest());
  });
});

describe("bundledServerApkPath", () => {
  const prev = process.env[BIN_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[BIN_ENV];
    else process.env[BIN_ENV] = prev;
  });

  it("throws a build hint when the APK is absent", () => {
    process.env[BIN_ENV] = path.join(os.tmpdir(), "argent-no-apk-here-" + Date.now());
    expect(() => bundledServerApkPath()).toThrow(/scripts\/build\.sh/);
  });

  it("resolves the versioned filename under the bin dir override when present", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-apk-"));
    const apk = path.join(dir, `argent-device-control-${serverManifest().versionName}.apk`);
    fs.writeFileSync(apk, "stub");
    process.env[BIN_ENV] = dir;
    expect(bundledServerApkPath()).toBe(apk);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
