/**
 * Backend benchmark: argent proprietary Android path (flag `open-device-server`
 * OFF -> simulator-server binary + argent-android-devtools APK) vs the open
 * Kotlin android-device-server (flag ON), on a single booted AVD.
 *
 * MEASUREMENT ONLY. Opt-in, not a test (lives under scripts/, not test/**). It
 * drives the SAME tool-registry call sites an agent hits (`describe`,
 * `screenshot`, `gesture-tap`, `gesture-swipe`, `await-ui-element`,
 * `await-screen-idle`, `paste`, `gesture-pinch`) via `registry.invokeTool`,
 * toggling the flag per block. Because the open path silently falls back to the
 * proprietary path on any failure, it (a) asserts `describe.source` per config,
 * (b) captures the tool-server's `console.debug` fallback lines, and (c) checks
 * the simulator-server host process — so a masked fallback is visible in the
 * output rather than silently scored as the wrong backend.
 *
 * The UiAutomation channel is exclusive AND exclusive between the ADT apk and
 * the open server: blocks run OFF-1 -> ON -> OFF-2, force-stopping the other
 * instrumentation + killing simulator-server between blocks. OFF-2 detects drift.
 *
 * Run against a booted emulator that exposes gRPC with a token (the proprietary
 * simulator-server `android` controller discovers the emulator via the
 * grpc.port/grpc.token in ~/Library/Caches/TemporaryItems/avd/running/*.ini,
 * only written when gRPC is enabled with a port):
 *
 *   emulator -avd <avd> -no-window -no-audio -no-boot-anim -grpc 8554 -grpc-use-token
 *
 * Point the proprietary path at the vendored binaries and run under ts-node.
 * This package's composite tsconfig (rootDir ./src) rejects a file under
 * scripts/, so register ts-node with skipProject via a tiny loader run from the
 * repo root (cwd must be the repo root so the flag file + output dir resolve):
 *
 *   // run-bench.js
 *   require("ts-node").register({ transpileOnly: true, skipProject: true,
 *     compilerOptions: { module: "commonjs", target: "ES2022",
 *       moduleResolution: "node", esModuleInterop: true, resolveJsonModule: true,
 *       skipLibCheck: true, strict: false, ignoreDeprecations: "6.0" } });
 *   require("./packages/tool-server/scripts/bench-open-vs-proprietary.ts");
 *
 *   ARGENT_SIMULATOR_SERVER_DIR=<pkg>/bin \
 *   ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR=<pkg>/bin \
 *   ARGENT_NATIVE_DEVTOOLS_DIR=<pkg>/dylibs \
 *   ANDROID_HOME=$HOME/Library/Android/sdk BENCH_SERIAL=emulator-5554 \
 *   node run-bench.js
 *
 * Env knobs: BENCH_SERIAL (default emulator-5554), BENCH_N (20), BENCH_WARMUP (3),
 * BENCH_COLD (3), BENCH_OUT (default <cwd>/.bench-results).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "../src/utils/setup-registry";
import { setFlag, unsetFlag } from "@argent/configuration-core";

/* -------------------------------------------------------------------------- */
/* Config + guards                                                            */
/* -------------------------------------------------------------------------- */

const SERIAL = process.env.BENCH_SERIAL ?? "emulator-5554";
const N = Number(process.env.BENCH_N ?? 20);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 3);
const COLD = Number(process.env.BENCH_COLD ?? 3);
const OUT_DIR = process.env.BENCH_OUT ?? join(process.cwd(), ".bench-results");
const PHYSICAL_DENY = "ZF524RZBHD";

if (SERIAL === PHYSICAL_DENY) throw new Error(`refuse to target physical device ${PHYSICAL_DENY}`);
if (!SERIAL.startsWith("emulator-")) {
  throw new Error(`BENCH_SERIAL must be an emulator- serial (got "${SERIAL}"); refusing.`);
}

const SETTINGS = "com.android.settings";
const CHROME = "com.android.chrome";
const OPEN_PKG = "com.argent.devicecontrol";
const ADT_PKG = "com.argent.androiddevtools";
const DS_PKGS = ["com.devicestream.server", "com.devicestream.server.test"];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* adb (always explicit -s SERIAL; never the physical device)                 */
/* -------------------------------------------------------------------------- */

