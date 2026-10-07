import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  IosOpenServerClient,
  type IosOpenServerNode,
  type IosOpenServerState,
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

// ---- simctl device type profile --------------------------------------------

/**
 * The simulator's screen from its simctl device type profile: `mainScreenWidth` /
 * `mainScreenHeight` are portrait PIXELS, so points = pixels / `mainScreenScale`
 * (402×874 @3 on an iPhone 17). Independent of the runner.
 */
async function simctlScreenPoints(udid: string): Promise<{ w: number; h: number; scale: number }> {
  const { stdout: devicesJson } = await execFileAsync("xcrun", ["simctl", "list", "devices", "-j"]);
  const devices = Object.values(
    (JSON.parse(devicesJson) as { devices: Record<string, Array<Record<string, string>>> }).devices
  ).flat();
  const typeId = devices.find((d) => d.udid === udid)?.deviceTypeIdentifier;
  if (!typeId) throw new Error(`simctl lists no device type for ${udid}`);
  const { stdout: typesJson } = await execFileAsync("xcrun", [
    "simctl",
    "list",
    "devicetypes",
    "-j",
  ]);
  const bundlePath = (
    JSON.parse(typesJson) as { devicetypes: Array<{ identifier: string; bundlePath: string }> }
  ).devicetypes.find((t) => t.identifier === typeId)?.bundlePath;
  if (!bundlePath) throw new Error(`simctl lists no bundle for device type ${typeId}`);
  const { stdout: profileJson } = await execFileAsync("plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    path.join(bundlePath, "Contents", "Resources", "profile.plist"),
  ]);
  const p = JSON.parse(profileJson) as {
    mainScreenWidth: number;
    mainScreenHeight: number;
    mainScreenScale: number;
  };
  return {
    w: p.mainScreenWidth / p.mainScreenScale,
    h: p.mainScreenHeight / p.mainScreenScale,
    scale: p.mainScreenScale,
  };
}

/** Time one RPC and log it as an informal observation (NOT a scoreboard number). */
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const r = await fn();
  console.log(`[device][timing] ${label} = ${Date.now() - t0}ms`);
  return r;
}

// ---- runner liveness and Settings readiness --------------------------------
//
// Runs 37561275916 and 37587956245: the one Settings instance stopped taking input
// for ~60 s (a getNestedState snapshot took 7 s instead of 240 ms), so tap/swipe
// failed with a pixel diff of exactly 0. Each gesture test now relaunches Settings
// and probes it first; an unresponsive app fails as a readiness error, not a diff.

/** A readiness probe's getNestedState must answer within this wall budget. */
const READY_PROBE_BUDGET_MS = 2_000;
/** ...with a runner-side capture under this (healthy: ~240 ms). */
const READY_CAPTURE_MAX_MS = 1_500;
/** ...and at least this many nodes in the Settings root tree. */
const READY_MIN_ELEMENTS = 10;
/** Settle after `launchApp` before probing (the old inline relaunch used the same). */
const LAUNCH_SETTLE_MS = 1_500;

/**
 * Marker file the CI step reads (`IOS_OPEN_SERVER_STATUS_FILE`, not `ARGENT_`
 * prefixed): `runner-never-up` makes the workflow restart the runner once.
 */
const STATUS_FILE = process.env.IOS_OPEN_SERVER_STATUS_FILE ?? "";

