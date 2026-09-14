import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { IOS_OPEN_SERVER_METHODS } from "../src/utils/ios-open-server-client";

// The host method list and the Swift `RunnerMethod` enum are the two halves of
// the JSON-RPC method table. They cannot share a literal source across the
// language boundary, so this test reads the Swift enum off disk and asserts the
// host list equals it exactly — edit one and this names the side that must follow.

const SWIFT_PROTOCOL_SOURCE = path.resolve(
  __dirname,
  "../../ios-device-server/ArgentRunner/ArgentRunnerUITests/RunnerProtocol.swift"
);

const swiftSource = readFileSync(SWIFT_PROTOCOL_SOURCE, "utf8");

/** The `case xxx` names inside a named Swift enum block. */
function extractEnumCases(source: string, enumName: string): string[] {
  const block = source.match(new RegExp(`enum\\s+${enumName}[^{]*\\{([\\s\\S]*?)\\n\\}`));
  expect(block, `Swift enum '${enumName}' not found`).not.toBeNull();
  return [...block![1]!.matchAll(/case\s+(\w+)/g)].map((m) => m[1]!);
}

describe("iOS open-server method parity (host list ↔ Swift RunnerMethod)", () => {
  it("host IOS_OPEN_SERVER_METHODS equals the Swift RunnerMethod enum", () => {
    const swiftMethods = extractEnumCases(swiftSource, "RunnerMethod");
    expect(new Set(swiftMethods)).toEqual(new Set(IOS_OPEN_SERVER_METHODS));
    // Same count, so neither side has a duplicate or an extra the other lacks.
    expect(swiftMethods.length).toBe(IOS_OPEN_SERVER_METHODS.length);
  });

  it("the deferred methods are disjoint from the supported ones", () => {
    const deferred = extractEnumCases(swiftSource, "DeferredMethod");
    const supported = new Set<string>(IOS_OPEN_SERVER_METHODS);
    for (const d of deferred) {
      expect(supported.has(d), `deferred method '${d}' also appears in the supported list`).toBe(false);
    }
    // The deferred set names the iOS-2/3/4 work, so it must be non-empty.
    expect(deferred.length).toBeGreaterThan(0);
  });
});
