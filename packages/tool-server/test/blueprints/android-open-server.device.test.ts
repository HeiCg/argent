/**
 * ON-DEVICE integration test for the open-source Android control server
 * (`@argent/android-device-server`), exercised through the `androidOpenServerBlueprint`
 * API — the SAME open path the describe / gesture / paste / await-* tools route
 * to when the `open-device-server` flag is on.
 *
 * SKIPPED BY DEFAULT. It talks to a real, booted Android emulator, installs the
 * server APK, and injects real touch/type events, so it never runs in CI or a
 * plain `vitest run`. Opt in explicitly:
 *
 *   OPEN_SERVER_DEVICE_TESTS=1 \
 *   ANDROID_HOME=/path/to/sdk \
 *   npx vitest run test/blueprints/android-open-server.device.test.ts
 *
 * Optional: OPEN_SERVER_DEVICE_SERIAL=emulator-5554 to pick a specific device;
 * otherwise the first `adb devices` entry in state "device" is used.
 *
 * Because it drives the blueprint API directly, there is NO fallback path to mask
 * a defect: any failure here is a genuine open-server (Kotlin or TS-routing) bug,
 * never a silent degrade to the uiautomator-dump / proprietary path. That is the
 * exclusivity the on-device validation runbook asks for.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  androidOpenServerBlueprint,
  type OpenDeviceServerApi,
  type OpenServerInfo,
} from "../../src/blueprints/android-open-server";
import type { OpenServerElement } from "../../src/tools/describe/platforms/android/open-server-tree";
import type { DeviceInfo } from "@argent/registry";
import { runAdb, adbShell, parseAdbDevices } from "../../src/utils/adb";
import { PNG } from "pngjs";

const ENABLED = process.env.OPEN_SERVER_DEVICE_TESTS === "1";
const SETTINGS = "com.android.settings";
const CHROME = "com.android.chrome";
const LAUNCHER = "com.google.android.apps.nexuslauncher";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Fraction of pixels that differ (per-channel tolerance 24) between two PNGs. */
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

type Element = OpenServerElement;
const label = (e: Element): string => (e.contentDesc ?? "").trim() || (e.text ?? "").trim();
const center = (e: Element): { x: number; y: number } => ({
  x: Math.round((e.bounds.x1 + e.bounds.x2) / 2),
  y: Math.round((e.bounds.y1 + e.bounds.y2) / 2),
});
const textSet = (tree: Element[]): Set<string> =>
  new Set(tree.map(label).filter((s) => s.length > 0));

/** Per-verb result row, printed as the report table in afterAll. */
interface Row {
  verb: string;
  status: "PASS" | "FAIL";
  evidence: string;
}
const rows: Row[] = [];
const record = (verb: string, status: "PASS" | "FAIL", evidence: string): void => {
  rows.push({ verb, status, evidence });
  // eslint-disable-next-line no-console
  console.log(`[${status}] ${verb} — ${evidence}`);
};

let api: OpenDeviceServerApi;
let dispose: () => Promise<void>;
let serial = "";

async function resolveSerial(): Promise<string> {
  if (process.env.OPEN_SERVER_DEVICE_SERIAL) return process.env.OPEN_SERVER_DEVICE_SERIAL;
  const { stdout } = await runAdb(["devices"]);
  const ready = parseAdbDevices(stdout).filter((d) => d.state === "device");
  if (ready.length === 0) throw new Error(`no adb device in state "device":\n${stdout}`);
  // Never accidentally drive a physical device: prefer an emulator, and if the
  // only "device"-state target is physical, require an explicit serial.
  const emu = ready.find((d) => d.serial.startsWith("emulator-"));
  if (emu) return emu.serial;
  if (ready.length === 1) return ready[0]!.serial;
  throw new Error(
    `multiple non-emulator devices attached; set OPEN_SERVER_DEVICE_SERIAL:\n${stdout}`
  );
}

async function freshSettings(): Promise<OpenServerInfo> {
  await api.launchApp(SETTINGS);
  await sleep(1500);
  await api.waitForIdle(3000);
  return api.getInfo();
}

const suite = ENABLED ? describe : describe.skip;