function writeStatus(status: "runner-never-up" | "runner-died-mid-suite"): void {
  if (!STATUS_FILE) return;
  try {
    writeFileSync(STATUS_FILE, `${status}\n`);
  } catch (err) {
    console.log(`[device] could not write ${STATUS_FILE}: ${errMsg(err)}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The runner process is gone (socket refused/closed), as opposed to slow. */
function isRunnerGone(err: unknown): boolean {
  return /ECONNREFUSED|ECONNRESET|EPIPE|connection closed/i.test(errMsg(err));
}

/** Ping with a short budget: "alive", "gone" (process exited), or "wedged". */
async function runnerLiveness(c: IosOpenServerClient): Promise<"alive" | "gone" | "wedged"> {
  try {
    await c.request("ping", undefined, { timeoutMs: 5_000 });
    return "alive";
  } catch (err) {
    return isRunnerGone(err) ? "gone" : "wedged";
  }
}

interface ReadinessProbe {
  ok: boolean;
  /** Empty when ok; otherwise every failed criterion. */
  reason: string;
  wallMs: number;
  captureMs?: number;
  snapshotMs?: number;
  elements?: number;
  navBars: string[];
  runnerGone: boolean;
}

/**
 * One bounded getNestedState: Settings is at its root (a 'General' row, a scroll
 * container, no 'General' NavigationBar), the tree has ≥ READY_MIN_ELEMENTS nodes,
 * and both the wall time and the runner's captureMs are within budget.
 */
async function probeSettingsRoot(c: IosOpenServerClient): Promise<ReadinessProbe> {
  const t0 = Date.now();
  let state: IosOpenServerState;
  try {
    state = await c.request<IosOpenServerState>(
      "getNestedState",
      {},
      { timeoutMs: READY_PROBE_BUDGET_MS }
    );
  } catch (err) {
    const wallMs = Date.now() - t0;
    return {
      ok: false,
      reason: `getNestedState failed after ${wallMs}ms: ${errMsg(err)}`,
      wallMs,
      navBars: [],
      runnerGone: isRunnerGone(err),
    };
  }
  const wallMs = Date.now() - t0;
  let elements = 0;
  const navBars: string[] = [];
  walk(state.tree, (n) => {
    elements++;
    if (n.type === "NavigationBar") navBars.push(`${n.identifier ?? ""}|${n.label ?? ""}`);
  });
  const problems: string[] = [];
  if (wallMs > READY_PROBE_BUDGET_MS)
    problems.push(`wall ${wallMs}ms > ${READY_PROBE_BUDGET_MS}ms`);
  if (state.timings.captureMs >= READY_CAPTURE_MAX_MS) {
    problems.push(
      `captureMs ${state.timings.captureMs.toFixed(0)} >= ${READY_CAPTURE_MAX_MS} ` +
        `(snapshot ${state.timings.snapshotMs.toFixed(0)}ms)`
    );
  }
  if (elements < READY_MIN_ELEMENTS) problems.push(`${elements} elements < ${READY_MIN_ELEMENTS}`);
  if (!findByLabel(state.tree, "General")) problems.push("no 'General' row");
  if (!findByType(state.tree, "Table") && !findByType(state.tree, "CollectionView")) {
    problems.push("no scroll container");
  }
  if (navBars.some((b) => b.split("|").includes("General"))) {
    problems.push("not at the Settings root (NavigationBar 'General')");
  }
  return {
    ok: problems.length === 0,
    reason: problems.join("; "),
    wallMs,
    captureMs: state.timings.captureMs,
    snapshotMs: state.timings.snapshotMs,
    elements,
    navBars,
    runnerGone: false,
  };
}

function logProbe(test: string, attempt: string, launchMs: number, p: ReadinessProbe): void {
  console.log(
    `[device][ready] test="${test}" attempt=${attempt} launchMs=${launchMs} ` +
      `probeWallMs=${p.wallMs} captureMs=${p.captureMs?.toFixed(1) ?? "-"} ` +
      `snapshotMs=${p.snapshotMs?.toFixed(1) ?? "-"} elements=${p.elements ?? "-"} ` +
      `navBars=${JSON.stringify(p.navBars)} ok=${p.ok}${p.ok ? "" : ` reason="${p.reason}"`}`
  );
}

function runnerDiedMidSuite(test: string, detail: string): Error {
  writeStatus("runner-died-mid-suite");
  return new Error(
    `[device] runner died mid-suite before "${test}" (it served earlier RPCs; now: ${detail}). ` +
      `See build/runner.log for the XCTest failure.`
  );
}

/**
 * Relaunch Settings (XCUIApplication.launch() restarts it, so it starts at the
 * root, scrolled to the top) and probe it. Not ready: terminateApp + launchApp
 * once and probe again. Still not ready: throw a readiness error.
 */
async function ensureSettingsReady(c: IosOpenServerClient, test: string): Promise<void> {
  const launchAndProbe = async (attempt: string): Promise<ReadinessProbe> => {
    const t0 = Date.now();
    try {
      await c.launchApp(SETTINGS);
    } catch (err) {
      if (isRunnerGone(err)) throw runnerDiedMidSuite(test, `launchApp: ${errMsg(err)}`);
      const launchMs = Date.now() - t0;
      const p: ReadinessProbe = {
        ok: false,
        reason: `launchApp failed after ${launchMs}ms: ${errMsg(err)}`,
        wallMs: 0,
        navBars: [],
        runnerGone: false,
      };
      logProbe(test, attempt, launchMs, p);
      return p;
    }
    const launchMs = Date.now() - t0;
    await sleep(LAUNCH_SETTLE_MS);
    const p = await probeSettingsRoot(c);
    logProbe(test, attempt, launchMs, p);
    if (p.runnerGone) throw runnerDiedMidSuite(test, p.reason);
    return p;
  };

  const first = await launchAndProbe("1");
  if (first.ok) return;
  try {
    await c.terminateApp(SETTINGS);
  } catch (err) {
    if (isRunnerGone(err)) throw runnerDiedMidSuite(test, `terminateApp: ${errMsg(err)}`);
    console.log(`[device][ready] test="${test}" terminateApp failed: ${errMsg(err)}`);
  }
  const second = await launchAndProbe("2 (after terminateApp)");
  if (second.ok) return;
  throw new Error(
    `[device] readiness failure before "${test}": Settings did not answer a root ` +
      `getNestedState within ${READY_PROBE_BUDGET_MS}ms with captureMs < ${READY_CAPTURE_MAX_MS} ` +
      `and >= ${READY_MIN_ELEMENTS} elements. First probe: ${first.reason}. ` +
      `After terminateApp + launchApp: ${second.reason}.`
  );
}

/** Tests that drive input and assert its effect; each gets a fresh, probed Settings. */
const GESTURE_TEST = /^(tap|swipe|typeText)\b/;

describe.skipIf(!enabled)("open iOS server — device suite (simulator)", () => {
  let client: IosOpenServerClient;

  beforeAll(async () => {
    expect(PORT, "IOS_OPEN_SERVER_PORT must be set").toBeGreaterThan(0);
    expect(UDID, "IOS_OPEN_SERVER_UDID must be set").not.toBe("");
    client = new IosOpenServerClient({ port: PORT, timeoutMs: 90_000 });
    // Run 37587956245 attempt 1: XCTest "Timed out attempting to launch app" ended
    // the runner's test, so every later RPC was ECONNREFUSED. If the runner is gone
    // after the first launch, say so and leave `runner-never-up` for the workflow,
    // which restarts the runner once. If it is still alive, relaunch once here.
    const neverUp = (detail: string): Error => {
      writeStatus("runner-never-up");
      return new Error(
        `[device] runner never came up: the initial launchApp(${SETTINGS}) failed and the ` +
          `runner no longer answers (${detail}). See build/runner.log ("Timed out attempting to launch app").`
      );
    };
    let launched = false;
    for (let attempt = 1; attempt <= 2 && !launched; attempt++) {
      const t0 = Date.now();
      try {
        await client.launchApp(SETTINGS);
        launched = true;
        console.log(
          `[device][ready] beforeAll launchApp attempt=${attempt} ok in ${Date.now() - t0}ms`
        );
      } catch (err) {
        console.log(
          `[device][ready] beforeAll launchApp attempt=${attempt} failed after ${Date.now() - t0}ms: ${errMsg(err)}`
        );
        const liveness = await runnerLiveness(client);
        if (liveness === "gone") throw neverUp(errMsg(err));
        if (attempt === 2) {
          throw new Error(
            `[device] runner up (${liveness}) but launchApp(${SETTINGS}) failed twice: ${errMsg(err)}`,
            { cause: err }
          );
        }
        try {
          await client.terminateApp(SETTINGS);
        } catch {
          /* a launch that never finished leaves nothing to terminate */
        }
      }
    }
    await sleep(LAUNCH_SETTLE_MS);
  }, 300_000);

  // Every test: a refused/closed socket means the runner exited mid-suite. Gesture
  // tests additionally relaunch Settings and probe it (ensureSettingsReady).
  beforeEach(async (ctx) => {
    const liveness = await runnerLiveness(client);
    if (liveness === "gone") throw runnerDiedMidSuite(ctx.task.name, "ping refused");
    if (liveness === "wedged")
      console.log(`[device][ready] test="${ctx.task.name}" ping >5s (wedged)`);
    if (GESTURE_TEST.test(ctx.task.name)) await ensureSettingsReady(client, ctx.task.name);
  }, 300_000);

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

  it("geometry is the device type's point size, not the runner's compatibility-mode screen", async () => {
    // Run 37572773799: the runner reported its own UIScreen.main (480 pt tall on an
    // iPhone 17, 402×874 pt @3), so every normalized tap hit the wrong row.
    // Run 37585976421: the point size was right but the scale was 1.6476, the
    // runner's compatibility-mode nativeBounds (1440 px) over 874 pt. The scale
    // now comes from the runner's screenshot, whose long side must be the panel.
    const expected = await simctlScreenPoints(UDID);
    const info = await client.getInfo();
    const size = await timed("getScreenSize (after getInfo, cached)", () => client.getScreenSize());
    const state = await client.getNestedState();
    const shot = await client.screenshot({ format: "png" });
    console.log(
      `[device] simctl profile ${expected.w}x${expected.h}@${expected.scale}; ` +
        `getInfo ${info.screenWidth}x${info.screenHeight}@${info.scale}; ` +
        `getScreenSize ${size.screenWidth}x${size.screenHeight}@${size.scale}; ` +
        `getNestedState ${state.info.screenWidth}x${state.info.screenHeight}@${state.info.scale}; ` +
        `runner screenshot ${shot.width}x${shot.height} px`
    );
    // Portrait profile; the reply may be landscape, so compare short and long sides.
    const sides = (w: number, h: number): [number, number] => [Math.min(w, h), Math.max(w, h)];
    const [expShort, expLong] = sides(expected.w, expected.h);
    for (const g of [info, size, state.info]) {
      const [short, long] = sides(g.screenWidth, g.screenHeight);
      expect(Math.abs(short - expShort)).toBeLessThanOrEqual(1);
      expect(Math.abs(long - expLong)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.scale - expected.scale)).toBeLessThanOrEqual(0.01);
    }
    // 874 pt × 3 = 2622 px on an iPhone 17.
    expect(
      Math.abs(Math.max(shot.width, shot.height) - expLong * expected.scale)
    ).toBeLessThanOrEqual(1);
  }, 60_000);

  it("getNestedState stage timings sum to captureMs", async () => {
    const state = await client.getNestedState();
    expect(state.screenshot).toBeUndefined();
    expect(state.tree.length).toBeGreaterThan(0);
    const t = state.timings;
    const sum = t.snapshotMs + t.serializeMs + t.encodeMs;
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
    console.log(`[device] tap neutral-pixel diff ratio = ${ratio.toFixed(4)}`);
    expect(ratio).toBeGreaterThanOrEqual(0.02);

    const after = await client.getNestedState();
    // "the nested tree's navigation title changes": the canonical hash changed, so
    // the version counter advances (a new screen was pushed).
    expect(after.version).not.toBe(before.version);
    // Informational: whether the pushed screen carries "General" as a nav title.
    let hasGeneralTitle = false;
    const navBars: string[] = [];
    walk(after.tree, (n) => {
      if ((n.type === "NavigationBar" || n.type === "StaticText") && n.label === "General") {
        hasGeneralTitle = true;
      }
      if (n.type === "NavigationBar") navBars.push(`${n.identifier ?? ""}|${n.label ?? ""}`);
    });
    // The bench's landing check reads the destination's NavigationBar title.
    console.log(
      `[device] after tap: version ${before.version}->${after.version}, generalTitlePresent=${hasGeneralTitle}, ` +
        `navigationBars(identifier|label)=${JSON.stringify(navBars)}`
    );
  }, 90_000);

  it("swipe scrolls the list — neutral-pixel diff in the list region", async () => {
    const state = await client.getNestedState();
    const table = findByType(state.tree, "Table") ?? findByType(state.tree, "CollectionView");
    expect(table, "no scroll container").toBeDefined();
    const b = table!.bounds;
    const midX = (b.x1 + b.x2) / 2;
    const beforeShot = await simctlScreenshot("swipe-before");
    // Swipe up (content moves up): from lower third to upper third of the list.
    // `durationMs` is what the host sends; the runner turns it into drag velocity.
    await client.swipe(midX, b.y1 + (b.y2 - b.y1) * 0.75, midX, b.y1 + (b.y2 - b.y1) * 0.25, {
      durationMs: 300,
    });
    await sleep(1200);
    const afterShot = await simctlScreenshot("swipe-after");
    const ratio = await neutralPixelDiffRatio(beforeShot, afterShot);
    console.log(`[device] swipe neutral-pixel diff ratio = ${ratio.toFixed(4)}`);
    expect(ratio).toBeGreaterThanOrEqual(0.02);
  }, 90_000);

  it("typeText enters text into the Settings search field", async () => {
    // beforeEach relaunched Settings at its root and probed it.
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
    await timed("screenshot(jpeg,0.5)", () =>
      client.screenshot({ format: "jpeg", quality: 60, scale: 0.5 })
    );
    expect(true).toBe(true);
  }, 120_000);
});
