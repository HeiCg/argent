import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { freeHostPort } from "./open-server-transport";
import { IosOpenServerClient } from "./ios-open-server-client";

/**
 * Build and launch the open iOS XCUITest server (`@argent/ios-device-server`),
 * adapted from base B's `runner-build.ts` / runner-launch logic. Simulator-first:
 * `build-for-testing` once per Xcode version (the cache key folds in
 * `xcodebuild -version`), then `test-without-building` detached against a
 * simulator destination; readiness is a `ping` within 120 s.
 *
 * The physical-device path keeps base B's `ARGENT_IOS_TEAM_ID` auto-signing and
 * the `iphoneos` xctestrun. It is compiled but not exercised in hosted CI
 * (iOS-1); the CI device test drives the simulator path only.
 */

const execFileAsync = promisify(execFile);

const RELATIVE_PROJECT = "ios-device-server/ArgentRunner/ArgentRunner.xcodeproj";
const TEST_IDENTIFIER = "ArgentRunnerUITests/ArgentRunnerSession/testServeCommands";
const BUILD_BUDGET_MS = 15 * 60 * 1000;
const READY_TIMEOUT_MS = 120 * 1000;

export interface IosRunnerTarget {
  /** Simulator or physical-device UDID. */
  udid: string;
  /** `simulator` uses a loopback socket + no signing; `device` uses usbmux + team. */
  kind: "simulator" | "device";
}

interface SpawnedIosRunner {
  proc: ChildProcess;
  port: number;
}

/** Locate the runner Xcode project. Override with `ARGENT_IOS_RUNNER_PROJECT`. */
function resolveRunnerProjectPath(): string {
  const override = process.env.ARGENT_IOS_RUNNER_PROJECT;
  if (override) return override;
  // Packaged tool-server copies the project next to the bundle; in the dev tree
  // resolve it from this package.
  return path.resolve(__dirname, "..", "..", "..", RELATIVE_PROJECT);
}

/** The derived-data / build cache dir, keyed below by Xcode version + sources. */
function derivedDataRoot(): string {
  return (
    process.env.ARGENT_IOS_RUNNER_DERIVED ??
    path.join(os.homedir(), ".argent", "ios-open-server", "derived")
  );
}

function runnerError(
  message: string,
  stage: string,
  kind: "validation" | "subprocess" | "timeout"
): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_READY_TIMEOUT,
    failure_stage: stage,
    failure_area: "tool_server",
    error_kind: kind,
  });
}

/** `xcodebuild -version`, part of the build cache key. */
async function xcodebuildVersion(): Promise<string> {
  const { stdout } = await execFileAsync("xcodebuild", ["-version"]);
  return stdout.trim();
}

/** sha256 over the source tree hash ⊕ `xcodebuild -version` ⊕ the destination. */
async function cacheKey(
  projectDir: string,
  xcodeVersion: string,
  destination: string
): Promise<string> {
  const h = createHash("sha256");
  h.update(xcodeVersion);
  h.update("\0");
  h.update(destination);
  h.update("\0");
  // Hash every Swift/Obj-C/plist/pbxproj under the project dir (order-stable).
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "build" || entry.name.endsWith(".xcuserdata")) continue;
        walk(full);
      } else if (/\.(swift|m|h|plist|pbxproj)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(projectDir);
  for (const f of files) {
    h.update(f);
    h.update(fs.readFileSync(f));
  }
  return h.digest("hex").slice(0, 32);
}

function destinationFor(target: IosRunnerTarget): string {
  return target.kind === "simulator"
    ? `platform=iOS Simulator,id=${target.udid}`
    : `platform=iOS,id=${target.udid}`;
}

/**
 * `build-for-testing`, cached per (Xcode version, source tree, destination). A
 * stamp mismatch wipes the derived dir and rebuilds. Returns the built
 * `.xctestrun` path for the destination's platform.
 */
