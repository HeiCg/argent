import { describe, expect, it } from "vitest";
import { parseFlow, serializeFlow, type FlowStep } from "../../src/tools/flows/flow-utils";

// The two non-selector conditions: `screen` (identity) and `idle`
// (readiness). They share the `await:` / `assert:` keys with the selector
// conditions, so the parse/serialize round trip and the mutual exclusion
// between the two families are the load-bearing behaviors.

const flow = (steps: string): string => `executionPrerequisite: ""\nsteps:\n${steps}`;

function parseSteps(steps: string): FlowStep[] {
  return parseFlow(flow(steps)).steps;
}

/** A flow's steps survive serialize → parse unchanged (canonical spelling). */
function expectRoundTrip(steps: string): FlowStep[] {
  const parsed = parseSteps(steps);
  expect(parseFlow(serializeFlow({ executionPrerequisite: "", steps: parsed })).steps).toEqual(
    parsed
  );
  return parsed;
}

describe("await/assert { screen }", () => {
  it("parses the identity gate and round-trips its minimal spelling", () => {
    const steps = expectRoundTrip(`  - await: { screen: "HomeTab>Profile" }\n`);
    expect(steps).toEqual([{ kind: "screen", mode: "await", route: "HomeTab>Profile" }]);
    // Minimal in, minimal out — no defaults materialize into the file.
    expect(serializeFlow({ executionPrerequisite: "", steps })).toContain(
      "await:\n      screen: HomeTab>Profile"
    );
  });

  it("keeps the assert form immediate and distinct from await", () => {
    expect(parseSteps(`  - assert: { screen: "Settings" }\n`)).toEqual([
      { kind: "screen", mode: "assert", route: "Settings" },
    ]);
    expect(() => parseSteps(`  - assert: { screen: "Settings", timeout: 5000 }\n`)).toThrow(
      /assert has no timeout/
    );
  });

  it("carries the optional app and metro port", () => {
    const steps = expectRoundTrip(
      `  - await: { screen: "Home", app: com.acme.notes, metroPort: 8082, timeout: 12000 }\n`
    );
    expect(steps).toEqual([
      {
        kind: "screen",
        mode: "await",
        route: "Home",
        app: "com.acme.notes",
        metroPort: 8082,
        timeout: 12000,
      },
    ]);
  });

  it("rejects a malformed route fingerprint at parse, not against a live app", () => {
    expect(() => parseSteps(`  - await: { screen: "" }\n`)).toThrow(/route fingerprint/);
    expect(() => parseSteps(`  - await: { screen: ">Home" }\n`)).toThrow(/empty path segment/);
    expect(() => parseSteps(`  - await: { screen: "Home>" }\n`)).toThrow(/empty path segment/);
    expect(() => parseSteps(`  - await: { screen: "Home>>Profile" }\n`)).toThrow(
      /empty path segment/
    );
  });

  it("rejects a bad app id or port", () => {
    expect(() => parseSteps(`  - await: { screen: "Home", app: "" }\n`)).toThrow(/screen.app/);
    expect(() => parseSteps(`  - await: { screen: "Home", metroPort: 0 }\n`)).toThrow(
      /screen.metroPort/
    );
    expect(() => parseSteps(`  - await: { screen: "Home", metroPort: 70000 }\n`)).toThrow(
      /screen.metroPort/
    );
  });
});

describe("await { idle }", () => {
  it("parses the readiness gate and round-trips", () => {
    expect(expectRoundTrip(`  - await: { idle: true }\n`)).toEqual([{ kind: "idle" }]);
    expect(expectRoundTrip(`  - await: { idle: true, minStableMs: 400, timeout: 9000 }\n`)).toEqual(
      [{ kind: "idle", minStableMs: 400, timeout: 9000 }]
    );
  });

  it("has no assert form — waiting is the whole point of the check", () => {
    expect(() => parseSteps(`  - assert: { idle: true }\n`)).toThrow(/idle has no assert form/);
  });

  it("takes only `true` — there is no useful 'prove the screen is moving'", () => {
    expect(() => parseSteps(`  - await: { idle: false }\n`)).toThrow(/idle takes only/);
  });

  it("bounds minStableMs", () => {
    expect(() => parseSteps(`  - await: { idle: true, minStableMs: -1 }\n`)).toThrow(
      /idle.minStableMs/
    );
    expect(() => parseSteps(`  - await: { idle: true, minStableMs: 99999 }\n`)).toThrow(
      /idle.minStableMs/
    );
  });
});

describe("condition families are mutually exclusive", () => {
  it("rejects mixing a selector condition with an identity one", () => {
    expect(() => parseSteps(`  - await: { screen: "Home", visible: { id: x } }\n`)).toThrow(
      /mixes `screen` with `visible`/
    );
  });

  it("rejects naming two identity conditions in one step", () => {
    expect(() => parseSteps(`  - await: { screen: "Home", idle: true }\n`)).toThrow(
      /exactly one condition key, not screen \+ idle/
    );
  });

  it("rejects a stray key rather than ignoring it", () => {
    expect(() => parseSteps(`  - await: { screen: "Home", settleMs: 500 }\n`)).toThrow(/settleMs/);
    expect(() => parseSteps(`  - await: { idle: true, metroPort: 8081 }\n`)).toThrow(/metroPort/);
  });

  // A typo next to a `screen:` gate used to be told that `screen` itself was
  // not a legal key — the parser lists what the AUTHOR may write, which is not
  // the same set as what its selector-condition branch parses.
  it("offers the identity conditions when an await/assert names no legal one", () => {
    expect(() => parseSteps(`  - await: { visble: { id: home } }\n`)).toThrow(
      /await needs exactly one condition key \(exists, visible, hidden, text, screen, idle\)/
    );
    expect(() => parseSteps(`  - assert: { visble: { id: home } }\n`)).toThrow(
      /assert needs exactly one condition key \(exists, visible, hidden, text, screen, idle\)/
    );
    // Same list when the body isn't a condition map at all.
    expect(() => parseSteps(`  - await: visible\n`)).toThrow(
      /await needs a condition \(exists, visible, hidden, text, screen, idle\)/
    );
  });

  it("does not offer them to a `when:` guard, which has no identity form", () => {
    const guard = (body: string) => (): FlowStep[] =>
      parseSteps(`  - when: ${body}\n    steps:\n      - echo: guarded\n`);

    // A stray key carrying neither substring, so the rejected entry echoed
    // back into the message cannot satisfy the negative assertions.
    const stray = guard("{ visble: { id: home } }");
    expect(stray).toThrow(
      /when needs exactly one condition key \(exists, visible, hidden, text, platform\)/
    );
    expect(stray).not.toThrow(/screen/);
    expect(stray).not.toThrow(/idle/);

    // And the identity conditions themselves are not guards.
    expect(guard('{ screen: "Home" }')).toThrow(/when needs exactly one condition key/);
    expect(guard("{ idle: true }")).toThrow(/when needs exactly one condition key/);
  });

  it("leaves the selector conditions untouched", () => {
    expect(parseSteps(`  - await: { visible: { id: home-screen } }\n`)).toEqual([
      { kind: "await", condition: "visible", selector: { identifier: "home-screen" } },
    ]);
  });
});