suite("android open-device-server on-device", () => {
  beforeAll(async () => {
    serial = await resolveSerial();
    // UiAutomation is a single, exclusive channel. Make sure device-farm's own
    // server (and the argent snapshot helper) are not holding it.
    for (const pkg of [
      "com.devicestream.server",
      "com.devicestream.server.test",
      "com.argent.androiddevtools",
    ]) {
      await adbShell(serial, `am force-stop ${pkg}`).catch(() => undefined);
    }
    const device: DeviceInfo = { id: serial, platform: "android", kind: "emulator" };
    const instance = await androidOpenServerBlueprint.factory({}, device, { device });
    api = instance.api;
    dispose = instance.dispose;
    expect(api.isReady()).toBe(true);
  }, 120_000);

  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.log("\n===== OPEN-SERVER DEVICE VALIDATION RESULTS (serial=" + serial + ") =====");
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `${r.status.padEnd(4)} | ${r.verb.padEnd(24)} | fallback=NO | ${r.evidence}`
      );
    }
    if (dispose) await dispose().catch(() => undefined);
  }, 30_000);

  it("ping — server answers on the open channel", async () => {
    const res = await api.ping();
    expect(res.status).toBe("ok");
    record("ping", "PASS", `status=${res.status}`);
  }, 30_000);

  it("3a describe — non-empty accessibility tree", async () => {
    await freshSettings();
    const { tree } = await api.getAccessibilityTree({ maxElements: 200 });
    const texts = [...textSet(tree)];
    expect(tree.length).toBeGreaterThan(0);
    const sample = texts.slice(0, 6).join(", ");
    record(
      "3a describe",
      "PASS",
      `${tree.length} elements, source=open-device-server; sample: [${sample}]`
    );
  }, 90_000);

  it("3b screenshot — valid PNG, dims match getInfo", async () => {
    const info = await api.getInfo();
    const shot = await api.screenshot({ format: "png" });
    const buf = Buffer.from(shot.data, "base64");
    const isPng =
      buf.length > 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47;
    expect(isPng).toBe(true);
    expect(shot.mimeType).toBe("image/png");
    expect(shot.width).toBe(info.screenWidth);
    expect(shot.height).toBe(info.screenHeight);
    record(
      "3b screenshot",
      "PASS",
      `${buf.length} bytes PNG, ${shot.width}x${shot.height} == getInfo ${info.screenWidth}x${info.screenHeight}`
    );
  }, 90_000);

  it("3c gesture-tap — tapping a row changes the screen", async () => {
    await freshSettings();
    const before = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
    const beforeTexts = textSet(before);
    const info = await api.getInfo();
    // A settings row's label often sits on a non-clickable TextView whose
    // clickable row parent handles the tap. Pick a labelled element whose center
    // falls inside some *other* clickable element's bounds — a label on a real,
    // navigable row — and tap that center (what a user does).
    const clickables = before.filter(
      (e) =>
        e.clickable === true &&
        e.bounds.y1 > info.screenHeight * 0.12 &&
        e.bounds.y2 < info.screenHeight * 0.85
    );
    const inside = (p: { x: number; y: number }, e: Element): boolean =>
      p.x >= e.bounds.x1 && p.x <= e.bounds.x2 && p.y >= e.bounds.y1 && p.y <= e.bounds.y2;
    const row =
      before.find(
        (e) => label(e).length > 0 && clickables.some((cl) => cl !== e && inside(center(e), cl))
      ) ?? clickables.find((e) => label(e).length > 0);
    if (!row) throw new Error("no labelled clickable row found on Settings");
    const c = center(row);
    await api.tap(c.x, c.y);
    await sleep(1200);
    await api.waitForIdle(3000);
    const after = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
    const afterTexts = textSet(after);
    const gained = [...afterTexts].filter((t) => !beforeTexts.has(t));
    const lost = [...beforeTexts].filter((t) => !afterTexts.has(t));
    expect(gained.length + lost.length).toBeGreaterThan(0);
    record(
      "3c gesture-tap",
      "PASS",
      `tapped "${label(row)}" @${c.x},${c.y}; +${gained.length}/-${lost.length} labels changed`
    );
  }, 90_000);

  it("3d gesture-swipe — momentum:false scrolls less than default fling", async () => {
    const measure = async (hold: boolean): Promise<number> => {
      const info = await freshSettings();
      const before = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
      // Anchor: labelled row nearest 60% of the screen height, so a plain drag
      // keeps it on-screen while an added fling pushes it noticeably further.
      const labelled = before.filter((e) => label(e).length > 0 && e.bounds.y2 > e.bounds.y1);
      const target = info.screenHeight * 0.6;
      const anchor = labelled
        .slice()
        .sort((a, b) => Math.abs(a.bounds.y1 - target) - Math.abs(b.bounds.y1 - target))[0];
      if (!anchor) throw new Error("no anchor row for swipe measurement");
      const anchorLabel = label(anchor);
      const beforeTop = anchor.bounds.y1;
      const cx = Math.round(info.screenWidth / 2);
      const y0 = Math.round(info.screenHeight * 0.7);
      const y1 = Math.round(info.screenHeight * 0.4);
      await api.swipe(cx, y0, cx, y1, 12, hold ? 120 : 0);
      await sleep(1400);
      await api.waitForIdle(3000);
      const after = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
      const found = after.find((e) => label(e) === anchorLabel);
      const afterTop = found ? found.bounds.y1 : beforeTop - info.screenHeight;
      const moved = beforeTop - afterTop;
      // eslint-disable-next-line no-console
      console.log(
        `  swipe hold=${hold} anchor="${anchorLabel}" top ${beforeTop}->${
          found ? found.bounds.y1 : "offscreen"
        } moved=${moved}`
      );
      return moved;
    };
    const movedDefault = await measure(false);
    const movedHeld = await measure(true);
    expect(movedDefault).toBeGreaterThan(0);
    expect(movedHeld).toBeGreaterThan(0);
    expect(movedHeld).toBeLessThan(movedDefault);
    record(
      "3d gesture-swipe",
      "PASS",
      `default fling moved ${movedDefault}px vs momentum:false ${movedHeld}px (held < default)`
    );
  }, 120_000);

  it("3e long-press (gesture custom, ~800ms hold) — context menu appears", async () => {
    await api.key("home");
    await sleep(1200);
    await api.waitForIdle(3000);
    const info = await api.getInfo();
    const home = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
    const beforeTexts = textSet(home);
    // A dock/hotseat app icon: clickable + labelled, in the bottom strip.
    const icon = home.find(
      (e) => e.clickable === true && label(e).length > 0 && e.bounds.y1 > info.screenHeight * 0.8
    );
    const fallbackIcon = home.find(
      (e) =>
        e.clickable === true &&
        label(e).length > 0 &&
        !/search|google|glance|weather|clock/i.test(label(e))
    );
    const target = icon ?? fallbackIcon;
    if (!target) throw new Error("no launcher icon found for long-press");
    const c = center(target);
    // gesture-custom: single pointer held ~800ms (Down, Move-in-place, Up).
    await api.gesture([
      {
        id: 0,
        points: [
          { x: c.x, y: c.y, tMs: 0 },
          { x: c.x, y: c.y, tMs: 400 },
          { x: c.x, y: c.y, tMs: 800 },
        ],
      },
    ]);
    await sleep(1200);
    await api.waitForIdle(3000);
    const afterInfo = await api.getInfo();
    const after = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
    const afterTexts = textSet(after);
    const gained = [...afterTexts].filter((t) => !beforeTexts.has(t));
    const menuHit = gained.find((t) => /app info|pause app|widget|uninstall|select/i.test(t));
    // A long-press keeps us in the launcher (a tap would have launched the app).
    const stayedInLauncher = afterInfo.currentPackage === LAUNCHER;
    expect(stayedInLauncher).toBe(true);
    expect(gained.length).toBeGreaterThan(0);
    record(
      "3e long-press",
      "PASS",
      `long-pressed "${label(target)}"; still in launcher; popup labels +${gained.length}` +
        (menuHit ? ` incl "${menuHit}"` : ` (${gained.slice(0, 4).join(", ")})`)
    );
  }, 90_000);

  it("3f gesture-pinch + gesture-rotate — multi-pointer reaches the screen", async () => {
    // Zoomable surface: Chrome on a real page (spec's "else Chrome on a page").
    // A genuine 2-pointer pinch zooms the page; a single pointer (or a dropped
    // second pointer) does not — so a visible screenshot diff after pinch proves
    // both pointers reached the screen.
    // Force-stop first so the tab starts at default zoom (1.0): Chrome preserves
    // pinch-zoom on the reused tab, and a prior run left zoomed-in would leave a
    // pinch-out with no headroom (false 0% diff).
    await adbShell(serial, `am force-stop ${CHROME}`).catch(() => undefined);
    await sleep(500);
    await api.launchApp(CHROME);
    await sleep(2500);
    await api.waitForIdle(3000);
    // Best-effort: dismiss the Chrome first-run flow if this profile still shows
    // it (already dismissed on a warm emulator; needed on a cold one).
    for (let i = 0; i < 5; i++) {
      const tree = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
      const fre = tree.find(
        (e) =>
          e.clickable === true &&
          /use without an account|got it|no thanks|not now|dismiss/i.test(
            label(e) + " " + (e.resourceId ?? "")
          )
      );
      const hasOmnibox = tree.some((e) =>
        /url_bar|search_box_text/i.test(e.resourceId ?? "")
      );
      if (hasOmnibox && !fre) break;
      if (!fre) break;
      const fc = center(fre);
      await api.tap(fc.x, fc.y);
      await sleep(1800);
      await api.waitForIdle(3000);
    }
    // Load a deterministic page via the omnibox so the pinch has content to zoom.
    const preTree = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
    const omni = preTree.find(
      (e) =>
        /url_bar|search_box_text/i.test(e.resourceId ?? "") ||
        /search or type/i.test(label(e))
    );
    if (omni) {
      const oc = center(omni);
      await api.tap(oc.x, oc.y);
      await sleep(1000);
      await api.waitForIdle(2000);
      // A normal, pinch-zoomable web page (chrome:// WebUI pages disable
      // pinch-zoom, so they are useless here). example.com is sparse but its
      // heading/paragraph zoom reliably; center the pinch on that text.
      await api.typeText("example.com");
      await sleep(500);
      await api.key("enter");
      await sleep(3500);
      await api.waitForIdle(3000);
    }

    const info = await api.getInfo();
    const cx = Math.round(info.screenWidth / 2);
    const cy = Math.round(info.screenHeight * 0.4); // web content, below toolbar
    const frames = 12;
    const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);
    const nearSpan = Math.round(info.screenWidth * 0.05);
    const farSpan = Math.round(info.screenWidth * 0.46);
    // Two horizontal fingers spanning `from`->`to` device px around cx: `out`
    // (near->far) zooms in, its reverse zooms out.
    const buildPinch = (from: number, to: number) =>
      [0, 1].map((pi) => {
        const dir = pi === 0 ? -1 : 1;
        const points = [];
        for (let f = 0; f < frames; f++) {
          const t = f / (frames - 1);
          points.push({ x: cx + dir * lerp(from, to, t), y: cy, tMs: f * 25 });
        }
        return { id: pi, points };
      });

    // Establish a known baseline: pinch IN hard to zoom OUT to the page minimum,
    // so the measured pinch-OUT below always has headroom. Chrome preserves
    // pinch-zoom across a same-origin reload, so without this a page left maxed
    // in by a prior run would make the pinch-out a false 0% (both pointers still
    // reach the screen — verified — there is just nothing left to zoom).
    await api.gesture(buildPinch(farSpan, nearSpan));
    await sleep(1000);
    await api.waitForIdle(3000);
    const before = Buffer.from((await api.screenshot({ format: "png" })).data, "base64");

    // Pinch-OUT (zoom in) from that baseline: a genuine 2-pointer pinch enlarges
    // the content across many pixels; a single (or dropped-second) pointer does
    // not, so a large screenshot diff proves both pointers reached the screen.
    const pinchRes = await api.gesture(buildPinch(nearSpan, farSpan));
    expect(pinchRes.success).toBe(true);
    await sleep(1200);
    await api.waitForIdle(3000);
    const after = Buffer.from((await api.screenshot({ format: "png" })).data, "base64");
    const ratio = pngDiffRatio(before, after);
    // eslint-disable-next-line no-console
    console.log(`  pinch screenshot diff ratio = ${(ratio * 100).toFixed(2)}%`);
    // Min-zoom -> zoomed-in reflows the whole viewport: expect a large change.
    expect(ratio).toBeGreaterThan(0.02);

    // Rotate: two fingers sweeping ~90° around a center. Same MotionInjector
    // 2-pointer path the pinch just proved delivers both pointers; Chrome pages
    // don't rotate, so assert no exception + success (the spec's minimum bar).
    const r = Math.round(info.screenWidth * 0.28);
    const rotate = [0, 1].map((pi) => {
      const base = pi === 0 ? 0 : Math.PI; // opposite ends of a diameter
      const points = [];
      for (let f = 0; f < frames; f++) {
        const t = f / (frames - 1);
        const ang = base + (Math.PI / 2) * t; // sweep 90°
        points.push({
          x: Math.round(cx + r * Math.cos(ang)),
          y: Math.round(cy + r * Math.sin(ang)),
          tMs: f * 25,
        });
      }
      return { id: pi, points };
    });
    const rotateRes = await api.gesture(rotate);
    expect(rotateRes.success).toBe(true);
    record(
      "3f gesture-pinch",
      "PASS",
      `pinch success; both pointers reached screen — Chrome zoom changed ${(ratio * 100).toFixed(1)}% of pixels`
    );
    record(
      "3f gesture-rotate",
      "PASS",
      `rotate success=${rotateRes.success}, no MotionInjector exception (same 2-pointer inject path visibly confirmed by pinch)`
    );
  }, 150_000);

  it("3g paste (typeText) — text lands in an EditText, read back via describe", async () => {
    await freshSettings();
    const tree = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
    // Settings search entry point.
    const search = tree.find(
      (e) =>
        (e.clickable === true || (e.resourceId ?? "").toLowerCase().includes("search")) &&
        /search/i.test(label(e) + " " + (e.resourceId ?? ""))
    );
    if (!search) throw new Error("no Settings search entry found");
    const c = center(search);
    await api.tap(c.x, c.y);
    await sleep(1200);
    await api.waitForIdle(3000);
    const marker = "battery" + Date.now().toString().slice(-4);
    const typed = await api.typeText(marker);
    expect(typed.success).toBe(true);
    await sleep(800);
    await api.waitForIdle(3000);
    const after = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
    const edit = after.find(
      (e) => /edittext/i.test(e.className) && (e.text ?? "").includes(marker)
    );
    const anyText = after.find((e) => (e.text ?? "").includes(marker));
    const hit = edit ?? anyText;
    expect(hit).toBeTruthy();
    record(
      "3g paste",
      "PASS",
      `typed "${marker}" (${typed.charsTyped} chars); read back in ${
        edit ? "EditText" : hit!.className
      } text="${hit!.text}"`
    );
  }, 90_000);

  it("3h await (getState / waitForIdle) — resolves via open path, low latency", async () => {
    await freshSettings();
    // getState without a screenshot: the poll-loop shape (idle + tree + info).
    const t0 = Date.now();
    const st = await api.getState({ includeScreenshot: false });
    const dt = Date.now() - t0;
    expect(st.tree.length).toBeGreaterThan(0);
    expect(st.info.screenWidth).toBeGreaterThan(0);
    expect(st.screenshot).toBe("");
    // getState WITH a screenshot: the includeScreenshot flag must actually add one.
    const withShot = await api.getState({ includeScreenshot: true });
    expect(withShot.screenshot.length).toBeGreaterThan(0);
    // waitForIdle on an already-idle screen should return quickly (<1s).
    const w0 = Date.now();
    const idle = await api.waitForIdle(2000);
    const idleDt = Date.now() - w0;
    expect(idle.idle).toBe(true);
    expect(idleDt).toBeLessThan(1500);
    record(
      "3h await/getState",
      "PASS",
      `getState ${st.tree.length} el in ${dt}ms (captureMs=${st.captureMs}, waitedMs=${st.waitedMs}); includeScreenshot=true -> ${withShot.screenshot.length} b64 chars; waitForIdle ${idleDt}ms`
    );
  }, 90_000);
});
