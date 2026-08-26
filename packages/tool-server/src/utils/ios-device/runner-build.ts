import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, withFailureSignal } from "@argent/registry";
import { withKeyedLock } from "../keyed-lock";
import {
  pidIsAlive,
  pollPidsUntilGone,
  scheduleGroupSigkill,
  signalGroupThenPid,
} from "../process-kill";
import { PS_BIN } from "../vega-process";

const execFileAsync = promisify(execFile);

/**
 * Build + launch orchestration for Argent's on-device XCUITest runner
 * (packages/ios-device-runner). The runner is a UI-test bundle whose single
 * `testServeCommands` method hosts an HTTP command server and parks for 24h;
 * see that package's PROTOCOL.md for the wire contract.
 *
 * Device runners must be signed with the USER's Apple team, so artifacts are
 * built lazily on first use (never shipped prebuilt) and cached under
 * ~/.argent/ios-device-runner keyed by a fingerprint of the runner sources,
 * the Xcode/SDK version, and the static xcodebuild arguments (which carry the
 * signing settings). The cache key doubles as
 * protocol versioning: an Argent update that changes runner sources lands in
 * a new cache directory and rebuilds, so the wire protocol needs no version
 * handshake. Superseded cache directories (and per-session xctestrun clones,
 * launch logs and .xcresult bundles) are swept best-effort after each
 * successful artifact resolution; see `sweepRunnerStorage`.
 */

/**
 * The one signing mode: automatic, under a single team. The bundle ids are
 * derived from the team, so they are unique per team by construction and
 * nothing about them is configurable.
 */
export interface RunnerSigningConfig {
  teamId: string;
  appBundleId: string;
  testBundleId: string;
}

