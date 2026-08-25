import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the devicectl seam so the handlers run without hardware; the app-session
// module stays real — its predicate and map are the state under test. The
// pre-flight must reject system-UI bundle ids BEFORE any of these are called.
const ensureDeviceReady = vi.fn();
const launchApp = vi.fn();
const uninstallApp = vi.fn();
const installApp = vi.fn();
vi.mock("../src/utils/ios-device/devicectl", () => ({
  ensureDeviceReady: (...a: unknown[]) => ensureDeviceReady(...a),
  launchApp: (...a: unknown[]) => launchApp(...a),
  uninstallApp: (...a: unknown[]) => uninstallApp(...a),
  installApp: (...a: unknown[]) => installApp(...a),
}));

import type { DeviceInfo } from "@argent/registry";
import { iosDeviceImpl as launchImpl } from "../src/tools/launch-app/platforms/ios-device";
import { iosDeviceImpl as restartImpl } from "../src/tools/restart-app/platforms/ios-device";
import { iosDeviceImpl as reinstallImpl } from "../src/tools/reinstall-app/platforms/ios-device";
import { InvalidToolInputError } from "../src/utils/capability";
import {
  clearCurrentIosDeviceApp,
  isSessionOnlySystemUi,
  requireCurrentIosDeviceApp,
} from "../src/utils/ios-device/app-session";

// Physical-iOS UDID shape (8 hex, dash, 16 hex) — see utils/device-info.ts.
const UDID = "00008110-000978540290401E";
const SPRINGBOARD = "com.apple.springboard";
const SPOTLIGHT = "com.apple.Spotlight";
// The handlers ignore device/options; a stub satisfies the (services, params, device) arity.
const DEVICE = { platform: "ios", kind: "device", udid: UDID } as unknown as DeviceInfo;

beforeEach(() => {
  ensureDeviceReady.mockReset().mockResolvedValue(undefined);
  launchApp.mockReset().mockResolvedValue(undefined);
  uninstallApp.mockReset().mockResolvedValue(undefined);
  installApp.mockReset().mockResolvedValue(undefined);
  // The session map is module-level state; start every test without an entry.
  clearCurrentIosDeviceApp(UDID);
});

describe("isSessionOnlySystemUi", () => {
  it("matches exactly the two system-UI ids, case-sensitively", () => {
    expect(isSessionOnlySystemUi(SPRINGBOARD)).toBe(true);
    expect(isSessionOnlySystemUi(SPOTLIGHT)).toBe(true);
    expect(isSessionOnlySystemUi("com.example.app")).toBe(false);
    expect(isSessionOnlySystemUi("com.apple.Preferences")).toBe(false);
  });
});

describe("restart-app (ios-device) — system-UI pre-flight", () => {
  it.each([SPRINGBOARD, SPOTLIGHT])("rejects %s before any device contact", async (bundleId) => {
    const err = await restartImpl
      .handler({}, { udid: UDID, bundleId }, DEVICE)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidToolInputError);
    expect((err as Error).message).toBe(
      `${bundleId} is system UI: it is always running and cannot be restarted. ` +
        "Use launch-app to put it under automation."
    );
    expect(ensureDeviceReady).not.toHaveBeenCalled();
    expect(launchApp).not.toHaveBeenCalled();
    // The rejection also registers no session.
    expect(() => requireCurrentIosDeviceApp(UDID)).toThrow(/Launch the target app first/);
  });

  it("still restarts a regular app", async () => {
    await expect(
      restartImpl.handler({}, { udid: UDID, bundleId: "com.example.app" }, DEVICE)
    ).resolves.toEqual({ restarted: true, bundleId: "com.example.app" });
    expect(launchApp).toHaveBeenCalledWith(UDID, "com.example.app", { terminateExisting: true });
  });
});

describe("reinstall-app (ios-device) — system-UI pre-flight", () => {
  it.each([SPRINGBOARD, SPOTLIGHT])("rejects %s before any device contact", async (bundleId) => {
    const err = await reinstallImpl
      .handler({}, { udid: UDID, bundleId, appPath: "/tmp/App.app" }, DEVICE)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidToolInputError);
    expect((err as Error).message).toBe(
      `${bundleId} is system UI: it is always running and cannot be reinstalled. ` +
        "Use launch-app to put it under automation."
    );
    expect(ensureDeviceReady).not.toHaveBeenCalled();
    expect(uninstallApp).not.toHaveBeenCalled();
    expect(installApp).not.toHaveBeenCalled();
  });
});

describe("launch-app (ios-device) — session-only registration unchanged", () => {
  it.each([SPRINGBOARD, SPOTLIGHT])(
    "%s registers the session without a devicectl launch",
    async (bundleId) => {
      await expect(launchImpl.handler({}, { udid: UDID, bundleId }, DEVICE)).resolves.toEqual({
        launched: true,
        bundleId,
      });
      expect(ensureDeviceReady).toHaveBeenCalledWith(UDID);
      expect(launchApp).not.toHaveBeenCalled();
      expect(requireCurrentIosDeviceApp(UDID)).toBe(bundleId);
    }
  );

  it("a regular app still gets a devicectl launch", async () => {
    await expect(
      launchImpl.handler({}, { udid: UDID, bundleId: "com.example.app" }, DEVICE)
    ).resolves.toEqual({ launched: true, bundleId: "com.example.app" });
    expect(launchApp).toHaveBeenCalledWith(UDID, "com.example.app");
    expect(requireCurrentIosDeviceApp(UDID)).toBe("com.example.app");
  });
});
