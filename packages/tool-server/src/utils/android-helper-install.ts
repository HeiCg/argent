import { runAdb, adbShell } from "./adb";
import { bundledHelperApkPath, helperManifest } from "@argent/native-devtools-android";
import { bundledServerApkPath, serverManifest } from "@argent/android-device-server";

/**
 * Manifest-driven install of an Argent Android helper/server APK.
 *
 * Parameterized over the manifest so both the `android-devtools` snapshot helper
 * and the open-source `android-device-server` share one install gate (probe the
 * installed versionCode, skip if current, reinstall on a signing-key mismatch).
 */

const installedHelpers = new Map<string, true>();

function cacheKey(serial: string, packageName: string, versionCode: number): string {
  return `${serial}|${packageName}|${versionCode}`;
}

interface InstalledVersionProbe {
  installed: boolean;
  versionCode: number | null;
}

/**
 * `--show-versioncode` returns the version in the same round-trip; `pm path`
 * would need a follow-up `dumpsys package`.
 */
async function probeInstalledVersion(
  serial: string,
  packageName: string
): Promise<InstalledVersionProbe> {
  let out: string;
  try {
    out = await adbShell(serial, `cmd package list packages --show-versioncode ${packageName}`, {
      timeoutMs: 5_000,
    });
  } catch {
    // `cmd package` is missing on older API levels.
    try {
      out = await adbShell(serial, `pm list packages ${packageName}`, { timeoutMs: 5_000 });
    } catch {
      return { installed: false, versionCode: null };
    }
  }

  for (const line of out.split("\n")) {
    const match = line.trim().match(/^package:([^\s]+)(?:\s+versionCode:(\d+))?$/);
    if (!match) continue;
    if (match[1] !== packageName) continue;
    const versionCode = match[2] ? parseInt(match[2], 10) : null;
    return { installed: true, versionCode: Number.isFinite(versionCode!) ? versionCode! : null };
  }
  return { installed: false, versionCode: null };
}

interface HelperInstallSpec {
  serial: string;
  packageName: string;
  versionCode: number;
  installFlags: string[];
  apkPath: string;
}

/** Install `apkPath` unless the device already has at least `versionCode`. */
async function ensureHelperInstalled(spec: HelperInstallSpec): Promise<void> {
  const { serial, packageName, versionCode, installFlags, apkPath } = spec;
  const key = cacheKey(serial, packageName, versionCode);
  if (installedHelpers.has(key)) return;

  const probe = await probeInstalledVersion(serial, packageName);
  if (probe.installed && probe.versionCode !== null && probe.versionCode >= versionCode) {
    installedHelpers.set(key, true);
    return;
  }

  const args = ["-s", serial, "install", ...installFlags, apkPath];

  try {
    await runAdb(args, { timeoutMs: 60_000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(message)) {
      // Same package installed under a different signing key (e.g. a rotated
      // local debug keystore); Android only allows the update after uninstall.
      try {
        await runAdb(["-s", serial, "uninstall", packageName], { timeoutMs: 30_000 });
      } catch {
        // Let the retried install report the failure.
      }
      await runAdb(args, { timeoutMs: 60_000 });
    } else {
      throw err;
    }
  }

  installedHelpers.set(key, true);
}

/** Install the argent-android-devtools snapshot helper APK. */
export async function ensureAndroidDevtoolsInstalled(serial: string): Promise<void> {
  const manifest = helperManifest();
  await ensureHelperInstalled({
    serial,
    packageName: manifest.packageName,
    versionCode: manifest.versionCode,
    installFlags: manifest.installFlags,
    apkPath: bundledHelperApkPath(),
  });
}

/** Install the open-source android-device-server APK. */
export async function ensureOpenDeviceServerInstalled(serial: string): Promise<void> {
  const manifest = serverManifest();
  await ensureHelperInstalled({
    serial,
    packageName: manifest.packageName,
    versionCode: manifest.versionCode,
    installFlags: manifest.installFlags,
    apkPath: bundledServerApkPath(),
  });
}

/**
 * Test-only helper to reset the install cache between runs.
 *
 * @public so knip keeps it: the only caller lives in the `argent-private`
 * submodule, which knip lists under `ignoreWorkspaces` and CI never checks out.
 * `research/android-describe-busy-ui/drivers/test-fallback.js` requires this
 * module from `dist/` and calls this twice - once to force the install-fallback
 * path, once to restore. Drop the tag when that driver becomes a vitest test.
 */
export function __resetAndroidDevtoolsInstallCache(): void {
  installedHelpers.clear();
}
