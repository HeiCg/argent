import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@argent/registry";

// Controls what `isFlagEnabled("open-device-server")` reports; each test flips it.
let flagEnabledMock: (name: string) => boolean;
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => flagEnabledMock(name) };
});

// The simulator-server fallback capture; mocked so the flag-off path never hits a
// real emulator framebuffer over HTTP.
vi.mock("../src/utils/rotation-aware-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/rotation-aware-capture")>();
  return {
    ...actual,
    captureScreenshotUpright: vi.fn(async () => ({ url: "http://x/ss.png", path: SS_PATH })),
  };
});

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { PNG } from "pngjs";
import { createScreenshotTool } from "../src/tools/screenshot";
import { createScreenshotDiffTool } from "../src/tools/screenshot-diff";
import { captureScreenshotUpright } from "../src/utils/rotation-aware-capture";

// A real, valid PNG so the open capture writes a file both the artifact store and
// the diff decoder accept.
function pngBuffer(w = 4, h = 4): Buffer {
  const p = new PNG({ width: w, height: h });
  p.data.fill(0);
  return PNG.sync.write(p);
}
const PNG_B64 = pngBuffer().toString("base64");
const ANDROID_SERIAL = "emulator-5554";
let SS_PATH = "";

interface FakeOpenApi {
  screenshot: ReturnType<typeof vi.fn>;
  getInfo: ReturnType<typeof vi.fn>;
}

function makeOpenApi(): FakeOpenApi {
  return {
    screenshot: vi.fn(async () => ({
      data: PNG_B64,
      mimeType: "image/png",
      width: 1000,
      height: 2000,
    })),
    getInfo: vi.fn(async () => ({
      screenWidth: 1000,
      screenHeight: 2000,
      currentPackage: "",
      keyboardVisible: false,
      displayRotation: 0,
    })),
  };
}

/** Registry that routes resolveService by URN prefix; SS resolution is pluggable. */
function makeRegistry(openApi: unknown, onSimulatorServer: () => Promise<unknown>) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      if (urn.startsWith("SimulatorServer:")) return onSimulatorServer();
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
}

beforeEach(async () => {
  flagEnabledMock = () => false;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-open-ss-"));
  SS_PATH = path.join(dir, "ss.png");
  await fs.writeFile(SS_PATH, pngBuffer());
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("screenshot → open-device-server (T1)", () => {
  it("flag on: captures via the open server's screenshot RPC (PNG) and never touches the simulator-server", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    const ssResolve = vi.fn(async () => {
      throw new Error("SS should not be resolved");
    });
    const registry = makeRegistry(openApi, ssResolve);
    const tool = createScreenshotTool(registry);

    const result = await tool.execute({}, { udid: ANDROID_SERIAL, includeImageInContext: true }, {
      artifacts: new ArtifactStore(),
    } as never);

    expect(openApi.screenshot).toHaveBeenCalledTimes(1);
    expect(openApi.screenshot).toHaveBeenCalledWith(expect.objectContaining({ format: "png" }));
    expect(result.image.mimeType).toBe("image/png");
    expect(ssResolve).not.toHaveBeenCalled();
  });

  it("passes an explicit scale through to the RPC", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    const tool = createScreenshotTool(makeRegistry(openApi, async () => ({})));

    await tool.execute({}, { udid: ANDROID_SERIAL, scale: 0.5, includeImageInContext: true }, {
      artifacts: new ArtifactStore(),
    } as never);

    expect(openApi.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ format: "png", scale: 0.5 })
    );
  });

  it("flag off: never touches the open server, uses the simulator-server capture", async () => {
    flagEnabledMock = () => false;
    const openApi = makeOpenApi();
    const ss = {};
    const tool = createScreenshotTool(makeRegistry(openApi, async () => ss));

    const result = await tool.execute({}, { udid: ANDROID_SERIAL, includeImageInContext: true }, {
      artifacts: new ArtifactStore(),
    } as never);

    expect(openApi.screenshot).not.toHaveBeenCalled();
    expect(vi.mocked(captureScreenshotUpright)).toHaveBeenCalledTimes(1);
    expect(result.image).toBeDefined();
  });

  it("open server throws: logs a warning and falls back to the simulator-server capture", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    openApi.screenshot.mockRejectedValueOnce(new Error("open boom"));
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const tool = createScreenshotTool(makeRegistry(openApi, async () => ({})));

    const result = await tool.execute({}, { udid: ANDROID_SERIAL, includeImageInContext: true }, {
      artifacts: new ArtifactStore(),
    } as never);

    expect(openApi.screenshot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureScreenshotUpright)).toHaveBeenCalledTimes(1);
    expect(result.image).toBeDefined();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("[screenshot] open-device-server"));
  });
});

describe("screenshot-diff live capture → open-device-server (T2)", () => {
  it("flag on: captures the live side through the open server, not the simulator-server", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    const ssResolve = vi.fn(async () => {
      throw new Error("SS should not be resolved");
    });
    const registry = makeRegistry(openApi, ssResolve);
    const tool = createScreenshotDiffTool(registry);

    // services() must skip the simulator-server ref while the flag is on.
    expect(tool.services({ captureCurrent: true, udid: ANDROID_SERIAL } as never)).toEqual({});

    const baseline = SS_PATH; // any valid PNG on disk
    const result = await tool.execute(
      {},
      { baselinePath: baseline, captureCurrent: true, udid: ANDROID_SERIAL } as never,
      { artifacts: new ArtifactStore() } as never
    );

    expect(openApi.screenshot).toHaveBeenCalled();
    expect(ssResolve).not.toHaveBeenCalled();
    expect(result.summary).toBeDefined();
  });

  it("flag off: keeps the simulator-server ref for a live capture", () => {
    flagEnabledMock = () => false;
    const tool = createScreenshotDiffTool(makeRegistry(makeOpenApi(), async () => ({})));
    expect(tool.services({ captureCurrent: true, udid: ANDROID_SERIAL } as never)).toEqual({
      simulatorServer: expect.objectContaining({ urn: `SimulatorServer:${ANDROID_SERIAL}` }),
    });
  });
});
