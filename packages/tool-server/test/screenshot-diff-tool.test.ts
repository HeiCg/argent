import fs from "fs/promises";
import os from "os";
import path from "path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@argent/registry";
import { executeScreenshotDiffTool, screenshotDiffTool } from "../src/tools/screenshot-diff";
import { createScreenshotTool } from "../src/tools/screenshot";
import { getScreenshotScale } from "../src/utils/simulator-client";
import { agentFacingText, sentencesClaimingSize } from "./helpers/size-claims";

describe("screenshotDiffTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rejects public tuning options so defaults stay internal", () => {
    const result = screenshotDiffTool.zodSchema!.safeParse({
      baselinePath: "/tmp/baseline.png",
      currentPath: "/tmp/current.png",
      udid: "ABC",
      outputDir: "/tmp",
      includeTextAnalysis: false,
      threshold: 0.2,
      textChangeMinConfidence: 0.9,
      maxRegions: 3,
    });

    expect(result.success).toBe(false);
  });

  it("requires udid and only declares the simulator-server service for live captures", () => {
    expect(
      screenshotDiffTool.zodSchema!.safeParse({
        baselinePath: "/tmp/baseline.png",
        currentPath: "/tmp/current.png",
        outputDir: "/tmp",
      }).success
    ).toBe(false);

    // A pure static-PNG diff needs no SimulatorServer — requesting it
    // unconditionally would fail on tvOS sims that have no such backend.
    const staticParams = {
      baselinePath: "/tmp/baseline.png",
      currentPath: "/tmp/current.png",
      udid: "ABC",
      outputDir: "/tmp",
    };
    expect(screenshotDiffTool.zodSchema!.safeParse(staticParams).success).toBe(true);
    expect(screenshotDiffTool.services(staticParams)).toEqual({});

    // A live capture resolves and starts the SimulatorServer for the device.
    const liveParams = {
      baselinePath: "/tmp/baseline.png",
      captureCurrent: true,
      udid: "ABC",
      outputDir: "/tmp",
    };
    expect(screenshotDiffTool.zodSchema!.safeParse(liveParams).success).toBe(true);
    const liveServices = {
      simulatorServer: {
        urn: "SimulatorServer:ABC",
        options: {
          device: {
            id: "ABC",
            platform: "android",
            // A non-`emulator-*` serial resolves to a physical device.
            kind: "device",
          },
        },
      },
    };
    expect(screenshotDiffTool.services(liveParams)).toEqual(liveServices);

    // The other live flag reaches the same captureLiveInput, so it needs the
    // same service — asserted separately because a condition covering only
    // captureCurrent satisfies every other test in the suite while leaving
    // captureBaseline to throw "requires a simulatorServer service".
    expect(
      screenshotDiffTool.services({
        currentPath: "/tmp/current.png",
        captureBaseline: true,
        udid: "ABC",
        outputDir: "/tmp",
      })
    ).toEqual(liveServices);
  });

  it("returns only the summary and diff artifact paths", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-tool-"));
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 2, 2, { r: 10, g: 20, b: 30 });
    await writePng(currentPath, 2, 2, { r: 10, g: 20, b: 30 });

    const result = await executeScreenshotDiffTool(
      {},
      {
        baselinePath,
        currentPath,
        udid: "ABC",
        outputDir: dir,
      },
      { artifacts: new ArtifactStore() }
    );

    // Diff outputs leave as artifact handles so a remote client can download
    // them; hostPath still points at the requested outputDir.
    expect(result.summary).toContain("Screenshot diff summary");
    expect(result.diffPath).toMatchObject({
      __argentArtifact: true,
      hostPath: path.join(dir, "current-diff.png"),
      mimeType: "image/png",
    });
    expect(result.contextDiffPath).toMatchObject({
      __argentArtifact: true,
      hostPath: path.join(dir, "current-context-diff.png"),
      mimeType: "image/png",
    });
    expect(Object.keys(result).sort()).toEqual(["contextDiffPath", "diffPath", "summary"]);
  });

  it("returns the summary alone when the aspect ratios differ, and writes nothing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-mismatch-"));
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 4, 2, { r: 10, g: 20, b: 30 });
    await writePng(currentPath, 2, 8, { r: 10, g: 20, b: 30 });

    const result = await executeScreenshotDiffTool(
      {},
      { baselinePath, currentPath, udid: "ABC", outputDir: dir },
      { artifacts: new ArtifactStore() }
    );

    // The description's "both images are omitted on dimension_mismatch, where
    // nothing was compared" — the equal-size test above pins the other arm, and
    // an omission is what a `toMatchObject` on the present keys cannot see.
    expect(result.summary).toContain("- status: dimension_mismatch");
    expect(Object.keys(result).sort()).toEqual(["summary"]);
    expect((await fs.readdir(dir)).sort()).toEqual(["baseline.png", "current.png"]);
    // Behaviour and promise together: an agent that reads the description and
    // then looks for diffPath here has to find the same answer in both.
    expect(screenshotDiffTool.description).toContain(
      "both images are omitted on dimension_mismatch"
    );
  });

  it("captures one live side at full resolution and copies it into outputDir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-live-"));
    const baselinePath = path.join(dir, "baseline.png");
    const capturedPath = path.join(dir, "captured.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
    const signal = AbortSignal.timeout(1000);
    const captureScreenshot = vi.fn(async () => ({
      url: "http://localhost/current.png",
      path: capturedPath,
    }));

    const result = await executeScreenshotDiffTool(
      { simulatorServer: { apiUrl: "http://localhost:4949" } },
      {
        baselinePath,
        captureCurrent: true,
        udid: "ABC",
        rotation: "LandscapeLeft",
        outputDir: dir,
      },
      { signal, artifacts: new ArtifactStore() },
      captureScreenshot as never
    );

    expect(captureScreenshot).toHaveBeenCalledWith(
      { apiUrl: "http://localhost:4949" },
      "LandscapeLeft",
      signal,
      1.0
    );

    const entries = await fs.readdir(dir);
    const liveCaptures = entries.filter((name) => /^current-[a-f0-9]{8}\.live\.png$/.test(name));
    expect(liveCaptures).toHaveLength(1);
    const liveBaseName = path.parse(liveCaptures[0]!).name;
    await expect(fs.stat(path.join(dir, liveCaptures[0]!))).resolves.toMatchObject({
      size: expect.any(Number),
    });
    expect(result.diffPath).toMatchObject({
      hostPath: path.join(dir, `${liveBaseName}-diff.png`),
    });
  });

  it("falls back to the tool-server's screenshot scale when the full-resolution capture fails (Android framebuffer mismatch)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-fallback-"));
    const baselinePath = path.join(dir, "baseline.png");
    const capturedPath = path.join(dir, "captured.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
    // Full-res (scale 1.0) fails the way the Android simulator-server does;
    // the retry, which passes no scale and so resolves the tool-server's own,
    // succeeds.
    const captureScreenshot = vi.fn(
      async (_api: unknown, _rotation: unknown, _signal: unknown, scale?: number) => {
        if (scale === 1.0) {
          throw new Error("Screenshot failed: wrong data size, expected 7853760 got 17627328.");
        }
        return { url: "http://localhost/current.png", path: capturedPath };
      }
    );

    const result = await executeScreenshotDiffTool(
      { simulatorServer: { apiUrl: "http://localhost:4949" } },
      { baselinePath, captureCurrent: true, udid: "ABC", outputDir: dir },
      { artifacts: new ArtifactStore() },
      captureScreenshot as never
    );

    // Full-res attempted first, then a retry at the tool-server's own scale.
    // Which argument carries that scale is not asserted — passing it explicitly
    // produces the same request, and the wire tests below pin the value itself.
    expect(captureScreenshot).toHaveBeenCalledTimes(2);
    expect(captureScreenshot.mock.calls[0]![3]).toBe(1.0);
    const liveCaptures = (await fs.readdir(dir)).filter((name) =>
      /^current-[a-f0-9]{8}\.live\.png$/.test(name)
    );
    expect(liveCaptures).toHaveLength(1);
    expect(result.diffPath).toBeTruthy();
  });

  it.each([
    { env: "", expected: 0.3 },
    { env: "0.6", expected: 0.6 },
  ])(
    "sends the scale the tool-server resolves on the retry (env $env)",
    async ({ env, expected }) => {
      vi.stubEnv("ARGENT_SCREENSHOT_SCALE", env);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-wire-"));
      const baselinePath = path.join(dir, "baseline.png");
      const capturedPath = path.join(dir, "captured.png");
      await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
      await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
      const bodies = stubEmulatorRejectingFullRes(capturedPath);

      const result = await executeScreenshotDiffTool(
        { simulatorServer: { apiUrl: "http://127.0.0.1:4949" } },
        { baselinePath, captureCurrent: true, udid: "emulator-5554", outputDir: dir },
        { artifacts: new ArtifactStore() }
      );

      // Asserted on the wire rather than on an injected capture stub, because
      // the scale the descriptions name is the one httpScreenshot resolves: a
      // 1.0 request carries no `scale` at all, and only the retry reveals it.
      // Both rows matter — with only the unset one, a retry that hardcoded 0.3
      // would pass while ignoring the configured scale the prose promises.
      expect(bodies).toEqual([{}, { scale: expected }]);
      expect(result.summary).toContain("Screenshot diff summary");
    }
  );

  it("names the resolved fallback scale in prose wherever it quotes it", () => {
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "");
    // The prose quotes this number as a literal, so it drifts the moment
    // DEFAULT_SCREENSHOT_SCALE moves; nothing else reads the two together.
    // Whole phrases, not the bare number: `toContain("0.3")` is also satisfied
    // by "0.35", by the unrelated "0.01" in the same sentence, and by prose that
    // drops the env var and keeps the digits.
    const fallback = getScreenshotScale();
    const shape = screenshotDiffTool.zodSchema!.shape;
    const registry = {
      resolveService: vi.fn(),
    } as unknown as import("@argent/registry").Registry;
    const scaleDescription = createScreenshotTool(registry).zodSchema!.shape.scale.description;

    expect(shape.captureBaseline.description).toContain(
      `ARGENT_SCREENSHOT_SCALE, ${fallback} by default`
    );
    expect(shape.captureCurrent.description).toContain(
      `ARGENT_SCREENSHOT_SCALE, ${fallback} by default`
    );
    expect(scaleDescription).toContain(
      `ARGENT_SCREENSHOT_SCALE env var, or ${fallback} whenever that is unset or outside (0,1]`
    );
    // The hazard the rest of that paragraph exists for, on the one surface an
    // agent reads with no skill loaded — `screenshot` is alwaysLoad.
    expect(scaleDescription).toContain("wrong data size");
    // …and the Fails line, which is where an agent looks to find out whether
    // that hazard ends the call or is absorbed. It ends it.
    expect(createScreenshotTool(registry).description).toContain(
      "if the device rejects a capture at the requested scale"
    );
    expect(screenshotDiffTool.description).toContain("a requested live capture cannot be taken");
  });

  it("does not promise a full-resolution capture, or a full-size diff image", () => {
    // Both sentences are pinned as phrases: reword either and this fails, which
    // is the point — a reword has to be checked against captureLiveInput and
    // writeDiffArtifacts again.
    const registry = {
      resolveService: vi.fn(),
    } as unknown as import("@argent/registry").Registry;

    expect(screenshotDiffTool.description).toContain(
      "otherwise the tool-server's screenshot scale"
    );
    expect(screenshotDiffTool.description).toContain(
      "diffPath is the diff at the size the comparison ran at"
    );
    // A positive phrase leaves room for a contradicting sentence beside it: a
    // "(full size)" label three lines below a bullet denying it satisfies every
    // positive check. So collect the sentences that reach for this vocabulary at
    // all, across every string either tool puts in front of an agent, and pin
    // that collection whole. An added claim is an extra element whether it
    // repeats a pinned phrase verbatim or reaches for a synonym, and a sibling
    // field is not a place the sweep does not look. Both tools together, because
    // the claim moves between them: `screenshot` is what captures a diff
    // baseline, and it is alwaysLoad, so it reaches an agent with no skill open.
    const expected: Record<string, string[]> = {
      // The capture's resolution cannot be banned outright — it is genuinely
      // attempted at full resolution — so the condition is what gets pinned.
      "screenshot-diff.description": [
        "Accepts saved baseline/current PNG paths, or one saved PNG plus one live capture from a device — full resolution when that capture succeeds, otherwise the tool-server's screenshot scale.",
      ],
      "screenshot-diff.captureBaseline": [
        "Capture the baseline screenshot live before diffing — at full resolution when that capture succeeds, otherwise at the tool-server's screenshot scale (ARGENT_SCREENSHOT_SCALE, 0.3 by default; at 1.0 the retry repeats the request that just failed, leaving a device that cannot stream a full frame with no fallback).",
      ],
      "screenshot-diff.captureCurrent": [
        "Capture the current screenshot live before diffing — at full resolution when that capture succeeds, otherwise at the tool-server's screenshot scale (ARGENT_SCREENSHOT_SCALE, 0.3 by default; at 1.0 the retry repeats the request that just failed, leaving a device that cannot stream a full frame with no fallback).",
      ],
      "screenshot.scale": [
        "Some Android emulators cannot stream a full-resolution frame and reject scale: 1.0 with a `wrong data size` error; retry at a lower scale on those devices.",
        "A screenshot-diff baseline should match what that tool's own live capture produces on the same device — it tries 1.0 and drops to the tool-server's screenshot scale when that fails — so save it at scale: 1.0 where a full frame streams, and with `scale` omitted where it does not, which yields a smaller frame only while ARGENT_SCREENSHOT_SCALE resolves below 1.0 and repeats the rejected request when it does not.",
      ],
    };
    for (const def of [screenshotDiffTool, createScreenshotTool(registry)]) {
      for (const [surface, text] of agentFacingText(def)) {
        const key = `${def.id}.${surface}`;
        expect(sentencesClaimingSize(text), key).toEqual(expected[key] ?? []);
      }
    }
    // Suppression is about where the bytes go, not what resolution they are:
    // conditioning it on a full-resolution capture sends agents at the call that
    // fails on these emulators. Pinned whole, because such a condition
    // re-attaches anywhere inside the sentence, including past its last clause.
    expect(createScreenshotTool(registry).zodSchema!.shape.includeImageInContext.description).toBe(
      "Default true. Set false only when capturing a baseline/current PNG for screenshot-diff — the file is still written, but the image bytes are not attached to the agent context."
    );
  });

  it("tells a `screenshot` caller that the scale it picks is a diff input", () => {
    // The two wire tests above pin the sizes these tools agree on, but only
    // `screenshot`'s own description reaches an agent capturing a baseline for a
    // diff it has not started yet; drop the pairing here and that agent picks a
    // scale with no reason to think it matters.
    const registry = {
      resolveService: vi.fn(),
    } as unknown as import("@argent/registry").Registry;
    // Both halves: that the two tools are linked at all, and the instruction
    // that link exists to give. Deleting the second leaves the first satisfied
    // by the word alone, and the three skills mirror the instruction, not the
    // mention.
    expect(createScreenshotTool(registry).zodSchema!.shape.scale.description).toContain(
      "save it at scale: 1.0 where a full frame streams, and with `scale` omitted where it does not"
    );
    expect(createScreenshotTool(registry).zodSchema!.shape.scale.description).toContain(
      "screenshot-diff"
    );
  });

  it("has nothing lower to retry when ARGENT_SCREENSHOT_SCALE is 1.0, so the capture fails", async () => {
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "1.0");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-env1-"));
    const baselinePath = path.join(dir, "baseline.png");
    const capturedPath = path.join(dir, "captured.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
    const bodies = stubEmulatorRejectingFullRes(capturedPath);

    await expect(
      executeScreenshotDiffTool(
        { simulatorServer: { apiUrl: "http://127.0.0.1:4949" } },
        { baselinePath, captureCurrent: true, udid: "emulator-5554", outputDir: dir },
        { artifacts: new ArtifactStore() }
      )
    ).rejects.toThrow("Screenshot failed: wrong data size, expected 7853760 got 17627328.");

    // httpScreenshot omits an in-band 1.0, so the retry serializes to the same
    // bytes as the attempt that just failed — the behaviour both flags'
    // descriptions warn about. The same stub succeeds at 0.3 in the test above.
    expect(bodies).toEqual([{}, {}]);
  });

  it("captures the baseline live against a saved current, naming that side's file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-baseline-"));
    const currentPath = path.join(dir, "current.png");
    const capturedPath = path.join(dir, "captured.png");
    // Deliberately different sizes, same aspect: the summary labels the two
    // sides, so this is what proves the live capture landed in the baseline
    // slot. Equal-sized fixtures pass just as well with the sides swapped.
    await writePng(currentPath, 2, 4, { r: 0, g: 0, b: 0 });
    await writePng(capturedPath, 4, 8, { r: 0, g: 0, b: 0 });
    const captureScreenshot = vi.fn(
      async (_api: unknown, _rotation: unknown, _signal: unknown, _scale?: number) => ({
        url: "http://localhost/baseline.png",
        path: capturedPath,
      })
    );

    const result = await executeScreenshotDiffTool(
      { simulatorServer: { apiUrl: "http://localhost:4949" } },
      { currentPath, captureBaseline: true, udid: "ABC", outputDir: dir },
      { artifacts: new ArtifactStore() },
      captureScreenshot as never
    );

    expect(result.summary).toContain("- size_normalized: baseline=4x8 current=2x4 compared_at=2x4");
    // Named for its side so the directory says which one was live; the diff
    // artifacts are named after currentPath either way.
    const liveCaptures = (await fs.readdir(dir)).filter((name) =>
      /^baseline-[a-f0-9]{8}\.live\.png$/.test(name)
    );
    expect(liveCaptures).toHaveLength(1);
    expect(captureScreenshot).toHaveBeenCalledTimes(1);
    // Full resolution is tried first on this side too, not only on captureCurrent.
    expect(captureScreenshot.mock.calls[0]![3]).toBe(1.0);
    expect(result.diffPath).toBeTruthy();
  });

  it("propagates the error when both the full-res capture and the fallback fail", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-bothfail-"));
    const baselinePath = path.join(dir, "baseline.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    const captureScreenshot = vi.fn(
      async (_api: unknown, _rotation: unknown, _signal: unknown, scale?: number) => {
        throw new Error(scale === 1.0 ? "full-res failed" : "device offline");
      }
    );

    await expect(
      executeScreenshotDiffTool(
        { simulatorServer: { apiUrl: "http://localhost:4949" } },
        { baselinePath, captureCurrent: true, udid: "ABC", outputDir: dir },
        {},
        captureScreenshot as never
      )
    ).rejects.toThrow("device offline");
    expect(captureScreenshot).toHaveBeenCalledTimes(2);
  });

  it("uses a fresh hashed filename for each live capture so concurrent diffs do not collide", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-unique-"));
    const baselinePath = path.join(dir, "baseline.png");
    const capturedPath = path.join(dir, "captured.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
    const captureScreenshot = vi.fn(async () => ({
      url: "http://localhost/current.png",
      path: capturedPath,
    }));

    await executeScreenshotDiffTool(
      { simulatorServer: { apiUrl: "http://localhost:4949" } },
      { baselinePath, captureCurrent: true, udid: "ABC", outputDir: dir },
      { artifacts: new ArtifactStore() },
      captureScreenshot as never
    );
    await executeScreenshotDiffTool(
      { simulatorServer: { apiUrl: "http://localhost:4949" } },
      { baselinePath, captureCurrent: true, udid: "ABC", outputDir: dir },
      { artifacts: new ArtifactStore() },
      captureScreenshot as never
    );

    const liveCaptures = (await fs.readdir(dir)).filter((name) =>
      /^current-[a-f0-9]{8}\.live\.png$/.test(name)
    );
    expect(liveCaptures).toHaveLength(2);
    expect(new Set(liveCaptures).size).toBe(2);
  });

  it("validates mutually exclusive saved and live inputs at execute time", async () => {
    await expect(
      executeScreenshotDiffTool(
        {},
        {
          baselinePath: "/tmp/baseline.png",
          currentPath: "/tmp/current.png",
          captureCurrent: true,
          udid: "ABC",
          outputDir: "/tmp",
        }
      )
    ).rejects.toThrow("Provide either currentPath or captureCurrent, not both.");
  });
});

/**
 * Stands in for an Android emulator whose framebuffer cannot stream a full
 * frame: `httpScreenshot` omits `scale` from the body for a 1.0 capture, and
 * that is the request this rejects — the way the real server does, HTTP 200
 * with an in-band `error`. Returns the request bodies as they went out.
 */
function stubEmulatorRejectingFullRes(capturedPath: string): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      return {
        ok: true,
        status: 200,
        json: async () =>
          body.scale === undefined
            ? { error: "wrong data size, expected 7853760 got 17627328" }
            : { url: "http://127.0.0.1:4949/media/shot.png", path: capturedPath },
      } as unknown as Response;
    })
  );
  return bodies;
}

async function writePng(
  filePath: string,
  width: number,
  height: number,
  fill: { r: number; g: number; b: number }
): Promise<void> {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (width * y + x) * 4;
      png.data[offset] = fill.r;
      png.data[offset + 1] = fill.g;
      png.data[offset + 2] = fill.b;
      png.data[offset + 3] = 255;
    }
  }

  await fs.writeFile(filePath, PNG.sync.write(png));
}
