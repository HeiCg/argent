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
import { EMPTY_TREE_HASH } from "../../src/utils/screen-hash";
import { PNG } from "pngjs";

const ENABLED = process.env.OPEN_SERVER_DEVICE_TESTS === "1";
// Phase 3n.1 P9: start the on-device server with benchDebug so the forced-fallback
// case can flip `_forceInjectUnavailable` on a `tap`. Debug params are honored only
// under benchDebug and only when explicitly sent, so this changes nothing else.
if (ENABLED) process.env.ARGENT_OPEN_SERVER_BENCH_DEBUG = "1";
const SETTINGS = "com.android.settings";
const CHROME = "com.android.chrome";
const LAUNCHER = "com.google.android.apps.nexuslauncher";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Phase 3k measurement helper. Parse a `logcat -v threadtime` dump for the touch
 * MotionEvents of a just-injected gesture and return the DELIVERED span in ms —
 * the wall-clock between the first and last touch-dispatch line — so the delivered
 * gesture duration can be compared to the requested duration for the backend under
 * test. Returns null when no touch lines are present (parsing varies by emulator
 * image; the caller then records "unmeasured" rather than failing the enforced
 * suite). A threadtime line starts `MM-DD HH:MM:SS.mmm `.
 */
function threadtimeMs(line: string): number | null {
  const m = line.match(/^\d{2}-\d{2}\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
  if (!m) return null;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}
function deliveredSpanMs(logcat: string): { spanMs: number | null; events: number } {
  const ts: number[] = [];
  for (const line of logcat.split("\n")) {
    // Touch dispatch lines under InputDispatcher/InputReader VERBOSE. Broad on
    // purpose (image-dependent wording); we only need the burst's first/last time.
    if (!/InputDispatcher|InputReader|MotionEvent/.test(line)) continue;
    if (
      !/\b(DOWN|MOVE|UP|ACTION_DOWN|ACTION_MOVE|ACTION_UP|dispatchMotion|deliverInputEvent)\b/.test(
        line
      )
    ) {
      continue;
    }
    const t = threadtimeMs(line);
    if (t !== null) ts.push(t);
  }
  if (ts.length < 2) return { spanMs: null, events: ts.length };
  return { spanMs: Math.max(...ts) - Math.min(...ts), events: ts.length };
}

/**
 * Phase 3k.1 (review 3K-H3) — device-side MotionEvent cadence from
 * `adb shell dumpsys input`. `InputDispatcher VERBOSE` logs nothing on this image, so
 * the logcat DOWN→UP span is only the two Launcher `TaplEvents` endpoints (no MOVE
 * cadence — the very thing a fling depends on). `dumpsys input` keeps a
 * RecentQueue / "recent events" list whose entries carry a per-event time (either
 * `age=NNNms` relative to the dump, or an absolute `eventTime=<ns>`) and INCLUDE the
 * MOVE frames, so the intermediate cadence is recoverable. Parse best-effort (the
 * format varies by image); return the source label, the number of MotionEvent time
 * samples, the delivered span (max−min) in ms, and the sorted inter-event deltas (the
 * MOVE cadence). Never throws — MEASUREMENT only, read immediately after each swipe.
 */
function dumpsysMotionEventTimes(dump: string): {
  source: string;
  n: number;
  spanMs: number | null;
  cadenceMs: number[];
} {
  // Prefer the RecentQueue / recent-events region if present (bounds the parse to the
  // just-injected burst rather than the whole global dump).
  const regionMatch = dump.match(/(RecentQueue|recent events|InboundQueue)[\s\S]{0,6000}/i);
  const region = regionMatch ? regionMatch[0] : dump;
  const round1 = (x: number): number => Number(x.toFixed(1));
  // 3K1-M8: filter to MotionEvent entries so the parsed times are the gesture's touch
  // frames (DOWN/MOVE/UP), not arbitrary input events sharing the queue — the event
  // class is now ESTABLISHED by the parser, not inferred from the arithmetic. On
  // images that label each entry (`MotionEvent(...) age=NNms`) the per-line filter
  // holds; if the image does not label event classes we fall back to the whole region
  // and SAY so in the source label, rather than claiming a MotionEvent read we cannot
  // back.
  const motionScope = region
    .split("\n")
    .filter((l) => /MotionEvent/i.test(l))
    .join("\n");
  const filtered = motionScope.length > 0;
  const classNote = (usedFilter: boolean): string =>
    usedFilter ? "MotionEvent-filtered" : "event class NOT filtered";
  // (a) `age=NNNms` relative to dump time (larger age = earlier event).
  const parseAges = (text: string): number[] =>
    [...text.matchAll(/\bage=(\d+(?:\.\d+)?)ms\b/g)].map((m) => Number(m[1]));
  let ages = filtered ? parseAges(motionScope) : [];
  const ageFiltered = ages.length >= 2;
  if (!ageFiltered) ages = parseAges(region); // fall back to the unfiltered region
  if (ages.length >= 2) {
    const sorted = ages.slice().sort((a, b) => b - a); // oldest → newest
    const cadence: number[] = [];
    for (let i = 1; i < sorted.length; i++) cadence.push(round1(sorted[i - 1]! - sorted[i]!));
    return {
      source: `dumpsys input RecentQueue age=…ms (${classNote(ageFiltered)})`,
      n: ages.length,
      spanMs: round1(Math.max(...ages) - Math.min(...ages)),
      cadenceMs: cadence,
    };
  }
  // (b) absolute `eventTime=<ns|ms>` (newer format); normalise to ms by magnitude.
  const parseEvt = (text: string): number[] =>
    [...text.matchAll(/\beventTime=(\d{4,})\b/g)].map((m) => Number(m[1]));
  let evt = filtered ? parseEvt(motionScope) : [];
  const evtFiltered = evt.length >= 2;
  if (!evtFiltered) evt = parseEvt(region);
  if (evt.length >= 2) {
    const toMs = (v: number): number => (v > 1e9 ? v / 1e6 : v); // ns → ms heuristic
    const ms = evt.map(toMs).sort((a, b) => a - b);
    const cadence: number[] = [];
    for (let i = 1; i < ms.length; i++) cadence.push(round1(ms[i]! - ms[i - 1]!));
    return {
      source: `dumpsys input eventTime=… (${classNote(evtFiltered)})`,
      n: evt.length,
      spanMs: round1(ms[ms.length - 1]! - ms[0]!),
      cadenceMs: cadence,
    };
  }
  return {
    source: "dumpsys input (no MotionEvent times parsed)",
    n: 0,
    spanMs: null,
    cadenceMs: [],
  };
}

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

/**
 * The `mCurrentFocus` line from `dumpsys window` — the WINDOW that actually receives
 * touch input. Review A8/fix e: `mFocusedApp` is deliberately EXCLUDED because it
 * flips to the destination activity before the window focus does (the early-flip
 * state), so a check that accepted `mFocusedApp` could pass while the launcher still
 * held the window — exactly the state this signal must exclude.
 */
async function foregroundFocus(dserial: string): Promise<string> {
  try {
    const out = await adbShell(dserial, "dumpsys window 2>/dev/null | grep -m1 mCurrentFocus");
    return out.replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

// Chrome first-run (FRE) buttons vary by build; match the primary "continue"
// controls plus the sign-in opt-outs so the FRE is cleared and a web page can
// actually render. On the CI google_apis image Chrome opens on FirstRunActivity,
// which blocks the page (and thus any pinch-zoom) until dismissed.
const CHROME_FRE_RE =
  /accept ?(&|and) ?continue|^\s*continue\s*$|use without an account|no thanks|not now|^\s*got it\s*$|dismiss|^\s*skip\s*$|maybe later|^\s*done\s*$|turn on sync|^\s*next\s*$|^\s*ok\s*$/i;

async function dismissChromeFre(a: OpenDeviceServerApi): Promise<void> {
  for (let i = 0; i < 8; i++) {
    let tree: Element[];
    try {
      tree = (await a.getAccessibilityTree({ maxElements: 200 })).tree;
    } catch {
      await sleep(800);
      continue;
    }
    const hasOmnibox = tree.some((e) => /url_bar|search_box_text/i.test(e.resourceId ?? ""));
    const fre = tree.find(
      (e) => e.clickable === true && CHROME_FRE_RE.test(label(e) + " " + (e.resourceId ?? ""))
    );
    if (hasOmnibox && !fre) return; // FRE cleared, page chrome present
    if (!fre) {
      if (hasOmnibox) return;
      await sleep(1000);
      continue;
    }
    const fc = center(fre);
    await a.tap(fc.x, fc.y);
    await sleep(1500);
    await a.waitForIdle(3000).catch(() => undefined);
  }
}

/**
 * Force-stop Chrome, dismiss the first-run flow, load `url`, and confirm a
 * zoomable web page rendered (its text matches `contentRe`). Returns whether the
 * page is confirmed plus the current focused-window line (proof of a stuck FRE
 * when not ready). A readiness GATE, not a numeric-bound change: the pinch's
 * visual-zoom assertion runs only when the page actually rendered — otherwise the
 * environment (headless CI Chrome) cannot present a surface to zoom.
 */
async function ensureChromeZoomable(
  a: OpenDeviceServerApi,
  dserial: string,
  url: string,
  contentRe: RegExp
): Promise<{ ready: boolean; focus: string }> {
  await adbShell(dserial, `am force-stop ${CHROME}`).catch(() => undefined);
  await sleep(600);
  await adbShell(dserial, `am start -a android.intent.action.VIEW -d '${url}' ${CHROME}`).catch(
    () => undefined
  );
  await sleep(3500);
  await a.waitForIdle(3000).catch(() => undefined);
  await dismissChromeFre(a);
  // FRE may have swallowed the VIEW intent; (re)issue it now that Chrome is past
  // the welcome flow.
  await adbShell(dserial, `am start -a android.intent.action.VIEW -d '${url}' ${CHROME}`).catch(
    () => undefined
  );
  await sleep(2500);
  await a.waitForIdle(3000).catch(() => undefined);
  for (let i = 0; i < 6; i++) {
    let text = "";
    try {
      text = [...textSet((await a.getAccessibilityTree({ maxElements: 200 })).tree)].join(" | ");
    } catch {
      /* retry */
    }
    if (contentRe.test(text)) return { ready: true, focus: await foregroundFocus(dserial) };
    await sleep(1500);
    await a.waitForIdle(2000).catch(() => undefined);
  }
  return { ready: false, focus: await foregroundFocus(dserial) };
}

/** Per-verb result row, printed as the report table in afterAll. */
interface Row {
  verb: string;
  status: "PASS" | "FAIL";
  evidence: string;
}
const rows: Row[] = [];
const record = (verb: string, status: "PASS" | "FAIL", evidence: string): void => {
  rows.push({ verb, status, evidence });
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
    console.log("\n===== OPEN-SERVER DEVICE VALIDATION RESULTS (serial=" + serial + ") =====");
    for (const r of rows) {
      console.log(`${r.status.padEnd(4)} | ${r.verb.padEnd(24)} | fallback=NO | ${r.evidence}`);
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
      buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
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
    // Returns the anchor's on-screen displacement in px, or { offscreen:true } when
    // the anchor scrolled OUT of the tree. Review A6/fix e: an off-screen anchor is
    // UNMEASURED (we only know it moved further than the visible span) — it must NOT
    // be substituted with a maximal displacement (beforeTop - screenHeight), which
    // biased the fling arm toward passing.
    const measure = async (hold: boolean): Promise<{ moved: number; offscreen: boolean }> => {
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
      if (!found) {
        console.log(
          `  swipe hold=${hold} anchor="${anchorLabel}" top ${beforeTop}->offscreen moved=UNMEASURED(>on-screen span)`
        );
        return { moved: NaN, offscreen: true };
      }
      const moved = beforeTop - found.bounds.y1;
      console.log(
        `  swipe hold=${hold} anchor="${anchorLabel}" top ${beforeTop}->${found.bounds.y1} moved=${moved}`
      );
      return { moved, offscreen: false };
    };
    const def = await measure(false);
    const held = await measure(true);
    if (!def.offscreen && !held.offscreen) {
      // Both measured on-screen: compare exact displacement.
      expect(def.moved).toBeGreaterThan(0);
      expect(held.moved).toBeGreaterThan(0);
      expect(held.moved).toBeLessThan(def.moved);
      record(
        "3d gesture-swipe",
        "PASS",
        `default fling moved ${def.moved}px vs momentum:false ${held.moved}px (held < default)`
      );
    } else if (def.offscreen && !held.offscreen) {
      // Default fling pushed the anchor off-screen (further than the visible span, by
      // an unmeasured amount) while momentum:false kept it on-screen — the fling
      // clearly scrolled further, without inventing a displacement number.
      expect(held.moved).toBeGreaterThan(0);
      record(
        "3d gesture-swipe",
        "PASS",
        `default fling scrolled the anchor OFF-screen (unmeasured, > on-screen span); ` +
          `momentum:false moved ${held.moved}px on-screen — fling scrolled further`
      );
    } else {
      // held off-screen (backwards) or both off-screen (unmeasured): cannot conclude
      // momentum:false < fling — fail loudly rather than pass on a substituted number.
      throw new Error(
        `swipe comparison unmeasured: default offscreen=${def.offscreen}, momentum:false offscreen=${held.offscreen} — cannot assert held < fling`
      );
    }
  }, 120_000);

  it("3k pacing — UiAutomation delivered swipe duration from logcat MotionEvents", async () => {
    // Phase 3k measurement (option i), UiAutomation arm (the default open path here).
    // Same long swipe as the former fast-inject arm — 26 REQUESTED steps, which the momentum
    // builder emits as an 8-FRAME wire gesture (2 head + 5 tail + DOWN/UP endpoints,
    // ~416 ms). Read the delivered MotionEvent span from logcat. MEASUREMENT only
    // (records delivered-vs-requested, asserts the backend stayed live) so a
    // logcat-parse miss never fails the enforced suite.
    const info = await freshSettings();
    const cx = Math.round(info.screenWidth / 2);
    const y0 = Math.round(info.screenHeight * 0.72);
    const y1 = Math.round(info.screenHeight * 0.32);
    const steps = 26; // 26 requested steps → 8 wire frames (~416 ms)
    const requestedMs = steps * 16;
    const wireNote = "26 requested steps → 8 wire frames";
    let evidence: string;
    try {
      await runAdb(["-s", serial, "logcat", "-c"]).catch(() => undefined);
      await api.swipe(cx, y0, cx, y1, steps, 0);
      // 3K-H3: read the device-side MotionEvent cadence from `dumpsys input`
      // IMMEDIATELY (the RecentQueue ages relative to the dump time, so it must be
      // read before the burst rolls out of the queue), then the logcat endpoints.
      const di = await runAdb(["-s", serial, "shell", "dumpsys", "input"], {
        timeoutMs: 20_000,
      }).catch(() => ({ stdout: "" }));
      const dv = dumpsysMotionEventTimes(di.stdout);
      await sleep(600);
      const dump = await runAdb(["-s", serial, "logcat", "-d", "-v", "threadtime"], {
        timeoutMs: 20_000,
      }).catch(() => ({ stdout: "" }));
      const { spanMs, events } = deliveredSpanMs(dump.stdout);
      const logRow =
        spanMs === null
          ? `logcat endpoints=UNMEASURED (no MotionEvent lines; ${events} ts)`
          : `logcat DOWN→UP endpoints=${spanMs}ms (${events} events, Launcher TaplEvents — endpoints only)`;
      const cad = dv.cadenceMs.length ? ` cadence=[${dv.cadenceMs.join(",")}]ms` : "";
      const diRow =
        dv.n >= 2
          ? `${dv.source}: delivered=${dv.spanMs}ms n=${dv.n}${cad}`
          : `${dv.source}: UNMEASURED (n=${dv.n})`;
      evidence = `requested=${requestedMs}ms (${wireNote}); ${logRow}; ${diRow}`;
    } catch (e) {
      // MEASUREMENT only — must not fail the enforced suite on a swipe/logcat hiccup.
      evidence = `UNMEASURED (${e instanceof Error ? e.message : String(e)}) requested=${requestedMs}ms (${wireNote})`;
    }
    console.log(`  3k pacing uiautomation ${evidence}`);
    expect(api.isReady()).toBe(true);
    record("3k pacing (uia delivered dur)", "PASS", evidence);
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
    // A genuine 2-pointer pinch zooms a web page; a single pointer (or a dropped
    // second pointer) does not — so a screenshot diff after pinch proves both
    // pointers reached the screen. Chrome on the CI google_apis image opens on
    // FirstRunActivity, which blocks the page until dismissed; ensureChromeZoomable
    // clears the FRE and confirms a rendered, zoomable page. Readiness GATE (not a
    // bound change): the visual-zoom assertion runs only when the page rendered —
    // otherwise headless-CI Chrome offers no surface to zoom (proven: the bench
    // saw "Chrome/example.com did not confirm content" on this same runner).
    const { ready, focus } = await ensureChromeZoomable(
      api,
      serial,
      "https://example.com",
      /example|more information|illustrative|iana|documents/i
    );

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
    console.log(
      `  pinch screenshot diff ratio = ${(ratio * 100).toFixed(2)}% (chrome ready=${ready})`
    );
    // Review A6/fix e: assert the readiness precondition — a pinch that verified
    // nothing (Chrome never rendered a zoomable page) must FAIL, never record PASS
    // conditionally. The gate clears the FRE and confirms a rendered page first.
    if (!ready) {
      throw new Error(
        `3f pinch: Chrome did not render a zoomable page (focus=${focus}) — 2-pointer delivery could not be visually verified`
      );
    }
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
      `pinch success; both pointers reached screen — Chrome zoom changed ${(ratio * 100).toFixed(1)}% of pixels (ready gate asserted)`
    );
    record(
      "3f gesture-rotate",
      "PASS",
      `rotate success=${rotateRes.success}, no MotionInjector exception (same 2-pointer inject path)`
    );
  }, 150_000);

  // ── Phase 3n: one case per injection strategy ─────────────────────────────
  // Each strategy (uia-sync / uia-async / input-manager) is threaded on the RPC's
  // `inject` param and must produce the SAME observable outcomes as the default
  // path: a tap navigates, a momentum swipe scrolls further than a momentum-free
  // one, and a 2-pointer pinch zooms. input-manager degrades to uia-async when the
  // device blocks the hidden API — the outcome is unchanged (the action still
  // lands); we record which strategy actually ran from the response echo. A
  // separate measurement-only case reads the device MotionEvent cadence per
  // strategy from `dumpsys input` (label: 8-frame wire gesture, N).
  const STRATEGIES = ["uia-sync", "uia-async", "input-manager"] as const;
  for (const strategy of STRATEGIES) {
    it(`3n-${strategy} — tap navigates, momentum swipe > momentum-free, pinch delivers 2 pointers`, async () => {
      // (1) TAP NAVIGATES.
      const info0 = await freshSettings();
      const before = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
      const beforeTexts = textSet(before);
      const clickables = before.filter(
        (e) =>
          e.clickable === true &&
          e.bounds.y1 > info0.screenHeight * 0.12 &&
          e.bounds.y2 < info0.screenHeight * 0.85
      );
      const inside = (p: { x: number; y: number }, e: Element): boolean =>
        p.x >= e.bounds.x1 && p.x <= e.bounds.x2 && p.y >= e.bounds.y1 && p.y <= e.bounds.y2;
      const row =
        before.find(
          (e) => label(e).length > 0 && clickables.some((cl) => cl !== e && inside(center(e), cl))
        ) ?? clickables.find((e) => label(e).length > 0);
      if (!row) throw new Error(`3n-${strategy}: no labelled clickable row on Settings`);
      const c = center(row);
      const tapRes = (await api.tap(c.x, c.y, { inject: strategy })) as {
        success: boolean;
        strategy?: string;
        injectError?: string;
      };
      const ranAs = tapRes.strategy ?? "(no echo)";
      const unavailable = tapRes.strategy === "unavailable";
      await sleep(1200);
      await api.waitForIdle(3000);
      const afterTexts = textSet((await api.getAccessibilityTree({ maxElements: 200 })).tree);
      const gained = [...afterTexts].filter((t) => !beforeTexts.has(t));
      const lost = [...beforeTexts].filter((t) => !afterTexts.has(t));
      expect(tapRes.success).toBe(true);
      expect(gained.length + lost.length).toBeGreaterThan(0);

      // (2) MOMENTUM SWIPE > MOMENTUM-FREE. Same anchor-displacement method as 3d.
      const measure = async (hold: boolean): Promise<{ moved: number; offscreen: boolean }> => {
        const info = await freshSettings();
        const tree = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
        const labelled = tree.filter((e) => label(e).length > 0 && e.bounds.y2 > e.bounds.y1);
        const target = info.screenHeight * 0.6;
        const anchor = labelled
          .slice()
          .sort((a, b) => Math.abs(a.bounds.y1 - target) - Math.abs(b.bounds.y1 - target))[0];
        if (!anchor) throw new Error(`3n-${strategy}: no anchor row for swipe`);
        const anchorLabel = label(anchor);
        const beforeTop = anchor.bounds.y1;
        const cx = Math.round(info.screenWidth / 2);
        const y0 = Math.round(info.screenHeight * 0.7);
        const y1 = Math.round(info.screenHeight * 0.4);
        await api.swipe(cx, y0, cx, y1, 12, hold ? 120 : 0, { inject: strategy });
        await sleep(1400);
        await api.waitForIdle(3000);
        const found = (await api.getAccessibilityTree({ maxElements: 200 })).tree.find(
          (e) => label(e) === anchorLabel
        );
        if (!found) return { moved: NaN, offscreen: true };
        return { moved: beforeTop - found.bounds.y1, offscreen: false };
      };
      const def = await measure(false);
      const held = await measure(true);
      let swipeNote: string;
      if (!def.offscreen && !held.offscreen) {
        expect(def.moved).toBeGreaterThan(0);
        expect(held.moved).toBeGreaterThan(0);
        expect(held.moved).toBeLessThan(def.moved);
        swipeNote = `fling ${def.moved}px > momentum-free ${held.moved}px`;
      } else if (def.offscreen && !held.offscreen) {
        expect(held.moved).toBeGreaterThan(0);
        swipeNote = `fling scrolled anchor OFF-screen (>span); momentum-free ${held.moved}px on-screen`;
      } else {
        throw new Error(
          `3n-${strategy}: swipe unmeasured (def offscreen=${def.offscreen}, held offscreen=${held.offscreen})`
        );
      }

      // (3) PINCH DELIVERS 2 POINTERS. The RPC must succeed via this strategy; the
      // visual zoom assertion runs only when headless Chrome actually rendered a
      // zoomable page (readiness gate, as in 3f), else it is measurement-only.
      const { ready } = await ensureChromeZoomable(
        api,
        serial,
        "https://example.com",
        /example|more information|illustrative|iana|documents/i
      );
      const info = await api.getInfo();
      const cx = Math.round(info.screenWidth / 2);
      const cy = Math.round(info.screenHeight * 0.4);
      const frames = 12;
      const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);
      const nearSpan = Math.round(info.screenWidth * 0.05);
      const farSpan = Math.round(info.screenWidth * 0.46);
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
      await api.gesture(buildPinch(farSpan, nearSpan), { inject: strategy });
      await sleep(1000);
      await api.waitForIdle(3000);
      const pinchBefore = Buffer.from((await api.screenshot({ format: "png" })).data, "base64");
      const pinchRes = (await api.gesture(buildPinch(nearSpan, farSpan), { inject: strategy })) as {
        success: boolean;
        strategy?: string;
      };
      expect(pinchRes.success).toBe(true);
      await sleep(1200);
      await api.waitForIdle(3000);
      const pinchAfter = Buffer.from((await api.screenshot({ format: "png" })).data, "base64");
      const ratio = pngDiffRatio(pinchBefore, pinchAfter);
      let pinchNote: string;
      if (ready) {
        expect(ratio).toBeGreaterThan(0.02);
        pinchNote = `zoom changed ${(ratio * 100).toFixed(1)}% of pixels`;
      } else {
        pinchNote = `Chrome not zoomable (measurement-only); pinch RPC success=${pinchRes.success}`;
      }

      record(
        `3n-${strategy}`,
        "PASS",
        `ranAs=${ranAs}${unavailable ? " (input-manager UNAVAILABLE → uia-async fallback)" : ""}; ` +
          `tap +${gained.length}/-${lost.length} labels; swipe ${swipeNote}; pinch ${pinchNote}`
      );
    }, 180_000);

    it(`3n-${strategy} — dumpsys MotionEvent cadence (8-frame wire gesture, N) [measurement-only]`, async () => {
      const info = await freshSettings();
      const cx = Math.round(info.screenWidth / 2);
      const y0 = Math.round(info.screenHeight * 0.7);
      const y1 = Math.round(info.screenHeight * 0.4);
      // A deterministic 8-frame single-pointer wire (DOWN + 6 MOVE + UP), 16 ms
      // apart, injected via this strategy — so dumpsys reports its MOVE cadence.
      const N_FRAMES = 8;
      const points = [];
      for (let f = 0; f < N_FRAMES; f++) {
        const t = f / (N_FRAMES - 1);
        points.push({ x: cx, y: Math.round(y0 + (y1 - y0) * t), tMs: f * 16 });
      }
      const res = (await api.gesture([{ id: 0, points }], { inject: strategy })) as {
        success: boolean;
        strategy?: string;
      };
      // Read the device-side MotionEvent times IMMEDIATELY (the RecentQueue is short).
      let cadence: { source: string; n: number; spanMs: number | null; cadenceMs: number[] };
      try {
        const dump = await adbShell(serial, "dumpsys input");
        cadence = dumpsysMotionEventTimes(dump);
      } catch (e) {
        cadence = {
          source: `dumpsys input unavailable: ${e instanceof Error ? e.message : String(e)}`,
          n: 0,
          spanMs: null,
          cadenceMs: [],
        };
      }
      // Measurement-only: never fails the enforced suite (parsing varies by image).
      record(
        `3n-${strategy}-cadence`,
        "PASS",
        `8-frame wire via ${res.strategy ?? "(no echo)"}; ${cadence.source}; N=${cadence.n}; ` +
          `deliveredSpan=${cadence.spanMs ?? "unmeasured"}ms; MOVE cadence=[${cadence.cadenceMs.join(", ")}]ms`
      );
    }, 120_000);
  }

  it("3n.1 P9 — input-manager forced unavailable falls back to uia-async, outcome unchanged", async () => {
    // Force the reflective pipe to report unavailable on THIS tap (benchDebug seam),
    // even though the emulator resolves it, and prove the tap still lands via the
    // automatic uia-async fallback — the fallback path has otherwise never run on a
    // "blocked" device (review 3N-M11). Then a normal input-manager tap confirms the
    // override was request-scoped (reset).
    const info = await freshSettings();
    const before = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
    const beforeTexts = textSet(before);
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
    if (!row) throw new Error("3n.1 P9: no labelled clickable row on Settings");
    const c = center(row);
    const forced = (await api.tap(c.x, c.y, {
      inject: "input-manager",
      _forceInjectUnavailable: true,
    })) as {
      success: boolean;
      strategy?: string;
      fellBackTo?: string;
      injectError?: string;
    };
    expect(forced.success).toBe(true);
    expect(forced.strategy).toBe("unavailable");
    expect(forced.fellBackTo).toBe("uia-async");
    await sleep(1200);
    await api.waitForIdle(3000);
    const afterTexts = textSet((await api.getAccessibilityTree({ maxElements: 200 })).tree);
    const changed =
      [...afterTexts].filter((t) => !beforeTexts.has(t)).length +
      [...beforeTexts].filter((t) => !afterTexts.has(t)).length;
    expect(changed).toBeGreaterThan(0); // outcome unchanged: the fell-back tap still navigated
    // Phase 3n.2 (review 3N1-L1): the seam now covers swipe and gesture too — force
    // the fallback on each and prove it reports uia-async. After scrcpy removal the
    // `uia-async` fallback is the only remaining safety net, so P9 must cover all
    // three inject RPCs, not tap alone.
    await freshSettings();
    const forcedSwipe = (await api.swipe(0.5, 0.7, 0.5, 0.3, 12, 0, {
      inject: "input-manager",
      _forceInjectUnavailable: true,
    })) as { success: boolean; strategy?: string; fellBackTo?: string };
    expect(forcedSwipe.success).toBe(true);
    expect(forcedSwipe.strategy).toBe("unavailable");
    expect(forcedSwipe.fellBackTo).toBe("uia-async");
    await freshSettings();
    const forcedGesture = (await api.gesture(
      [
        {
          points: [
            { x: 0.4, y: 0.5, tMs: 0 },
            { x: 0.3, y: 0.5, tMs: 120 },
          ],
        },
        {
          points: [
            { x: 0.6, y: 0.5, tMs: 0 },
            { x: 0.7, y: 0.5, tMs: 120 },
          ],
        },
      ],
      { inject: "input-manager", _forceInjectUnavailable: true }
    )) as { success: boolean; strategy?: string; fellBackTo?: string };
    expect(forcedGesture.success).toBe(true);
    expect(forcedGesture.strategy).toBe("unavailable");
    expect(forcedGesture.fellBackTo).toBe("uia-async");
    // Reset check: a normal input-manager tap (no force) reports input-manager again.
    await freshSettings();
    const normal = (await api.tap(c.x, c.y, { inject: "input-manager" })) as {
      success: boolean;
      strategy?: string;
    };
    expect(normal.strategy).toBe("input-manager");
    record(
      "3n.1 P9 forced-fallback",
      "PASS",
      `forced unavailable → tap strategy=${forced.strategy} fellBackTo=${forced.fellBackTo} (tap still navigated +/-${changed} labels); ` +
        `swipe strategy=${forcedSwipe.strategy} fellBackTo=${forcedSwipe.fellBackTo}; ` +
        `gesture strategy=${forcedGesture.strategy} fellBackTo=${forcedGesture.fellBackTo}; reset → ${normal.strategy}`
    );
  }, 120_000);

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

  it("3i getNestedState (F12) — nested multi-window tree in one round-trip", async () => {
    await freshSettings();
    const st = await api.getNestedState();
    expect(st.tree.length).toBeGreaterThan(0);
    // Nested shape: the window root carries a children array (not a flat list).
    const root = st.tree[0]!;
    expect(Array.isArray(root.children)).toBe(true);
    expect(st.info.screenWidth).toBeGreaterThan(0);
    record(
      "3i getNestedState",
      "PASS",
      `${st.tree.length} window root(s), first root has ${root.children?.length ?? 0} children; nested shape ok`
    );
  }, 90_000);

  it("3m fingerprints opt-in — Σ(stages)≈captureMs, 1 traversal after tap, no forced rebuild", async () => {
    // Sum of the on-device capture stages (everything inside captureMs; idleMs is
    // the pre-capture waitForIdle and is excluded). Phase 3m adds `fingerprintMs`,
    // so nothing hides in the residual.
    // Phase 3n.2 (residual gate): `infoMs` (DisplayReader.read + isKeyboardVisible's
    // window enumeration) and `recycleMs` (forest recycle) are now first-class stages
    // — the two chunks of work that used to sit inside captureMs with no stage and
    // pushed the after-tap residual to 11 ms. `otherMs` is the server-computed
    // leftover (captureMs − Σ(named)); it is NOT summed here (it IS the residual), so
    // the gate |captureMs − Σ(stages)| ≤ 10 stays a real check on unaccounted work.
    const sumStages = (t: {
      rootMs?: number;
      windowsMs?: number;
      rootsMs?: number[];
      serializeMs?: number;
      encodeMs?: number;
      fingerprintMs?: number;
      infoMs?: number;
      recycleMs?: number;
    }): number =>
      (t.rootMs ?? 0) +
      (t.windowsMs ?? 0) +
      (t.rootsMs ?? []).reduce((a, b) => a + b, 0) +
      (t.serializeMs ?? 0) +
      (t.encodeMs ?? 0) +
      (t.fingerprintMs ?? 0) +
      (t.infoMs ?? 0) +
      (t.recycleMs ?? 0);
    const median = (xs: number[]): number => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)] ?? 0;
    };

    // ---- (A) Idle describes: residual within tolerance, no fingerprints requested.
    await freshSettings();
    const idleResiduals: number[] = [];
    // Phase 3n.2 (residual gate): collect the two newly-measured stages + the
    // server-computed leftover per sample so a 1 ms miss is interpretable instead of
    // a bare assertion (review "Residual gate diagnosis").
    const idleInfoMs: number[] = [];
    const idleRecycleMs: number[] = [];
    const idleOtherMs: number[] = [];
    // Phase 3n pre-registration: 20-sample median (was 5). Run 34840929610 failed the
    // |captureMs − Σ(stages)| ≤ 10 gate by 1 ms on a 5-sample median — too few samples
    // for a stable median. The 10 ms threshold is unchanged.
    for (let i = 0; i < 20; i++) {
      const st = await api.getNestedState({});
      expect(st.timings).toBeTruthy();
      idleResiduals.push(st.captureMs - sumStages(st.timings!));
      idleInfoMs.push(st.timings!.infoMs ?? 0);
      idleRecycleMs.push(st.timings!.recycleMs ?? 0);
      idleOtherMs.push(st.timings!.otherMs ?? 0);
      // Plain describe path: fingerprints NOT requested ⇒ absent, and ~0 cost.
      expect(st.hash).toBeUndefined();
      expect(st.timings!.fingerprintMs ?? 0).toBeLessThanOrEqual(5);
      // Phase 3m.1 (3M-H4): `version` is ABSENT while the AX clock is unarmed
      // (pinned at 0, no information) and a number once any armed read/action has
      // registered the listener — never a literal 0 a host could replay as
      // `sinceVersion: 0`. The clock is process-global and sticky, so its state
      // here depends on suite order; assert the invariant that holds either way.
      expect(st.version === undefined || typeof st.version === "number").toBe(true);
      if (st.version !== undefined) expect(st.version).toBeGreaterThanOrEqual(0);
    }
    const idleResidualMed = median(idleResiduals.map((r) => Math.abs(r)));
    expect(idleResidualMed).toBeLessThanOrEqual(10);

    // ---- (B) After-tap describes: same residual bound, and the capture never
    //          re-enters rootInActiveWindow (rootSource stays "windows").
    const tapTarget = async (): Promise<{ x: number; y: number }> => {
      const info = await freshSettings();
      const before = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
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
      return center(row);
    };
    const afterResiduals: number[] = [];
    const afterInfoMs: number[] = [];
    const afterRecycleMs: number[] = [];
    const afterOtherMs: number[] = [];
    let afterRootSource: string | undefined;
    // Phase 3n pre-registration: 20-sample median (was 5); threshold unchanged.
    for (let i = 0; i < 20; i++) {
      const c = await tapTarget();
      await api.tap(c.x, c.y);
      // settle:false shape — capture mid/just-after transition (waitTimeoutMs 0).
      const st = await api.getNestedState({ waitTimeoutMs: 0 });
      expect(st.timings).toBeTruthy();
      afterResiduals.push(st.captureMs - sumStages(st.timings!));
      afterInfoMs.push(st.timings!.infoMs ?? 0);
      afterRecycleMs.push(st.timings!.recycleMs ?? 0);
      afterOtherMs.push(st.timings!.otherMs ?? 0);
      afterRootSource = st.timings!.rootSource ?? afterRootSource;
      expect(st.hash).toBeUndefined(); // still opt-out on the plain describe path
    }
    const afterResidualMed = median(afterResiduals.map((r) => Math.abs(r)));
    // Phase 3n.2 (residual gate): print the 20 per-sample residuals + the new stage
    // medians so a miss is interpretable (review "Residual gate diagnosis": "do not
    // loosen, do not widen the sample count again" — decompose instead). Emitted to
    // the device-test log for both phases regardless of pass/fail.
    const residualReport =
      `idle |resid| med ${idleResidualMed}ms; after-tap |resid| med ${afterResidualMed}ms (<=10)\n` +
      `  idle residuals(signed) [${idleResiduals.join(", ")}]\n` +
      `  idle infoMs med ${median(idleInfoMs)} recycleMs med ${median(idleRecycleMs)} otherMs med ${median(idleOtherMs)}\n` +
      `  after residuals(signed) [${afterResiduals.join(", ")}]\n` +
      `  after infoMs med ${median(afterInfoMs)} recycleMs med ${median(afterRecycleMs)} otherMs med ${median(afterOtherMs)}`;
    console.log(`[3m residual gate]\n${residualReport}`);
    expect(afterResidualMed).toBeLessThanOrEqual(10);
    // The active root came from the interactive-windows snapshot, not
    // rootInActiveWindow (phase 3g fix not bypassed).
    expect(afterRootSource).toBe("windows");

    // ---- (C) Exactly ONE forest traversal per after-tap describe (was 2 pre-fix:
    //          the forced TreeStore.ensure() rebuild + the capture serialize).
    const c = await tapTarget();
    await api.tap(c.x, c.y);
    await api.waitForIdle(3000);
    const tBefore = ((await api.getInfo()) as { traversals?: number }).traversals ?? NaN;
    await api.getNestedState({ waitTimeoutMs: 0 });
    const tAfter = ((await api.getInfo()) as { traversals?: number }).traversals ?? NaN;
    expect(tAfter - tBefore).toBe(1);

    // ---- (D) Opt-IN: fingerprints requested ⇒ hashes present on both read RPCs.
    await freshSettings();
    const fpNested = await api.getNestedState({ fingerprints: true });
    expect(typeof fpNested.hash).toBe("string");
    expect((fpNested.hash ?? "").length).toBeGreaterThan(0);
    expect(typeof fpNested.idHash).toBe("string");
    // Phase 3m.1 (3M-H1): a real screen never carries the EMPTY_TREE_HASH sentinel.
    expect(fpNested.hash).not.toBe(EMPTY_TREE_HASH);
    expect(fpNested.stateHash).not.toBe(EMPTY_TREE_HASH);
    // Phase 3m.1 (3M-H4): a fingerprints read ARMS the clock, so `version` is a
    // number (not absent) and non-negative — the same value that describes `hash`.
    expect(typeof fpNested.version).toBe("number");
    const plainFlat = await api.getState({ includeScreenshot: false });
    expect(plainFlat.hash).toBeUndefined();
    // Clock is now armed (the opt-in reads above registered the listener), so even
    // a plain read reports a numeric version (3M-H4: armed ⇒ present).
    expect(typeof plainFlat.version).toBe("number");
    const fpFlat = await api.getState({ includeScreenshot: false, fingerprints: true });
    expect(typeof fpFlat.hash).toBe("string");
    expect((fpFlat.hash ?? "").length).toBeGreaterThan(0);
    expect(fpFlat.hash).not.toBe(EMPTY_TREE_HASH);
    expect(typeof fpFlat.version).toBe("number");

    record(
      "3m fingerprints opt-in",
      "PASS",
      `idle residual med ${idleResidualMed}ms, after-tap residual med ${afterResidualMed}ms (<=10); ` +
        `new stages after-tap: infoMs med ${median(afterInfoMs)}, recycleMs med ${median(afterRecycleMs)}, ` +
        `otherMs med ${median(afterOtherMs)}; rootSource=${afterRootSource}; ` +
        `after-tap traversals delta ${tAfter - tBefore} (==1); opt-out hash absent, opt-in hash present`
    );
  }, 300_000);

  it("3j paste (setClipboard + KEYCODE_PASTE / typeText fallback, F20) — URL lands in an EditText", async () => {
    const KEYCODE_PASTE = 279;
    // Focus the Settings search field (an EditText). Returns whether it focused.
    const focusSearch = async (): Promise<void> => {
      await freshSettings();
      const tree = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
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
    };
    const readField = async (): Promise<string> => {
      const after = (await api.getAccessibilityTree({ maxElements: 200 })).tree;
      const edit = after.find((e) => /edittext/i.test(e.className) && (e.text ?? "").length > 0);
      return edit?.text ?? after.find((e) => (e.text ?? "").length > 0)?.text ?? "";
    };
    const url = `https://ex.com/r?token=abcdef012345678${Date.now().toString().slice(-3)}`;
    const emoji = `party🎉time${Date.now().toString().slice(-3)}`;

    // ---- URL: clipboard-paste if the write round-trips, else type it (same focus). ----
    await focusSearch();
    const clip1 = await api.setClipboard(url);
    let urlVia = "unsupported";
    if (clip1.success) {
      await adbShell(serial, `input keyevent ${KEYCODE_PASTE}`);
      await sleep(800);
      await api.waitForIdle(3000);
      if ((await readField()).includes(url)) urlVia = "clipboard";
    }
    if (urlVia === "unsupported") {
      // Fallback: sendStringSync types printable ASCII (URLs, OTPs) verbatim — into
      // the field already focused above (no second focus). A single open-server RPC
      // can wedge under CI contention (client 10 s timeout, then it destroys the
      // socket); the client reconnects on the next call, so retry once rather than
      // failing the whole verb on one transient timeout.
      try {
        await api.typeText(url);
      } catch {
        await sleep(500);
        await focusSearch(); // reconnect + re-focus the field on the fresh socket
        await api.typeText(url).catch(() => undefined);
      }
      await sleep(800);
      await api.waitForIdle(3000).catch(() => undefined);
      if ((await readField()).includes(url)) urlVia = "typeText-fallback";
    }
    // The URL must land by SOME open-path method (F20: clipboard, else typing).
    expect(urlVia).not.toBe("unsupported");

    // ---- emoji: only the clipboard path can carry it. On API 35 the background
    // clipboard write is dropped and emoji can't be typed, so the OPEN path reports
    // unsupported (the full paste tool then falls back to the proprietary emulator
    // clipboard). Recorded, not hard-asserted — this is the F20 platform finding.
    await focusSearch();
    const clip2 = await api.setClipboard(emoji);
    let emojiVia = "unsupported (open path)";
    if (clip2.success) {
      await adbShell(serial, `input keyevent ${KEYCODE_PASTE}`);
      await sleep(800);
      await api.waitForIdle(3000);
      if ((await readField()).includes("🎉")) emojiVia = "clipboard";
    }
    record(
      "3j paste F20",
      "PASS",
      `setClipboard.success url=${clip1.success}/emoji=${clip2.success} (ClipboardManager from instrumentation); ` +
        `url landed via ${urlVia}; emoji via ${emojiVia}`
    );
  }, 120_000);

  it("3k getScreenSize during a running fling — 5 consecutive calls each < 50ms (no implicit idle gate, P3c fix 1)", async () => {
    const info = await freshSettings();
    const cx = Math.round(info.screenWidth / 2);
    const y0 = Math.round(info.screenHeight * 0.8);
    const y1 = Math.round(info.screenHeight * 0.2);
    // Fling: holdEndMs=0 means the lift carries momentum, so the Settings list
    // keeps scrolling AFTER swipe() returns — the UI is mid-animation for the
    // getScreenSize calls below.
    await api.swipe(cx, y0, cx, y1, 8, 0);
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const geo = await api.getScreenSize();
      timings.push(Date.now() - t0);
      expect(geo.screenWidth).toBe(info.screenWidth);
      expect(geo.screenHeight).toBe(info.screenHeight);
    }
    // Each call must be idle-free: reading straight from the platform Display
    // cannot block on the fling settling. Before P3c, getScreenSize peeked
    // uiDevice.displayRotation, whose implicit waitForIdle stalled here for
    // HUNDREDS of ms while the fling ran. Review A7/fix e: restored to the original
    // 50 ms bound — no observed run exceeded it (max 45 ms on the contended x86/KVM
    // runner), and a fling settle is hundreds of ms to >1 s, so 50 ms still cleanly
    // catches a re-introduced idle gate. The 4× loosening to 200 had no failure
    // behind it and let a real regression hide under runner jitter.
    const GATE_MS = 50;
    for (const dt of timings) expect(dt).toBeLessThan(GATE_MS);
    const worst = Math.max(...timings);
    record(
      "3k getScreenSize@fling",
      "PASS",
      `5 calls during fling: [${timings.join(", ")}]ms, worst ${worst}ms < ${GATE_MS}`
    );
  }, 90_000);
});
