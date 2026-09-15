/**
 * iOS-4 sim-input discriminating test (review 2026-09-15-review-ios2-findings.md,
 * "The one discriminating test for iOS-4"). A SHORT, ON-siminput-only macOS job
 * — no OFF arms, no describe/swipe loops — that answers whether the sim-input
 * landing failure is HID recogniser TIMING (fixable by the hold + event
 * timestamps) or a DELIVERY recipe that iOS 26.5 never consumes as a tap.
 *
 * Method: locate the target ONCE, FREEZE the coordinate, then for each hold cell
 * run 20 sim-input taps from a fresh Settings root, recording per tap the MAXIMUM
 * neutral-pixel diff ratio (a NUMBER, not a boolean), the coordinate and the poll
 * index; keep the before/after PNG pair of the highest- and lowest-ratio tap of
 * each cell. A control cell of 20 XCUITest taps at the same frozen coordinate
 * anchors the navigation-ratio scale.
 *
 * Decision rule (applied later, by hand, over the JSON): if the ratio distribution
 * becomes bimodal at ~0.18 and the landing rate rises with hold → recogniser
 * timing (fix the hold + event timestamps); if ratios stay clustered at 0.02–0.06
 * at every hold → the touch is delivered but never consumed as a tap (the event
 * recipe needs a 26.5 revision — the sim-input-depth work).
 *
 * HOLD CONFIGURABILITY (ticket iOS-2.1 item 7): the {0.15, 0.35}s cells need a
 * per-tap hold on the wire. It is NOT available today — `packages/ios-sim-input`
 * stays byte-identical and its `main.swift` `case "tap"` passes `duration: 0`
 * (→ IndigoHIDInput's fixed 0.05s hold); no `hold`/`holdSeconds` field is parsed
 * for a tap (swipe reads `durationMs`, tap does not). So HOLD_CONFIGURABLE_TODAY
 * is false: only the 0.05s cell runs; the longer-hold cells are emitted as
 * SKIPPED with that reason. Making the hold configurable is the iOS-4 Swift change
 * (parse a tap `holdSeconds` in `main.swift` and pass it instead of `duration:0`).
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { createRegistry } from "../src/utils/setup-registry";
import { setFlag } from "@argent/configuration-core";
import { IosOpenServerClient } from "../src/utils/ios-open-server-client";
import { IosSimInputService } from "../src/utils/ios-sim-input-service";

const execFileAsync = promisify(execFile);

const UDID = process.env.BENCH_UDID ?? process.env.IOS_OPEN_SERVER_UDID ?? "";
const RUNNER_PORT = Number(process.env.IOS_OPEN_SERVER_PORT ?? "0");
const TAPS = Number(process.env.DISC_TAPS ?? 20);
const OUT_DIR = process.env.BENCH_OUT ?? join(process.cwd(), ".bench-results");
const SETTINGS = "com.apple.Preferences";
const TARGET_LABEL = process.env.BENCH_TAP_TARGET ?? "General";
const HOLD_CELLS = [0.05, 0.15, 0.35];
// See the header: the sim-input CLI hardcodes the tap hold today.
const HOLD_CONFIGURABLE_TODAY = false;

if (!UDID) throw new Error("BENCH_UDID / IOS_OPEN_SERVER_UDID must be set");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function relaunch(): Promise<void> {
  try {
    execFileSync("xcrun", ["simctl", "terminate", UDID, SETTINGS], {
      stdio: "ignore",
      timeout: 15_000,
    });
  } catch {
    /* not running */
  }
  await sleep(200);
  try {
    execFileSync("xcrun", ["simctl", "launch", UDID, SETTINGS], {
      stdio: "ignore",
      timeout: 15_000,
    });
  } catch {
    /* ignore */
  }
  await sleep(900);
}

