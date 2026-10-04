import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Registry } from "@argent/registry";

// A physical iPhone must be described through the upstream XCUITest runner
// (`describeIosDevice`), exactly as the describe tool's `iosDevice` branch does;
// `describeIos` (ax-service / open iOS server) is simulator-only.
vi.mock("../src/tools/describe/platforms/ios", () => ({ describeIos: vi.fn() }));
vi.mock("../src/tools/describe/platforms/ios-device", () => ({ describeIosDevice: vi.fn() }));
vi.mock("../src/tools/describe/platforms/android", () => ({ describeAndroid: vi.fn() }));
vi.mock("../src/utils/ios-devices", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-devices")>(
    "../src/utils/ios-devices"
  );
  return { ...actual, isTvOsSimulator: vi.fn(async () => false) };
});

import { captureElementFrame } from "../src/utils/match-element-frame";
import { describeIos } from "../src/tools/describe/platforms/ios";
import { describeIosDevice } from "../src/tools/describe/platforms/ios-device";
import { isTvOsSimulator } from "../src/utils/ios-devices";

const describeIosMock = vi.mocked(describeIos);
const describeIosDeviceMock = vi.mocked(describeIosDevice);
const registry = {} as Registry;

const PHYSICAL_UDID = "00008110-000978540290401E";
const SIMULATOR_UDID = "00000000-0000-0000-0000-000000000000";
const FRAME = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 };
const TREE = {
  source: "xcuitest-runner" as const,
  tree: {
    role: "Application",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [{ role: "AXButton", label: "Save", frame: FRAME, children: [] }],
  },
};

beforeEach(() => {
  describeIosMock.mockReset();
  describeIosDeviceMock.mockReset();
  vi.mocked(isTvOsSimulator).mockClear();
});

describe("captureElementFrame: physical iOS device", () => {
  it("routes a physical iPhone to describeIosDevice, never describeIos", async () => {
    describeIosDeviceMock.mockResolvedValue(TREE);

    const frame = await captureElementFrame(registry, PHYSICAL_UDID, {
      by: "text",
      value: "Save",
    });

    expect(frame).toEqual(FRAME);
    expect(describeIosDeviceMock).toHaveBeenCalledTimes(1);
    expect(describeIosDeviceMock.mock.calls[0]![1]).toMatchObject({
      id: PHYSICAL_UDID,
      platform: "ios",
      kind: "device",
    });
    expect(describeIosMock).not.toHaveBeenCalled();
    // No simctl tvOS probe against a physical UDID.
    expect(isTvOsSimulator).not.toHaveBeenCalled();
  });

  it("still routes a simulator to describeIos", async () => {
    describeIosMock.mockResolvedValue({ ...TREE, source: "ax-service" });

    const frame = await captureElementFrame(registry, SIMULATOR_UDID, {
      by: "text",
      value: "Save",
    });

    expect(frame).toEqual(FRAME);
    expect(describeIosMock).toHaveBeenCalledTimes(1);
    expect(describeIosDeviceMock).not.toHaveBeenCalled();
  });
});
