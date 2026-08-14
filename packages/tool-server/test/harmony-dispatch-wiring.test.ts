import { describe, it, expect, vi } from "vitest";

// The four tools whose HarmonyOS support is a single `harmony: harmonyImpl` line
// in a `dispatchByPlatform` table. Every other harmony test reaches the backend
// by importing `harmonyImpl` and calling `.handler()` directly, which exercises
// the backend and never the wiring: delete all four lines and the rest of the
// suite stays green while each of these tools 501s on a real device.
//
// Only the leaf handler is stubbed, deliberately — the claim under test is
// dispatch, so a stub owning no device behaviour keeps these cases pinned to the
// wiring while the backends underneath them keep changing.
// Hoisted with the `vi.mock` factories that close over them — a plain top-level
// const is still in its temporal dead zone when the factory runs.
const { launchStub, restartStub, openUrlStub, keyboardStub } = vi.hoisted(() => {
  // Full dispatch signature, so the device it was handed stays typed below.
  const stub = <T>(result: T) => ({
    handler: vi.fn(
      async (_services: unknown, _params: unknown, device: { platform: string; kind: string }) => {
        void device;
        return result;
      }
    ),
  });
  return {
    launchStub: stub({ launched: true, bundleId: "com.huawei.hmos.calculator" }),
    restartStub: stub({ restarted: true, bundleId: "com.huawei.hmos.calculator" }),
    openUrlStub: stub({ opened: true, url: "https://example.com" }),
    keyboardStub: stub({ typed: "hi" }),
  };
});

vi.mock("../src/tools/launch-app/platforms/harmony", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  harmonyImpl: launchStub,
}));
vi.mock("../src/tools/restart-app/platforms/harmony", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  harmonyImpl: restartStub,
}));
vi.mock("../src/tools/open-url/platforms/harmony", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  harmonyImpl: openUrlStub,
}));
vi.mock("../src/tools/keyboard/platforms/harmony", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  harmonyImpl: keyboardStub,
}));

import { createLaunchAppTool } from "../src/tools/launch-app";
import { createRestartAppTool } from "../src/tools/restart-app";
import { openUrlTool } from "../src/tools/open-url";
import { createKeyboardTool } from "../src/tools/keyboard";

const HARMONY_UDID = "harmony-025DEK236V035771";
const registry = { resolveService: vi.fn(async () => ({})) } as never;

const cases = [
  {
    name: "launch-app",
    stub: launchStub,
    tool: () => createLaunchAppTool(registry),
    params: { udid: HARMONY_UDID, bundleId: "com.huawei.hmos.calculator" },
    result: { launched: true, bundleId: "com.huawei.hmos.calculator" },
  },
  {
    name: "restart-app",
    stub: restartStub,
    tool: () => createRestartAppTool(registry),
    params: { udid: HARMONY_UDID, bundleId: "com.huawei.hmos.calculator" },
    result: { restarted: true, bundleId: "com.huawei.hmos.calculator" },
  },
  {
    name: "open-url",
    stub: openUrlStub,
    tool: () => openUrlTool,
    params: { udid: HARMONY_UDID, url: "https://example.com" },
    result: { opened: true, url: "https://example.com" },
  },
  {
    name: "keyboard",
    stub: keyboardStub,
    tool: () => createKeyboardTool(registry),
    params: { udid: HARMONY_UDID, text: "hi" },
    result: { typed: "hi" },
  },
] as const;

describe("HarmonyOS dispatch wiring", () => {
  it.each(cases)(
    "$name routes a harmony device to its harmony branch",
    async ({ stub: impl, tool, params, result }) => {
      impl.handler.mockClear();
      // Not `.toHaveBeenCalled()` alone: without the dispatch entry this rejects
      // with NotImplementedOnPlatformError, so asserting on the resolved value
      // pins that the branch both ran and produced the tool's result.
      await expect(tool().execute!({}, params as never)).resolves.toEqual(result);
      expect(impl.handler).toHaveBeenCalledOnce();
      expect(impl.handler.mock.calls[0]![2]).toMatchObject({
        platform: "harmony",
        kind: "device",
      });
    }
  );

  it("does not reach a harmony branch for a device of another platform", async () => {
    // Guards the inverse mutation: a `harmony` entry wired onto the wrong arm of
    // the table would satisfy the cases above and silently hijack Android.
    keyboardStub.handler.mockClear();
    await createKeyboardTool(registry).execute!({}, {
      udid: "emulator-5554",
      text: "hi",
    } as never).catch(() => undefined);
    expect(keyboardStub.handler).not.toHaveBeenCalled();
  });
});
