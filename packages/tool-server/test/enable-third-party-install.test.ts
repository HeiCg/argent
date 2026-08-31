import { describe, it, expect, vi, beforeEach } from "vitest";

// Android-only tool: it drives `pm list packages` + `appops set` over adb shell.
// shellQuote stays real (it is pure) so the argv assertions see the true quoting.
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell: vi.fn(),
}));

import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { enableThirdPartyInstallTool } from "../src/tools/enable-third-party-install";
import { adbShell } from "../src/utils/adb";
import { UnsupportedOperationError } from "../src/utils/capability";

const androidEmulator = "emulator-5554";
const packageName = "com.example.app";
const services = {} as never;

function failsWith(code: string): (err: unknown) => boolean {
  return (err) => typeof code === "string" && getFailureSignal(err)?.error_code === code;
}

beforeEach(() => {
  vi.mocked(adbShell).mockReset();
  // Default: package installed, appops accepts the op (silent success).
  vi.mocked(adbShell).mockImplementation(async (_serial: string, cmd: string) => {
    if (cmd.startsWith("pm list packages")) return `package:${packageName}\n`;
    return "";
  });
});

describe("enable-third-party-install", () => {
  it("sets the REQUEST_INSTALL_PACKAGES app-op for an installed package", async () => {
    await expect(
      enableThirdPartyInstallTool.execute(services, { udid: androidEmulator, packageName })
    ).resolves.toEqual({ enabled: true, packageName });

    const commands = vi.mocked(adbShell).mock.calls.map(([, cmd]) => cmd);
    expect(commands).toContain(`appops set '${packageName}' REQUEST_INSTALL_PACKAGES allow`);
  });

  it("fails when the package is not installed", async () => {
    vi.mocked(adbShell).mockImplementation(async (_serial: string, cmd: string) => {
      if (cmd.startsWith("pm list packages")) return "";
      return "";
    });
    await expect(
      enableThirdPartyInstallTool.execute(services, { udid: androidEmulator, packageName })
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.ANDROID_ENABLE_THIRD_PARTY_INSTALL_FAILED));
    // appops must not run once the preflight has rejected the package.
    const ranAppops = vi
      .mocked(adbShell)
      .mock.calls.some(([, cmd]) => cmd.startsWith("appops set"));
    expect(ranAppops).toBe(false);
  });

  it("fails when appops rejects the op", async () => {
    vi.mocked(adbShell).mockImplementation(async (_serial: string, cmd: string) => {
      if (cmd.startsWith("pm list packages")) return `package:${packageName}\n`;
      return "Error: Unknown operation REQUEST_INSTALL_PACKAGES";
    });
    await expect(
      enableThirdPartyInstallTool.execute(services, { udid: androidEmulator, packageName })
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.ANDROID_ENABLE_THIRD_PARTY_INSTALL_FAILED));
  });

  it("rejects a non-Android device via the capability gate", async () => {
    await expect(
      enableThirdPartyInstallTool.execute(services, {
        udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
        packageName,
      })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(adbShell).not.toHaveBeenCalled();
  });
});
