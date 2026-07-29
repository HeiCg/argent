import { describe, expect, it, vi, beforeEach } from "vitest";
import { isFlagEnabled } from "@argent/configuration-core";
import { InvalidToolInputError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";

// The two physical-iOS operations that shell `devicectl` instead of going
// through a CoreDevice service. Isolated in their own file so the
// `node:child_process` mock can't reach the suites that run the real binary.
const execCalls: string[][] = [];
let execResult: () => Promise<{ stdout: string; stderr: string }> = () =>
  Promise.resolve({ stdout: "", stderr: "" });

vi.mock("node:child_process", () => ({
  execFile: Object.assign(() => undefined, {
    [Symbol.for("nodejs.util.promisify.custom")]: (file: string, args: string[]) => {
      execCalls.push([file, ...args]);
      return execResult();
    },
  }),
}));

vi.mock("@argent/configuration-core", () => ({ isFlagEnabled: vi.fn() }));

const { iosImpl: openUrlIos } = await import("../src/tools/open-url/platforms/ios");
const { makeIosImpl: makeRestartAppIosImpl } =
  await import("../src/tools/restart-app/platforms/ios");

const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";
const device = resolveDevice(PHYSICAL_UDID);
const restartIos = makeRestartAppIosImpl({} as never);
const mockFlag = vi.mocked(isFlagEnabled);

beforeEach(() => {
  execCalls.length = 0;
  execResult = () => Promise.resolve({ stdout: "", stderr: "" });
  mockFlag.mockReturnValue(true);
});

describe("open-url on a physical iPhone", () => {
  it("opens the URL through devicectl", async () => {
    const result = await openUrlIos.handler(
      {} as never,
      { udid: PHYSICAL_UDID, url: "https://example.com" } as never,
      device
    );

    expect(execCalls).toEqual([
      [
        "xcrun",
        "devicectl",
        "device",
        "process",
        "openURL",
        "--device",
        PHYSICAL_UDID,
        "https://example.com",
      ],
    ]);
    expect(result.opened).toBe(true);
    expect(result.url).toBe("https://example.com");
  });

  it("never reaches simctl, which cannot address hardware", async () => {
    await openUrlIos.handler(
      {} as never,
      { udid: PHYSICAL_UDID, url: "myapp://x" } as never,
      device
    );
    expect(execCalls.flat()).not.toContain("simctl");
  });

  it("is refused while the physical-iOS flag is off", async () => {
    mockFlag.mockReturnValue(false);
    await expect(
      openUrlIos.handler({} as never, { udid: PHYSICAL_UDID, url: "https://x" } as never, device)
    ).rejects.toBeInstanceOf(InvalidToolInputError);
    // The gate has to run before the subprocess, not after it.
    expect(execCalls).toEqual([]);
  });
});

describe("restart-app on a physical iPhone", () => {
  it("relaunches through devicectl, terminating the running instance first", async () => {
    const result = await restartIos.handler(
      {} as never,
      { udid: PHYSICAL_UDID, bundleId: "com.example.app" } as never,
      device
    );

    expect(execCalls).toEqual([
      [
        "xcrun",
        "devicectl",
        "device",
        "process",
        "launch",
        "--terminate-existing",
        "--device",
        PHYSICAL_UDID,
        "com.example.app",
      ],
    ]);
    expect(result.restarted).toBe(true);
    expect(result.bundleId).toBe("com.example.app");
  });

  it("reports a devicectl failure rather than claiming a restart", async () => {
    execResult = () => Promise.reject(new Error("app not installed"));
    await expect(
      restartIos.handler(
        {} as never,
        { udid: PHYSICAL_UDID, bundleId: "com.example.app" } as never,
        device
      )
    ).rejects.toThrow(/Failed to restart com\.example\.app/);
  });

  it("is refused while the physical-iOS flag is off", async () => {
    mockFlag.mockReturnValue(false);
    await expect(
      restartIos.handler({} as never, { udid: PHYSICAL_UDID, bundleId: "com.x" } as never, device)
    ).rejects.toBeInstanceOf(InvalidToolInputError);
    expect(execCalls).toEqual([]);
  });
});
