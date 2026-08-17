import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@argent/registry";
import { createScreenshotTool } from "../src/tools/screenshot";
import { getScreenshotScale } from "../src/utils/simulator-client";

describe("screenshot tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
      filename: "screenshot.png",
      mimeType: "image/png",
      hostPath: "/tmp/screenshot.png",
    });
    expect(result).not.toHaveProperty("includeImageInContext");
    expect(result).not.toHaveProperty("url");
  });

  it("omitting `scale` puts the tool-server's own scale on the wire", async () => {
    // Half of an equality several tool descriptions and skills rest on: a
    // baseline captured here with `scale` omitted has to come out at the size
    // screenshot-diff's live capture falls back to. That side is asserted in
    // screenshot-diff-tool.test.ts; this is the one that would go stale if this
    // path ever resolved a default of its own.
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "");
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: "http://localhost/s.png", path: "/tmp/s.png" }),
        } as unknown as Response;
      })
    );
    const registry = {
      resolveService: vi.fn().mockResolvedValue({ apiUrl: "http://localhost:4949" }),
    } as unknown as import("@argent/registry").Registry;

    await createScreenshotTool(registry).execute(
      {},
      { udid: "ABC", includeImageInContext: false },
      { artifacts: new ArtifactStore() }
    );

    expect(bodies).toEqual([{ scale: getScreenshotScale() }]);
  });

  it("hands Chromium no scale of its own, so nothing is downscaled by default", async () => {
    // The other half of the split this tool's `scale` description and
    // argent-device-interact both state: 30% on iOS/Android, untouched on
    // Chromium. `execute` resolves getScreenshotScale() one line above this
    // branch and deliberately does not pass it, which is exactly the line a
    // platform-unifying cleanup collapses.
    const captureScreenshot = vi.fn().mockResolvedValue({ path: "/tmp/c.png" });
    const registry = {
      resolveService: vi.fn().mockResolvedValue({ captureScreenshot }),
    } as unknown as import("@argent/registry").Registry;

    await createScreenshotTool(registry).execute(
      {},
      { udid: "chromium-cdp-9222", rotation: "LandscapeLeft", includeImageInContext: false },
      { artifacts: new ArtifactStore() }
    );

    // `rotation` rides the same object and the same post-processing branch, so
    // dropping it returns an unrotated image and says nothing. Read off the call
    // rather than matched as a shape: an absent `scale` key reads the same as
    // the explicit undefined it is today.
    const opts = captureScreenshot.mock.calls[0]![0] as { scale?: number; rotation?: string };
    expect(opts.scale).toBeUndefined();
    expect(opts.rotation).toBe("LandscapeLeft");
  });
});
