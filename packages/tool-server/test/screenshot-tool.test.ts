import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@argent/registry";
import { createScreenshotTool } from "../src/tools/screenshot";

// The tool resolves its backend lazily via the registry rather than taking an
// eagerly-declared service, so a tvOS udid can branch away from the
// simulator-server it can't drive. A non-iOS-shaped udid ("ABC") skips the tvOS
// runtime probe and goes straight to simulator-server.
function simulatorServerTool(hostPath = "/tmp/screenshot.png") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "http://localhost/screenshot.png", path: hostPath }),
    })
  );
  const registry = {
    resolveService: vi.fn().mockResolvedValue({ apiUrl: "http://localhost:4949" }),
  } as unknown as import("@argent/registry").Registry;
  return createScreenshotTool(registry);
}

describe("screenshot tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an image artifact handle; includeImageInContext is an input-only flag handled by the MCP adapter", async () => {
    const screenshotTool = simulatorServerTool();

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
      mimeType: "image/png",
      hostPath: "/tmp/screenshot.png",
    });
    expect(result).not.toHaveProperty("includeImageInContext");
    expect(result).not.toHaveProperty("url");
  });

  it("tags the capture for durable saving under .argent/screenshots", async () => {
    const screenshotTool = simulatorServerTool();

    const result = await screenshotTool.execute(
      {},
      { udid: "ABC", includeImageInContext: true },
      { artifacts: new ArtifactStore() }
    );

    // Without this hint the client materializes the PNG into a session-scoped
    // temp cache that disappears with the session.
    expect(result.image.saveDir).toBe(".argent/screenshots");
  });

  it("names the saved file by device and capture time, not by the backend's temp name", async () => {
    // The simulator-server writes a bare `<hrtime>-<epochMs>.png`, which says
    // nothing in a durable directory shared across sessions.
    const screenshotTool = simulatorServerTool(
      "/tmp/simserver-x/media/821081000-1785417279821.png"
    );

    const before = Date.now();
    const result = await screenshotTool.execute(
      {},
      { udid: "ABC", includeImageInContext: true },
      { artifacts: new ArtifactStore() }
    );
    const after = Date.now();

    const match = /^screenshot-ABC-(\d+)\.png$/.exec(result.image.filename);
    expect(match, `unexpected filename ${result.image.filename}`).not.toBeNull();
    const stamp = Number(match![1]);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
    // The host path is untouched — only the presented name is argent's own.
    expect(result.image.hostPath).toBe("/tmp/simserver-x/media/821081000-1785417279821.png");
  });

  it("keeps the saved filename to a single safe path segment for an unsafe device id", async () => {
    // A Chromium device id carries characters (`:` / `/`) that must not reach a
    // filename the client joins onto a directory.
    const screenshotTool = simulatorServerTool();

    const result = await screenshotTool.execute(
      {},
      { udid: "chromium:9222/page", includeImageInContext: true },
      { artifacts: new ArtifactStore() }
    );

    expect(result.image.filename).toMatch(/^screenshot-chromium-9222-page-\d+\.png$/);
    expect(result.image.filename).not.toContain("/");
    expect(result.image.filename).not.toContain(":");
  });
});
