/**
 * Build + launch orchestration for Argent's on-device XCUITest runner
 * `packages/ios-device-runner`. The runner is a UI-test bundle whose single
 * `testServeCommands` method hosts an HTTP command server and parks for 24h;
 * see that package's PROTOCOL.md for the wire contract.
 *
 * Device runners must be signed with the USER's Apple team, so artifacts are
 * built lazily on first use (never shipped prebuilt) into the one build dir
 * ~/.argent/ios-device-runner/derived, stamped with a fingerprint of the
 * runner sources, the Xcode/SDK version, and the static xcodebuild arguments
 * (which carry the signing settings). A stamp mismatch (an Argent or Xcode
 * update, a team change) rebuilds in place, so exactly one artifact tree
 * exists at a time and nothing accumulates. The stamp doubles as protocol
 * versioning: an Argent update that changes runner sources rebuilds the
 * runner, so the wire protocol needs no version handshake. Launch logs and
 * crash bundles are one fixed path per device, overwritten each launch.
 */

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
 * Config for automatic singing, under a single team. The
 * bundle ids are derived from the team, so they are unique
 * per team by construction and nothing about them is configurable.
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
 * Resolve the signing configuration from ARGENT_IOS_TEAM_ID. The bundle ids are
 * derived from the team, so they are unique per team by construction and need no
 * configuration.
 */
export function resolveRunnerSigningConfig(): RunnerSigningConfig {
  const teamId = process.env.ARGENT_IOS_TEAM_ID?.trim();

  if (!teamId) {
    throw signingTeamError(
      "ARGENT_IOS_TEAM_ID is not set. Set it to your Apple Developer Team ID " +
        "(a 10-character code). Xcode > Settings > Accounts > select your Apple ID " +
        "and team, or developer.apple.com/account under Membership."
    );
  }

  // The leading "t" keeps the derived segment from starting with a digit.
  const appBundleId = `com.argent.runner.t${teamId.toLowerCase()}`;

  return {
    teamId,
    appBundleId,
    testBundleId: `${appBundleId}.uitests`,
  };
}

const PROJECT_SUFFIX = "ios-device-runner/ArgentRunner/ArgentRunner.xcodeproj";

/**
 * Locates the runner's Xcode project.
 *
 * Next to the tool-server bundle by default, where the pack step copies it.
 * Development builds of the bundle produce the same layout, so this is the
 * one location; a tool-server run outside the bundle (ts-node, tsc dist, tests)
 * sets ARGENT_IOS_RUNNER_PROJECT instead.
 */
