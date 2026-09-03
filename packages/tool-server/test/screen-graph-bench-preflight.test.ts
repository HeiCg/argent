import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAssertion, type OracleNode } from "../src/screen-graph/bench/oracle";

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
      const r = evaluateAssertion(launch.nodes, e.needle, { screen: launch.screen });
      if (r.matched) offenders.push(`${e.task} (needle "${e.needle}" on ${e.app} launch)`);
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

// A visible marker so the skip is not silent in CI logs.
describe("screen-graph bench pre-flight — fixture presence", () => {
  it(present ? "fixture is present" : "fixture NOT yet captured (pre-flight pending)", () => {
    expect(true).toBe(true);
  });
});