function adb(args: string[], timeoutMs = 20_000): string {
  return execFileSync("adb", ["-s", SERIAL, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function adbShell(cmd: string, timeoutMs = 20_000): string {
  return adb(["shell", cmd], timeoutMs);
}

/* -------------------------------------------------------------------------- */
/* console.debug capture (the tool-server logs fallbacks there)               */
/* -------------------------------------------------------------------------- */

const debugLines: string[] = [];
const realDebug = console.debug.bind(console);
console.debug = (...a: unknown[]): void => {
  debugLines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
};
function fallbackCountSince(mark: number): { count: number; samples: string[] } {
  const slice = debugLines.slice(mark);
  const hits = slice.filter((l) => /falling back|fell back|fallback/i.test(l));
  return { count: hits.length, samples: hits.slice(0, 3) };
}

/* -------------------------------------------------------------------------- */
/* stats + estimators                                                          */
/* -------------------------------------------------------------------------- */

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
function summarize(xs: number[]): {
  n: number;
  p50: number;
  p95: number;
  max: number;
  min: number;
  mean: number;
} {
  const s = xs.slice().sort((a, b) => a - b);
  const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  return {
    n: xs.length,
    p50: pct(s, 50),
    p95: pct(s, 95),
    max: s.length ? s[s.length - 1]! : NaN,
    min: s.length ? s[0]! : NaN,
    mean: Number(mean.toFixed(1)),
  };
}
// Estimator: the token-bench harness prefers js-tiktoken(o200k_base); it is not
// installed in this checkout, so we use the spec's documented chars/4 fallback.
const TOKENIZER = "chars/4 (js-tiktoken o200k_base not installed in checkout)";
const estTokens = (s: string): number => Math.ceil(s.length / 4);

/* -------------------------------------------------------------------------- */
/* describe text parsing (same formatDescribeTree output for both configs)     */
/* -------------------------------------------------------------------------- */

function parseDescribe(desc: string): { elements: number; idTextSet: string[] } {
  const lines = desc.split("\n");
  const rootIdx = lines.findIndex((l) => l.startsWith("ROOT "));
  const body = lines.slice(rootIdx + 1).filter((l) => l.trim().length > 0);
  const set = new Set<string>();
  for (const line of body) {
    const idM = line.match(/\bid="((?:[^"\\]|\\.)*)"/);
    const labelM = line.match(/(?<![=\w])"((?:[^"\\]|\\.)*)"/); // first quoted, not name="..."
    const id = idM?.[1];
    const label = labelM?.[1];
    if (id) set.add(`id:${id}`);
    if (label) set.add(`text:${label}`);
  }
  return { elements: body.length, idTextSet: [...set] };
}
function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni === 0 ? 1 : Number((inter / uni).toFixed(3));
}

/* -------------------------------------------------------------------------- */
/* PNG dims                                                                    */
/* -------------------------------------------------------------------------- */

function pngInfo(path: string): { bytes: number; width: number; height: number; sig: boolean } {
  const buf = readFileSync(path);
  const sig =
    buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const width = sig ? buf.readUInt32BE(16) : 0;
  const height = sig ? buf.readUInt32BE(20) : 0;
  return { bytes: statSync(path).size, width, height, sig };
}

/* -------------------------------------------------------------------------- */
/* backend teardown                                                            */
/* -------------------------------------------------------------------------- */