let shotSeq = 0;
async function screenshot(tag: string): Promise<string> {
  const file = join(os.tmpdir(), `disc-${tag}-${process.pid}-${shotSeq++}.png`);
  await execFileAsync("xcrun", ["simctl", "io", UDID, "screenshot", file], { timeout: 20_000 });
  return file;
}
function rmShot(...pngs: string[]): void {
  for (const p of pngs) {
    try {
      rmSync(p, { force: true });
      rmSync(p.replace(/\.png$/, ".bmp"), { force: true });
    } catch {
      /* ignore */
    }
  }
}
function persist(src: string, cell: string, name: string): string {
  const dir = join(OUT_DIR, "disc-shots", cell);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
  try {
    copyFileSync(src, dest);
  } catch {
    /* ignore */
  }
  return dest;
}
async function diffRatio(a: string, b: string): Promise<number> {
  const toBmp = async (png: string): Promise<Buffer> => {
    const bmp = png.replace(/\.png$/, ".bmp");
    await execFileAsync("sips", ["-s", "format", "bmp", "-Z", "160", png, "--out", bmp], {
      timeout: 20_000,
    });
    return readFileSync(bmp);
  };
  const read = (
    buf: Buffer
  ): { w: number; h: number; off: number; stride: number; bpp: number } => {
    const off = buf.readUInt32LE(10);
    const w = buf.readInt32LE(18);
    const h = Math.abs(buf.readInt32LE(22));
    const bpp = buf.readUInt16LE(28) / 8;
    const stride = Math.floor((w * bpp + 3) / 4) * 4;
    return { w, h, off, stride, bpp };
  };
  const [ba, bb] = [await toBmp(a), await toBmp(b)];
  const ia = read(ba);
  const ib = read(bb);
  const w = Math.min(ia.w, ib.w);
  const h = Math.min(ia.h, ib.h);
  let changed = 0;
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pa = ia.off + y * ia.stride + x * ia.bpp;
      const pb = ib.off + y * ib.stride + x * ib.bpp;
      const d =
        Math.abs(ba[pa]! - bb[pb]!) +
        Math.abs(ba[pa + 1]! - bb[pb + 1]!) +
        Math.abs(ba[pa + 2]! - bb[pb + 2]!);
      if (d > 42) changed++;
      total++;
    }
  }
  return total === 0 ? 0 : changed / total;
}

interface TapDatum {
  ratio: number;
  pollIndex: number;
  coord: { x: number; y: number };
}
interface CellResult {
  cell: string;
  holdSeconds: number;
  backend: "sim-input" | "xcuitest";
  skipped: boolean;
  skipReason?: string;
  taps: TapDatum[];
  landedAt02: number; // ratio >= 0.02
  landedAt10: number; // ratio >= 0.10 (a real navigation)
}

/** Run one cell of `TAPS` taps from a fresh root at the frozen point; record the
 * max diff ratio and poll index per tap; keep the highest/lowest-ratio PNG pair. */
