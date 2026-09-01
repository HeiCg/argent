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

/**
 * Resolve the committed manifest across both trees. In dev `__dirname/..` is this
 * package, so `assets/manifest.json` is our own contract. Once this code is
 * inlined into the `@swmansion/argent` tool-server bundle, `__dirname/..`
 * collapses onto the argent package, where `assets/manifest.json` already belongs
 * to `@argent/native-devtools-android`'s helper — reading it there spawned the
 * WRONG instrumentation (the open server answered `Unknown method:
 * getAccessibilityTree` and describe fell back silently). `bundle-tools.cjs`
 * therefore copies our manifest to a dedicated `assets/android-device-server/`
 * subdir; prefer it, and only fall back to the sibling in the dev tree. Order
 * matters: in a correctly-built bundle the subdir always wins, and the sibling is
 * reached only in dev (where it is our own, correct, manifest).
 */
export function resolveServerManifestPath(baseDir: string = path.join(__dirname, "..")): string {
  const bundled = path.join(baseDir, "assets", "android-device-server", "manifest.json");
  if (fs.existsSync(bundled)) return bundled;
  return path.join(baseDir, "assets", "manifest.json");
}

/** Read (and cache) the committed version contract. */
export function serverManifest(): DeviceServerManifest {
  if (cachedManifest) return cachedManifest;
  cachedManifest = JSON.parse(
    fs.readFileSync(resolveServerManifestPath(), "utf-8")
  ) as DeviceServerManifest;
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