function killSimServerForEmulator(): void {
  // Only ever the emulator's controller; never `android_device --id <physical>`.
  try {
    const out = execFileSync("pgrep", ["-f", `simulator-server .*android --id ${SERIAL}`], {
      encoding: "utf8",
    });
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      try {
        execFileSync("kill", [pid]);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* none running */
  }
}
function simServerRssKb(): number | null {
  try {
    const out = execFileSync("pgrep", ["-f", `simulator-server .*android --id ${SERIAL}`], {
      encoding: "utf8",
    });
    const pid = out.split(/\s+/).filter(Boolean)[0];
    if (!pid) return null;
    const rss = execFileSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf8" }).trim();
    return rss ? Number(rss) : null;
  } catch {
    return null;
  }
}
function forceStopInstrumentation(): void {
  for (const pkg of [OPEN_PKG, ADT_PKG, ...DS_PKGS]) {
    try {
      adbShell(`am force-stop ${pkg}`, 8_000);
    } catch {
      /* best effort */
    }
  }
}
async function teardownBackend(reg?: Awaited<ReturnType<typeof createRegistry>>): Promise<void> {
  if (reg) await reg.dispose().catch(() => undefined);
  forceStopInstrumentation();
  killSimServerForEmulator();
  await sleep(1200);
}

/* -------------------------------------------------------------------------- */
/* screen setup                                                                */
/* -------------------------------------------------------------------------- */

type Reg = ReturnType<typeof createRegistry>;

function dismissSystemDialogs(): void {
  try {
    adbShell("am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS", 5_000);
  } catch {
    /* best effort */
  }
}
async function ensureSettings(reg: Reg): Promise<void> {
  dismissSystemDialogs();
  adbShell(`am force-stop ${SETTINGS}`, 8_000);
  // Reset Settings so a restored search screen (with leftover paste text) can't
  // masquerade as the root; guarantees the pristine-root describe is comparable.
  try {
    adbShell(`pm clear ${SETTINGS}`, 8_000);
  } catch {
    /* fall through to plain launch */
  }
  await sleep(300);
  adbShell(`am start -n ${SETTINGS}/.Settings`, 8_000);
  await sleep(1500);
  await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
}

// A describe validated to be the real Settings root: not a crash dialog, and
// carrying at least one canonical root row. Retries the screen reset a few times
// so a transient ADT crash can't poison the byte/element/fidelity numbers.
async function cleanSettingsDescribe(
  reg: Reg
): Promise<{ description: string; source: string }> {
  let last = { description: "", source: "" };
  for (let attempt = 0; attempt < 4; attempt++) {
    await ensureSettings(reg);
    try {
      const d = (await reg.invokeTool("describe", { udid: SERIAL })) as {
        description: string;
        source: string;
      };
      last = d;
      const crashed = /keeps stopping|aerr_|isn't responding/i.test(d.description);
      const rootish = /network|battery|display|storage|connected|apps|sound|notif/i.test(
        d.description
      );
      if (!crashed && rootish) return d;
    } catch {
      /* retry */
    }
    dismissSystemDialogs();
    await sleep(600);
  }
  return last;
}
async function ensureChrome(reg: Reg): Promise<boolean> {
  adbShell(`am force-stop ${CHROME}`, 8_000);
  await sleep(500);
  // Load a deterministic, pinch-zoomable page directly via a VIEW intent.
  adbShell(
    `am start -a android.intent.action.VIEW -d https://example.com ${CHROME}`,
    12_000
  );
  await sleep(3500);
  await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 5000 }).catch(() => undefined);
  // Confirm we are actually in Chrome (a cold FRE would block content).
  try {
    const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
    return /example|more information|url_bar|search/i.test(d.description);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* measurement                                                                 */
/* -------------------------------------------------------------------------- */

interface VerbResult {
  verb: string;
  latency: ReturnType<typeof summarize>;
  errors: number;
  fallbacks: number;
  fallbackSamples: string[];
  extra?: Record<string, unknown>;
}

async function timeCalls(
  label: string,
  fn: (i: number) => Promise<void>,
  extra?: () => Record<string, unknown>
): Promise<VerbResult> {
  for (let i = 0; i < WARMUP; i++) await fn(i).catch(() => undefined);
  const mark = debugLines.length;
  const lat: number[] = [];
  let errors = 0;
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    try {
      await fn(i);
      lat.push(Date.now() - t0);
    } catch {
      errors++;
    }
  }
  const fb = fallbackCountSince(mark);
  return {
    verb: label,
    latency: summarize(lat),
    errors,
    fallbacks: fb.count,
    fallbackSamples: fb.samples,
    extra: extra?.(),
  };
}

interface BlockResult {
  block: string;
  config: "OFF" | "ON";
  coldStartMs: number[];
  verbs: VerbResult[];
  describeSample: { source: string; bytes: number; tokens: number; elements: number };
  fidelitySet: string[];
  screenshot: { bytes: number; width: number; height: number; format: string };
  simServerRssKb: number | null;
  notes: string[];
}

async function coldStart(config: "OFF" | "ON"): Promise<number[]> {
  const out: number[] = [];
  for (let k = 0; k < COLD; k++) {
    await teardownBackend();
    const reg = createRegistry();
    const t0 = Date.now();
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { source: string };
        ok = true;
        out.push(Date.now() - t0);
        void d;
      } catch {
        await sleep(500);
      }
    }
    if (!ok) out.push(NaN);
    await reg.dispose().catch(() => undefined);
  }
  return out;
}

