import { beforeEach, describe, expect, it } from "vitest";
import {
  isClipboardUnsupported,
  recordClipboardOutcome,
  markClipboardUnsupported,
  invalidateClipboardSupport,
  __resetOpenServerClipboardCache,
} from "../src/utils/open-server-clipboard-cache";

const DEV = "emulator-5554";

beforeEach(() => __resetOpenServerClipboardCache());

describe("open-server clipboard cache (R3, phase 3g)", () => {
  it("a single definitive false does not mark unsupported", () => {
    const marked = recordClipboardOutcome(DEV, "definitive-false");
    expect(marked).toBe(false);
    expect(isClipboardUnsupported(DEV)).toBe(false);
  });

  it("two CONSECUTIVE definitive falses mark unsupported", () => {
    expect(recordClipboardOutcome(DEV, "definitive-false")).toBe(false);
    expect(recordClipboardOutcome(DEV, "definitive-false")).toBe(true);
    expect(isClipboardUnsupported(DEV)).toBe(true);
  });

  it("a transient (error-carrying) false never counts and resets the run", () => {
    recordClipboardOutcome(DEV, "definitive-false"); // count = 1
    recordClipboardOutcome(DEV, "transient"); // resets to 0
    expect(recordClipboardOutcome(DEV, "definitive-false")).toBe(false); // count = 1 again
    expect(isClipboardUnsupported(DEV)).toBe(false);
    // Only a second CONSECUTIVE definitive false (no transient between) marks.
    expect(recordClipboardOutcome(DEV, "definitive-false")).toBe(true);
    expect(isClipboardUnsupported(DEV)).toBe(true);
  });

  it("a success resets the run so it never marks from stale count", () => {
    recordClipboardOutcome(DEV, "definitive-false"); // count = 1
    recordClipboardOutcome(DEV, "ok"); // resets
    expect(recordClipboardOutcome(DEV, "definitive-false")).toBe(false);
    expect(isClipboardUnsupported(DEV)).toBe(false);
  });

  it("repeated transient falses never mark, however many", () => {
    for (let i = 0; i < 5; i++) {
      expect(recordClipboardOutcome(DEV, "transient")).toBe(false);
    }
    expect(isClipboardUnsupported(DEV)).toBe(false);
  });

  it("the mark is per-device (an interleaved other device does not break the run)", () => {
    const OTHER = "emulator-5556";
    expect(recordClipboardOutcome(DEV, "definitive-false")).toBe(false);
    expect(recordClipboardOutcome(OTHER, "definitive-false")).toBe(false);
    // DEV's run is still 1 — the two devices count independently, not consecutively.
    expect(recordClipboardOutcome(DEV, "definitive-false")).toBe(true);
    expect(isClipboardUnsupported(DEV)).toBe(true);
    expect(isClipboardUnsupported(OTHER)).toBe(false);
  });

  it("invalidate clears both the mark and the running count", () => {
    markClipboardUnsupported(DEV);
    expect(isClipboardUnsupported(DEV)).toBe(true);
    invalidateClipboardSupport(DEV);
    expect(isClipboardUnsupported(DEV)).toBe(false);
    // And a fresh run starts from zero.
    expect(recordClipboardOutcome(DEV, "definitive-false")).toBe(false);
  });
});
