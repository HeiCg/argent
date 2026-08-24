import { describe, expect, it, vi } from "vitest";
import { installApp, launchApp } from "../src/utils/ios-device/devicectl";

const fake = vi.hoisted(() => ({ stderr: "" }));

// devicectl promisifies execFile at module load, so the mock must replace the
// callback-style function itself; every call fails with the scripted stderr.
vi.mock("node:child_process", () => ({
  execFile: (_file: unknown, _args: unknown, _options: unknown, callback: unknown) => {
    (callback as (error: Error) => void)(
      Object.assign(new Error("Command failed: xcrun devicectl"), {
        stdout: "",
        stderr: fake.stderr,
      })
    );
  },
}));

const UDID = "00008110-000978540290401E";

describe("devicectl error hints are folded into the message", () => {
  it("carries the unlock guidance for a locked-screen launch failure", async () => {
    fake.stderr = "ERROR: The application failed to launch.";

    const error = await launchApp(UDID, "com.example.app").catch((caught: unknown) => caught);

    expect((error as Error).name).toBe("IosDeviceControlError");
    expect((error as Error).message).toBe(
      "Failed to launch com.example.app: ERROR: The application failed to launch. " +
        "Hint: Unlock the device and keep the screen awake, then retry. " +
        "(A locked iPhone refuses app launches.)"
    );
    // The property survives for callers that branch on it.
    expect((error as { hint?: string | null }).hint).toContain("Unlock the device");
  });

  it("carries the trust/pairing guidance for an unpaired-device failure", async () => {
    fake.stderr = "ERROR: The device must be paired before use";

    const error = await installApp(UDID, "/tmp/Example.app").catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("Failed to install app");
    expect((error as Error).message).toContain(
      "Connect the device by cable, accept the Trust prompt"
    );
  });
});