async function buildForTesting(target: IosRunnerTarget): Promise<string> {
  const projectPath = resolveRunnerProjectPath();
  const projectDir = path.dirname(projectPath);
  const destination = destinationFor(target);
  const xcodeVersion = await xcodebuildVersion();
  const key = await cacheKey(projectDir, xcodeVersion, destination);

  const derived = path.join(derivedDataRoot(), key);
  const stamp = path.join(derived, ".argent-cache-key");
  const cached = fs.existsSync(stamp) ? fs.readFileSync(stamp, "utf8").trim() : "";
  if (cached !== key) {
    await fsp.rm(derived, { recursive: true, force: true });
    await fsp.mkdir(derived, { recursive: true });

    const args = [
      "build-for-testing",
      "-project",
      projectPath,
      "-scheme",
      "ArgentRunner",
      "-destination",
      destination,
      "-derivedDataPath",
      derived,
      "ONLY_ACTIVE_ARCH=YES",
      "ENABLE_CODE_COVERAGE=NO",
    ];
    if (target.kind === "device") {
      const teamId = process.env.ARGENT_IOS_TEAM_ID?.trim();
      if (!teamId)
        throw runnerError(
          "ARGENT_IOS_TEAM_ID is required to build for a physical device",
          "ios_open_server_signing",
          "validation"
        );
      args.push(
        "-allowProvisioningUpdates",
        "CODE_SIGN_STYLE=Automatic",
        `DEVELOPMENT_TEAM=${teamId}`,
        `ARGENT_RUNNER_APP_BUNDLE_ID=com.argent.runner.t${teamId.toLowerCase()}`
      );
    }
    await execFileAsync("xcodebuild", args, {
      timeout: BUILD_BUDGET_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    fs.writeFileSync(stamp, key);
  }

  return findXctestrun(path.join(derived, "Build", "Products"), target.kind);
}

/** The `.xctestrun` for the target platform (iphonesimulator vs iphoneos). */
function findXctestrun(productsDir: string, kind: IosRunnerTarget["kind"]): string {
  const wantSim = kind === "simulator";
  const entries = fs.existsSync(productsDir) ? fs.readdirSync(productsDir) : [];
  const runs = entries.filter((e) => e.endsWith(".xctestrun"));
  const match =
    runs.find((e) => (wantSim ? /simulator/i.test(e) : /iphoneos|device/i.test(e))) ?? runs[0];
  if (!match)
    throw runnerError(
      `no .xctestrun produced in ${productsDir}`,
      "ios_open_server_build",
      "subprocess"
    );
  return path.join(productsDir, match);
}

/**
 * Launch the runner detached via `test-without-building`, injecting the chosen
 * port through `TEST_RUNNER_ARGENT_RUNNER_PORT` (xcodebuild strips the prefix so
 * the test process reads `ARGENT_RUNNER_PORT`).
 */
async function launchRunner(target: IosRunnerTarget, xctestrun: string): Promise<SpawnedIosRunner> {
  const port = await freeHostPort();
  const destination = destinationFor(target);
  const args = [
    "test-without-building",
    "-xctestrun",
    xctestrun,
    "-only-testing:" + TEST_IDENTIFIER,
    "-destination",
    destination,
    "-test-timeouts-enabled",
    "NO",
  ];
  const proc = spawn("xcodebuild", args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, TEST_RUNNER_ARGENT_RUNNER_PORT: String(port) },
  });
  proc.unref();
  return { proc, port };
}

/** Ping the runner until it answers or 120 s elapse. */
async function waitForReady(
  client: IosOpenServerClient,
  timeoutMs = READY_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await client.ping();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw runnerError(
    `iOS open server did not become ready within ${timeoutMs}ms: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    "ios_open_server_ready",
    "timeout"
  );
}

/** Build (cached) + launch + wait-for-ready, returning the process and a client. */
export async function spawnIosRunner(
  target: IosRunnerTarget
): Promise<{ spawned: SpawnedIosRunner; client: IosOpenServerClient }> {
  const xctestrun = await buildForTesting(target);
  const spawned = await launchRunner(target, xctestrun);
  const client = new IosOpenServerClient({ port: spawned.port });
  try {
    await waitForReady(client);
  } catch (err) {
    client.close();
    try {
      spawned.proc.kill();
    } catch {
      /* ignore */
    }
    throw err;
  }
  return { spawned, client };
}
