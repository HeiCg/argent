import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IosOpenServerClient,
  type IosOpenServerNode,
} from "../../src/utils/ios-open-server-client";

/**
 * Device suite for the open iOS server, run ONLY in CI on a booted simulator
 * (`OPEN_IOS_SERVER_DEVICE_TESTS=1`). The CI workflow builds the runner, launches
 * it against `com.apple.Preferences`, and hands this test the runner port
 * (`IOS_OPEN_SERVER_PORT`) and the simulator UDID (`IOS_OPEN_SERVER_UDID`). These
 * names avoid the `ARGENT_` prefix, which the `clear-argent-env` vitest setup
 * strips before the test module loads.
 *
 * The tap/swipe effect oracle is NEUTRAL PIXELS: `xcrun simctl io <udid>
 * screenshot` before and after, compared as an optical diff ratio (via a small
 * BMP downscale that needs no image library), independent of the runner's own
 * capture path. These are correctness checks, not published numbers.
 */

const execFileAsync = promisify(execFile);

const enabled = process.env.OPEN_IOS_SERVER_DEVICE_TESTS === "1";
// NOTE: these must NOT start with `ARGENT_` — the `clear-argent-env` vitest setup
// deletes every ARGENT_*-prefixed var before this module loads.
const PORT = Number(process.env.IOS_OPEN_SERVER_PORT ?? "0");
const UDID = process.env.IOS_OPEN_SERVER_UDID ?? "";
const SETTINGS = "com.apple.Preferences";

// ---- neutral-pixel diff (BMP, no image lib) -------------------------------

async function simctlScreenshot(tag: string): Promise<string> {
  const file = path.join(os.tmpdir(), `ios-open-dev-${tag}-${Date.now()}.png`);
  await execFileAsync("xcrun", ["simctl", "io", UDID, "screenshot", file]);
  return file;
}

/** Downscale a PNG to a small 24-bit BMP (longest side 200) via `sips`. */
async function toBmp(png: string): Promise<Buffer> {
  const bmp = png.replace(/\.png$/, ".bmp");
  await execFileAsync("sips", ["-s", "format", "bmp", "-Z", "200", png, "--out", bmp]);
  return readFileSync(bmp);
}

interface Bmp {
  width: number;
  height: number;
  data: Buffer;
  stride: number;
  offset: number;
  bpp: number;
}

/** Parse an uncompressed 24- or 32-bit BMP (both are `sips`'s bmp outputs). */
function parseBmp(buf: Buffer): Bmp {
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  const bpp = buf.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) throw new Error(`expected 24/32-bit BMP, got ${bpp}`);
  const bytesPerPixel = bpp / 8;
  const stride = Math.floor((width * bytesPerPixel + 3) / 4) * 4;
  return { width, height, data: buf, stride, offset, bpp };
}

/** Fraction of pixels that differ by more than `threshold` on any channel. */
async function neutralPixelDiffRatio(pngA: string, pngB: string, threshold = 14): Promise<number> {
  const a = parseBmp(await toBmp(pngA));
  const b = parseBmp(await toBmp(pngB));
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const bppA = a.bpp / 8;
  const bppB = b.bpp / 8;
  let changed = 0;
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = a.offset + y * a.stride + x * bppA;
      const ib = b.offset + y * b.stride + x * bppB;
      const d =
        Math.abs(a.data[ia]! - b.data[ib]!) +
        Math.abs(a.data[ia + 1]! - b.data[ib + 1]!) +
        Math.abs(a.data[ia + 2]! - b.data[ib + 2]!);
      if (d > threshold * 3) changed++;
      total++;
    }
  }
  return total === 0 ? 0 : changed / total;
}

// ---- tree helpers ----------------------------------------------------------

function walk(nodes: IosOpenServerNode[], fn: (n: IosOpenServerNode) => void): void {
  for (const n of nodes) {
    fn(n);
    walk(n.children, fn);
  }
}

function findByLabel(nodes: IosOpenServerNode[], label: string): IosOpenServerNode | undefined {
  let hit: IosOpenServerNode | undefined;
  walk(nodes, (n) => {
    if (!hit && n.label === label) hit = n;
  });
  return hit;
}