function signingTeamError(message: string): Error {
  return withFailureSignal(new Error(message), {
    error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
    failure_stage: "ios_device_signing_team",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

/**
 * Resolve the signing configuration from ARGENT_IOS_TEAM_ID, the one required
 * setting. Deliberately no keychain detection or other inference: an explicit
 * value is predictable on every Mac, and the error tells the user exactly
 * where the id lives. The bundle ids are derived from the team, so they are
 * unique per team by construction and need no configuration.
 */
export function resolveRunnerSigningConfig(): RunnerSigningConfig {
  const teamId = process.env.ARGENT_IOS_TEAM_ID?.trim();
  if (!teamId) {
    throw signingTeamError(
      "ARGENT_IOS_TEAM_ID is not set. Set it to your Apple Developer Team ID " +
        "(a 10-character code): Xcode > Settings > Accounts > select your Apple ID " +
        "and team, or developer.apple.com/account under Membership."
    );
  }
  // The leading "t" keeps the derived segment from starting with a digit.
  const appBundleId = `com.argent.runner.t${teamId.toLowerCase()}`;
  return { teamId, appBundleId, testBundleId: `${appBundleId}.uitests` };
}

/**
 * Locate the runner's Xcode project. Two layouts exist and each has one
 * candidate. In a CHECKOUT the fixed walk-up finds it: src (ts-node) and dist
 * layouts sit at the same depth below packages/tool-server, so both land on
 * packages/ios-device-runner. In a PUBLISHED install the tool-server is one
 * esbuild bundle at <packageDir>/dist/tool-server.cjs and the pack step
 * (bundle-tools.cjs) copies the runner project next to it, so the second
 * candidate resolves relative to the bundle itself. ARGENT_IOS_RUNNER_PROJECT
 * overrides both for unusual layouts. `exists` is a test seam over the
 * filesystem probe.
 */
export function resolveRunnerProjectPath(
  exists: (candidatePath: string) => boolean = fs.existsSync
): string {
  const override = process.env.ARGENT_IOS_RUNNER_PROJECT;
  if (override) return override;
  const projectSuffix = "ios-device-runner/ArgentRunner/ArgentRunner.xcodeproj";
  const candidates = [
    path.resolve(__dirname, "../../../..", projectSuffix),
    path.resolve(__dirname, projectSuffix),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  // Same code family as this file's spawn failure: the runner can never come
  // up from here, and the stage names which precondition broke.
  throw withFailureSignal(
    new Error(
      `Could not locate the ios-device-runner Xcode project (looked at ` +
        `${candidates.join(" and ")}). Set ARGENT_IOS_RUNNER_PROJECT to the ` +
        `ArgentRunner.xcodeproj path.`
    ),
    {
      error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
      failure_stage: "ios_device_runner_project_resolve",
      failure_area: "tool_server",
      error_kind: "not_found",
    }
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
  /**
   * True when this call reused an existing artifact instead of running the
   * build. The blueprint's cache self-heal keys on this: only a CACHED
   * artifact's prepare-time XctestrunFormatError means poisoning worth a
   * wipe-and-rebuild; the same error from a fresh build is genuine format
   * drift and retrying would loop a deterministic failure.
   */
  fromCache: boolean;
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
 * base; they carry a previous session's port.
 *
 * Existence is trusted as validity: a hit here is what makes
 * `ensureRunnerArtifact` skip the build, so a torn file (an interrupted
 * build) keeps hitting until something intervenes. That is deliberate (a
 * content probe would re-parse the plist on every start) because the
 * poisoning IS caught one step later, when `prepareXctestrunWithPort` throws
 * `XctestrunFormatError`, and the blueprint self-heals a cached artifact by
 * wiping this derived dir and forcing one rebuild.
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
/**
 * The xcodebuild lines worth reading out of a failed build. Every failure
 * ends with the same boilerplate (asterisk banner, "The following build
 * commands failed"), so a blind tail shows ceremony and cuts the `error:`
 * lines that name the cause. Deduped because xcodebuild repeats each error
 * per target; falls back to the tail when no error line exists.
 */
export function xcodebuildFailureSummary(output: string): string {
  const lines = output.split("\n");
  const errors = [...new Set(lines.filter((line) => /(^|\s)error: /.test(line)))];
  if (errors.length > 0)
    return errors
      .slice(0, 8)
      .map((line) => line.trim())
      .join("\n");
  return lines.slice(-15).join("\n").trim();
}

export function resolveSigningHint(output: string): string | null {
  const lower = output.toLowerCase();
  // Checked before the provisioning arm: this message also contains the words
  // "provisioning profile", and the sign-into-Xcode advice would be wrong.
  // Normally auto-healed by the concrete-destination rebuild (see
  // isProfileMissingDeviceFailure); surfaced only when that retry failed too.
  if (lower.includes("team has no devices")) {
    return (
      "This team has no registered devices yet. Keep the phone connected and retry: " +
      "building against the connected device registers it with the team."
    );
  }
  if (
    lower.includes("failed registering bundle identifier") ||
    // Bare "is not available" also appears in unrelated failures (destination,
    // device, OS availability), so it only counts as a registration failure
    // alongside its real registration context.
    (lower.includes("is not available") &&
      (lower.includes("identifier") || lower.includes("registered")))
  ) {
    // The derived bundle id is unique per team, so this is not a cross-team
    // collision; free Personal Team accounts cap how many new app ids they
    // may register in a rolling window.
    return (
      "Registering the runner bundle id failed. On a free Personal Team, Apple limits " +
      "new app ids; wait a few days and retry, or sign under a paid team."
    );
  }
  if (lower.includes("no profiles for") || lower.includes("provisioning profile")) {
    return (
      "Provisioning failed. Check that this team's Apple ID is signed into Xcode " +
      "(Xcode > Settings > Accounts), then retry."
    );
  }
  return null;
}

const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The static xcodebuild arguments of a runner build: everything except the
 * per-run `-destination`/`-derivedDataPath` pair. This exact array is both
 * what `ensureRunnerArtifact` spawns and the hashed material of the artifact
 * cache key (`computeRunnerCacheKey`), so any edit here (a flag, signing
 * plumbing, a bundle-id value) changes the key and forces a rebuild instead
 * of silently reusing a stale cached artifact.
 */
export function runnerBuildStaticArgs(projectPath: string, config: RunnerSigningConfig): string[] {
  return [
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
    // script phases; none of them matter for a headless runner artifact.
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
    `DEVELOPMENT_TEAM=${config.teamId}`,
  ];
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
 * profile does not cover the target device, the signature of plugging in a
 * NEW phone after the artifact was minted. Recoverable by rebuilding against
 * the concrete device destination (see `rebuildRunnerArtifactForDevice`).
 */
export function isProfileMissingDeviceFailure(logText: string): boolean {
  return (
    logText.includes("0xe8008012") ||
    /doesn't include the currently selected device/i.test(logText) ||
    /provisioning profile cannot be installed on this device/i.test(logText) ||
    // A team that has never registered a device cannot mint a development
    // profile from the generic-destination build at all, so a brand-new
    // account fails here on its very first run. Same recovery as the other
    // shapes: a concrete-destination build registers the device.
    /team has no devices/i.test(logText)
  );
}

/**
 * Rebuild the runner against a CONCRETE device destination with
 * `-allowProvisioningDeviceRegistration`, so automatic signing regenerates the
 * profile to include that device. Reuses the same derived-data cache dir:
 * only the signing changes, so the incremental rebuild is fast.
 */
export async function rebuildRunnerArtifactForDevice(
  udid: string,
  config: RunnerSigningConfig
): Promise<RunnerArtifact> {
  return ensureRunnerArtifact(config, { destinationUdid: udid, force: true });
}

/**
 * In-process build serialization, keyed by artifact cache key: the registry
 * dedups per-URN (per-device) only, so two device factories in one server
 * would otherwise race `build-for-testing` into the same derived dir, the
 * origin of torn artifacts. Same shared mutex as withFlowFileLock
 * (flow-utils.ts). Deliberately NO cross-process file lock: one tool-server
 * per Mac is the deployment, the storage sweep already tolerates
 * cross-process races best-effort, and the blueprint's cache self-heal turns
 * a residual torn artifact into a one-rebuild recovery, not a permanent
 * failure.
 */
const runnerBuildLocks = new Map<string, Promise<unknown>>();

async function withRunnerBuildLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(runnerBuildLocks, key, fn);
}

/**
 * Ensure a built device runner artifact exists for the current sources +
 * toolchain + signing config, building it if needed. First build takes
 * minutes; subsequent calls are a cache hit. `force` skips the cache check
 * and always rebuilds; the profile-missing-device retry and the blueprint's
 * poisoned-cache self-heal both use it.
 */
export async function ensureRunnerArtifact(
  config: RunnerSigningConfig,
  opts: {
    destinationUdid?: string;
    force?: boolean;
    /** Test seam over the xcodebuild arm; defaults to the real build. */
    build?: typeof buildRunnerArtifact;
  } = {}
): Promise<RunnerArtifact> {
  const projectPath = resolveRunnerProjectPath();
  const [sourcesHash, xcodeVersion] = await Promise.all([
    fingerprintRunnerSources(projectPath),
    xcodeVersionFingerprint(),
  ]);
  const staticArgs = runnerBuildStaticArgs(projectPath, config);
  const cacheKey = computeRunnerCacheKey(sourcesHash, xcodeVersion, staticArgs);
  const derivedDataPath = path.join(cacheRoot(), `cache-${cacheKey}`);
  const build = opts.build ?? buildRunnerArtifact;

  // The cache check sits INSIDE the per-key lock: a hit while a build for the
  // SAME key is in flight would hand out the half-written file that build is
  // producing, so it must wait that build out, after which the check finds
  // the finished artifact and concurrent cold-cache callers pay exactly one
  // build between them. With no build in flight the chain is empty and a hit
  // costs one microtask; other keys have their own chains and never queue.
  const artifact = await withRunnerBuildLock(cacheKey, async (): Promise<RunnerArtifact> => {
    const cached = opts.force ? null : findBaseXctestrun(derivedDataPath);
    if (cached) return { xctestrunPath: cached, derivedDataPath, fromCache: true };
    return build(derivedDataPath, staticArgs, opts.destinationUdid);
  });

  // Success-only, fire-and-forget storage sweep. Only after the current
  // artifact is known good may its superseded siblings go: on a FAILED build
  // the previous key's directory is the only working artifact a rollback
  // would reuse, so the failure path (the throw above) must never reach this.
  // The session's own env clone is safe by ordering: sweepRunnerStorage
  // snapshots its listings synchronously, before this function resolves,
  // and the clone is only minted later by `prepareXctestrunWithPort`.
  void sweepRunnerStorage({ derivedDataPath });
  return artifact;
}

/**
 * Marker naming the process whose build owns a derived dir, written for the
 * duration of the xcodebuild call. It is what lets the storage sweep tell an
 * in-flight build tree from a superseded one; see `buildIsInFlight`.
 */
const BUILD_OWNER_FILE = ".argent-build-owner";

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
    // Concrete-destination why: see rebuildRunnerArtifactForDevice.
    destinationUdid ? `platform=iOS,id=${destinationUdid}` : "generic/platform=iOS",
    "-derivedDataPath",
    derivedDataPath,
  ];

  const ownerPath = path.join(derivedDataPath, BUILD_OWNER_FILE);
  await fsp.writeFile(ownerPath, String(process.pid));
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
    throw new Error(
      `Building the iOS device runner failed.${hint ? ` ${hint}` : ""}\n\n` +
        `xcodebuild reported:\n${xcodebuildFailureSummary(output)}`,
      { cause: error }
    );
  } finally {
    // A marker outliving its build (SIGKILLed tool-server) is harmless: the
    // sweep only spares a dir whose recorded pid is still alive.
    await fsp.rm(ownerPath, { force: true }).catch(() => {});
  }

  const built = findBaseXctestrun(derivedDataPath);
  if (!built) {
    throw new Error(
      `xcodebuild reported success but no iphoneos .xctestrun was found under ${derivedDataPath}/Build/Products.`
    );
  }
  return { xctestrunPath: built, derivedDataPath, fromCache: false };
}

/** How many runner-*.log launch logs a sweep keeps (newest first). */
export const MAX_RUNNER_LOG_FILES = 20;

/**
 * How many Test-*.xcresult bundles a sweep keeps (newest first). runner-crash
 * reads only the newest; the spares cover the session before it. A bundle
 * being written RIGHT NOW is by construction the newest of the family, so a
 * concurrent sweep can never take it.
 */
export const MAX_RUNNER_RESULT_BUNDLES = 3;

/** A cache-<key> entry under cacheRoot(), hex-keyed, ours to manage. */
const CACHE_DIR_NAME_RE = /^cache-[0-9a-f]+$/;
/** A per-session port-injected clone minted by `prepareXctestrunWithPort`. */
const ENV_CLONE_NAME_RE = /\.env\.port-\d+\.xctestrun$/;
/** A launch log minted by `launchRunner`; the trailing number is Date.now(). */
const RUNNER_LOG_NAME_RE = /^runner-.+-(\d+)\.log$/;
/** An xcodebuild result bundle: Test-<scheme>-<date>-<utc offset>.xcresult. */
const XCRESULT_NAME_RE = /^Test-.+-(\d{4}\.\d{2}\.\d{2}_\d{2}-\d{2}-\d{2}).*\.xcresult$/;

/** What `planRunnerStorageSweep` decided to delete, as per-directory names. */
interface RunnerStorageSweepPlan {
  cacheDirNames: string[];
  cloneNames: string[];
  logNames: string[];
  resultBundleNames: string[];
}

/**
 * Decision core of the storage sweep: pure over injected directory listings
 * (the test seam, like `waitForPidsToExit`'s process-table seams). Four
 * artifact families accumulate forever under ~/.argent/ios-device-runner
 * without this: cache-<key> derived-data dirs (hundreds of MB, a new key per
 * source/Xcode/signing change), per-session .env.port-N.xctestrun clones,
 * per-launch runner-*.log files, and the Test-*.xcresult bundle every session
 * writes under the current derived dir's Logs/Test (`launchRunner` passes no
 * -resultBundlePath, and the current cache dir is deliberately kept, so
 * nothing else ever prunes those).
 *
 * The plan deletes cache dirs other than the current key's and those named in
 * `busyCacheDirNames`, env clones other than `keepCloneName`, and all but the
 * newest `maxLogFiles` logs / `maxResultBundles` result bundles (by the
 * timestamp embedded in their names). Names that match none of the families
 * are never touched.
 */
export function planRunnerStorageSweep(listing: {
  /** Basename of the current derived-data dir (`cache-<key>`); kept. */
  currentCacheDirName: string;
  /** Entries under cacheRoot(). */
  cacheDirNames: readonly string[];
  /** Cache dirs a live build owns; kept. See `buildIsInFlight`. */
  busyCacheDirNames?: readonly string[];
  /** Entries under the current derived dir's Build/Products. */
  productNames: readonly string[];
  /** Basename of an env clone to keep (none at ensure-time). */
  keepCloneName?: string | null;
  /** Entries under the launch-log dir. */
  logNames: readonly string[];
  /** Entries under the current derived dir's Logs/Test. */
  testLogNames: readonly string[];
  maxLogFiles?: number;
  maxResultBundles?: number;
}): RunnerStorageSweepPlan {
  const cacheDirNames = listing.cacheDirNames.filter(
    (name) =>
      CACHE_DIR_NAME_RE.test(name) &&
      name !== listing.currentCacheDirName &&
      !listing.busyCacheDirNames?.includes(name)
  );
  const cloneNames = listing.productNames.filter(
    (name) => ENV_CLONE_NAME_RE.test(name) && name !== listing.keepCloneName
  );
  return {
    cacheDirNames,
    cloneNames,
    logNames: beyondNewest(
      listing.logNames,
      RUNNER_LOG_NAME_RE,
      listing.maxLogFiles ?? MAX_RUNNER_LOG_FILES
    ),
    resultBundleNames: beyondNewest(
      listing.testLogNames,
      XCRESULT_NAME_RE,
      listing.maxResultBundles ?? MAX_RUNNER_RESULT_BUNDLES
    ),
  };
}

/**
 * The names beyond the newest `max` of one capped family: those matching
 * `pattern`, whose first capture group is a timestamp that sorts
 * chronologically once stripped to digits. Non-matching names are foreign and
 * never returned.
 */
function beyondNewest(names: readonly string[], pattern: RegExp, max: number): string[] {
  const stamp = (name: string): number =>
    Number((pattern.exec(name)?.[1] ?? "").replace(/\D/g, ""));
  return names
    .filter((name) => pattern.test(name))
    .sort((a, b) => stamp(b) - stamp(a) || a.localeCompare(b))
    .slice(max);
}

/**
 * Sweep stale runner storage around a freshly resolved artifact. Listings are
 * snapshotted SYNCHRONOUSLY (before the `void`-ing caller's next await can
 * run), so files created after the call (the session's own env clone) can
 * never enter the plan; only the deletes are async. Best-effort throughout:
 * a concurrent tool-server may race the same directories, so unreadable
 * listings plan nothing, per-path rm failures are swallowed, and the returned
 * promise never rejects (safe to fire-and-forget). Deliberately silent: this
 * module logs nothing, and a lost sweep just retries on the next start.
 */
export function sweepRunnerStorage(opts: {
  derivedDataPath: string;
  keepClonePath?: string | null;
  /** Test seam; defaults to the real launch-log dir. */
  logDir?: string;
  maxLogFiles?: number;
  maxResultBundles?: number;
}): Promise<void> {
  const cacheRootDir = path.dirname(opts.derivedDataPath);
  const productsDir = path.join(opts.derivedDataPath, "Build", "Products");
  const testLogsDir = path.join(opts.derivedDataPath, "Logs", "Test");
  const logDir = opts.logDir ?? logsRoot();
  const cacheDirNames = listNamesSync(cacheRootDir);
  const plan = planRunnerStorageSweep({
    currentCacheDirName: path.basename(opts.derivedDataPath),
    cacheDirNames,
    busyCacheDirNames: cacheDirNames.filter((name) =>
      buildIsInFlight(path.join(cacheRootDir, name))
    ),
    productNames: listNamesSync(productsDir),
    keepCloneName: opts.keepClonePath ? path.basename(opts.keepClonePath) : null,
    logNames: listNamesSync(logDir),
    testLogNames: listNamesSync(testLogsDir),
    maxLogFiles: opts.maxLogFiles,
    maxResultBundles: opts.maxResultBundles,
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
    ...plan.resultBundleNames.map((name) => rmQuiet(path.join(testLogsDir, name))),
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
 * True when a derived dir carries a build-owner marker naming a LIVE process.
 * Two checkouts on one Mac fingerprint to two cache keys, so each one's dir is
 * a plain "superseded sibling" to the other; without this probe a fast cache
 * hit here would rm -rf a peer that is minutes into a 15-minute
 * `build-for-testing`. Same ownership rule as `killStaleRunnersForDevice`: an
 * absent marker, or one whose owner is gone, protects nothing. Read
 * synchronously to keep the sweep's snapshot-before-the-caller-resumes
 * ordering.
 */
function buildIsInFlight(cacheDirPath: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(path.join(cacheDirPath, BUILD_OWNER_FILE), "utf8"), 10);
  } catch {
    return false;
  }
  return Number.isFinite(pid) && pidIsAlive(pid);
}

/**
 * Thrown when an .xctestrun cannot be prepared for launch: it does not parse
 * as a plist (a truncated file, the signature of a build interrupted
 * mid-write), or it parses but contains no test target this module
 * recognizes (Apple format drift). Typed so the failure surfaces at prepare
 * time with the true cause; a portless clone would instead launch a runner
 * that never binds its port, burn the whole ready timeout, and blame signing
 * or a locked screen. One class for both shapes on purpose; the blueprint's
 * cache self-heal keys on it: a first occurrence on a CACHED artifact means
 * cache poisoning (wipe the derived dir, force one rebuild), while on a
 * freshly built artifact it propagates as genuine drift.
 */
export class XctestrunFormatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "XctestrunFormatError";
  }
}

/**
 * Clone the .xctestrun with ARGENT_RUNNER_PORT injected into every test
 * target's env dictionaries (all four maps: xctestrun format v2 nests targets
 * under TestConfigurations). The Swift runner reads the port from its
 * environment and binds it on the device's loopback, where usbmux's
 * device-side connect terminates. Throws `XctestrunFormatError` when the
 * plist cannot be parsed or no target is found.
 */
export async function prepareXctestrunWithPort(
  xctestrunPath: string,
  port: number
): Promise<string> {
  let plist: Record<string, unknown>;
  try {
    const { stdout } = await execFileAsync(
      "plutil",
      ["-convert", "json", "-o", "-", xctestrunPath],
      { maxBuffer: 32 * 1024 * 1024 }
    );
    plist = JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    // A raw plutil failure here would read as an infrastructure error; typed,
    // the blueprint recognizes a torn cached artifact and self-heals it.
    throw new XctestrunFormatError(
      `xctestrun at ${xctestrunPath} could not be parsed as a plist: ` +
        `${(error as Error).message}. Delete ~/.argent/ios-device-runner and retry to ` +
        `force a rebuild.`,
      { cause: error }
    );
  }

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
      `xctestrun format not recognized: no test target found in ${xctestrunPath}. ` +
        `Xcode's .xctestrun format has likely drifted past what this Argent version ` +
        `understands; update Argent.`
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
 * detached: testmanagerd installs the `<testBundleId>.xctrunner` app and
 * starts the never-ending test. The child outlives individual commands; the
 * blueprint owns its lifecycle. Log output goes to a file for postmortems.
 *
 * Resolves only once xcodebuild has actually spawned. A spawn failure (Xcode
 * moved or removed after an artifact cache hit) arrives as an async "error"
 * event that nothing else listens for, so it rejects here instead of killing
 * the whole tool-server as an uncaught exception.
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
  try {
    // events.once resolves on "spawn", rejects on "error", and removes both
    // listeners either way.
    await once(child, "spawn");
  } catch (error) {
    throw new FailureError(
      "xcodebuild could not be started. Check that Xcode is installed and on PATH.",
      {
        error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
        failure_stage: "ios_device_runner_spawn",
        failure_area: "tool_server",
        error_kind: "subprocess",
      },
      { cause: error as Error }
    );
  }
  // A late "error" event must never become an uncaught exception.
  child.on("error", () => {});
  return { child, logPath };
}

/**
 * Kill ORPHANED stale runner xcodebuild processes for a device, left behind
 * when a previous tool-server process exited without disposing its runner
 * service (the child is spawned detached and survives its parent). Two
 * concurrent test sessions on one device conflict in testmanagerd, so the
 * factory sweeps before every launch. Matches only OUR processes:
 * `test-without-building`, this device's destination, and our cache root in
 * the argv.
 *
 * A match is reaped only when its owner is gone: ppid 1 (the dead
 * tool-server's runner was re-parented to launchd) or a ppid that no longer
 * exists (the kill(ppid, 0) liveness probe fails). A matched runner with a
 * LIVE parent belongs to a peer tool-server and is deliberately spared:
 * reaping on the argv alone made two servers driving one device SIGTERM each
 * other's runners on every factory start. If the spared runner's session
 * genuinely conflicts with ours, testmanagerd raises its own loud
 * two-simultaneous-sessions error at launch, which is the intended outcome.
 *
 * Resolves only once every signaled pid has exited (or been SIGKILLed after
 * `STALE_EXIT_TIMEOUT_MS`); returning on the bare SIGTERM would let a fast
 * cache-hit start race the old session's testmanagerd teardown, recreating
 * exactly the conflict this sweep exists to prevent. No stale runners means
 * no wait at all. The ps-snapshot/probe/kill/sleep parameters are test seams,
 * `waitForPidsToExit`'s plus the process listing; the escalation forwards
 * them wholesale.
 */
export async function killStaleRunnersForDevice(
  udid: string,
  opts: {
    /** Snapshot of `ps -ax -o pid=,ppid=,command=`; defaults to running it. */
    listProcesses?: () => Promise<string>;
    timeoutMs?: number;
    pollIntervalMs?: number;
    isAlive?: (pid: number) => boolean;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<number> {
  const listProcesses = opts.listProcesses ?? listProcessTable;
  const isAlive = opts.isAlive ?? pidIsAlive;
  const kill = opts.kill ?? process.kill.bind(process);

  let stdout: string;
  try {
    stdout = await listProcesses();
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
    const [pidField, ppidField] = line.trim().split(/\s+/);
    const pid = Number.parseInt(pidField ?? "", 10);
    const ppid = Number.parseInt(ppidField ?? "", 10);
    // An unparseable line is spared like a live-parent one: when ownership
    // cannot be determined, not killing is the recoverable mistake.
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid === process.pid) continue;
    if (ppid !== 1 && isAlive(ppid)) continue; // a live peer tool-server owns it
    if (!signalGroupThenPid(kill, pid, "SIGTERM")) continue; // nothing reached, nothing to await
    signaled.push(pid);
  }
  if (signaled.length > 0) await waitForPidsToExit(signaled, opts);
  return signaled.length;
}

/**
 * Argv of the real process-table snapshot, exported so tests can pin the
 * binary: it must be `PS_BIN`, never bare "ps". A tool-server launched from a
 * GUI / launchd context inherits a PATH without /bin, a bare "ps" spawn
 * ENOENTs there, and the sweep's catch would read that failure as zero stale
 * runners, silently reaping nothing; see PS_BIN's comment in vega-process.ts.
 */
export const PROCESS_TABLE_ARGV = [PS_BIN, "-ax", "-o", "pid=,ppid=,command="] as const;

/** Real process-table snapshot behind `killStaleRunnersForDevice`'s seam. */
async function listProcessTable(): Promise<string> {
  const [bin, ...args] = PROCESS_TABLE_ARGV;
  const { stdout } = await execFileAsync(bin, args, {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** SIGTERM-to-SIGKILL escalation delay; mirrors killRunnerProcess's 5s. */
const STALE_EXIT_TIMEOUT_MS = 5_000;
const STALE_EXIT_POLL_INTERVAL_MS = 100;

/**
 * Wait (bounded) for already-signaled pids to exit, then SIGKILL holdouts:
 * process group first with a pid fallback, like killRunnerProcess. Pids dead
 * on entry cost nothing; live ones are re-probed every poll interval, so a
 * cooperative exit returns within one interval. Returns the SIGKILLed pids.
 * The probe/kill/sleep parameters are test seams over the process table,
 * forwarded to the shared poll/escalation primitives in utils/process-kill.
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
  const kill = opts.kill ?? process.kill.bind(process);
  const remaining = await pollPidsUntilGone(pids, {
    timeoutMs: opts.timeoutMs ?? STALE_EXIT_TIMEOUT_MS,
    pollIntervalMs: opts.pollIntervalMs ?? STALE_EXIT_POLL_INTERVAL_MS,
    isAlive: opts.isAlive,
    sleep: opts.sleep,
  });
  for (const pid of remaining) {
    // A swallowed double failure means the pid exited between the last poll
    // and the escalation, which is the desired outcome.
    signalGroupThenPid(kill, pid, "SIGKILL");
  }
  return remaining;
}

/** Kill a runner's whole process group (xcodebuild spawns helpers). */
export function killRunnerProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  signalGroupThenPid(process.kill.bind(process), pid, "SIGTERM");
  // Unconditional after the grace period; this path has always accepted the
  // recycled-pgid window (boot-electron's fallback gates on a re-probe).
  scheduleGroupSigkill(pid, 5_000, { gateOnGroupLiveness: false });
}
