import { readFile, rename, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { harmonyScreenCap } from "./harmony-uitest";
import { scaleDecodedPng } from "./png-scale";

/**
 * Capture the HarmonyOS display and return the path to a host-side PNG.
 *
 * `uitest screenCap` always writes the panel at full resolution — there is no
 * scale flag — so a Mate 60 frame arrives as a ~250KB 1216x2688 RGBA PNG. The
 * downscale therefore happens here, through the same shared helper Vega uses,
 * so `ARGENT_SCREENSHOT_SCALE` and the 0.3 default mean the same thing on
 * HarmonyOS as everywhere else.
 */
export async function captureHarmonyScreenshotPng(opts: {
  connectKey: string;
  scale?: number;
}): Promise<string> {
  const rawPath = join(tmpdir(), `argent-harmony-raw-${process.hrtime.bigint()}.png`);
  try {
    await harmonyScreenCap(opts.connectKey, rawPath);
    // The decode is the only proof `uitest` captured anything: `hdc` reports the
    // connection's status, not the remote command's, so a failed capture arrives
    // as a successful transfer of a truncated file.
    const decoded = PNG.sync.read(await readFile(rawPath));
    const scaled = scaleDecodedPng(decoded, opts.scale);
    const outPath = join(tmpdir(), `harmony-screenshot-${process.hrtime.bigint()}.png`);
    if (scaled === decoded) {
      // Identity — what screenshot-diff's scale 1.0 asks for. Re-encoding pixels
      // the resample never touched costs ~100ms per 3.7MP frame to reproduce the
      // file `uitest` already wrote, so move that one into place instead.
      // Comparing against the helper's own return, rather than re-deriving the
      // threshold, keeps one definition of which scales resample.
      await rename(rawPath, outPath);
    } else {
      await writeFile(outPath, PNG.sync.write(scaled));
    }
    return outPath;
  } finally {
    await rm(rawPath, { force: true }).catch(() => {});
  }
}