export function resolveRunnerProjectPath(): string {
  const override = process.env.ARGENT_IOS_RUNNER_PROJECT;

  if (override) {
    return override;
  }

  const candidate = path.resolve(__dirname, PROJECT_SUFFIX);

  if (fs.existsSync(candidate)) {
    return candidate;
  }

  throw withFailureSignal(
    new Error(
      `Could not locate the ios-device-runner Xcode project (looked at ` +
        `${candidate}). Set ARGENT_IOS_RUNNER_PROJECT to the ` +
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

/** Hashes runner sources. */
async function fingerprintRunnerSources(projectPath: string): Promise<string> {
  const root = path.dirname(projectPath);
  const hash = createHash("sha256");

  // Note that hashing is order sensitive in that case. That's the reason for
  // sorting files in subfolders.
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (["xcuserdata", "DerivedData"].includes(entry.name)) {
          continue;
        }

        await walk(full);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        const content = await fsp.readFile(full);

        // We are not using size and mtime as pack step copy & npm install restamp mtimes.
        // This would invalidate the cache.
        hash.update(`${path.relative(root, full)}|${content.length}\n`);
        hash.update(content);
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
  fromCache: boolean;
}

function derivedDir(): string {
  return path.join(os.homedir(), ".argent", "ios-device-runner", "derived");
}

function logsRoot(): string {
  return path.join(os.homedir(), ".argent", "ios-device-runner", "logs");
}

function resultsRoot(): string {
  return path.join(os.homedir(), ".argent", "ios-device-runner", "results");
}

/**
 * Stamp naming the generation (cache key) of the artifact in the build dir,
 * written only after a successful build. Cache hits require a matching stamp,
 * so an interrupted build (no stamp, or the previous generation's) rebuilds
 * instead of trusting whatever files survived.
 */
const CACHE_KEY_FILE = ".argent-cache-key";

/**
 * Find the base device .xctestrun under a derived-data dir.
 */
function findBaseXctestrun(derivedDataPath: string): string | null {
  const productsDir = path.join(derivedDataPath, "Build", "Products");

  if (!fs.existsSync(productsDir)) {
    return null;
  }

  const candidates = fs.readdirSync(productsDir).filter((name) => {
    return name.endsWith(".xctestrun") && name.includes("iphoneos");
  });

  if (candidates.length === 0) {
    return null;
  }

  return path.join(productsDir, candidates.sort()[0]!);
}

/** The xcodebuild lines worth reading out of a failed build. */
export function xcodebuildFailureSummary(output: string): string {
  // Every failure ends with the same boilerplate (asterisk banner, "The following build
  // commands failed"), so a blind tail shows ceremony and cuts the `error:`
  // lines that name the cause. Deduped because xcodebuild repeats each error
  // per target; falls back to the tail when no error line exists.
  const lines = output.split("\n");
  const errors = [...new Set(lines.filter((line) => /(^|\s)error: /.test(line)))];

  if (errors.length > 0) {
    return errors
      .slice(0, 8)
      .map((line) => line.trim())
      .join("\n");
  }

  return lines.slice(-15).join("\n").trim();
}

export function resolveSigningHint(output: string): string | null {
  const lower = output.toLowerCase();

  // Checked before the provisioning arm: this message also contains the words
  // "provisioning profile", and the sign-into-Xcode advice would be wrong.
  // Normally auto-healed by the concrete-destination rebuild (see
  // isProfileMissingDeviceFailure). Surfaced only when that retry failed too.
  if (lower.includes("team has no devices")) {
    return (
      "This team has no registered devices yet. Keep the phone connected and retry: " +
      "building against the connected device registers it with the team."
    );
  }

  if (
    lower.includes("failed registering bundle identifier") ||
    // Bare "is not available" also appears in unrelated failures destination,
    // device, OS availability, so it only counts as a registration failure
    // alongside its real registration context.
    (lower.includes("is not available") &&
      (lower.includes("identifier") || lower.includes("registered")))
  ) {
    // The derived bundle id is unique per team, so this is not a cross-team
    // collision. Free personal Team accounts cap how many new app ids they
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
 * The static xcodebuild arguments of a runner build. Everything except the per-run
 *`-destination` and `-derivedDataPath` pair.
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
    "COMPILER_INDEX_STORE_ENABLE=NO",
    "ENABLE_CODE_COVERAGE=NO",
    "ONLY_ACTIVE_ARCH=YES",
    "ENABLE_PREVIEWS=NO",
    "ENABLE_DEBUG_DYLIB=NO",
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
 * True when a runner install or launch failure means the profile does not cover
 * the target device, the signature of plugging in a new phone after the artifact
 * was minted. Recoverable by rebuilding against the concrete device destination
 * (see `rebuildRunnerArtifactForDevice`).
 */
export function isProfileMissingDeviceFailure(logText: string): boolean {
  return (
    logText.includes("0xe8008012") ||
    /doesn't include the currently selected device/i.test(logText) ||
    /provisioning profile cannot be installed on this device/i.test(logText) ||
    // A team that has never registered a device cannot mint a development
    // profile from the generic-destination build at all, so a brand-new
    // account fails here on its very first run. Same recovery as the other
    // shapes. A concrete-destination build registers the device.
    /team has no devices/i.test(logText)
  );
}

/**
 * Rebuild the runner against a concrete device destination with `-allowProvisioningDeviceRegistration`,
 * so automatic signing regenerates the profile to include that device. Reuses
 * the same derived-data cache dir: only the signing changes, so the incremental
 * rebuild is fast.
 */
export async function rebuildRunnerArtifactForDevice(
  udid: string,
  config: RunnerSigningConfig
): Promise<RunnerArtifact> {
  return ensureRunnerArtifact(config, { destinationUdid: udid, force: true });
}

/**
 * In-process build serialization: the registry dedups per-URN (per-device)
 * only, so two device factories in one server would otherwise race
 * `build-for-testing` into the one derived dir, the origin of torn
 * artifacts. Same shared mutex as withFlowFileLock (flow-utils.ts).
 */
const runnerBuildLocks = new Map<string, Promise<unknown>>();

async function withRunnerBuildLock<T>(fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(runnerBuildLocks, "runner-build", fn);
}

/**
 * Ensure the artifact in the one build dir matches the current sources +
 * toolchain + signing config, building it if not.
 *
 * First build takes minutes. Subsequent calls are a cache hit. Setting `force`
 * skips the cache check and always rebuilds. The profile-missing-device retry
 * and the blueprint's poisoned-cache self-heal both use it.
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
  const derivedDataPath = derivedDir();
  const build = opts.build ?? buildRunnerArtifact;

  return withRunnerBuildLock(async (): Promise<RunnerArtifact> => {
    const stampPath = path.join(derivedDataPath, CACHE_KEY_FILE);
    const stamped = await fsp.readFile(stampPath, "utf8").catch(() => null);

    if (!opts.force && stamped === cacheKey) {
      const cached = findBaseXctestrun(derivedDataPath);

      if (cached) {
        return { xctestrunPath: cached, derivedDataPath, fromCache: true };
      }
    }

    // No matching stamp means whatever the dir holds cannot be trusted:
    // another generation's products (older sources, Xcode or signing), an
    // interrupted build, or a pre-stamp layout. Start clean so generations
    // cannot mix. A force rebuild under a MATCHING stamp keeps the tree: the
    // device-registration retry only re-signs, and incremental is fast.
    if (stamped !== cacheKey) {
      await fsp.rm(derivedDataPath, { recursive: true, force: true });
    }

    const built = await build(derivedDataPath, staticArgs, opts.destinationUdid);
    await fsp.writeFile(stampPath, cacheKey);
    return built;
  });
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
    // Concrete-destination why: see rebuildRunnerArtifactForDevice.
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

    throw new Error(
      `Building the iOS device runner failed.${hint ? ` ${hint}` : ""}\n\n` +
        `xcodebuild reported:\n${xcodebuildFailureSummary(output)}`,
      { cause: error }
    );
  }

  const built = findBaseXctestrun(derivedDataPath);

  if (!built) {
    throw new Error(
      `xcodebuild reported success but no iphoneos .xctestrun was found under ${derivedDataPath}/Build/Products.`
    );
  }

  return { xctestrunPath: built, derivedDataPath, fromCache: false };
}

/**
 * Thrown when an .xctestrun does not parse as a plist: a truncated file, the
 * signature of a build interrupted mid-write. Typed because the blueprint's
 * cache self-heal keys on it: a first occurrence on a CACHED artifact means
 * cache poisoning (wipe the derived dir, force one rebuild), while on a
 * freshly built artifact it propagates as a genuine build failure.
 */
export class XctestrunFormatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "XctestrunFormatError";
  }
}

/**
 * Cheap validity probe over a cached .xctestrun. `findBaseXctestrun` trusts
 * mere existence, so a torn file (interrupted build) would otherwise ride the
 * cache hit into xcodebuild and fail there with an unclassifiable message;
 * caught here instead, the blueprint recognizes the poisoning and self-heals.
 */
export async function assertXctestrunParses(xctestrunPath: string): Promise<void> {
  try {
    await execFileAsync("plutil", ["-lint", xctestrunPath], { timeout: 20_000 });
  } catch (error) {
    throw new XctestrunFormatError(
      `xctestrun at ${xctestrunPath} could not be parsed as a plist: ` +
        `${(error as Error).message}. Delete ~/.argent/ios-device-runner and retry to ` +
        `force a rebuild.`,
      { cause: error }
    );
  }
}

export interface LaunchedRunner {
  child: ChildProcess;
  logPath: string;
  /** This device's one crash bundle; overwritten on every launch. */
  resultBundlePath: string;
}

/**
 * Launch the runner on the device via `xcodebuild test-without-building`,
 * detached: testmanagerd installs the `<testBundleId>.xctrunner` app and
 * starts the never-ending test. The child outlives individual commands; the
 * blueprint owns its lifecycle. Log output goes to a file for postmortems.
 *
 * The session's port travels as TEST_RUNNER_ARGENT_RUNNER_PORT on the
 * xcodebuild process: xcodebuild forwards TEST_RUNNER_-prefixed variables,
 * prefix stripped, into the test runner process (man xcodebuild), so the
 * on-device runner reads ARGENT_RUNNER_PORT without any per-session copy of
 * the .xctestrun. Verified on hardware against test-without-building.
 *
 * The launch log and the crash bundle are one fixed path per device,
 * overwritten each launch: nothing accumulates, so there is nothing to
 * sweep. Only the latest session's postmortem survives, which is the only
 * one the crash reader ever consumed. testmanagerd allows one session per
 * device, so per-device paths cannot collide.
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
  port: number;
}): Promise<LaunchedRunner> {
  const logDir = logsRoot();
  const resultsDir = resultsRoot();
  await Promise.all([
    fsp.mkdir(logDir, { recursive: true }),
    fsp.mkdir(resultsDir, { recursive: true }),
  ]);
  const deviceTag = opts.udid.slice(0, 8);
  const logPath = path.join(logDir, `runner-${deviceTag}.log`);
  const resultBundlePath = path.join(resultsDir, `argent-${deviceTag}.xcresult`);
  // xcodebuild refuses to write onto an existing result bundle.
  await fsp.rm(resultBundlePath, { recursive: true, force: true });
  const logFd = fs.openSync(logPath, "w");

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
      "-resultBundlePath",
      resultBundlePath,
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
      env: { ...process.env, TEST_RUNNER_ARGENT_RUNNER_PORT: String(opts.port) },
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
  return { child, logPath, resultBundlePath };
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
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid === process.pid) {
      continue;
    }

    // a live peer tool-server owns it
    if (ppid !== 1 && isAlive(ppid)) {
      continue;
    }

    // nothing reached, nothing to await
    if (!signalGroupThenPid(kill, pid, "SIGTERM")) {
      continue;
    }

    signaled.push(pid);
  }

  if (signaled.length > 0) {
    await waitForPidsToExit(signaled, opts);
  }

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
