import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";

const execFileAsync = promisify(execFile);

/**
 * Crash post-mortem from the runner's `.xcresult` bundle.
 */

/**
 * Pull the crash line out of `xcresulttool get test-results summary` JSON.
 */
export function extractCrashFailureText(summary: unknown): string | null {
  const failures = (summary as { testFailures?: unknown })?.testFailures;

  if (!Array.isArray(failures)) {
    return null;
  }

  const texts = failures
    .map((f) => (f as { failureText?: unknown })?.failureText)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  const crash = texts.find((t) => /crash/i.test(t)) ?? texts[0];

  if (!crash) {
    return null;
  }

  // One line, bounded. Failure texts can embed multi-paragraph diagnostics.
  return crash.split("\n")[0]!.slice(0, 400);
}

/**
 * Crash reason from this session's result bundle, or null if none can be read.
 * Never throws.
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
