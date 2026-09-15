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
 * The harness (`loadFixture`, `percentile`, `stat`, `runHostBench`, …) lives in
 * `bench-describe-host-lib.ts` and is unit-tested in `test/bench-describe-host.test.ts`.
 * It is kept out of this file so the `import.meta.url` main-check below never
 * reaches the CommonJS `tsconfig.test.json` compile (TS1343).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadFixture,
  runHostBench,
  type HostBenchResult,
  type StageStat,
} from "./bench-describe-host-lib";

export const DEFAULT_FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "describe-host-idle-settings.nested.json"
);

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
  const fx = loadFixture(fixture ?? DEFAULT_FIXTURE_PATH);
  const result = runHostBench(fx, { iterations, tokenize });
  printReport(result);
}
