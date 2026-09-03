/**
 * Offline host micro-bench for the open-device-server idle describe (phase 3i).
 *
 * The CI bench (`bench-open-vs-proprietary.ts`) measures the WHOLE idle describe
 * round-trip on a device; the server-side stages ride the reply as `timings`, but
 * the ~90 ms that lives OUTSIDE the Kotlin handler — NDJSON transport, host
 * `JSON.parse`, the nested→parsed→DescribeNode two-pass lowering, the v2 trim,
 * `formatDescribeTree`, and o200k tokenization — was unattributed. This script
 * runs those HOST stages on a committed nested-tree fixture, with NO device, so
 * the CPU cost of each stage is measurable and repeatable in isolation. Transport
 * cost (Nagle / `adb forward`) is device-only and is measured by the CI bench's
 * `ping` + `wireBytes`, not here.
 *
 * Fixture: `fixtures/describe-host-idle-settings.nested.json` — a representative
 * idle Settings root as the FULL nested tree the server emits, ~21 KB on the wire,
 * rendering to ~667 o200k tokens (the device idle Settings figure is 657).
 *
 * Run:  npx tsx packages/tool-server/scripts/bench-describe-host.ts [--iterations N] [--fixture path] [--no-tokenize]
 *
 * The exported harness (`loadFixture`, `percentile`, `stat`, `runHostBench`) is
 * unit-tested in `test/bench-describe-host.test.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  nestedRootsToParsedHierarchy,
  openServerNestedToDescribeNode,
  type OpenServerNestedElement,
} from "../src/tools/describe/platforms/android/open-server-tree";
import { buildDescribeTreeFromParsedRoot } from "../src/tools/describe/platforms/android/uiautomator-parser";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import { getEncoding } from "js-tiktoken";

export interface HostBenchFixture {
  description?: string;
  screen: { width: number; height: number };
  tree: OpenServerNestedElement[];
}

export const DEFAULT_FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "describe-host-idle-settings.nested.json"
);

export function loadFixture(path: string = DEFAULT_FIXTURE_PATH): HostBenchFixture {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as HostBenchFixture;
  if (!parsed || !Array.isArray(parsed.tree) || !parsed.screen) {
    throw new Error(`fixture at ${path} is missing { screen, tree[] }`);
  }
  return parsed;
}

/** Total nested elements under `roots` (the on-the-wire node count). */
export function countNodes(roots: OpenServerNestedElement[]): number {
  let n = 0;
  const stack = [...roots];
  while (stack.length > 0) {
    const el = stack.pop()!;
    n += 1;
    if (el.children) for (const c of el.children) stack.push(c);
  }
  return n;
}

/** Nearest-rank percentile of an UNSORTED sample array (`p` in 0..100). */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export interface StageStat {
  p50: number;
  p95: number;
  mean: number;
  min: number;
  n: number;
}

export function stat(samples: number[]): StageStat {
  const n = samples.length;
  if (n === 0) return { p50: NaN, p95: NaN, mean: NaN, min: NaN, n: 0 };
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  return { p50: percentile(samples, 50), p95: percentile(samples, 95), mean, min: Math.min(...samples), n };
}

export interface HostBenchPayload {
  /** UTF-8 byte length of the nested tree as it travels on the wire. */
  wireBytes: number;
  /** Nested element count over the wire. */
  nodeCount: number;
  /** Rendered describe text byte length (post-trim, post-format). */
  renderedBytes: number;
  /** Rendered describe line count. */
  renderedLines: number;
  /** o200k token count of the rendered describe, or null when tokenization is off/failed. */
  tokens: number | null;
}

export interface HostBenchResult {
  iterations: number;
  payload: HostBenchPayload;
  stages: {
    /** `JSON.parse` of the wire payload. */
    parseMs: StageStat;
    /** nested→parsed rebuild (`nestedRootsToParsedHierarchy`) — host pass 1. */
    lowerMs: StageStat;
    /** v2 trim + lower to DescribeNode (`buildDescribeTreeFromParsedRoot`) — host pass 2. */
    trimMs: StageStat;
    /** `formatDescribeTree`. */
    renderMs: StageStat;
    /** o200k tokenization (null-filled when off). */
    tokenizeMs: StageStat;
    /** Full host pipeline parse→…→tokenize, end to end. */
    totalMs: StageStat;
  };
}

type Encoder = { encode: (s: string) => number[] } | null;

function loadEncoder(): Encoder {
  try {
    return getEncoding("o200k_base");
  } catch {
    return null;
  }
}

function timeIt(iterations: number, fn: () => void): number[] {
  const out: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    out[i] = performance.now() - t0;
  }
  return out;
}

export interface RunHostBenchOptions {
  iterations?: number;
  warmup?: number;
  tokenize?: boolean;
}

