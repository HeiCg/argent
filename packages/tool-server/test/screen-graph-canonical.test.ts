import { describe, expect, it } from "vitest";
import { canonicalAction, swipeDirection } from "../src/screen-graph/canonical";
import { actionSignature } from "../src/screen-graph/types";

const SIZE = { width: 1080, height: 1920 };

describe("canonicalAction target preference", () => {
  it("prefers resource-id over text over coordinates", () => {
    expect(canonicalAction({ kind: "tap", target: { id: "com.x:id/ok", text: "OK" }, x: 10, y: 10 }, SIZE)).toEqual({
      kind: "tap",
      target: { id: "com.x:id/ok" },
    });
    expect(canonicalAction({ kind: "tap", target: { text: "OK" }, x: 10, y: 10 }, SIZE)).toEqual({
      kind: "tap",
      target: { text: "OK" },
    });
  });

  it("falls back to a 1/16 bucketed coordinate when no id/text", () => {
    const a = canonicalAction({ kind: "tap", x: 540, y: 960 }, SIZE);
    // 540/1080*16 = 8, 960/1920*16 = 8
    expect(a).toEqual({ kind: "tap", bucket: { x: 8, y: 8 } });
  });

  it("clamps the bucket to the 0..15 grid", () => {
    const a = canonicalAction({ kind: "tap", x: 1080, y: 1920 }, SIZE);
    expect(a.bucket).toEqual({ x: 15, y: 15 });
  });

  it("ignores blank id/text and uses the coordinate bucket", () => {
    const a = canonicalAction({ kind: "tap", target: { id: "  ", text: "" }, x: 0, y: 0 }, SIZE);
    expect(a).toEqual({ kind: "tap", bucket: { x: 0, y: 0 } });
  });
});

describe("canonicalAction swipe / key / back", () => {
  it("derives swipe direction from the dominant delta", () => {
    expect(swipeDirection(500, 1500, 500, 300)).toBe("up");
    expect(swipeDirection(500, 300, 500, 1500)).toBe("down");
    expect(swipeDirection(900, 500, 100, 500)).toBe("left");
    expect(swipeDirection(100, 500, 900, 500)).toBe("right");
    expect(canonicalAction({ kind: "swipe", startX: 500, startY: 1500, endX: 500, endY: 300 })).toEqual({
      kind: "swipe",
      dir: "up",
    });
  });

  it("maps a back key to the back kind and keeps other keys named", () => {
    expect(canonicalAction({ kind: "key", key: "KEYCODE_BACK" })).toEqual({ kind: "back" });
    expect(canonicalAction({ kind: "key", key: "back" })).toEqual({ kind: "back" });
    expect(canonicalAction({ kind: "key", key: "enter" })).toEqual({ kind: "key", key: "enter" });
    expect(canonicalAction({ kind: "back" })).toEqual({ kind: "back" });
  });
});

describe("actionSignature", () => {
  it("distinguishes coordinate-bucket taps but merges id-equal taps", () => {
    const a = canonicalAction({ kind: "tap", x: 100, y: 100 }, SIZE);
    const b = canonicalAction({ kind: "tap", x: 900, y: 900 }, SIZE);
    expect(actionSignature(a)).not.toBe(actionSignature(b));

    const id1 = canonicalAction({ kind: "tap", target: { id: "com.x:id/ok" }, x: 1, y: 1 }, SIZE);
    const id2 = canonicalAction({ kind: "tap", target: { id: "com.x:id/ok" }, x: 999, y: 999 }, SIZE);
    expect(actionSignature(id1)).toBe(actionSignature(id2));
  });
});
