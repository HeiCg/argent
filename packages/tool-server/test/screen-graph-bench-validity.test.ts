import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INVALID_LABEL,
  interruptedSkip,
  invalidConfigs,
  notRunSkip,
  plannedTaskRuns,
  validityExitCode,
} from "../src/screen-graph/bench/validity";

// Run 37215518035: the emulator died during B2; O1..O5 each "aborted after 3
// consecutive task errors" with 0/3 scored, yet the job concluded SUCCESS.
const FIXTURE = resolve(__dirname, "fixtures/screen-graph-run-37215518035.json");
type Rec = Record<string, unknown> & { config: string };
type Run = {
  env: Record<string, unknown>;
  records: Rec[];
  aggregates: Array<{ config: string; total: number; scored: number; excluded: number }>;
  skipped: Record<string, string>;
};
const load = (): Run => JSON.parse(readFileSync(FIXTURE, "utf8")) as Run;

const agg = (config: string, total = 100, scored = 100, excluded = 0) => ({
  config,
  total,
  scored,
  excluded,
});

describe("screen-graph validity gate — pure", () => {
  it("planned task-runs = reps × tasks", () => {
    expect(plannedTaskRuns({ reps: 5, tasks: 20 })).toBe(100);
    expect(plannedTaskRuns({})).toBeNull();
  });

  it("run 37215518035 shape: B1 valid, B2 + O1..O5 INVALID, non-zero exit", () => {
    const run = load();
    const invalid = invalidConfigs({
      aggregates: run.aggregates,
      skipped: run.skipped,
      planned: plannedTaskRuns(run.env),
    });
    expect(invalid.map((v) => v.config)).toEqual(["B2", "O1", "O2", "O3", "O4", "O5"]);
    expect(invalid.find((v) => v.config === "O3")!.reason).toMatch(
      /aborted after 3 consecutive task errors/
    );
    expect(validityExitCode(invalid)).toBe(1);
  });

  it("a fully healthy matrix is valid (exit 0)", () => {
    const invalid = invalidConfigs({
      aggregates: ["B1", "B2", "O1", "O2", "O3", "O4", "O5"].map((c) => agg(c)),
      skipped: {},
      planned: 100,
    });
    expect(invalid).toEqual([]);
    expect(validityExitCode(invalid)).toBe(0);
  });

  it("locate/action/oracle failures keep their meaning: failures, never invalidation", () => {
    // These are failure REASONS counted against the config (excluded stays 0); the
    // existing B1-invalid / -note / -provenance annotations are not infra aborts.
    const invalid = invalidConfigs({
      aggregates: [agg("B1"), agg("O5")],
      skipped: {
        "B1-invalid": "2 describe/tree fallback(s) — proprietary path NOT exercised",
        "O5-note": "no warm store (earlier configs recorded none)",
      },
      planned: 100,
    });
    expect(invalid).toEqual([]);
  });

  it("one pre-action infra exclusion (device not found) invalidates the config", () => {
    const invalid = invalidConfigs({
      aggregates: [agg("O2", 100, 99, 1)],
      skipped: {},
      planned: 100,
    });
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.reason).toMatch(/1 run\(s\) excluded as pre-action infrastructure faults/);
  });

  it("fewer task-runs than planned invalidates the config", () => {
    const invalid = invalidConfigs({
      aggregates: [agg("O1", 40, 40, 0)],
      skipped: {},
      planned: 100,
    });
    expect(invalid[0]!.reason).toMatch(/ran 40\/100 planned task-runs/);
  });

  it("a documented skip (proprietary unavailable) is not an invalidation", () => {
    const invalid = invalidConfigs({
      aggregates: [agg("B2")],
      skipped: { B1: "proprietary binaries unavailable: binary missing" },
      planned: 100,
    });
    expect(invalid).toEqual([]);
  });

  it("watchdog interruption: the in-flight and never-run configs are INVALID", () => {
    const lost = {
      lostAt: "2026-10-04T16:38:40Z",
      reason: "adb get-state failed 3 consecutive checks",
      context: "config O2",
    };
    const skipped = { O2: interruptedSkip(lost), O3: notRunSkip(lost) };
    expect(skipped.O2).toBe(
      "interrupted: emulator lost at 2026-10-04T16:38:40Z (adb get-state failed 3 consecutive checks)"
    );
    expect(skipped.O3).toBe("not run: emulator lost at 2026-10-04T16:38:40Z");
    const invalid = invalidConfigs({
      aggregates: [agg("B1"), agg("O2", 12, 12, 0)],
      skipped,
      planned: 100,
    });
    expect(invalid.map((v) => v.config)).toEqual(["O2", "O3"]);
    expect(interruptedSkip(null, "2026-10-04T17:00:00Z")).toBe(
      "interrupted: SIGTERM at 2026-10-04T17:00:00Z (no emulator-lost marker)"
    );
  });
});

