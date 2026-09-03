import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAssertion, type OracleNode } from "../src/screen-graph/bench/oracle";
import {
  isProblemVerdict,
  preflightVerdict,
  type NeedleEvalRow,
} from "../src/screen-graph/bench/preflight";

/**
 * BLOCKER-1 guard: with the real launch-screen dumps captured by the C.1
 * pre-flight (`scripts/bench-preflight.ts` → this fixture), assert that NO task
 * that navigates away from its launch screen has an assertion needle that
 * already matches that launch screen — otherwise a missed tap would false-pass.
 *
 * The fixture is captured on the AVD during the pre-flight and committed. Until
 * then the suite skips (with a visible reason) rather than fail red.
 */
interface Fixture {
  serial: string;
  settingsRoot?: { screen: { width: number; height: number }; nodes: OracleNode[] };
  exampleCom?: { screen: { width: number; height: number }; nodes: OracleNode[] };
  needleEval: Array<{
    task: string;
    app: string;
    needle: string;
    navigates: boolean;
    matchesLaunch: boolean;
    verdict: string;
  }>;
}

const FIXTURE = join(__dirname, "fixtures", "preflight-launch-screens.json");
const present = existsSync(FIXTURE);

describe.skipIf(!present)("screen-graph bench pre-flight — launch-screen needle guard (BLOCKER-1)", () => {
  const fx = present ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture) : ({ needleEval: [] } as Fixture);

  it("no navigating task's needle matches its launch screen (re-evaluated from the dump)", () => {
    const offenders: string[] = [];
    for (const e of fx.needleEval) {
      if (!e.navigates) continue;
      const launch = e.app === "settings" ? fx.settingsRoot : fx.exampleCom;
      if (!launch) continue;
      // C.4 work item E: navigating tasks are gated over the FULL launch tree
      // (visible OR below-fold), since they swipe the root before tapping.
      const r = evaluateAssertion(launch.nodes, e.needle, { ignoreVisibility: true });
      if (r.matched) offenders.push(`${e.task} (needle "${e.needle}" in ${e.app} launch tree)`);
    }
    expect(offenders, `needles present on the launch screen: ${offenders.join("; ")}`).toEqual([]);
  });

  it("every launch-only task's needle IS present on its launch/destination screen", () => {
    const missing: string[] = [];
    for (const e of fx.needleEval) {
      if (e.navigates) continue;
      const launch = e.app === "settings" ? fx.settingsRoot : fx.exampleCom;
      if (!launch) continue;
      const r = evaluateAssertion(launch.nodes, e.needle, { screen: launch.screen });
      if (!r.matched) missing.push(`${e.task} (needle "${e.needle}")`);
    }
    expect(missing, `launch-only needles missing from the screen: ${missing.join("; ")}`).toEqual([]);
  });
});

// C.3 §1: the PURE gate the pre-flight script exits on. BAD or MISSING ⇒ not ok.
describe("preflightVerdict — the matrix gate", () => {
  const okRows: NeedleEvalRow[] = [
    { task: "settings-display", verdict: "ok (unique to destination)" },
    { task: "chrome-open-page", verdict: "ok (launch == destination; needle present)" },
  ];

  it("ok when every needle is fine (no problems)", () => {
    const v = preflightVerdict(okRows);
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
  });

  it("not ok on a BAD needle (on the launch screen a navigating task leaves)", () => {
    const v = preflightVerdict([
      { task: "settings-network", verdict: "BAD (needle on launch screen a navigating task leaves)" },
    ]);
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual([
      "settings-network: BAD (needle on launch screen a navigating task leaves)",
    ]);
  });

  it("not ok on a MISSING needle (launch-only task, needle absent)", () => {
    const v = preflightVerdict([
      { task: "chrome-open-page", verdict: "MISSING (launch-only task but needle not on screen)" },
    ]);
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual([
      "chrome-open-page: MISSING (launch-only task but needle not on screen)",
    ]);
  });

  it("mixed: reports only the BAD/MISSING rows, ok=false, in input order", () => {
    const v = preflightVerdict([
      { task: "a-ok", verdict: "ok (unique to destination)" },
      { task: "b-bad", verdict: "BAD (…)" },
      { task: "c-ok", verdict: "ok (launch == destination; needle present)" },
      { task: "d-missing", verdict: "MISSING (…)" },
    ]);
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual(["b-bad: BAD (…)", "d-missing: MISSING (…)"]);
  });

  it("empty evaluation is vacuously ok", () => {
    expect(preflightVerdict([])).toEqual({ ok: true, problems: [] });
  });

  it("isProblemVerdict classifies BAD/MISSING as problems and ok/other as fine", () => {
    expect(isProblemVerdict("BAD whatever")).toBe(true);
    expect(isProblemVerdict("MISSING whatever")).toBe(true);
    expect(isProblemVerdict("  BAD leading marker space")).toBe(true);
    expect(isProblemVerdict("ok (unique to destination)")).toBe(false);
    expect(isProblemVerdict("ok (launch == destination; needle present)")).toBe(false);
  });
});

// A visible marker so the skip is not silent in CI logs.
describe("screen-graph bench pre-flight — fixture presence", () => {
  it(present ? "fixture is present" : "fixture NOT yet captured (pre-flight pending)", () => {
    expect(true).toBe(true);
  });
});