export function runHostBench(
  fixture: HostBenchFixture,
  opts: RunHostBenchOptions = {}
): HostBenchResult {
  const iterations = opts.iterations ?? 200;
  const warmup = opts.warmup ?? Math.min(20, iterations);
  const doTokenize = opts.tokenize ?? true;
  const { width, height } = fixture.screen;

  // Fixed inputs: each stage is timed on the output of the previous stage,
  // computed once, so a stage's number is that stage alone (not compounded).
  const wireString = JSON.stringify(fixture.tree);
  const wireBytes = Buffer.byteLength(wireString, "utf8");
  const parsedTree = JSON.parse(wireString) as OpenServerNestedElement[];
  const hierarchy = nestedRootsToParsedHierarchy(parsedTree);
  const node = buildDescribeTreeFromParsedRoot(hierarchy, width, height);
  const rendered = formatDescribeTree(node, { source: "open-device-server" });
  const encoder = doTokenize ? loadEncoder() : null;
  const tokens = encoder ? encoder.encode(rendered).length : null;

  // Warm the JITs before the measured loop.
  for (let i = 0; i < warmup; i++) {
    const h = nestedRootsToParsedHierarchy(JSON.parse(wireString) as OpenServerNestedElement[]);
    const dn = buildDescribeTreeFromParsedRoot(h, width, height);
    const txt = formatDescribeTree(dn, { source: "open-device-server" });
    if (encoder) encoder.encode(txt);
  }

  const parseMs = timeIt(iterations, () => {
    JSON.parse(wireString);
  });
  const lowerMs = timeIt(iterations, () => {
    nestedRootsToParsedHierarchy(parsedTree);
  });
  const trimMs = timeIt(iterations, () => {
    buildDescribeTreeFromParsedRoot(hierarchy, width, height);
  });
  const renderMs = timeIt(iterations, () => {
    formatDescribeTree(node, { source: "open-device-server" });
  });
  const tokenizeMs = encoder
    ? timeIt(iterations, () => {
        encoder.encode(rendered);
      })
    : [];
  // TOTAL excludes tokenization on purpose: the describe tool renders the tree to
  // text and returns it (tools/describe/index.ts) — it NEVER tokenizes. o200k is a
  // bench/agent-side cost, reported as a separate informational row below.
  const totalMs = timeIt(iterations, () => {
    const parsed = JSON.parse(wireString) as OpenServerNestedElement[];
    const dn = openServerNestedToDescribeNode(parsed, width, height);
    formatDescribeTree(dn, { source: "open-device-server" });
  });

  return {
    iterations,
    payload: {
      wireBytes,
      nodeCount: countNodes(fixture.tree),
      renderedBytes: Buffer.byteLength(rendered, "utf8"),
      renderedLines: rendered.split("\n").length,
      tokens,
    },
    stages: {
      parseMs: stat(parseMs),
      lowerMs: stat(lowerMs),
      trimMs: stat(trimMs),
      renderMs: stat(renderMs),
      tokenizeMs: stat(tokenizeMs),
      totalMs: stat(totalMs),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

function fmt(ms: number): string {
  return Number.isFinite(ms) ? ms.toFixed(4) : "   -  ";
}

// A real idle-Settings nested reply measured on-device (run 33784227150) is
// ~31877 B on the wire; this synthetic fixture is smaller, so the host CPU numbers
// are a LOWER bound. Reported so the fixture is never mistaken for a device capture.
const REAL_WIRE_REF_BYTES = 31877;

function printReport(result: HostBenchResult): void {
  const { payload, stages, iterations } = result;
  const rows: Array<[string, StageStat]> = [
    ["JSON.parse", stages.parseMs],
    ["nested->parsed (pass 1)", stages.lowerMs],
    ["v2 trim (pass 2)", stages.trimMs],
    ["formatDescribeTree", stages.renderMs],
    ["o200k tokenize (informational, NOT in TOTAL)", stages.tokenizeMs],
    ["TOTAL host (parse+lower+trim+render)", stages.totalMs],
  ];
  const pctOfWire = Math.round((payload.wireBytes / REAL_WIRE_REF_BYTES) * 100);
  const lines: string[] = [];
  lines.push(`[bench-describe-host] iterations=${iterations}`);
  lines.push(
    `[bench-describe-host] fixture: SYNTHETIC (~${pctOfWire}% of a real ~${REAL_WIRE_REF_BYTES} B wire reply) — host CPU here is a lower bound`
  );
  lines.push(
    `[bench-describe-host] payload: wireBytes=${payload.wireBytes} nodes=${payload.nodeCount} ` +
      `renderedBytes=${payload.renderedBytes} renderedLines=${payload.renderedLines} tokens=${payload.tokens ?? "n/a"}`
  );
  lines.push(`[bench-describe-host] host stage p50 / p95 / mean (ms) — TOTAL excludes tokenize`);
  for (const [label, s] of rows) {
    lines.push(
      `[bench-describe-host]   ${label.padEnd(24)} ${fmt(s.p50).padStart(9)} / ${fmt(s.p95).padStart(9)} / ${fmt(s.mean).padStart(9)}`
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
  // Machine-readable line for a CI step to grep/capture.
  process.stdout.write(`RESULT_JSON=${JSON.stringify(result)}\n`);
}

function parseArgs(argv: string[]): { iterations?: number; fixture?: string; tokenize: boolean } {
  let iterations: number | undefined;
  let fixture: string | undefined;
  let tokenize = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--iterations" || a === "-n") iterations = Number(argv[++i]);
    else if (a === "--fixture" || a === "-f") fixture = argv[++i];
    else if (a === "--no-tokenize") tokenize = false;
  }
  return { iterations, fixture, tokenize };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isMain()) {
  const { iterations, fixture, tokenize } = parseArgs(process.argv.slice(2));
  const fx = loadFixture(fixture);
  const result = runHostBench(fx, { iterations, tokenize });
  printReport(result);
}
