import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { ArtifactStore, type Registry } from "@argent/registry";

// The physical-iOS route shells out (`sips` for the downscale) and the probe
// under test spawns `xcrun devicectl` — both via promisify(execFile), so mock
// child_process the way screenshot-tv-scale.test.ts does. promisify appends a
// node-style callback as the last argument.
const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

// The tool's devicectl seams — the structural capability probe and the
// host-side capture — are mocked so each routing case can pick the toolchain
// it runs on. The probe's own behaviour has its importActual-based suite below.
vi.mock("../src/utils/ios-device/devicectl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device/devicectl")>()),
  captureScreenshot: vi.fn(),
  supportsHostScreenshot: vi.fn(),
}));

import { createScreenshotTool, downscalePngInPlace } from "../src/tools/screenshot";
import {
  captureScreenshot as captureIosDeviceScreenshot,
  supportsHostScreenshot,
} from "../src/utils/ios-device/devicectl";

type ExecFileCallback = (e: Error | null, r?: { stdout: string; stderr: string }) => void;

function callbackOf(args: unknown[]): ExecFileCallback | undefined {
  return args.find((a) => typeof a === "function") as ExecFileCallback | undefined;
}

/** Reply to every execFile spawn with an error — the safe default. */
function failAllSpawns(message = "unexpected execFile call"): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    callbackOf(args)?.(new Error(message));
  });
}

/**
 * Serve `sips -g` with the given dimensions and record `sips -Z` targets;
 * everything else errors.
 */
function mockSips(dims: { width: number; height: number }): { zTargets: () => string[] } {
  const zCalls: string[] = [];
  execFileMock.mockImplementation((...args: unknown[]) => {
    const file = args[0] as string;
    const argv = (args[1] as string[]) ?? [];
    const cb = callbackOf(args);
    if (file === "sips" && argv[0] === "-g") {
      cb?.(null, {
        stdout: `pixelWidth: ${dims.width}\npixelHeight: ${dims.height}\n`,
        stderr: "",
      });
      return;
    }
    if (file === "sips" && argv[0] === "-Z") {
      zCalls.push(argv[1]);
      cb?.(null, { stdout: "", stderr: "" });
      return;
    }
    cb?.(new Error(`unexpected execFile ${file} ${argv.join(" ")}`));
  });
  return { zTargets: () => zCalls };
}

beforeEach(() => {
  execFileMock.mockReset();
  failAllSpawns();
  vi.mocked(supportsHostScreenshot).mockReset();
  vi.mocked(captureIosDeviceScreenshot).mockReset();
});

describe("screenshot tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an image artifact handle; includeImageInContext is an input-only flag handled by the MCP adapter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          url: "http://localhost/screenshot.png",
          path: "/tmp/screenshot.png",
        }),
      })
    );

    // The tool resolves its backend lazily via the registry rather than taking
    // an eagerly-declared service, so a tvOS udid can branch away from the
    // simulator-server it can't drive. A non-iOS-shaped udid ("ABC") skips the
    // tvOS runtime probe and goes straight to simulator-server.
    const registry = {
      resolveService: vi.fn().mockResolvedValue({ apiUrl: "http://localhost:4949" }),
    } as unknown as import("@argent/registry").Registry;
    const screenshotTool = createScreenshotTool(registry);

    const params = {
      udid: "ABC",
      includeImageInContext: false,
    };
    screenshotTool.zodSchema!.parse(params);

    const result = await screenshotTool.execute({}, params, { artifacts: new ArtifactStore() });

    // The PNG is returned as an artifact handle the MCP client materializes —
    // the unreachable `127.0.0.1` media URL is no longer surfaced.
    expect(result.image).toMatchObject({
      __argentArtifact: true,
      kind: "screenshot",
      filename: "screenshot.png",
      mimeType: "image/png",
      hostPath: "/tmp/screenshot.png",
    });
    expect(result).not.toHaveProperty("includeImageInContext");
    expect(result).not.toHaveProperty("url");
  });
});