async function runCell(
  cell: string,
  holdSeconds: number,
  backend: "sim-input" | "xcuitest",
  tapOnce: (pt: { x: number; y: number }, w: number, h: number) => Promise<void>,
  frozen: { x: number; y: number },
  size: { w: number; h: number }
): Promise<CellResult> {
  const taps: TapDatum[] = [];
  const pairs: Array<{ before: string; after: string }> = [];
  for (let i = 0; i < TAPS; i++) {
    await relaunch();
    await sleep(300);
    const before = await screenshot(`${cell}-b`);
    try {
      await tapOnce(frozen, size.w, size.h);
    } catch {
      /* recorded as a low ratio below */
    }
    let maxRatio = 0;
    let maxPoll = -1;
    let lastAfter = "";
    for (let poll = 0; poll < 3; poll++) {
      await sleep(800);
      const after = await screenshot(`${cell}-a`);
      const r = await diffRatio(before, after).catch(() => 0);
      if (r > maxRatio) {
        maxRatio = r;
        maxPoll = poll;
      }
      if (lastAfter) rmShot(lastAfter);
      lastAfter = after;
    }
    taps.push({ ratio: Number(maxRatio.toFixed(4)), pollIndex: maxPoll, coord: frozen });
    pairs.push({ before, after: lastAfter });
  }
  // Keep the before/after PNG pair of the highest- and lowest-ratio tap; delete
  // the rest (the artifact stays small).
  const order = taps.map((t, i) => ({ i, r: t.ratio })).sort((a, b) => a.r - b.r);
  const keep = new Set<number>([order[0]?.i ?? -1, order[order.length - 1]?.i ?? -1]);
  pairs.forEach((p, i) => {
    if (keep.has(i)) {
      if (p.before) persist(p.before, cell, `tap${i}-r${taps[i]!.ratio}-before.png`);
      if (p.after) persist(p.after, cell, `tap${i}-r${taps[i]!.ratio}-after.png`);
    }
    rmShot(p.before, p.after);
  });
  return {
    cell,
    holdSeconds,
    backend,
    skipped: false,
    taps,
    landedAt02: taps.filter((t) => t.ratio >= 0.02).length,
    landedAt10: taps.filter((t) => t.ratio >= 0.1).length,
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  setFlag("open-ios-device-server", true, "project");
  const reg = createRegistry();
  const client = new IosOpenServerClient({ port: RUNNER_PORT, timeoutMs: 90_000 });
  const sim = new IosSimInputService();

  await relaunch();
  // Locate the target ONCE and freeze it.
  const st = await client.getNestedState();
  const size = await client.getScreenSize();
  const w = size.screenWidth;
  const h = size.screenHeight;
  let hit: { x: number; y: number } | null = null;
  const walk = (nodes: typeof st.tree): void => {
    for (const n of nodes) {
      if (!hit && n.label === TARGET_LABEL) {
        hit = {
          x: (n.bounds.x1 + n.bounds.x2) / 2 / w,
          y: (n.bounds.y1 + n.bounds.y2) / 2 / h,
        };
      }
      walk(n.children);
    }
  };
  walk(st.tree);
  if (!hit) throw new Error(`target "${TARGET_LABEL}" not found on the Settings root`);
  const frozen = hit;

  const cells: CellResult[] = [];

  // Control cell: XCUITest taps via invokeTool (flag ON) — anchors the nav scale.
  cells.push(
    await runCell(
      "control-xcuitest",
      0.05,
      "xcuitest",
      async (pt) => {
        await reg.invokeTool("gesture-tap", { udid: UDID, x: pt.x, y: pt.y });
      },
      frozen,
      { w, h }
    )
  );

  // sim-input hold cells.
  for (const hold of HOLD_CELLS) {
    const cell = `siminput-hold-${hold}`;
    if (hold !== 0.05 && !HOLD_CONFIGURABLE_TODAY) {
      cells.push({
        cell,
        holdSeconds: hold,
        backend: "sim-input",
        skipped: true,
        skipReason:
          "hold not configurable on the wire (main.swift tap passes duration:0 → fixed 0.05s); " +
          "needs the iOS-4 Swift change to parse a tap holdSeconds. packages/ios-sim-input stays byte-identical.",
        taps: [],
        landedAt02: 0,
        landedAt10: 0,
      });
      continue;
    }
    cells.push(
      await runCell(
        cell,
        hold,
        "sim-input",
        async (pt, sw, sh) => {
          // The wire ignores holdSeconds today; sent for forward-compat with iOS-4.
          await sim.send(UDID, {
            type: "tap",
            x: pt.x * sw,
            y: pt.y * sh,
            screenWidth: sw,
            screenHeight: sh,
            holdSeconds: hold,
          });
        },
        frozen,
        { w, h }
      )
    );
  }

  const out = {
    env: {
      udid: UDID,
      runnerPort: RUNNER_PORT,
      taps: TAPS,
      frozenCoord: frozen,
      holdConfigurableToday: HOLD_CONFIGURABLE_TODAY,
      holdCells: HOLD_CELLS,
      runId: process.env.GITHUB_RUN_ID ?? null,
      sha: process.env.GITHUB_SHA ?? null,
    },
    cells,
    decisionRule:
      "bimodal ratios at ~0.18 + landing rising with hold ⇒ recogniser timing; " +
      "ratios clustered at 0.02–0.06 at every hold ⇒ delivery recipe needs a 26.5 revision.",
  };
  const outPath = join(OUT_DIR, "siminput-discriminating.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  for (const c of cells) {
    console.log(
      `[disc] ${c.cell} backend=${c.backend} hold=${c.holdSeconds}s ${
        c.skipped
          ? `SKIPPED (${c.skipReason})`
          : `landed@0.02=${c.landedAt02}/${c.taps.length} landed@0.10=${c.landedAt10}/${c.taps.length}`
      }`
    );
  }
  process.stdout.write(`RESULT_JSON=${outPath}\n`);

  await sim.stopAll().catch(() => undefined);
  client.close();
  await reg.dispose().catch(() => undefined);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[disc] FATAL", e);
    process.exit(1);
  });
