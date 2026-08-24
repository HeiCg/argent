import { describe, expect, it } from "vitest";
import { extractCrashFailureText } from "../src/utils/ios-device/runner-crash";

// Shape mirrors `xcrun xcresulttool get test-results summary` output. The
// Reminders incident's real failure text is the fixture: a Swift runtime trap
// recorded by xcodebuild after the runner process died mid-snapshot.
const CRASH_TEXT =
  "Crash: ArgentRunnerUITests-Runner at Swift runtime failure: Double value " +
  "cannot be converted to Int because the result would be greater than Int.max";

describe("extractCrashFailureText", () => {
  it("prefers a failure that names a crash", () => {
    const summary = {
      testFailures: [
        { failureText: "runner session ended without a shutdown command" },
        { failureText: CRASH_TEXT },
      ],
    };
    expect(extractCrashFailureText(summary)).toBe(CRASH_TEXT);
  });

  it("falls back to the first failure text when none names a crash", () => {
    const summary = { testFailures: [{ failureText: "some failure" }] };
    expect(extractCrashFailureText(summary)).toBe("some failure");
  });

  it("keeps only the first line, bounded", () => {
    const summary = {
      testFailures: [{ failureText: `${"x".repeat(500)}\nsecond line` }],
    };
    const text = extractCrashFailureText(summary);
    expect(text).toHaveLength(400);
    expect(text).not.toContain("second line");
  });

  it("returns null on empty or malformed summaries", () => {
    expect(extractCrashFailureText(null)).toBeNull();
    expect(extractCrashFailureText({})).toBeNull();
    expect(extractCrashFailureText({ testFailures: [] })).toBeNull();
    expect(extractCrashFailureText({ testFailures: [{ failureText: 42 }] })).toBeNull();
  });
});
