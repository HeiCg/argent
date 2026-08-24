import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Build + launch orchestration for Argent's on-device XCUITest runner
 * (packages/ios-device-runner). The runner is a UI-test bundle whose single
 * `testServeCommands` method hosts an HTTP command server and parks for 24h —
 * see that package's PROTOCOL.md for the wire contract.
 *
 * Device runners must be signed with the USER's Apple team, so artifacts are
 * built lazily on first use (never shipped prebuilt) and cached under
 * ~/.argent/ios-device-runner keyed by a fingerprint of the runner sources,
 * the Xcode/SDK version, and the static xcodebuild arguments (which carry the
 * signing settings). The cache key doubles as
 * protocol versioning: an Argent update that changes runner sources lands in
 * a new cache directory and rebuilds, so the wire protocol needs no version
 * handshake.
 */

/** Env-configurable signing. Automatic signing + team id covers most setups. */
export interface RunnerSigningConfig {
  teamId: string | null;
  signingIdentity: string | null;
  provisioningProfile: string | null;
  appBundleId: string;
  testBundleId: string;
}

const DEFAULT_APP_BUNDLE_ID = "com.swmansion.argent.runner";

export function resolveRunnerSigningConfig(): RunnerSigningConfig {
  const appBundleId = process.env.ARGENT_IOS_RUNNER_BUNDLE_ID || DEFAULT_APP_BUNDLE_ID;
  return {
    teamId: process.env.ARGENT_IOS_TEAM_ID || null,
    signingIdentity: process.env.ARGENT_IOS_SIGNING_IDENTITY || null,
    provisioningProfile: process.env.ARGENT_IOS_PROVISIONING_PROFILE || null,
    appBundleId,
    testBundleId: `${appBundleId}.uitests`,
  };
}

/**
 * Locate the runner's Xcode project. Both src (ts-node) and dist layouts sit
 * at the same depth below packages/tool-server, so a fixed walk-up works for
 * dev and built runs alike; ARGENT_IOS_RUNNER_PROJECT overrides for exotic
 * installs.
 */
function resolveRunnerProjectPath(): string {
  const override = process.env.ARGENT_IOS_RUNNER_PROJECT;
  if (override) return override;
  const candidate = path.resolve(
    __dirname,
    "../../../..",
    "ios-device-runner/ArgentRunner/ArgentRunner.xcodeproj"
  );
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(
    `Could not locate the ios-device-runner Xcode project (looked at ${candidate}). ` +
      `Set ARGENT_IOS_RUNNER_PROJECT to the ArgentRunner.xcodeproj path.`
  );
}

const SOURCE_EXTENSIONS = new Set([
  ".swift",
  ".m",
  ".h",
  ".pbxproj",
  ".plist",
  ".entitlements",
  ".xctestplan",
  ".xcscheme",
]);

async function fingerprintRunnerSources(projectPath: string): Promise<string> {
  const root = path.dirname(projectPath);
  const hash = createHash("sha256");
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "xcuserdata" || entry.name === "DerivedData") continue;
        await walk(full);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        const stat = await fsp.stat(full);
        hash.update(`${path.relative(root, full)}|${stat.size}|${Math.round(stat.mtimeMs)}\n`);
      }
    }
  };
  await walk(root);
  return hash.digest("hex");
}

async function xcodeVersionFingerprint(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("xcodebuild", ["-version"], { timeout: 20_000 });
    return stdout.trim().replace(/\n/g, " ");
  } catch {
    return "unknown-xcode";
  }
}

export interface RunnerArtifact {
  xctestrunPath: string;
  derivedDataPath: string;
}

function cacheRoot(): string {
  return path.join(os.homedir(), ".argent", "ios-device-runner", "derived");
}

/**
 * Find the base (non-env-clone) device .xctestrun under a derived-data dir.
 * Env clones are named `*.env.*.xctestrun` and must never be picked as the
 * base — they carry a previous session's port.
 */
function findBaseXctestrun(derivedDataPath: string): string | null {
  const productsDir = path.join(derivedDataPath, "Build", "Products");
  if (!fs.existsSync(productsDir)) return null;
  const candidates = fs
    .readdirSync(productsDir)
    .filter(
      (name) => name.endsWith(".xctestrun") && !name.includes(".env.") && name.includes("iphoneos")
    );
  if (candidates.length === 0) return null;
  return path.join(productsDir, candidates.sort()[0]!);
}

