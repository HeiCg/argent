import { readFile, writeFile, rm } from "node:fs/promises";
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
    const decoded = PNG.sync.read(await readFile(rawPath));
    const scaled = scaleDecodedPng(decoded, opts.scale);
    const outPath = join(tmpdir(), `harmony-screenshot-${process.hrtime.bigint()}.png`);
    await writeFile(outPath, PNG.sync.write(scaled));
    return outPath;
  } finally {
    await rm(rawPath, { force: true }).catch(() => {});
  }
}
