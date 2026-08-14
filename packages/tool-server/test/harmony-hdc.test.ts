import { describe, it, expect } from "vitest";
import { hdcFailure, shellQuote } from "../src/utils/harmony-hdc";
import { toDevicePoint } from "../src/utils/harmony-uitest";

describe("hdcFailure", () => {
  it("reports the `[Fail]` line hdc printed", () => {
    // hdc exits 0 for this, so the prefix is the only failure signal there is.
    expect(
      hdcFailure({
        stdout: "[Fail]Not match target founded, check connect-key please\n",
        stderr: "",
      })
    ).toBe("[Fail]Not match target founded, check connect-key please");
  });

  it("reads a failure written to stderr", () => {
    expect(hdcFailure({ stdout: "", stderr: "[Fail]Error opening file: no such file\n" })).toBe(
      "[Fail]Error opening file: no such file"
    );
  });

  it("returns null when nothing failed", () => {
    expect(hdcFailure({ stdout: "hi\n", stderr: "" })).toBeNull();
    expect(hdcFailure({ stdout: "[Empty]\n", stderr: "" })).toBeNull();
  });

  it("does not let a remote command's own output forge a transport failure", () => {
    // Matched at the start of a line, not as a substring: a device log or a test
    // name containing the token must not read as hdc losing the connection.
    expect(hdcFailure({ stdout: "test case [Fail]ing on purpose\n", stderr: "" })).toBeNull();
  });
});

describe("shellQuote", () => {
  // `hdc shell` takes a command LINE, not an argv, so every caller-supplied
  // value lands in a device-side /bin/sh. Each of these was round-tripped
  // through a real device via `echo` and came back byte-identical.
  it.each([
    ["hello world", `'hello world'`],
    ["a'b", `'a'\\''b'`],
    // The only row with two quotes: at one, a first-match-only replace produces
    // identical bytes, so nothing else here separates it from `replaceAll`.
    ["a'b'c", `'a'\\''b'\\''c'`],
    ['a"b', `'a"b'`],
    ["a$b", `'a$b'`],
    ["a;echo PWNED", `'a;echo PWNED'`],
    ["a`echo X`b", "'a`echo X`b'"],
    ["ünïcode 中文", `'ünïcode 中文'`],
  ])("quotes %j", (input, expected) => {
    expect(shellQuote(input)).toBe(expected);
  });

  it("neutralises a command substitution rather than letting it run", () => {
    // The single quote is the whole defence; if it were double quotes the
    // backticks below would execute on the device as the `shell` user.
    expect(shellQuote("`id`")).toBe("'`id`'");
  });
});

describe("toDevicePoint", () => {
  const display = { width: 1216, height: 2688 };

  it("scales a normalized point into device pixels", () => {
    expect(toDevicePoint(0.5, 0.5, display)).toEqual({ x: 608, y: 1344 });
  });

  it("keeps the far edge inside the display", () => {
    // `uitest` accepts an off-screen coordinate, returns `No Error` and does
    // nothing — so 1.0 must land on the last addressable pixel, not one past it,
    // or a tap on a right-edge element silently misses while reporting success.
    expect(toDevicePoint(1, 1, display)).toEqual({ x: 1215, y: 2687 });
  });

  it("clamps a point outside the unit square instead of going negative", () => {
    // `uitest` *does* reject negative coordinates, so an un-clamped caller would
    // turn an out-of-range frame into a hard error rather than an edge tap.
    expect(toDevicePoint(-0.2, 1.4, display)).toEqual({ x: 0, y: 2687 });
  });

  it("puts the origin at the first pixel", () => {
    expect(toDevicePoint(0, 0, display)).toEqual({ x: 0, y: 0 });
  });
});
