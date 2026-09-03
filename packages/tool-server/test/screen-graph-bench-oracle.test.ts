import { describe, expect, it } from "vitest";
import {
  accountSuccess,
  evaluateAssertion,
  isExcludedRun,
  isVisibleNode,
  type OracleNode,
} from "../src/screen-graph/bench/oracle";

const SCREEN = { width: 1080, height: 2400 };
const onScreen = (dy = 0): { x1: number; y1: number; x2: number; y2: number } => ({
  x1: 100,
  y1: 200 + dy,
  x2: 900,
  y2: 260 + dy,
});

describe("screen-graph bench oracle — matching rules (ticket C.1 §3)", () => {
  it("matches a needle in a visible node's text, case-insensitively", () => {
    const nodes: OracleNode[] = [{ text: "Network & internet", bounds: onScreen() }];
    const r = evaluateAssertion(nodes, "network & INTERNET", { screen: SCREEN });
    expect(r.matched).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.field).toBe("text");
    expect(r.matches[0]!.text).toBe("Network & internet");
  });

  it("matches on content-description when text does not carry the needle", () => {
    const nodes: OracleNode[] = [{ text: "", cd: "Bluetooth toggle", bounds: onScreen() }];
    const r = evaluateAssertion(nodes, "bluetooth", { screen: SCREEN });
    expect(r.matched).toBe(true);
    expect(r.matches[0]!.field).toBe("contentDescription");
  });

  it("prefers text over content-description when both carry the needle", () => {
    const nodes: OracleNode[] = [{ text: "Storage", cd: "storage settings", bounds: onScreen() }];
    const r = evaluateAssertion(nodes, "storage", { screen: SCREEN });
    expect(r.matches[0]!.field).toBe("text");
  });

  it("does NOT match a node whose text/cd lack the needle (no over-match)", () => {
    // The example.com body has 'documents'/'permission' but never 'documentation'.
    const nodes: OracleNode[] = [
      { text: "This domain is for use in illustrative examples in documents.", bounds: onScreen() },
      { text: "You may use this domain without asking for permission.", bounds: onScreen(80) },
    ];
    expect(evaluateAssertion(nodes, "documentation", { screen: SCREEN }).matched).toBe(false);
    expect(evaluateAssertion(nodes, "documents", { screen: SCREEN }).matched).toBe(true);
    expect(evaluateAssertion(nodes, "permission", { screen: SCREEN }).matched).toBe(true);
  });

  it("ignores nodes scrolled off screen (geometry visibility)", () => {
    const nodes: OracleNode[] = [
      { text: "brightness", bounds: { x1: 100, y1: 3000, x2: 900, y2: 3060 } }, // below screen
    ];
    expect(evaluateAssertion(nodes, "brightness", { screen: SCREEN }).matched).toBe(false);
  });

  it("ignores explicitly hidden and zero-area nodes", () => {
    expect(
      evaluateAssertion([{ text: "hidden", visible: false, bounds: onScreen() }], "hidden", {
        screen: SCREEN,
      }).matched
    ).toBe(false);
    expect(
      evaluateAssertion([{ text: "zero", bounds: { x1: 10, y1: 10, x2: 10, y2: 10 } }], "zero", {
        screen: SCREEN,
      }).matched
    ).toBe(false);
  });

  it("supports explicit equals semantics", () => {
    const nodes: OracleNode[] = [{ text: "battery saver", bounds: onScreen() }];
    expect(evaluateAssertion(nodes, "battery", { screen: SCREEN, mode: "equals" }).matched).toBe(
      false
    );
    expect(evaluateAssertion(nodes, "battery saver", { screen: SCREEN, mode: "equals" }).matched).toBe(
      true
    );
    // default (contains) still matches the substring.
    expect(evaluateAssertion(nodes, "battery", { screen: SCREEN }).matched).toBe(true);
  });

  it("an empty needle never matches", () => {
    expect(evaluateAssertion([{ text: "x", bounds: onScreen() }], "", { screen: SCREEN }).matched).toBe(
      false
    );
    expect(evaluateAssertion([{ text: "x", bounds: onScreen() }], "   ", { screen: SCREEN }).matched).toBe(
      false
    );
  });

  it("returns every visible match, not just the first", () => {
    const nodes: OracleNode[] = [
      { text: "app info", bounds: onScreen() },
      { text: "default apps", bounds: onScreen(80) },
      { text: "unrelated", bounds: onScreen(160) },
    ];
    const r = evaluateAssertion(nodes, "app", { screen: SCREEN });
    expect(r.matches).toHaveLength(2);
  });

  it("isVisibleNode honours explicit flag when bounds are absent", () => {
    expect(isVisibleNode({ text: "x", visible: true })).toBe(true);
    expect(isVisibleNode({ text: "x" })).toBe(false);
  });
});

describe("screen-graph bench oracle — success/exclusion accounting (ticket C.1 §2, review MEDIUM-7/8)", () => {
  it("excludes locate-failed runs from the success denominator", () => {
    const a = accountSuccess([
      { success: true },
      { success: true },
      { success: false },
      { success: false, locateFailed: true }, // aborted on locate → not scored
    ]);
    expect(a.total).toBe(4);
    expect(a.locateFailed).toBe(1);
    expect(a.excluded).toBe(1);
    expect(a.scored).toBe(3);
    expect(a.ok).toBe(2);
    expect(a.successRate).toBe(Number((2 / 3).toFixed(3)));
  });

  it("excludes action-failed, oracle-error and task-error runs too", () => {
    const a = accountSuccess([
      { success: true },
      { success: false, actionFailed: true },
      { success: false, oracleError: true },
      { success: false, taskError: true },
    ]);
    expect(a.actionFailed).toBe(1);
    expect(a.oracleError).toBe(1);
    expect(a.taskError).toBe(1);
    expect(a.excluded).toBe(3);
    expect(a.scored).toBe(1);
    expect(a.ok).toBe(1);
    expect(a.successRate).toBe(1);
  });

  it("an excluded run never counts as a success even if success is stale-true", () => {
    // MEDIUM-8: a swallowed action failure must not become a false success.
    const a = accountSuccess([
      { success: true, actionFailed: true },
      { success: true, locateFailed: true },
      { success: true },
    ]);
    expect(a.scored).toBe(1);
    expect(a.ok).toBe(1);
    expect(a.successRate).toBe(1);
  });

  it("isExcludedRun flags every plumbing/infra reason", () => {
    expect(isExcludedRun({ success: true })).toBe(false);
    expect(isExcludedRun({ success: true, locateFailed: true })).toBe(true);
    expect(isExcludedRun({ success: true, actionFailed: true })).toBe(true);
    expect(isExcludedRun({ success: true, oracleError: true })).toBe(true);
    expect(isExcludedRun({ success: true, taskError: true })).toBe(true);
  });

  it("all-excluded config scores 0 over 0 scored runs", () => {
    const a = accountSuccess([
      { success: false, locateFailed: true },
      { success: false, oracleError: true },
    ]);
    expect(a.scored).toBe(0);
    expect(a.successRate).toBe(0);
  });

  it("no exclusions → plain success rate", () => {
    const a = accountSuccess([{ success: true }, { success: false }, { success: true }]);
    expect(a.excluded).toBe(0);
    expect(a.successRate).toBe(Number((2 / 3).toFixed(3)));
  });
});
