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

/**
 * Install memo for the open-source android-device-server only. The devtools
 * helper probes on every call (see `ensureAndroidDevtoolsInstalled`); the open
 * server keeps its per-process memo keyed by serial, package and versionCode.
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

/**
 * Run `adb install` with `args`, uninstalling `packageName` and retrying once
 * when the device holds the same package under a different signing key.
 */
async function installApk(serial: string, packageName: string, args: string[]): Promise<void> {
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
}

/**
 * Install the helper APK unless the device already has at least the bundled
 * versionCode.
 *
 * The probe runs on every call rather than being memoized per serial: a wipe or
 * a snapshot restore drops the package while the same serial stays connected,
 * and a memo would keep skipping the install for the life of the process. One
 * `cmd package list packages` per service instantiation is cheap enough to pay.
 *
 * `force` installs without probing, and with `-d` so the install may go
 * backwards in versionCode. The probe cannot tell a working helper from a
 * foreign build carrying the same versionCode (the manifest pins it at 1), so a
 * repair has to ignore its verdict.
 */
export async function ensureAndroidDevtoolsInstalled(
  serial: string,
  options: { force?: boolean } = {}
): Promise<void> {
  const manifest = helperManifest();

  if (!options.force) {
    const probe = await probeInstalledVersion(serial, manifest.packageName);
    // A null versionCode means the `pm list packages` fallback answered (API
    // levels without `cmd package`), which reports presence only. Treat a
    // present package as current there: installing on every instantiation
    // would replace a working helper each time, and a stale one is caught by
    // the forced reinstall once `am instrument` refuses it. Only API 23 — the
    // helper's minSdk — lacks `cmd package`, so the one device class that
    // never upgrades a stale-but-present helper is also the oldest supported.
    if (
      probe.installed &&
      (probe.versionCode === null || probe.versionCode >= manifest.versionCode)
    ) {
      return;
    }
  }

  const apkPath = bundledHelperApkPath();
  const flags = options.force ? [...manifest.installFlags, "-d"] : manifest.installFlags;
  const args = ["-s", serial, "install", ...flags, apkPath];
  await installApk(serial, manifest.packageName, args);
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
  await installApk(serial, packageName, args);

  installedHelpers.set(key, true);
}

/**
 * Install the open-source android-device-server APK. Resolves to the versionCode
 * now on the device (the probed one when it was already current, the bundled one
 * after an install), so the blueprint knows which RPC features the server has.
 */
export async function ensureOpenDeviceServerInstalled(serial: string): Promise<number | undefined> {
  const manifest = serverManifest();
  await ensureHelperInstalled({
    serial,
    packageName: manifest.packageName,
    versionCode: manifest.versionCode,
    installFlags: manifest.installFlags,
    apkPath: bundledServerApkPath(),
  });
  return undefined; // scaffold: the installed versionCode is not reported yet
}

/**
 * Test-only helper to reset the open-server install memo between runs. The
 * devtools helper has no memo (every call probes the device), so this clears
 * only the android-device-server entries.
 *
 * @public so knip keeps it: a caller lives in the `argent-private`
 * submodule, which knip lists under `ignoreWorkspaces` and CI never checks out.
 * `research/android-describe-busy-ui/drivers/test-fallback.js` requires this
 * module from `dist/` and calls it. Drop the export once that driver does.
 */
export function __resetAndroidDevtoolsInstallCache(): void {
  installedHelpers.clear();
}
