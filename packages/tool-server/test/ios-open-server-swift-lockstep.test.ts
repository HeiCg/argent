import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  RUNNER_TYPE_TO_ROLE,
  SCROLL_CONTAINER_TYPES,
} from "../src/tools/describe/platforms/ios/open-server-tree";

// The TS describe adapter and the Swift runner each hold half of the same
// agreement. The runner decides WHICH element types ship in a snapshot
// (`scrollContainerTypes`); the adapter decides what those types mean once they
// arrive (`SCROLL_CONTAINER_TYPES`, `RUNNER_TYPE_TO_ROLE`). The compiler cannot
// see across the language boundary, so this suite reads the Swift source and
// pins the two sides against each other.

const SWIFT_SNAPSHOT_SOURCE = path.resolve(
  __dirname,
  "../../ios-device-server/ArgentRunner/ArgentRunnerUITests/ArgentRunnerSession+Snapshot.swift"
);

const swiftSource = readFileSync(SWIFT_SNAPSHOT_SOURCE, "utf8");

/** `case .button: return "Button"` pairs from the Swift `elementTypeName` switch. */
function extractElementTypeNames(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of source.matchAll(/case\s+\.(\w+)\s*:\s*return\s+"(\w+)"/g)) {
    map.set(match[1], match[2]);
  }
  return map;
}

function extractSwiftTypeList(source: string, name: string): string[] {
  const list = source.match(
    new RegExp(`let\\s+${name}\\s*:\\s*Set<XCUIElement\\.ElementType>\\s*=\\s*\\[([^\\]]*)\\]`)
  );
  expect(list, `Swift list '${name}' not found in ${SWIFT_SNAPSHOT_SOURCE}`).not.toBeNull();
  const body = list![1]!.replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/\.(\w+)/g)].map((match) => match[1]!);
}

describe("iOS open-server describe adapter ↔ Swift runner lockstep", () => {
  const typeNames = extractElementTypeNames(swiftSource);

  it("SCROLL_CONTAINER_TYPES matches the runner's scrollContainerTypes", () => {
    const swiftMembers = extractSwiftTypeList(swiftSource, "scrollContainerTypes");
    const swiftWireNames = swiftMembers.map((m) => {
      const wire = typeNames.get(m);
      expect(wire, `elementTypeName has no case for .${m}`).toBeDefined();
      return wire!;
    });
    expect(new Set(swiftWireNames)).toEqual(SCROLL_CONTAINER_TYPES);
  });

  it("every RUNNER_TYPE_TO_ROLE key is a wire type the runner can emit", () => {
    const wireNames = new Set(typeNames.values());
    for (const key of Object.keys(RUNNER_TYPE_TO_ROLE)) {
      expect(
        wireNames.has(key),
        `RUNNER_TYPE_TO_ROLE key '${key}' is not an emitted wire type`
      ).toBe(true);
    }
  });
});
