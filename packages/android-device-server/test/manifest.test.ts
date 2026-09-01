import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { serverManifest, bundledServerApkPath, resolveServerManifestPath } from "../src/index";

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

describe("resolveServerManifestPath (bundling collision regression)", () => {
  // Regression for the integration bug: once this package is inlined into the
  // @swmansion/argent tool-server bundle, __dirname/.. collapses onto the argent
  // tree, where assets/manifest.json is @argent/native-devtools-android's helper
  // manifest. Reading that shared path returned the devtools instrumentation, so
  // the open server spawned the wrong process and describe fell back silently.
  // bundle-tools.cjs now copies our manifest to assets/android-device-server/, and
  // the resolver must prefer it over the colliding sibling.
  const DEVTOOLS_DECOY = {
    packageName: "com.argent.androiddevtools",
    instrumentationRunner: "com.argent.androiddevtools/.SnapshotInstrumentation",
    versionName: "0.1.0",
    versionCode: 1,
    installFlags: ["-r", "-t"],
  };
  const DEVICE_SERVER = {
    packageName: "com.argent.devicecontrol",
    instrumentationRunner: "com.argent.devicecontrol/.DeviceControlInstrumentation",
    versionName: "0.1.0",
    versionCode: 1,
    installFlags: ["-r", "-t"],
  };

  let base: string;
  afterEach(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it("picks its own subdir manifest over the colliding sibling in a bundled tree", () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bundle-"));
    // Simulate the argent bundle: assets/manifest.json is the devtools decoy, and
    // our manifest is copied to assets/android-device-server/manifest.json.
    fs.mkdirSync(path.join(base, "assets", "android-device-server"), { recursive: true });
    fs.writeFileSync(path.join(base, "assets", "manifest.json"), JSON.stringify(DEVTOOLS_DECOY));
    fs.writeFileSync(
      path.join(base, "assets", "android-device-server", "manifest.json"),
      JSON.stringify(DEVICE_SERVER)
    );

    const resolved = resolveServerManifestPath(base);
    expect(resolved).toBe(path.join(base, "assets", "android-device-server", "manifest.json"));
    const m = JSON.parse(fs.readFileSync(resolved, "utf-8"));
    // The old __dirname/../assets/manifest.json read would have returned the decoy.
    expect(m.packageName).toBe("com.argent.devicecontrol");
    expect(m.instrumentationRunner).toBe("com.argent.devicecontrol/.DeviceControlInstrumentation");
  });

  it("falls back to the sibling manifest in the dev tree (no subdir)", () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "argent-dev-"));
    // Dev layout: only the package's own assets/manifest.json exists.
    fs.mkdirSync(path.join(base, "assets"), { recursive: true });
    fs.writeFileSync(path.join(base, "assets", "manifest.json"), JSON.stringify(DEVICE_SERVER));

    const resolved = resolveServerManifestPath(base);
    expect(resolved).toBe(path.join(base, "assets", "manifest.json"));
    expect(JSON.parse(fs.readFileSync(resolved, "utf-8")).packageName).toBe(
      "com.argent.devicecontrol"
    );
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