/** Map an xcodebuild signing failure to the config key that fixes it. */
export function resolveSigningHint(output: string): string | null {
  const lower = output.toLowerCase();
  if (lower.includes("requires a development team")) {
    return "Set ARGENT_IOS_TEAM_ID to your Apple Developer Team ID (Xcode > Settings > Accounts).";
  }
  if (
    lower.includes("failed registering bundle identifier") ||
    // Bare "is not available" also appears in unrelated failures (destination,
    // device, OS availability), so it only counts as a bundle-id collision
    // alongside its real registration context.
    (lower.includes("is not available") &&
      (lower.includes("identifier") || lower.includes("registered")))
  ) {
    return (
      "The runner bundle id collided (common on free Personal Team accounts). " +
      "Set ARGENT_IOS_RUNNER_BUNDLE_ID to a unique reverse-DNS value, e.g. com.yourname.argent.runner."
    );
  }
  if (lower.includes("no profiles for") || lower.includes("provisioning profile")) {
    return (
      "Provisioning failed. With automatic signing, set ARGENT_IOS_TEAM_ID; " +
      "or set ARGENT_IOS_PROVISIONING_PROFILE to a profile that covers the runner bundle ids."
    );
  }
  return null;
}

const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The static xcodebuild arguments of a runner build — everything except the
 * per-run `-destination`/`-derivedDataPath` pair. This exact array is both
 * what `ensureRunnerArtifact` spawns and the hashed material of the artifact
 * cache key (`computeRunnerCacheKey`), so any edit here — a flag, signing
 * plumbing, a bundle-id value — changes the key and forces a rebuild instead
 * of silently reusing a stale cached artifact.
 */
export function runnerBuildStaticArgs(projectPath: string, config: RunnerSigningConfig): string[] {
  const args = [
    "build-for-testing",
    "-project",
    projectPath,
    "-scheme",
    "ArgentRunner",
    "-parallel-testing-enabled",
    "NO",
    "-maximum-concurrent-test-device-destinations",
    "1",
    "-allowProvisioningUpdates",
    "-allowProvisioningDeviceRegistration",
    // Keep the build lean: no index store, coverage, previews, or sandboxed
    // script phases — none of them matter for a headless runner artifact.
    "COMPILER_INDEX_STORE_ENABLE=NO",
    "ENABLE_CODE_COVERAGE=NO",
    "ONLY_ACTIVE_ARCH=YES",
    "ENABLE_PREVIEWS=NO",
    "ENABLE_DEBUG_DYLIB=NO",
    // The project reads PRODUCT_BUNDLE_IDENTIFIER from these two settings, so
    // the per-user rebrand happens here without touching the project file.
    `ARGENT_RUNNER_APP_BUNDLE_ID=${config.appBundleId}`,
    `ARGENT_RUNNER_TEST_BUNDLE_ID=${config.testBundleId}`,
    "CODE_SIGN_STYLE=Automatic",
  ];
  if (config.teamId) args.push(`DEVELOPMENT_TEAM=${config.teamId}`);
  if (config.signingIdentity) args.push(`CODE_SIGN_IDENTITY=${config.signingIdentity}`);
  if (config.provisioningProfile) {
    args.push(`PROVISIONING_PROFILE_SPECIFIER=${config.provisioningProfile}`);
  }
  return args;
}

/**
 * Artifact cache key: sources + toolchain + the static build args. The args
 * carry the signing config, so hashing them (instead of a hand-bumped version
 * literal) keys the cache on the full build invocation by construction.
 */