async function runBlock(block: string, config: "OFF" | "ON"): Promise<BlockResult> {
  const notes: string[] = [];
  if (config === "ON") setFlag("open-device-server", true, "project");
  else unsetFlag("open-device-server", "project");

  const coldStartMs = await coldStart(config);

  await teardownBackend();
  const reg = createRegistry();
  const verbs: VerbResult[] = [];

  // ---- Settings root screen ----
  // Validated pristine-root describe first: this is the sample used for
  // bytes/tokens/elements/fidelity, immune to the latency loop and transient
  // crash dialogs.
  const clean = await cleanSettingsDescribe(reg);
  const lastDesc = clean.description;
  const lastSource = clean.source;
  const parsed = parseDescribe(lastDesc);

  // describe latency (measured separately; screen already at root)
  const describeRes = await timeCalls("describe", async () => {
    await reg.invokeTool("describe", { udid: SERIAL });
  });
  const describeSample = {
    source: lastSource,
    bytes: Buffer.byteLength(lastDesc, "utf8"),
    tokens: estTokens(lastDesc),
    elements: parsed.elements,
  };
  const expectSource = config === "ON" ? "open-device-server" : "android-devtools|uiautomator";
  if (config === "ON" && lastSource !== "open-device-server") {
    notes.push(`describe.source="${lastSource}" (expected open-device-server) — masked fallback`);
  }
  if (config === "OFF" && !/android-devtools|uiautomator/.test(lastSource)) {
    notes.push(`describe.source="${lastSource}" (expected ${expectSource})`);
  }
  verbs.push(describeRes);

  // screenshot
  let shot = { bytes: 0, width: 0, height: 0, format: "unknown" };
  const screenshotRes = await timeCalls("screenshot", async () => {
    const s = (await reg.invokeTool("screenshot", {
      udid: SERIAL,
      includeImageInContext: false,
    })) as { image: { hostPath: string; mimeType: string; size: number } };
    const info = pngInfo(s.image.hostPath);
    shot = {
      bytes: info.bytes,
      width: info.width,
      height: info.height,
      format: s.image.mimeType + (info.sig ? " (PNG sig ok)" : " (no PNG sig)"),
    };
  });
  verbs.push(screenshotRes);

  // gesture-tap (fixed neutral coordinate; latency = inject round-trip)
  verbs.push(
    await timeCalls("gesture-tap", async () => {
      await reg.invokeTool("gesture-tap", { udid: SERIAL, x: 0.5, y: 0.5 });
    })
  );

  // re-establish settings after taps navigated
  await ensureSettings(reg);

  // gesture-swipe
  verbs.push(
    await timeCalls("gesture-swipe", async () => {
      await reg.invokeTool("gesture-swipe", {
        udid: SERIAL,
        fromX: 0.5,
        fromY: 0.7,
        toX: 0.5,
        toY: 0.35,
        durationMs: 250,
      });
    })
  );

  await ensureSettings(reg);

  // await-screen-idle (already idle -> resolve time)
  verbs.push(
    await timeCalls("await-screen-idle", async () => {
      await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 });
    })
  );

  // await-ui-element: pick a present label from the current describe
  let selText = "Settings";
  try {
    const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
    const m = d.description.split("\n").map((l) => l.match(/(?<![=\w])"((?:[^"\\]|\\.)*)"/)?.[1]);
    const cand = m.find((x): x is string => !!x && x.length > 2 && x.length < 30);
    if (cand) selText = cand;
  } catch {
    /* keep default */
  }
  verbs.push(
    await timeCalls(
      "await-ui-element",
      async () => {
        await reg.invokeTool("await-ui-element", {
          udid: SERIAL,
          condition: "exists",
          selector: { text: selText },
          timeoutMs: 4000,
        });
      },
      () => ({ selector: selText })
    )
  );

  // paste: open Settings search, focus field, then type into it N times
  await ensureSettings(reg);
  let pasteReady = false;
  try {
    const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
    // Find the search entry line and tap its centre.
    const line = d.description
      .split("\n")
      .find((l) => /search/i.test(l) && /\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)/.test(l));
    const fm = line?.match(/\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)\s*$/);
    if (fm) {
      const x = Number(fm[1]) + Number(fm[3]) / 2;
      const y = Number(fm[2]) + Number(fm[4]) / 2;
      await reg.invokeTool("gesture-tap", { udid: SERIAL, x, y });
      await sleep(1200);
      pasteReady = true;
    }
  } catch {
    /* pasteReady stays false */
  }
  if (!pasteReady) notes.push("paste: could not locate Settings search field; measured on current focus");
  verbs.push(
    await timeCalls("paste", async (i) => {
      await reg.invokeTool("paste", { udid: SERIAL, text: `b${i % 10}` });
    })
  );

  // gesture-pinch on Chrome/example.com
  const chromeOk = await ensureChrome(reg);
  if (!chromeOk) notes.push("gesture-pinch: Chrome/example.com did not confirm content; latency still measured");
  verbs.push(
    await timeCalls("gesture-pinch", async (i) => {
      const zoomIn = i % 2 === 0;
      await reg.invokeTool("gesture-pinch", {
        udid: SERIAL,
        centerX: 0.5,
        centerY: 0.4,
        startDistance: zoomIn ? 0.08 : 0.42,
        endDistance: zoomIn ? 0.42 : 0.08,
        durationMs: 300,
      });
    })
  );

  const rss = config === "OFF" ? simServerRssKb() : null;
  if (config === "ON") notes.push("host process: none beyond adb (open server runs on-device via am instrument)");

  // Fidelity is compared on the pristine Settings root captured at block start
  // (before any tap/paste/keyboard state), so OFF and ON are the same screen.
  const fidelitySet = parsed.idTextSet;

  await reg.dispose().catch(() => undefined);
  await teardownBackend();

  return {
    block,
    config,
    coldStartMs,
    verbs,
    describeSample,
    fidelitySet,
    screenshot: shot,
    simServerRssKb: rss,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date().toISOString();

  // environment capture
  const env = {
    startedAt: started,
    serial: SERIAL,
    N,
    WARMUP,
    COLD,
    tokenizer: TOKENIZER,
    androidRelease: adbShell("getprop ro.build.version.release").trim(),
    androidSdk: adbShell("getprop ro.build.version.sdk").trim(),
    abi: adbShell("getprop ro.product.cpu.abi").trim(),
    screen: adbShell("wm size").trim(),
    density: adbShell("wm density").trim(),
    simulatorServerDir: process.env.ARGENT_SIMULATOR_SERVER_DIR ?? null,
    devtoolsAndroidBinDir: process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR ?? null,
  };
  realDebug("[bench] env:", JSON.stringify(env));

  const blocks: BlockResult[] = [];
  for (const [block, config] of [
    ["OFF-1", "OFF"],
    ["ON", "ON"],
    ["OFF-2", "OFF"],
  ] as Array<[string, "OFF" | "ON"]>) {
    realDebug(`[bench] === block ${block} (${config}) ===`);
    const r = await runBlock(block, config);
    blocks.push(r);
    realDebug(
      `[bench] ${block} done: describe p50=${r.verbs[0]?.latency.p50}ms source=${r.describeSample.source} ` +
        `screenshot=${r.screenshot.bytes}b cold=${JSON.stringify(r.coldStartMs)} rss=${r.simServerRssKb}`
    );
  }

  // reset flag to default OFF
  unsetFlag("open-device-server", "project");

  const off1 = blocks.find((b) => b.block === "OFF-1")!;
  const on = blocks.find((b) => b.block === "ON")!;
  const result = {
    env,
    blocks,
    fidelity: {
      off1_vs_on_jaccard: jaccard(off1.fidelitySet, on.fidelitySet),
      onlyOff: off1.fidelitySet.filter((x) => !on.fidelitySet.includes(x)),
      onlyOn: on.fidelitySet.filter((x) => !off1.fidelitySet.includes(x)),
      offCount: off1.fidelitySet.length,
      onCount: on.fidelitySet.length,
    },
    finishedAt: new Date().toISOString(),
  };

  const outPath = join(OUT_DIR, `bench-${started.replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  realDebug(`[bench] wrote ${outPath}`);
  // Print the path last so the caller can capture it.
  process.stdout.write(`RESULT_JSON=${outPath}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    realDebug("[bench] FATAL", e);
    process.exit(1);
  });
