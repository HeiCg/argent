import { describe, it, expect } from "vitest";
import {
  assertSupported,
  NotImplementedOnPlatformError,
  UnsupportedOperationError,
} from "../src/utils/capability";
import type { DeviceInfo, ToolCapability } from "@argent/registry";

const iosSim: DeviceInfo = { id: "x", platform: "ios", kind: "simulator" };
const androidEmu: DeviceInfo = { id: "y", platform: "android", kind: "emulator" };

describe("assertSupported", () => {
  it("passes through when capability is undefined (no declaration)", () => {
    expect(() => assertSupported("t", undefined, iosSim)).not.toThrow();
    expect(() => assertSupported("t", undefined, androidEmu)).not.toThrow();
  });

  it("rejects a platform with no block declared", () => {
    const cap: ToolCapability = { apple: { simulator: true, device: true } };
    expect(() => assertSupported("t", cap, androidEmu)).toThrow(UnsupportedOperationError);
  });

  it("rejects a kind not enabled in the platform block", () => {
    const cap: ToolCapability = { apple: { simulator: true } };
    const iosDevice: DeviceInfo = { id: "x", platform: "ios", kind: "device" };
    expect(() => assertSupported("t", cap, iosDevice)).toThrow(UnsupportedOperationError);
  });

  it("respects the supports() refiner", () => {
    const cap: ToolCapability = {
      apple: { simulator: true },
      supports: (d) => d.id !== "x",
    };
    expect(() => assertSupported("t", cap, iosSim)).toThrow(UnsupportedOperationError);
  });

  it("passes when platform + kind + supports() all match", () => {
    const cap: ToolCapability = {
      apple: { simulator: true },
      android: { emulator: true },
    };
    expect(() => assertSupported("t", cap, iosSim)).not.toThrow();
    expect(() => assertSupported("t", cap, androidEmu)).not.toThrow();
  });
});

describe("NotImplementedOnPlatformError", () => {
  it("composes a uniform message with toolId, platform, and the file path to fill in", () => {
    const err = new NotImplementedOnPlatformError({
      toolId: "demo-tool",
      platform: "android",
      hint: "Use `adb shell <command>`.",
    });
    expect(err.name).toBe("NotImplementedOnPlatformError");
    expect(err.toolId).toBe("demo-tool");
    expect(err.platform).toBe("android");
    expect(err.hint).toBe("Use `adb shell <command>`.");
    expect(err.message).toContain("demo-tool");
    expect(err.message).toContain("android");
    expect(err.message).toContain("tools/demo-tool/platforms/android.ts");
    expect(err.message).toContain("capability declaration");
    expect(err.message).toContain("Use `adb shell");
  });

  it("appends the hint after the shared template, so a hint can override its guidance", () => {
    // The iosDevice miss in cross-platform-tool.ts relies on this ordering: its
    // hint says "ignore the ios.ts guidance above" to correct the template's
    // derived file path and capability advice for physical devices.
    const err = new NotImplementedOnPlatformError({
      toolId: "demo-tool",
      platform: "android",
      hint: "Actually do X instead.",
    });
    expect(err.message.endsWith(" Actually do X instead.")).toBe(true);
    expect(err.message.indexOf("capability declaration")).toBeLessThan(
      err.message.indexOf("Actually do X instead.")
    );
  });

  it("works without a hint", () => {
    const err = new NotImplementedOnPlatformError({
      toolId: "demo-tool",
      platform: "android",
    });
    expect(err.hint).toBeNull();
    expect(err.message).toContain("demo-tool");
    expect(err.message).toContain("android");
  });
});