export function computeRunnerCacheKey(
  sourcesHash: string,
  xcodeVersion: string,
  staticArgs: readonly string[]
): string {
  return createHash("sha256")
    .update([sourcesHash, xcodeVersion, ...staticArgs].join("\n"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * True when a runner install/launch failure means the (locally provisioned)
 * profile does not cover the target device — the signature of plugging in a
 * NEW phone after the artifact was minted. Recoverable by rebuilding against
 * the concrete device destination (see `rebuildRunnerArtifactForDevice`).
 */
export function isProfileMissingDeviceFailure(logText: string): boolean {
  return (
    logText.includes("0xe8008012") ||
    /doesn't include the currently selected device/i.test(logText) ||
    /provisioning profile cannot be installed on this device/i.test(logText)
  );
}

/**
 * Rebuild the runner against a CONCRETE device destination with
 * `-allowProvisioningDeviceRegistration`, so automatic signing regenerates the
 * profile to include that device. Reuses the same derived-data cache dir —
 * only the signing changes, so the incremental rebuild is fast.
 */
export async function rebuildRunnerArtifactForDevice(
  udid: string,
  config: RunnerSigningConfig = resolveRunnerSigningConfig()
): Promise<RunnerArtifact> {
  return ensureRunnerArtifact(config, { destinationUdid: udid, force: true });
}

/**
 * Ensure a built device runner artifact exists for the current sources +
 * toolchain + signing config, building it if needed. First build takes
 * minutes; subsequent calls are a cache hit.
 */
export async function ensureRunnerArtifact(
  config: RunnerSigningConfig = resolveRunnerSigningConfig(),
  opts: { destinationUdid?: string; force?: boolean } = {}
): Promise<RunnerArtifact> {
  const projectPath = resolveRunnerProjectPath();
  const [sourcesHash, xcodeVersion] = await Promise.all([
    fingerprintRunnerSources(projectPath),
    xcodeVersionFingerprint(),
  ]);
  const staticArgs = runnerBuildStaticArgs(projectPath, config);
  const cacheKey = computeRunnerCacheKey(sourcesHash, xcodeVersion, staticArgs);
  const derivedDataPath = path.join(cacheRoot(), `cache-${cacheKey}`);

  const cached = findBaseXctestrun(derivedDataPath);
  if (cached && !opts.force) return { xctestrunPath: cached, derivedDataPath };

  await fsp.mkdir(derivedDataPath, { recursive: true });
  const args = [
    ...staticArgs,
    "-destination",
    // A concrete device destination (with -allowProvisioningDeviceRegistration)
    // makes automatic signing regenerate the profile to INCLUDE that device —
    // the recovery for plugging in a new phone after the artifact was minted.
    opts.destinationUdid ? `platform=iOS,id=${opts.destinationUdid}` : "generic/platform=iOS",
    "-derivedDataPath",
    derivedDataPath,
  ];

  try {
    await execFileAsync("xcodebuild", args, {
      timeout: BUILD_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout ?? "", e.stderr ?? "", e.message ?? ""].join("\n");
    const hint = resolveSigningHint(output);
    const tail = output.trim().split("\n").slice(-15).join("\n");
    throw new Error(
      `Building the iOS device runner failed.${hint ? ` ${hint}` : ""}\n\nxcodebuild output tail:\n${tail}`,
      { cause: error }
    );
  }

  const built = findBaseXctestrun(derivedDataPath);
  if (!built) {
    throw new Error(
      `xcodebuild reported success but no iphoneos .xctestrun was found under ${derivedDataPath}/Build/Products.`
    );
  }
  return { xctestrunPath: built, derivedDataPath };
}

/**
 * Thrown when an .xctestrun contains no test target this module recognizes —
 * Apple format drift. Typed so the failure surfaces at prepare time with the
 * true cause; a portless clone would instead launch a runner that never binds
 * its port, burn the whole ready timeout, and blame signing or a locked
 * screen.
 */
export class XctestrunFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XctestrunFormatError";
  }
}

/**
 * Clone the .xctestrun with ARGENT_RUNNER_PORT injected into every test
 * target's env dictionaries (all four maps — xctestrun format v2 nests targets
 * under TestConfigurations). The Swift runner reads the port from its
 * environment and binds it on all interfaces, where usbmux's device-side
 * connect reaches it. Throws `XctestrunFormatError` when no target is found.
 */
export async function prepareXctestrunWithPort(
  xctestrunPath: string,
  port: number
): Promise<string> {
  const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", xctestrunPath], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const plist = JSON.parse(stdout) as Record<string, unknown>;

  const envKeys = [
    "EnvironmentVariables",
    "TestingEnvironmentVariables",
    "UITestEnvironmentVariables",
    "UITargetAppEnvironmentVariables",
  ];
  let injectedTargets = 0;
  const injectIntoTarget = (target: Record<string, unknown>): void => {
    injectedTargets += 1;
    for (const key of envKeys) {
      const env = (target[key] ?? {}) as Record<string, unknown>;
      env["ARGENT_RUNNER_PORT"] = String(port);
      target[key] = env;
    }
  };
  const looksLikeTarget = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" &&
    value !== null &&
    ("TestBundlePath" in (value as object) || "TestHostPath" in (value as object));

  const configurations = plist["TestConfigurations"];
  if (Array.isArray(configurations)) {
    for (const config of configurations) {
      const targets = (config as Record<string, unknown>)["TestTargets"];
      if (Array.isArray(targets))
        for (const t of targets) if (looksLikeTarget(t)) injectIntoTarget(t);
    }
  }
  // Format v1: test targets are top-level keys.
  for (const value of Object.values(plist)) if (looksLikeTarget(value)) injectIntoTarget(value);

  if (injectedTargets === 0) {
    throw new XctestrunFormatError(
      `xctestrun format not recognized — cannot inject the runner port into ${xctestrunPath}: ` +
        `no test target with TestBundlePath/TestHostPath found under TestConfigurations or at ` +
        `the top level. Xcode's .xctestrun format has likely drifted past what this version of ` +
        `Argent understands.`
    );
  }

  const jsonPath = xctestrunPath.replace(/\.xctestrun$/, `.env.port-${port}.json`);
  const clonePath = xctestrunPath.replace(/\.xctestrun$/, `.env.port-${port}.xctestrun`);
  await fsp.writeFile(jsonPath, JSON.stringify(plist));
  try {
    await execFileAsync("plutil", ["-convert", "xml1", jsonPath, "-o", clonePath]);
  } finally {
    await fsp.rm(jsonPath, { force: true });
  }
  return clonePath;
}

export interface LaunchedRunner {
  child: ChildProcess;
  logPath: string;
}

/**
 * Launch the runner on the device via `xcodebuild test-without-building`,
 * detached — testmanagerd installs the `<testBundleId>.xctrunner` app and
 * starts the never-ending test. The child outlives individual commands; the
 * blueprint owns its lifecycle. Log output goes to a file for postmortems.
 */
export async function launchRunner(opts: {
  udid: string;
  xctestrunPath: string;
  derivedDataPath: string;
}): Promise<LaunchedRunner> {
  const logDir = path.join(os.homedir(), ".argent", "ios-device-runner", "logs");
  await fsp.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `runner-${opts.udid.slice(0, 8)}-${Date.now()}.log`);
  const logFd = fs.openSync(logPath, "a");

  const child = spawn(
    "xcodebuild",
    [
      "test-without-building",
      "-only-testing",
      "ArgentRunnerUITests/ArgentRunnerSession/testServeCommands",
      "-parallel-testing-enabled",
      "NO",
      "-test-timeouts-enabled",
      "NO",
      "-collect-test-diagnostics",
      "never",
      "-maximum-concurrent-test-device-destinations",
      "1",
      "-destination-timeout",
      "20",
      "-xctestrun",
      opts.xctestrunPath,
      "-derivedDataPath",
      opts.derivedDataPath,
      "-destination",
      `platform=iOS,id=${opts.udid}`,
    ],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    }
  );
  child.unref();
  fs.closeSync(logFd);
  return { child, logPath };
}

/**
 * Kill stale runner xcodebuild processes for a device — left behind when a
 * previous tool-server process exited without disposing its runner service
 * (the child is spawned detached and survives its parent). Two concurrent
 * test sessions on one device conflict in testmanagerd, so the factory sweeps
 * before every launch. Matches only OUR processes: `test-without-building`,
 * this device's destination, and our cache root in the argv.
 */
export async function killStaleRunnersForDevice(udid: string): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=,command="], {
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch {
    return 0;
  }
  let killed = 0;
  for (const line of stdout.split("\n")) {
    if (
      !line.includes("test-without-building") ||
      !line.includes(`platform=iOS,id=${udid}`) ||
      !line.includes(path.join(".argent", "ios-device-runner"))
    ) {
      continue;
    }
    const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? "", 10);
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        continue;
      }
    }
    killed += 1;
  }
  return killed;
}

/** Kill a runner's whole process group (xcodebuild spawns helpers). */
export function killRunnerProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 5_000).unref();
}