describe("physical-iOS route — probe-picked capture path", () => {
  const UDID = "00008110-000978540290401E";
  const DEVICE = { id: UDID, platform: "ios", kind: "device" };

  function runnerStub(imageBase64: string | undefined) {
    const run = vi.fn(async () => ({ imageBase64 }));
    const resolveService = vi.fn(async () => ({ run, udid: UDID }));
    return { run, resolveService };
  }

  function screenshotDevice(resolveService: unknown, scale = 1.0) {
    const tool = createScreenshotTool({ resolveService } as unknown as Registry);
    return tool.execute(
      {},
      { udid: UDID, scale, includeImageInContext: true },
      { artifacts: new ArtifactStore() }
    );
  }

  it("goes straight to the runner when the probe says the subcommand is missing — zero devicectl capture attempts", async () => {
    vi.mocked(supportsHostScreenshot).mockResolvedValue(false);
    const { run, resolveService } = runnerStub(Buffer.from("png-bytes").toString("base64"));

    const result = await screenshotDevice(resolveService);

    // No doomed devicectl attempt per capture, and no error text to match.
    expect(captureIosDeviceScreenshot).not.toHaveBeenCalled();
    expect(resolveService).toHaveBeenCalledWith(`ios-device-runner:${UDID}`, { device: DEVICE });
    expect(run).toHaveBeenCalledWith(
      { command: "screenshot" },
      { readOnly: true, timeoutMs: 30_000 }
    );
    await expect(fs.readFile(result.image.hostPath, "utf8")).resolves.toBe("png-bytes");
    await fs.rm(result.image.hostPath, { force: true });
  });

  it("keeps the host-side devicectl path — and never resolves the runner — when the probe says present", async () => {
    vi.mocked(supportsHostScreenshot).mockResolvedValue(true);
    vi.mocked(captureIosDeviceScreenshot).mockResolvedValue(undefined);
    const { resolveService } = runnerStub(undefined);

    const result = await screenshotDevice(resolveService);

    expect(captureIosDeviceScreenshot).toHaveBeenCalledWith(
      UDID,
      expect.stringContaining("argent-ios-device-screenshot-")
    );
    expect(resolveService).not.toHaveBeenCalled();
    expect(result.image.hostPath).toContain("argent-ios-device-screenshot-");
  });

  it("surfaces a reworded devicectl failure unchanged instead of guessing at a fallback", async () => {
    vi.mocked(supportsHostScreenshot).mockResolvedValue(true);
    vi.mocked(captureIosDeviceScreenshot).mockRejectedValue(
      new Error(
        "Failed to capture screenshot: The operation failed. (Some new CoreDevice wording.)"
      )
    );
    const { resolveService } = runnerStub(undefined);

    // On a toolchain the probe verified, a capture failure is a real capture
    // failure — same semantics as before the probe existed.
    await expect(screenshotDevice(resolveService)).rejects.toThrow("Some new CoreDevice wording");
    expect(resolveService).not.toHaveBeenCalled();
  });

  it("keeps the unknown-subcommand wording as a last-resort net behind a probe that answered wrong", async () => {
    vi.mocked(supportsHostScreenshot).mockResolvedValue(true);
    vi.mocked(captureIosDeviceScreenshot).mockRejectedValue(
      new Error("Failed to capture screenshot: unrecognized subcommand 'screenshot'")
    );
    const { run, resolveService } = runnerStub(Buffer.from("net").toString("base64"));

    const result = await screenshotDevice(resolveService);

    expect(captureIosDeviceScreenshot).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    await fs.rm(result.image.hostPath, { force: true });
  });

  it("throws when the runner answers without inline image data", async () => {
    vi.mocked(supportsHostScreenshot).mockResolvedValue(false);
    const { resolveService } = runnerStub(undefined);

    await expect(screenshotDevice(resolveService)).rejects.toThrow(
      "Runner screenshot returned no inline image data."
    );
  });

  it("downscales the runner capture in place against its real dimensions", async () => {
    vi.mocked(supportsHostScreenshot).mockResolvedValue(false);
    const sips = mockSips({ width: 1920, height: 1080 });
    const { resolveService } = runnerStub(Buffer.from("full-res").toString("base64"));

    const result = await screenshotDevice(resolveService, 0.5);

    // 1920-wide capture at scale 0.5 targets 960 — via the shared helper.
    expect(sips.zTargets()).toEqual(["960"]);
    await fs.rm(result.image.hostPath, { force: true });
  });
});

