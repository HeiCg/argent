import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";

const execFileAsync = promisify(execFile);

/**
 * Best-effort post-mortem for a dead runner: when the XCUITest process
 * crashes, xcodebuild records the crash reason (exception / Swift runtime
 * failure text) in the session's .xcresult bundle, whose per-device path
 * `launchRunner` pins via -resultBundlePath. Surfacing that line in the tool
 * error turns "runner is not listening on device port N" into an actionable
 * diagnosis.
 */

/**
 * Pull the crash line out of `xcresulttool get test-results summary` JSON.
 * Pure so the parsing is unit-testable; the shape is Apple's, so parse
 * defensively. Prefers a failure that names a crash, falls back to the first
 * failure text.
 */
export function extractCrashFailureText(summary: unknown): string | null {
  const failures = (summary as { testFailures?: unknown })?.testFailures;
  if (!Array.isArray(failures)) return null;
  const texts = failures
    .map((f) => (f as { failureText?: unknown })?.failureText)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  const crash = texts.find((t) => /crash/i.test(t)) ?? texts[0];
  if (!crash) return null;
  // One line, bounded: failure texts can embed multi-paragraph diagnostics.
  return crash.split("\n")[0]!.slice(0, 400);
}

/**
 * Crash reason recorded in this session's result bundle, or null when there
 * is none / it cannot be read. Never throws: this runs on an error path and
 * must not mask the original failure.
 */
export async function readRunnerCrashSummary(resultBundlePath: string): Promise<string | null> {
  try {
    await fs.access(resultBundlePath);
    const { stdout } = await execFileAsync(
      "xcrun",
      ["xcresulttool", "get", "test-results", "summary", "--path", resultBundlePath],
      { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }
    );
    return extractCrashFailureText(JSON.parse(stdout));
  } catch {
    return null;
  }
}