// End to end through the harness's offline regen path (BENCH_REGEN): the same
// decision the live run makes, rendered into results-ci.md and the process exit code.
const REPO = resolve(__dirname, "../../..");
const LOADER =
  'require("ts-node").register({transpileOnly:true,skipProject:true,compilerOptions:{module:"commonjs",target:"ES2022",moduleResolution:"node",esModuleInterop:true,resolveJsonModule:true,skipLibCheck:true,strict:false,ignoreDeprecations:"6.0"}}); require("./packages/tool-server/scripts/bench-screen-graph.ts");';

function regen(json: Run): { code: number; md: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "sg-validity-"));
  const src = join(dir, "bench-sg.json");
  const report = join(dir, "results-ci.md");
  writeFileSync(src, JSON.stringify(json));
  let code = 0;
  let stderr = "";
  try {
    execFileSync("node", ["-e", LOADER], {
      cwd: REPO,
      env: {
        ...process.env,
        BENCH_REGEN: src,
        BENCH_OUT: dir,
        BENCH_REPORT: report,
        BENCH_REPS: "5",
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    code = err.status ?? 1;
    stderr = String(err.stderr ?? "");
  }
  return { code, md: readFileSync(report, "utf8"), stderr };
}

/** The fixture's healthy B1 runs, cloned for every config (a fully valid matrix). */
function healthy(): Run {
  const run = load();
  const b1 = run.records.filter((r) => r.config === "B1");
  const configs = ["B1", "B2", "O1", "O2", "O3", "O4", "O5"];
  return {
    ...run,
    records: configs.flatMap((c) => b1.map((r) => ({ ...r, config: c }))),
    aggregates: [],
    skipped: {},
  };
}

/** The config's row in the first per-config table (per-step tokens + success). */
const rowOf = (md: string, config: string): string =>
  md.split("\n").find((l) => l.startsWith(`| ${config} | `)) ?? "";

describe("screen-graph validity gate — harness regen (exit code + results markdown)", () => {
  it("run 37215518035 fixture: exit 1, INVALID (emulator lost) rows, B1 still 100%", () => {
    const r = regen(load());
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/::error::screen-graph: 6 config\(s\) INVALID/);
    expect(r.md).toContain("## Validity");
    for (const c of ["B2", "O1", "O2", "O3", "O4", "O5"]) {
      expect(rowOf(r.md, c)).toContain(INVALID_LABEL);
    }
    expect(rowOf(r.md, "B1")).toContain("100% (100/100)");
    expect(rowOf(r.md, "B1")).not.toContain("INVALID");
  }, 60_000);

  it("fully healthy matrix: exit 0, no INVALID", () => {
    const r = regen(healthy());
    expect(r.code).toBe(0);
    expect(r.md).not.toContain(INVALID_LABEL);
  }, 60_000);

  it("only locate/oracle failures: exit 0, failures still reported as failures", () => {
    const run = healthy();
    let n = 0;
    run.records = run.records.map((rec) => {
      if (rec.config !== "O5" || n >= 6) return rec;
      n++;
      return n % 2
        ? { ...rec, success: false, locateFailed: true }
        : { ...rec, success: false, oracleError: true };
    });
    const r = regen(run);
    expect(r.code).toBe(0);
    expect(r.md).not.toContain(INVALID_LABEL);
    expect(rowOf(r.md, "O5")).toContain("94% (94/100)");
    expect(rowOf(r.md, "O5")).toContain("6 (3/0/3/0)");
  }, 60_000);
});
