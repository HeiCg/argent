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
 * handshake. Superseded cache directories (and per-session xctestrun clones
 * and launch logs) are swept best-effort after each successful artifact
 * resolution — see `sweepRunnerStorage`.
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

function logsRoot(): string {
  return path.join(os.homedir(), ".argent", "ios-device-runner", "logs");
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
  const artifact =
    cached && !opts.force
      ? { xctestrunPath: cached, derivedDataPath }
      : await buildRunnerArtifact(derivedDataPath, staticArgs, opts.destinationUdid);

  // Success-only, fire-and-forget storage sweep. Only after the current
  // artifact is known good may its superseded siblings go: on a FAILED build
  // the previous key's directory is the only working artifact a rollback
  // would reuse, so the failure path (the throw above) must never reach this.
  // The session's own env clone is safe by ordering — sweepRunnerStorage
  // snapshots its listings synchronously, before this function resolves,
  // and the clone is only minted later by `prepareXctestrunWithPort`.
  void sweepRunnerStorage({ derivedDataPath });
  return artifact;
}

/** The build arm of `ensureRunnerArtifact`: cache miss (or forced rebuild). */
async function buildRunnerArtifact(
  derivedDataPath: string,
  staticArgs: readonly string[],
  destinationUdid: string | undefined
): Promise<RunnerArtifact> {
  await fsp.mkdir(derivedDataPath, { recursive: true });
  const args = [
    ...staticArgs,
    "-destination",
    // A concrete device destination (with -allowProvisioningDeviceRegistration)
    // makes automatic signing regenerate the profile to INCLUDE that device —
    // the recovery for plugging in a new phone after the artifact was minted.
    destinationUdid ? `platform=iOS,id=${destinationUdid}` : "generic/platform=iOS",
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

/** How many runner-*.log launch logs a sweep keeps (newest first). */
export const MAX_RUNNER_LOG_FILES = 20;

/** A cache-<key> entry under cacheRoot() — hex-keyed, ours to manage. */
const CACHE_DIR_NAME_RE = /^cache-[0-9a-f]+$/;
/** A per-session port-injected clone minted by `prepareXctestrunWithPort`. */
const ENV_CLONE_NAME_RE = /\.env\.port-\d+\.xctestrun$/;
/** A launch log minted by `launchRunner`; the trailing number is Date.now(). */
const RUNNER_LOG_NAME_RE = /^runner-.+-(\d+)\.log$/;

/** What `planRunnerStorageSweep` decided to delete, as per-directory names. */
export interface RunnerStorageSweepPlan {
  cacheDirNames: string[];
  cloneNames: string[];
  logNames: string[];
}

/**
 * Decision core of the storage sweep — pure over injected directory listings
 * (the test seam, like `waitForPidsToExit`'s process-table seams). Three
 * artifact families accumulate forever under ~/.argent/ios-device-runner
 * without this: cache-<key> derived-data dirs (hundreds of MB, a new key per
 * source/Xcode/signing change), per-session .env.port-N.xctestrun clones, and
 * per-launch runner-*.log files. The plan deletes cache dirs other than the
 * current key's, env clones other than `keepCloneName`, and all but the
 * newest `maxLogFiles` logs (by the Date.now() embedded in their names).
 * Names that match none of the families are never touched.
 */
export function planRunnerStorageSweep(listing: {
  /** Basename of the current derived-data dir (`cache-<key>`) — kept. */
  currentCacheDirName: string;
  /** Entries under cacheRoot(). */
  cacheDirNames: readonly string[];
  /** Entries under the current derived dir's Build/Products. */
  productNames: readonly string[];
  /** Basename of an env clone to keep (none at ensure-time). */
  keepCloneName?: string | null;
  /** Entries under the launch-log dir. */
  logNames: readonly string[];
  maxLogFiles?: number;
}): RunnerStorageSweepPlan {
  const maxLogFiles = listing.maxLogFiles ?? MAX_RUNNER_LOG_FILES;
  const cacheDirNames = listing.cacheDirNames.filter(
    (name) => CACHE_DIR_NAME_RE.test(name) && name !== listing.currentCacheDirName
  );
  const cloneNames = listing.productNames.filter(
    (name) => ENV_CLONE_NAME_RE.test(name) && name !== listing.keepCloneName
  );
  const logNames = listing.logNames
    .filter((name) => RUNNER_LOG_NAME_RE.test(name))
    .sort((a, b) => logTimestamp(b) - logTimestamp(a) || a.localeCompare(b))
    .slice(maxLogFiles);
  return { cacheDirNames, cloneNames, logNames };
}

function logTimestamp(name: string): number {
  return Number(RUNNER_LOG_NAME_RE.exec(name)?.[1] ?? 0);
}

/**
 * Sweep stale runner storage around a freshly resolved artifact. Listings are
 * snapshotted SYNCHRONOUSLY — before the `void`-ing caller's next await can
 * run — so files created after the call (the session's own env clone) can
 * never enter the plan; only the deletes are async. Best-effort throughout:
 * a concurrent tool-server may race the same directories, so unreadable
 * listings plan nothing, per-path rm failures are swallowed, and the returned
 * promise never rejects (safe to fire-and-forget). Deliberately silent — this
 * module logs nothing, and a lost sweep just retries on the next start.
 */
export function sweepRunnerStorage(opts: {
  derivedDataPath: string;
  keepClonePath?: string | null;
  /** Test seam; defaults to the real launch-log dir. */
  logDir?: string;
  maxLogFiles?: number;
}): Promise<void> {
  const cacheRootDir = path.dirname(opts.derivedDataPath);
  const productsDir = path.join(opts.derivedDataPath, "Build", "Products");
  const logDir = opts.logDir ?? logsRoot();
  const plan = planRunnerStorageSweep({
    currentCacheDirName: path.basename(opts.derivedDataPath),
    cacheDirNames: listNamesSync(cacheRootDir),
    productNames: listNamesSync(productsDir),
    keepCloneName: opts.keepClonePath ? path.basename(opts.keepClonePath) : null,
    logNames: listNamesSync(logDir),
    maxLogFiles: opts.maxLogFiles,
  });
  const rmQuiet = async (target: string): Promise<void> => {
    try {
      await fsp.rm(target, { recursive: true, force: true });
    } catch {
      /* raced a concurrent tool-server; the next sweep retries */
    }
  };
  return Promise.all([
    ...plan.cacheDirNames.map((name) => rmQuiet(path.join(cacheRootDir, name))),
    ...plan.cloneNames.map((name) => rmQuiet(path.join(productsDir, name))),
    ...plan.logNames.map((name) => rmQuiet(path.join(logDir, name))),
  ]).then(() => undefined);
}

function listNamesSync(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
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
 * environment and binds it on the device's loopback, where usbmux's
 * device-side connect terminates. Throws `XctestrunFormatError` when no target is found.
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
  const logDir = logsRoot();
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
 *
 * Resolves only once every signaled pid has exited (or been SIGKILLed after
 * `STALE_EXIT_TIMEOUT_MS`) — returning on the bare SIGTERM would let a fast
 * cache-hit start race the old session's testmanagerd teardown, recreating
 * exactly the conflict this sweep exists to prevent. No stale runners means
 * no wait at all.
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
  const signaled: number[] = [];
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
    signaled.push(pid);
  }
  if (signaled.length > 0) await waitForPidsToExit(signaled);
  return signaled.length;
}

/** SIGTERM-to-SIGKILL escalation delay — mirrors killRunnerProcess's 5s. */
const STALE_EXIT_TIMEOUT_MS = 5_000;
const STALE_EXIT_POLL_INTERVAL_MS = 100;

/**
 * Wait (bounded) for already-signaled pids to exit, then SIGKILL holdouts —
 * process group first with a pid fallback, like killRunnerProcess. Pids dead
 * on entry cost nothing; live ones are re-probed every poll interval, so a
 * cooperative exit returns within one interval. Returns the SIGKILLed pids.
 * The probe/kill/sleep parameters are test seams over the process table.
 */
export async function waitForPidsToExit(
  pids: readonly number[],
  opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    isAlive?: (pid: number) => boolean;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<number[]> {
  const timeoutMs = opts.timeoutMs ?? STALE_EXIT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? STALE_EXIT_POLL_INTERVAL_MS;
  const isAlive = opts.isAlive ?? pidIsAlive;
  const kill = opts.kill ?? process.kill.bind(process);
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const maxPolls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  let remaining = pids.filter((pid) => isAlive(pid));
  for (let poll = 0; poll < maxPolls && remaining.length > 0; poll += 1) {
    await sleep(pollIntervalMs);
    remaining = remaining.filter((pid) => isAlive(pid));
  }
  for (const pid of remaining) {
    try {
      kill(-pid, "SIGKILL");
    } catch {
      try {
        kill(pid, "SIGKILL");
      } catch {
        /* exited between the last poll and the escalation */
      }
    }
  }
  return remaining;
}

/** Signal 0 probes liveness without delivering anything. */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
