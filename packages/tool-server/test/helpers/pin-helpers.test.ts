import { describe, it, expect } from "vitest";
import { pinsOnce, pinsUnqualified } from "./pins";
import { expectTagEndsTheClaim, platformTag } from "./platform-tag";

/**
 * The doc-pinning helpers only ever fail under a mutation, so nothing in a green
 * suite tells a weakened one from the real thing — `pinsUnqualified` degraded to
 * `pinsOnce`, or the anchored tag regex degraded to a containment check, both
 * leave every caller passing. Their contracts are asserted here directly.
 */
describe("pinsOnce", () => {
  it("requires exactly one occurrence", () => {
    pinsOnce("restart-app is not supported on chromium", "not supported on chromium");
    expect(() => pinsOnce("nothing here", "not supported on chromium")).toThrow();
    expect(() => pinsOnce("chromium chromium", "chromium")).toThrow();
  });
});

describe("pinsUnqualified", () => {
  const claim = "not supported on chromium";

  it("passes when the claim stands on its own", () => {
    for (const tail of [
      ".",
      ", where boot-device only starts an app",
      " — the gate rejects it —",
    ]) {
      pinsUnqualified(`restart-app is ${claim}${tail}`, claim);
    }
  });

  it("fails on a carve-out appended to the claim it pins", () => {
    for (const tail of [
      " except for an Electron app you booted yourself",
      " unless you booted the app yourself",
      ", other than an app boot-device started",
      " only when the app was booted elsewhere",
    ]) {
      expect(() => pinsUnqualified(`restart-app is ${claim}${tail}`, claim), tail).toThrow();
    }
  });

  it("sees a carve-out through markdown emphasis and quotes", () => {
    // The device-interact row bolds the refusal, so the carve-out lands after the
    // closing marks rather than against the needle.
    expect(() => pinsUnqualified(`**${claim}** except for Electron`, claim)).toThrow();
    expect(() => pinsUnqualified(`"${claim}", unless you booted it`, claim)).toThrow();
  });
});

describe("expectTagEndsTheClaim", () => {
  const tag = platformTag({ apple: { simulator: true }, android: { emulator: true } });

  it("accepts a tag that ends the claim", () => {
    expect(tag).toBe("iOS / Android");
    for (const cell of [
      `| Reload JS | \`debugger-reload-metro\` (${tag}) |`,
      `Reload all connected apps (${tag}). Needs a CDP target.`,
      `Relaunch by bundleId (${tag}); not supported on Chromium`,
      `Relaunch by bundleId (${tag})`,
    ]) {
      expectTagEndsTheClaim(cell, tag, "row");
    }
  });

  it("rejects a platform appended outside the tag", () => {
    for (const cell of [
      `Relaunch by bundleId (${tag}) and Chromium. Use when …`,
      `Reload all connected apps (${tag}) plus any CDP browser.`,
    ]) {
      expect(() => expectTagEndsTheClaim(cell, tag, "row"), cell).toThrow();
    }
  });
});
