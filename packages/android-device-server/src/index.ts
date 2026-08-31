import * as path from "node:path";
import * as fs from "node:fs";

/**
 * `@argent/android-device-server` — the TypeScript face of the open-source
 * on-device control server. The Kotlin sources, Gradle build and this metadata
 * reader all live in this package; the built APK ships in `bin/` (git-ignored,
 * published via the `files` allow-list). The tool-server's `android-open-server`
 * blueprint reads the manifest and APK path from here, exactly as the
 * `android-devtools` blueprint reads them from `@argent/native-devtools-android`.
 */

// `__dirname/..` is the package root in both dev and the published tree.
// ARGENT_ANDROID_DEVICE_SERVER_BIN_DIR overrides bin/ (e.g. for a locally-built
// APK in CI), mirroring ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR.
function binDir(): string {
  return process.env.ARGENT_ANDROID_DEVICE_SERVER_BIN_DIR ?? path.join(__dirname, "..", "bin");
}

export interface DeviceServerManifest {
  /** Application id of the server APK; the install gate compares by this. */
  packageName: string;
  /** `am instrument -w <this>` component that launches the persistent server. */
  instrumentationRunner: string;
  versionName: string;
  versionCode: number;
  /** `adb install` flags; `-t` allows a test/instrumentation APK, `-r` reinstalls. */
  installFlags: string[];
}

let cachedManifest: DeviceServerManifest | null = null;

/** Read (and cache) the committed version contract from `assets/manifest.json`. */
export function serverManifest(): DeviceServerManifest {
  if (cachedManifest) return cachedManifest;
  const manifestPath = path.join(__dirname, "..", "assets", "manifest.json");
  cachedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as DeviceServerManifest;
  return cachedManifest;
}

/** Absolute path to the bundled server APK, or throw with a build hint if absent. */
export function bundledServerApkPath(): string {
  const manifest = serverManifest();
  const apk = path.join(binDir(), `argent-device-control-${manifest.versionName}.apk`);
  if (!fs.existsSync(apk)) {
    throw new Error(
      `Bundled Android device-control server APK not found at ${apk}. ` +
        `Run \`bash packages/android-device-server/scripts/build.sh\` to build it ` +
        `(requires the Android SDK + Gradle), or set ` +
        `PREBUILT_ANDROID_DEVICE_SERVER_APK / ARGENT_ANDROID_DEVICE_SERVER_BIN_DIR.`
    );
  }
  return apk;
}