describe("downscalePngInPlace — shared device-route downscale", () => {
  it("caps the longest actual side at the requested scale", async () => {
    const sips = mockSips({ width: 1920, height: 1080 });
    await downscalePngInPlace("/tmp/cap.png", 0.5);
    expect(sips.zTargets()).toEqual(["960"]);
  });

  it("spawns nothing at scale 1", async () => {
    await downscalePngInPlace("/tmp/cap.png", 1.0);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("keeps the full-resolution file when sips fails (best-effort)", async () => {
    failAllSpawns("sips: command not found");
    await expect(downscalePngInPlace("/tmp/cap.png", 0.5)).resolves.toBeUndefined();
  });
});

describe("supportsHostScreenshot — structural devicectl capability probe", () => {
  /** A fresh, unmocked devicectl module, so each case starts with a cold memo. */
  async function freshDevicectl() {
    vi.resetModules();
    return vi.importActual<typeof import("../src/utils/ios-device/devicectl")>(
      "../src/utils/ios-device/devicectl"
    );
  }

  function probeSpawns(): unknown[][] {
    return execFileMock.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("--help")
    );
  }

  /** Serve `devicectl device --help` with the given stdout; everything else errors. */
  function mockDeviceHelp(stdout: string): void {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = (args[1] as string[]) ?? [];
      const cb = callbackOf(args);
      if (args[0] === "xcrun" && argv.includes("--help")) {
        cb?.(null, { stdout, stderr: "" });
        return;
      }
      cb?.(new Error(`unexpected execFile ${String(args[0])} ${argv.join(" ")}`));
    });
  }

  // The advertised subcommand table is the binary's own declaration of its
  // command tree — the structural signal, with no error wording involved.
  const XCODE16_DEVICE_HELP =
    "USAGE: devicectl device <subcommand>\n\nSUBCOMMANDS:\n" +
    "  copy                    Copy files.\n" +
    "  info                    Commands that provide information about a specific\n" +
    "                          device\n" +
    "  screenshot              Capture a screenshot from a device.\n" +
    "  uninstall               Uninstall content from a device.\n";
  // devicectl 518.33's actual table (verified live): no screenshot row — and a
  // deep-indented description continuation starting with the word must not
  // count as one.
  const DEVICECTL_518_DEVICE_HELP =
    "USAGE: devicectl device <subcommand>\n\nSUBCOMMANDS:\n" +
    "  copy                    Copy files.\n" +
    "  process                 Interact with processes on devices, including\n" +
    "                          screenshot-adjacent tooling.\n" +
    "  sysdiagnose             Gather a sysdiagnose for a device.\n";

  it("answers true from a `screenshot` row in the advertised subcommand table", async () => {
    mockDeviceHelp(XCODE16_DEVICE_HELP);
    const devicectl = await freshDevicectl();

    await expect(devicectl.supportsHostScreenshot()).resolves.toBe(true);
    expect(probeSpawns()).toHaveLength(1);
    expect(probeSpawns()[0][0]).toBe("xcrun");
    expect(probeSpawns()[0][1]).toEqual(["devicectl", "device", "--help"]);
  });

  it("answers false for a table without the row, even though the probe itself exits cleanly", async () => {
    // The regression the parse exists for: `devicectl device screenshot --help`
    // on 518.33 ALSO exits 0 (ArgumentParser serves the parent's help for an
    // unknown subcommand), so a clean exit alone must never read as supported.
    mockDeviceHelp(DEVICECTL_518_DEVICE_HELP);
    const devicectl = await freshDevicectl();

    await expect(devicectl.supportsHostScreenshot()).resolves.toBe(false);
  });

  it("answers false when the probe fails outright, whatever the refusal says", async () => {
    // Deliberately NOT Apple's unknown-subcommand wording — a reworded
    // devicectl (or a missing one) must classify identically.
    failAllSpawns("some entirely reworded refusal");
    const devicectl = await freshDevicectl();

    await expect(devicectl.supportsHostScreenshot()).resolves.toBe(false);
  });

  it("spawns the probe once per process, even for concurrent callers", async () => {
    mockDeviceHelp(XCODE16_DEVICE_HELP);
    const devicectl = await freshDevicectl();

    await Promise.all([devicectl.supportsHostScreenshot(), devicectl.supportsHostScreenshot()]);
    await devicectl.supportsHostScreenshot();

    expect(probeSpawns()).toHaveLength(1);
  });
});
