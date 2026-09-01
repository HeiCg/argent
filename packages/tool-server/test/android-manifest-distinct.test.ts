import { describe, it, expect } from "vitest";
import { serverManifest } from "@argent/android-device-server";
import { helperManifest } from "@argent/native-devtools-android";

// The tool-server installs and instruments BOTH Android APKs: the open-source
// device-control server (open-device-server flag) and the native-devtools
// snapshot helper. They ship as separate APKs with separate instrumentation
// runners, but their manifests share the basename `manifest.json` and, once
// inlined into the @swmansion/argent bundle, once resolved to the SAME on-disk
// file — so the open server spawned the helper's instrumentation and describe
// fell back silently. Guard that the two never converge: distinct package and
// distinct runner is what keeps `am instrument` starting the right process.
describe("android instrumentation manifests are distinct", () => {
  const server = serverManifest();
  const helper = helperManifest();

  it("resolves the open-device-server manifest to its own package", () => {
    expect(server.packageName).toBe("com.argent.devicecontrol");
    expect(server.instrumentationRunner).toBe(
      "com.argent.devicecontrol/.DeviceControlInstrumentation"
    );
  });

  it("does not collide with the native-devtools helper manifest", () => {
    expect(server.packageName).not.toBe(helper.packageName);
    expect(server.instrumentationRunner).not.toBe(helper.instrumentationRunner);
    // The runner must name its own package, or `am instrument` targets the wrong app.
    expect(server.instrumentationRunner.startsWith(server.packageName + "/")).toBe(true);
    expect(helper.instrumentationRunner.startsWith(helper.packageName + "/")).toBe(true);
  });
});
