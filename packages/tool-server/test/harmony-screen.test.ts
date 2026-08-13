import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import {
  hdcFileRecv as realHdcFileRecv,
  runHdcShell as realRunHdcShell,
} from "../src/utils/harmony-hdc";
import { captureHarmonyScreenshotPng } from "../src/utils/harmony-screen";

// Only the transport is faked. `shellQuote` stays real so the assertions see
// the exact command lines the device would; the fetch writes a real (tiny)
// PNG so `captureHarmonyScreenshotPng`'s decode/scale path runs for true.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/harmony-hdc")>();
  return { ...actual, runHdcShell: vi.fn(), hdcFileRecv: vi.fn() };
});

const runHdcShell = vi.mocked(realRunHdcShell);
const hdcFileRecv = vi.mocked(realHdcFileRecv);

/** A minimal valid PNG — what `uitest screenCap` would have written. */
function tinyPng(): Buffer {
  return PNG.sync.write(new PNG({ width: 4, height: 4 }));
}

/** The remote path of every `uitest screenCap -p '<path>'` call, in order. */
function capturedRemotePaths(): string[] {
  return runHdcShell.mock.calls
    .map((c) => /screenCap -p '([^']+)'/.exec(c[1])?.[1])
    .filter((p): p is string => typeof p === "string");
}

const outPaths: string[] = [];

async function capture(): Promise<string> {
  const out = await captureHarmonyScreenshotPng({ connectKey: "dev", scale: 1 });
  outPaths.push(out);
  return out;
}

beforeEach(() => {
  runHdcShell.mockReset().mockResolvedValue({ stdout: "", exitCode: 0 });
  hdcFileRecv.mockReset();
});

afterEach(async () => {
  await Promise.all(outPaths.splice(0).map((p) => rm(p, { force: true }).catch(() => {})));
});

describe("harmonyScreenCap viaDeviceTmp", () => {
  it("removes the on-device capture even when the fetch fails", async () => {
    // Without the finally-delete, every failed screenshot leaves a
    // multi-hundred-KB PNG on /data/local/tmp, a partition nothing prunes.
    hdcFileRecv.mockRejectedValue(new Error("[Fail]Error opening file: no such file"));

    await expect(captureHarmonyScreenshotPng({ connectKey: "dev", scale: 1 })).rejects.toThrow(
      /Error opening file/
    );

    const [remotePath] = capturedRemotePaths();
    expect(remotePath).toMatch(/^\/data\/local\/tmp\/argent-\d+-\d+\.png$/);
    const commands = runHdcShell.mock.calls.map((c) => c[1]);
    // The rm runs after the screenCap (and after the failed recv), against
    // the exact path the capture wrote.
    expect(commands).toContain(`rm -f '${remotePath}'`);
    expect(commands.indexOf(`rm -f '${remotePath}'`)).toBeGreaterThan(
      commands.findIndex((c) => c.includes("screenCap"))
    );
  });

  it("uses a distinct remote path for two concurrent captures", async () => {
    // A fixed path would let one capture overwrite the other's between write
    // and fetch, silently handing the loser the winner's screen.
    hdcFileRecv.mockImplementation(async (_key, _remote, localPath) => {
      await writeFile(localPath, tinyPng());
    });

    const [a, b] = await Promise.all([capture(), capture()]);

    const paths = capturedRemotePaths();
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
    for (const p of paths) {
      expect(p).toContain(`/data/local/tmp/argent-${process.pid}-`);
    }
    // Both captures completed as real, readable PNGs.
    for (const out of [a, b]) {
      const decoded = PNG.sync.read(await readFile(out));
      expect([decoded.width, decoded.height]).toEqual([4, 4]);
    }
  });
});

describe("captureHarmonyScreenshotPng", () => {
  it("removes the host-side raw capture when decoding it fails", async () => {
    // The fetch "succeeds" but delivers garbage; the raw file must not be
    // left behind in the host tmpdir on the error path.
    hdcFileRecv.mockImplementation(async (_key, _remote, localPath) => {
      await writeFile(localPath, Buffer.from("this is not a png"));
    });

    await expect(captureHarmonyScreenshotPng({ connectKey: "dev", scale: 1 })).rejects.toThrow();

    // hdcFileRecv's localPath IS the raw intermediate; it must be gone.
    const rawPath = hdcFileRecv.mock.calls[0]![2];
    expect(rawPath).toContain("argent-harmony-raw-");
    await expect(access(rawPath)).rejects.toThrow();
  });
});
