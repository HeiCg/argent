import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, constants as fsConstants } from "node:fs/promises";
import { join } from "node:path";
import { formatSubprocessFailure } from "./subprocess-error";

const execFileAsync = promisify(execFile);

/**
 * Wrapper for DevEco Studio's `Emulator` manager — HarmonyOS' `emulator` and
 * `avdmanager` rolled into one (`-list` / `-create` / `-start` / `-stop` /
 * `-imageList` / `-install`).
 *
 * It violates the convention every other subprocess wrapper here relies on: the
 * exit code does not indicate success. Measured against DevEco Studio 6.1
 * (Emulator 6.1.1.200):
 *
 *   -list      (none)           exit 0   ok
 *   -create    (no image)       exit 0   FAILED
 *   -stop      (missing)        exit 0   FAILED
 *   -install   (outside China)  exit 0   FAILED
 *   -start     (missing)        exit 1   FAILED
 *
 * So a failure is usually exit 0, but not always — `-start` is the outlier. Since
 * the code is unreliable in both directions, `runHarmonyEmulator` deliberately
 * does NOT reject on a non-zero exit: it returns the child's output either way
 * and leaves the verdict to `emulatorFailure`, which reads stdout. That keeps one
 * classification path instead of two that disagree.
 *
 * `hdc`, the HarmonyOS device connector, lives in `harmony-hdc.ts`: this
 * manager knows about instances, `hdc` knows about targets, and the two are
 * separate binaries with separate failure vocabularies.
 */

/** The manager prints this exact token for an empty list rather than no output. */
export const HARMONY_EMPTY_SENTINEL = "[Empty]";

/**
 * DevEco Studio's macOS install root. Non-macOS hosts (DevEco also ships for
 * Windows) are supported through `$DEVECO_STUDIO_HOME` rather than a second
 * hardcoded root, because only the macOS layout has been verified here.
 */
const MACOS_DEVECO_ROOT = "/Applications/DevEco-Studio.app/Contents";

/** Path of the emulator manager relative to a DevEco Studio install root. */
const EMULATOR_RELATIVE = join("tools", "emulator", "Emulator");

// Mirrors android-binary.ts / vega-cli.ts: memoize briefly so a burst of tool
// calls pays one lookup, but a *negative* result expires — a user who installs
// DevEco Studio mid-session recovers without restarting the tool-server.
const BINARY_TTL_MS = 60_000;
let cachedEmulator: { path: string | null; checkedAt: number } | undefined;

// X_OK rather than F_OK (as in vega-cli.ts): a present-but-non-executable file
// at the DevEco path is a partial install, and returning it would surface as an
// opaque EACCES at spawn instead of the actionable not-found hint.
async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path to the HarmonyOS emulator manager, or null when DevEco Studio
 * isn't installed. Not resolved from PATH: the binary is named `Emulator`, too
 * generic a name to match on PATH without risking an unrelated executable.
 */
export async function resolveHarmonyEmulator(): Promise<string | null> {
  const now = Date.now();
  if (cachedEmulator && now - cachedEmulator.checkedAt < BINARY_TTL_MS) {
    return cachedEmulator.path;
  }
  const configured = process.env.DEVECO_STUDIO_HOME?.trim();
  const root = configured || (process.platform === "darwin" ? MACOS_DEVECO_ROOT : null);
  let path: string | null = null;
  if (root) {
    const candidate = join(root, EMULATOR_RELATIVE);
    if (await isExecutable(candidate)) path = candidate;
  }
  cachedEmulator = { path, checkedAt: now };
  return path;
}

export interface HarmonyRunResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function runHarmonyEmulator(
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<HarmonyRunResult> {
  const bin = await resolveHarmonyEmulator();
  if (!bin) {
    throw new Error(
      "The HarmonyOS `Emulator` manager was not found. Install DevEco Studio, or set " +
        "`$DEVECO_STUDIO_HOME` to its install root, then retry."
    );
  }
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { killed?: boolean; code?: unknown; stdout?: string; stderr?: string };
    // The child ran and exited non-zero (`-start` on a missing instance does
    // this) — its diagnostic is on stdout, so hand the output back and let the
    // caller classify it exactly as it would an exit-0 failure. A numeric `code`
    // is what distinguishes this from a spawn error, whose `code` is a string
    // like ENOENT.
    if (!e.killed && typeof e.code === "number" && (e.stdout != null || e.stderr != null)) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
    // Spawn failure or timeout SIGKILL: no diagnostic to classify, so surface it
    // the way every other subprocess wrapper here does.
    throw new Error(formatSubprocessFailure("Emulator", args, err), { cause: err });
  }
}

/**
 * Emulator-image downloads are restricted by Huawei to mainland China; outside it
 * `Emulator -install` prints exactly this and exits 0. Without an image no
 * instance can be created, so this is the wall every non-China host hits — worth
 * naming precisely instead of reporting the generic create failure it causes.
 */
const CHINA_ONLY_MARKER = "available only in the Chinese mainland";

/**
 * Verified `Emulator` failure diagnostics, each observed on a real invocation.
 *
 * Ordered most-specific first, because a failure often prints two lines and the
 * first match wins. `-start` on a missing instance prints both `"<name>" is not
 * found. Please create the device(folder): <path>` and a bare `Unable to start
 * the emulator`; the naming line is the one that tells the caller what to do, so
 * the generic trailers sit at the bottom.
 */
const EMULATOR_FAILURE_MARKERS = [
  CHINA_ONLY_MARKER,
  "Cannot find image",
  "is not found. Please create the device",
  "failed, emulator is not exists",
  "Device create fail",
  "Unable to start the emulator",
] as const;

/**
 * The diagnostic the emulator manager printed, or null if the call succeeded.
 * Matched against the verified marker list rather than a bare "fail" substring,
 * so an instance or image name containing "fail" cannot forge a failure.
 */
export function emulatorFailure(result: HarmonyRunResult): string | null {
  const text = `${result.stdout}\n${result.stderr}`;
  const marker = EMULATOR_FAILURE_MARKERS.find((m) => text.includes(m));
  if (!marker) return null;
  const line = text.split(/\r?\n/).find((l) => l.includes(marker));
  return (line ?? marker).trim();
}

/** True when the diagnostic is Huawei's mainland-China image-download restriction. */
export function isChinaOnlyRestriction(diagnostic: string): boolean {
  return diagnostic.includes(CHINA_ONLY_MARKER);
}