function findByType(nodes: IosOpenServerNode[], type: string): IosOpenServerNode | undefined {
  let hit: IosOpenServerNode | undefined;
  walk(nodes, (n) => {
    if (!hit && n.type === type) hit = n;
  });
  return hit;
}

function center(n: IosOpenServerNode): { x: number; y: number } {
  return { x: (n.bounds.x1 + n.bounds.x2) / 2, y: (n.bounds.y1 + n.bounds.y2) / 2 };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Time one RPC and log it as an informal observation (NOT a scoreboard number). */
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const r = await fn();
  // eslint-disable-next-line no-console
  console.log(`[device][timing] ${label} = ${Date.now() - t0}ms`);
  return r;
}

describe.skipIf(!enabled)("open iOS server — device suite (simulator)", () => {
  let client: IosOpenServerClient;

  beforeAll(async () => {
    expect(PORT, "IOS_OPEN_SERVER_PORT must be set").toBeGreaterThan(0);
    expect(UDID, "IOS_OPEN_SERVER_UDID must be set").not.toBe("");
    client = new IosOpenServerClient({ port: PORT, timeoutMs: 90_000 });
    await client.launchApp(SETTINGS);
    await sleep(1500);
  }, 120_000);

  afterAll(async () => {
    try {
      await client.shutdown();
    } catch {
      /* ignore */
    }
    client?.close();
  });

  it("ping answers", async () => {
    expect(await client.ping()).toEqual({ status: "ok" });
  }, 30_000);

  it("getInfo reports Settings, geometry and orientation without a screenshot", async () => {
    const info = await client.getInfo();
    expect(info.bundleId).toBe(SETTINGS);
    expect(info.screenWidth).toBeGreaterThan(0);
    expect(info.screenHeight).toBeGreaterThan(0);
    expect(info.scale).toBeGreaterThanOrEqual(1);
    expect(["portrait", "landscape"]).toContain(info.orientation);
  }, 30_000);

  it("getNestedState stage timings sum to captureMs", async () => {
    const state = await client.getNestedState();
    expect(state.screenshot).toBeUndefined();
    expect(state.tree.length).toBeGreaterThan(0);
    const t = state.timings;
    const sum = t.snapshotMs + t.serializeMs + t.encodeMs;
    // eslint-disable-next-line no-console
    console.log(
      `[device] getNestedState stages: snapshot=${t.snapshotMs.toFixed(1)} serialize=${t.serializeMs.toFixed(1)} ` +
        `encode=${t.encodeMs.toFixed(1)} sum=${sum.toFixed(1)} capture=${t.captureMs.toFixed(1)}`
    );
    // captureMs spans exactly the three stages, so the sum tracks it closely.
    expect(Math.abs(sum - t.captureMs)).toBeLessThanOrEqual(Math.max(5, t.captureMs * 0.3));
  }, 60_000);

  it("tap on 'General' navigates — neutral-pixel diff ≥ 2% and the tree title changes", async () => {
    const before = await client.getNestedState();
    const general = findByLabel(before.tree, "General");
    expect(general, "no 'General' row in Settings").toBeDefined();
    const beforeShot = await simctlScreenshot("tap-before");

    const c = center(general!);
    await client.tap(c.x, c.y);
    await sleep(1200);

    const afterShot = await simctlScreenshot("tap-after");
    const ratio = await neutralPixelDiffRatio(beforeShot, afterShot);
    // eslint-disable-next-line no-console
    console.log(`[device] tap neutral-pixel diff ratio = ${ratio.toFixed(4)}`);
    expect(ratio).toBeGreaterThanOrEqual(0.02);

    const after = await client.getNestedState();
    // The pushed General screen carries "General" as a navigation-bar title; the
    // version counter advances because the canonical hash changed.
    expect(after.version).not.toBe(before.version);
    const hasGeneralTitle = (() => {
      let found = false;
      walk(after.tree, (n) => {
        if (n.type === "NavigationBar" || n.type === "StaticText") {
          if (n.label === "General") found = true;
        }
      });
      return found;
    })();
    expect(hasGeneralTitle).toBe(true);
  }, 90_000);

  it("swipe scrolls the list — neutral-pixel diff in the list region", async () => {
    const state = await client.getNestedState();
    const table = findByType(state.tree, "Table") ?? findByType(state.tree, "CollectionView");
    expect(table, "no scroll container").toBeDefined();
    const b = table!.bounds;
    const midX = (b.x1 + b.x2) / 2;
    const beforeShot = await simctlScreenshot("swipe-before");
    // Swipe up (content moves up): from lower third to upper third of the list.
    await client.swipe(midX, b.y1 + (b.y2 - b.y1) * 0.75, midX, b.y1 + (b.y2 - b.y1) * 0.25, { steps: 12 });
    await sleep(1200);
    const afterShot = await simctlScreenshot("swipe-after");
    const ratio = await neutralPixelDiffRatio(beforeShot, afterShot);
    // eslint-disable-next-line no-console
    console.log(`[device] swipe neutral-pixel diff ratio = ${ratio.toFixed(4)}`);
    expect(ratio).toBeGreaterThanOrEqual(0.02);
  }, 90_000);

  it("typeText enters text into the Settings search field", async () => {
    // Return to the Settings root.
    await client.launchApp(SETTINGS);
    await sleep(1500);
    // iOS hides the search bar just above the first row; a downward swipe at the
    // top reveals it so its element is on-screen and hittable.
    const s0 = await client.getNestedState();
    const table = findByType(s0.tree, "Table") ?? findByType(s0.tree, "CollectionView");
    if (table) {
      const midX = (table.bounds.x1 + table.bounds.x2) / 2;
      await client.swipe(midX, table.bounds.y1 + 40, midX, table.bounds.y1 + 260, { steps: 8 });
      await sleep(900);
    }
    const state = await client.getNestedState();
    const search = findByType(state.tree, "SearchField");
    expect(search, "no SearchField in the Settings tree").toBeDefined();
    const c = center(search!);
    await client.tap(c.x, c.y);
    await sleep(900);
    const res = await client.typeText("General");
    expect(res.success).toBe(true);
    expect(res.charsTyped).toBe("General".length);
  }, 90_000);

  it("screenshot returns png and half-scale jpeg", async () => {
    const png = await client.screenshot({ format: "png" });
    expect(png.mimeType).toBe("image/png");
    expect(png.data.length).toBeGreaterThan(0);
    const jpeg = await client.screenshot({ format: "jpeg", quality: 60, scale: 0.5 });
    expect(jpeg.mimeType).toBe("image/jpeg");
    expect(jpeg.width).toBeLessThan(png.width);
    expect(jpeg.height).toBeLessThan(png.height);
  }, 60_000);

  it("launchApp and terminateApp round-trip", async () => {
    const launched = await client.launchApp(SETTINGS);
    expect(launched.success).toBe(true);
    expect(launched.bundleId).toBe(SETTINGS);
    const terminated = await client.terminateApp(SETTINGS);
    expect(terminated.success).toBe(true);
    // Relaunch so shutdown in afterAll has a clean target.
    await client.launchApp(SETTINGS);
  }, 90_000);

  it("informal per-RPC timings (observations, NOT scoreboard numbers)", async () => {
    await client.launchApp(SETTINGS);
    await sleep(1200);
    await timed("ping", () => client.ping());
    await timed("getScreenSize", () => client.getScreenSize());
    await timed("getInfo", () => client.getInfo());
    const state = await timed("getNestedState", () => client.getNestedState());
    // eslint-disable-next-line no-console
    console.log(
      `[device][timing] getNestedState stages: snapshot=${state.timings.snapshotMs.toFixed(1)} ` +
        `serialize=${state.timings.serializeMs.toFixed(1)} encode=${state.timings.encodeMs.toFixed(1)} ` +
        `capture=${state.timings.captureMs.toFixed(1)} nodes=${state.tree.length}`
    );
    const root = state.tree[0];
    const target = root && root.children[0] ? center(root.children[0]) : { x: 40, y: 120 };
    await timed("tap", () => client.tap(target.x, target.y));
    await sleep(600);
    await timed("swipe", () => client.swipe(target.x, 500, target.x, 200, { steps: 10 }));
    await sleep(600);
    await timed("screenshot(png)", () => client.screenshot({ format: "png" }));
    await timed("screenshot(jpeg,0.5)", () => client.screenshot({ format: "jpeg", quality: 60, scale: 0.5 }));
    expect(true).toBe(true);
  }, 120_000);
});
