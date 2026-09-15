/**
 * Pure harness for the offline host micro-bench (phase 3i) — everything the unit
 * test in `test/bench-describe-host.test.ts` exercises, with NO `import.meta`.
 *
 * The CLI entry (`bench-describe-host.ts`) owns `DEFAULT_FIXTURE_PATH` and the
 * `import.meta.url` main-check; that file needs bundler resolution + module
 * `esnext` (see scripts/tsconfig.json). This lib is imported into BOTH the CLI
 * (run under tsx) and the CommonJS `tsconfig.test.json` compile, so it must stay
 * `import.meta`-free or `typecheck:tests` fails with TS1343. The test passes an
 * explicit fixture path resolved from its own `__dirname`.
 *
 * See `bench-describe-host.ts` for what each stage measures and why.
 */
import { readFileSync } from "node:fs";
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

export function loadFixture(path: string): HostBenchFixture {
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
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    mean,
    min: Math.min(...samples),
    n,
  };
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
