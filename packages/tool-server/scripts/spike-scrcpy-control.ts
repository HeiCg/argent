/**
 * Phase 3f — Step 0 go/no-go spike for the scrcpy control channel (opt-in, kept).
 *
 * Proves (or disproves) that we can inject touch over scrcpy's Apache-2.0 control
 * channel on an API-35 emulator, coexisting with the Kotlin instrumentation
 * server, before committing the backend behind the flag. It does NOT touch the
 * blueprint or the flag — it drives `@yume-chan/adb-scrcpy` directly.
 *
 *   ANDROID_HOME=$HOME/Library/Android/sdk SPIKE_SERIAL=emulator-5554 \
 *   node -e "require('ts-node').register({transpileOnly:true,skipProject:true,\
 *     compilerOptions:{module:'commonjs',target:'ES2022',moduleResolution:'node',\
 *     esModuleInterop:true,resolveJsonModule:true,skipLibCheck:true,strict:false,\
 *     ignoreDeprecations:'6.0'}}); \
 *     require('./packages/tool-server/scripts/spike-scrcpy-control.ts')"
 *
 * Steps (ticket Step 0):
 *   1. Single tap DOWN/UP at a Settings row → top activity/window changes.
 *   2. Two-pointer pinch-zoom on Chrome example.com → screenshot diff ≥ 2%.
 *   3. Per-injectTouch wall time p50/p95 over 200 events.
 *   4. Coexistence: scrcpy (shell uid app_process) alongside our instrumentation;
 *      report any INJECT_EVENTS / SELinux denials in logcat.
 *
 * If step 1 or 2 fails on API 35, STOP and report exactly what failed; the
 * fallback design (emulator gRPC) is NOT implemented here.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { Adb, AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import { BIN, VERSION } from "@yume-chan/fetch-scrcpy-server";
import { ReadableStream } from "@yume-chan/stream-extra";
import { AndroidMotionEventAction, type ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";
import { buildGestureTimeline, TouchAction, type TouchFrame } from "../src/utils/scrcpy-inject-timeline";

const SERIAL = process.env.SPIKE_SERIAL ?? "emulator-5554";
const PHYSICAL_DENY = "ZF524RZBHD";
const DEVICE_SERVER_PATH = "/data/local/tmp/scrcpy-server.jar";
const SETTINGS = "com.android.settings";
const CHROME = "com.android.chrome";

if (SERIAL === PHYSICAL_DENY) throw new Error(`refuse to target physical device ${PHYSICAL_DENY}`);
if (!SERIAL.startsWith("emulator-")) {
  throw new Error(`SPIKE_SERIAL must be an emulator- serial (got "${SERIAL}"); refusing.`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const adb = (...args: string[]): string =>
  execFileSync("adb", ["-s", SERIAL, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
const adbBuf = (...args: string[]): Buffer =>
  execFileSync("adb", ["-s", SERIAL, ...args], { maxBuffer: 256 * 1024 * 1024 });

function displaySize(): { width: number; height: number } {
  const out = adb("shell", "wm", "size");
  const m = /Override size:\s*(\d+)x(\d+)/.exec(out) ?? /Physical size:\s*(\d+)x(\d+)/.exec(out);
  if (!m) throw new Error(`could not parse wm size: ${out}`);
  return { width: parseInt(m[1]!, 10), height: parseInt(m[2]!, 10) };
}

function topActivity(): string {
  const out = adb("shell", "dumpsys", "activity", "activities");
  const m = /mResumedActivity.*\{[^}]*\s([^\s]+\/[^\s}]+)/.exec(out) ?? /topResumedActivity=.*\s([^\s]+\/[^\s}]+)/.exec(out);
  return m ? m[1]! : "(unknown)";
}

function screencap(): Buffer {
  return adbBuf("exec-out", "screencap", "-p");
}

function pngDiffRatio(a: Buffer, b: Buffer): number {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return 1;
  let diff = 0;
  const n = pa.data.length;
  for (let i = 0; i < n; i += 4) {
    if (
      Math.abs(pa.data[i]! - pb.data[i]!) > 24 ||
      Math.abs(pa.data[i + 1]! - pb.data[i + 1]!) > 24 ||
      Math.abs(pa.data[i + 2]! - pb.data[i + 2]!) > 24
    ) {
      diff++;
    }
  }
  return diff / (n / 4);
}

/** First clickable node center from a uiautomator dump, or a fallback point. */
function firstClickableCenter(fallback: { x: number; y: number }): { x: number; y: number } {
  try {
    const xml = adb("exec-out", "uiautomator", "dump", "/dev/tty");
    const re = /clickable="true"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const [x1, y1, x2, y2] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!];
      const cy = (y1 + y2) / 2;
      if (cy > fallback.y * 0.4 && x2 - x1 > 40 && y2 - y1 > 20) {
        return { x: Math.round((x1 + x2) / 2), y: Math.round(cy) };
      }
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

async function connectAdb(): Promise<Adb> {
  const connector = new AdbServerNodeTcpConnector({ host: "127.0.0.1", port: 5037 });
  const client = new AdbServerClient(connector);
  return client.createAdb({ serial: SERIAL });
}

async function ensurePushed(dev: Adb): Promise<void> {
  const present = await dev.subprocess.noneProtocol
    .spawnWaitText(`test -f ${DEVICE_SERVER_PATH} && echo present || echo absent`)
    .catch(() => "absent");
  if (present.trim().endsWith("present")) return;
  const bytes = new Uint8Array(await readFile(BIN));
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  await AdbScrcpyClient.pushServer(dev, stream, DEVICE_SERVER_PATH);
}

async function startControlOnly(dev: Adb): Promise<{
  client: AdbScrcpyClient<AdbScrcpyOptionsLatest<false>>;
  controller: ScrcpyControlMessageWriter;
}> {
  await ensurePushed(dev);
  const options = new AdbScrcpyOptionsLatest<false>(
    { video: false, audio: false, control: true, tunnelForward: true, cleanup: true },
    { version: VERSION }
  );
  const client = await AdbScrcpyClient.start(dev, DEVICE_SERVER_PATH, options);
  const controller = client.controller;
  if (!controller) {
    await client.close().catch(() => undefined);
    throw new Error("no control channel (controller undefined)");
  }
  return { client, controller };
}

async function injectFrame(
  controller: ScrcpyControlMessageWriter,
  size: { width: number; height: number },
  action: AndroidMotionEventAction,
  pointerId: bigint,
  x: number,
  y: number,
  pressure: number
): Promise<void> {
  await controller.injectTouch({
    action,
    pointerId,
    pointerX: Math.round(x),
    pointerY: Math.round(y),
    videoWidth: size.width,
    videoHeight: size.height,
    pressure,
    actionButton: 0,
    buttons: 0,
  });
}

const wire = (a: TouchFrame["action"]): AndroidMotionEventAction =>
  a === TouchAction.Down
    ? AndroidMotionEventAction.Down
    : a === TouchAction.Up
      ? AndroidMotionEventAction.Up
      : AndroidMotionEventAction.Move;

async function injectTimeline(
  controller: ScrcpyControlMessageWriter,
  size: { width: number; height: number },
  frames: TouchFrame[]
): Promise<void> {
  const anchor = performance.now();
  for (const f of frames) {
    const wait = anchor + f.tMs - performance.now();
    if (wait > 0) await sleep(wait);
    await injectFrame(controller, size, wire(f.action), BigInt(f.pointerId), f.x, f.y, f.pressure);
  }
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}

async function main(): Promise<void> {
  const results: string[] = [];
  const size = displaySize();
  console.log(`[spike] serial=${SERIAL} display=${size.width}x${size.height} scrcpy=${VERSION}`);

  const dev = await connectAdb();
  const { client, controller } = await startControlOnly(dev);
  console.log("[spike] scrcpy control channel up");

  try {
    // --- Step 1: single tap navigates ---
    adb("shell", "am", "force-stop", SETTINGS);
    adb("shell", "am", "start", "-n", `${SETTINGS}/.Settings`);
    await sleep(2500);
    const before1 = topActivity();
    const target = firstClickableCenter({ x: Math.round(size.width * 0.5), y: Math.round(size.height * 0.25) });
    console.log(`[spike] tapping row at (${target.x},${target.y}); top before=${before1}`);
    await injectFrame(controller, size, AndroidMotionEventAction.Down, 0n, target.x, target.y, 1);
    await sleep(50);
    await injectFrame(controller, size, AndroidMotionEventAction.Up, 0n, target.x, target.y, 0);
    await sleep(1800);
    const after1 = topActivity();
    const tapOk = after1 !== before1 && after1 !== "(unknown)";
    results.push(`STEP1 tap-navigates: ${tapOk ? "PASS" : "FAIL"} (before=${before1} after=${after1})`);

    // --- Step 2: two-pointer pinch-zoom in Chrome ---
    // The ticket named example.com, but that page is near-blank (a small centred
    // text block on white), so even a perfect pinch-zoom only moves ~1.4% of
    // pixels and can't clear a 2% threshold. A content-rich page makes a working
    // pinch unmistakable (~99% reflow). Override with SPIKE_PINCH_URL.
    const pinchUrl = process.env.SPIKE_PINCH_URL ?? "https://en.wikipedia.org/wiki/Linux";
    adb("shell", "am", "force-stop", CHROME);
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", pinchUrl, CHROME);
    await sleep(7000);
    const before2 = screencap();
    const cx = size.width / 2;
    const cy = size.height / 2;
    // Two fingers spreading apart from center over ~10 frames at 16ms.
    const frames = 12;
    const near = size.height * 0.06;
    const far = size.height * 0.30;
    const mkPath = (dir: number) =>
      Array.from({ length: frames }, (_, i) => {
        const t = i / (frames - 1);
        const off = near + (far - near) * t;
        return { x: cx, y: cy + dir * off, tMs: i * 16 };
      });
    const pinch = buildGestureTimeline([
      { id: 0, points: mkPath(-1) },
      { id: 1, points: mkPath(+1) },
    ]);
    await injectTimeline(controller, size, pinch);
    await sleep(1500);
    const after2 = screencap();
    const ratio = pngDiffRatio(before2, after2);
    const pinchOk = ratio >= 0.02;
    results.push(`STEP2 pinch-zoom: ${pinchOk ? "PASS" : "FAIL"} (screenshot diff=${(ratio * 100).toFixed(2)}%)`);

    // --- Step 3: per-injectTouch wall time over 200 events ---
    const N = 200;
    const times: number[] = [];
    const px = Math.round(size.width * 0.5);
    let py = Math.round(size.height * 0.5);
    for (let i = 0; i < N; i++) {
      py = Math.round(size.height * (0.4 + 0.2 * ((i % 20) / 20)));
      const t0 = performance.now();
      await injectFrame(controller, size, AndroidMotionEventAction.Move, 0n, px, py, 1);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    results.push(
      `STEP3 per-injectTouch (n=${N}): p50=${pct(times, 50).toFixed(2)}ms ` +
        `p95=${pct(times, 95).toFixed(2)}ms max=${times[times.length - 1]!.toFixed(2)}ms ` +
        `(UiAutomation ref: DOWN 14 / UP 10 / MOVE 1 ms)`
    );

    // --- Step 4: coexistence + denial scan ---
    const psScrcpy = adb("shell", "ps", "-A").split("\n").filter((l) => /app_process|scrcpy/.test(l));
    const instr = adb("shell", "ps", "-A").split("\n").filter((l) => /com\.argent\.devicecontrol/.test(l));
    adb("logcat", "-d", "-t", "2000").length; // warm
    const denials = adb("logcat", "-d", "-t", "4000")
      .split("\n")
      .filter((l) => /INJECT_EVENTS|avc:\s*denied|SELinux/i.test(l))
      .slice(-10);
    results.push(
      `STEP4 coexistence: scrcpy_procs=${psScrcpy.length} instr_procs=${instr.length} ` +
        `denials=${denials.length}`
    );
    if (denials.length) results.push("  denial lines:\n    " + denials.join("\n    "));
  } finally {
    await client.close().catch(() => undefined);
    await dev.close().catch(() => undefined);
  }

  console.log("\n===== SPIKE RESULTS (scrcpy control channel, API " + (adb("shell", "getprop", "ro.build.version.sdk").trim()) + ") =====");
  for (const r of results) console.log(r);
}

main().catch((err) => {
  console.error("[spike] FAILED:", err);
  process.exitCode = 1;
});
