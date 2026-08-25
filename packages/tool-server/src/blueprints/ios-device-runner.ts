import * as net from "node:net";
import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  withFailureSignal,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
  type ServiceInstance,
} from "@argent/registry";
import { ensureDeviceReady } from "../utils/ios-device/devicectl";
import {
  ensureRunnerArtifact,
  isProfileMissingDeviceFailure,
  killRunnerProcess,
  killStaleRunnersForDevice,
  launchRunner,
  prepareXctestrunWithPort,
  rebuildRunnerArtifactForDevice,
  resolveRunnerSigningConfig,
  type LaunchedRunner,
  type RunnerArtifact,
} from "../utils/ios-device/runner-build";
import * as fs from "node:fs/promises";
import { createUsbmuxCommandSender } from "../utils/ios-device/runner-route";
import { isIosDeviceTransportError } from "../utils/ios-device/usbmux-protocol";
import { readRunnerCrashSummary } from "../utils/ios-device/runner-crash";
import {
  createRunnerClient,
  waitForRunnerReady,
  type RunnerClient,
} from "../utils/ios-device/runner-client";

const IOS_DEVICE_RUNNER_NAMESPACE = "ios-device-runner";

/**
 * Recent runner deaths that interrupted an app-scoped command, keyed
 * `udid|bundleId`. Outlives the service instance on purpose: each death tears
 * the instance down, and the signal that matters — "every fresh runner dies
 * touching this app" — only exists across instances. Entries expire after
 * CRASH_MEMORY_MS; a repeat within the window escalates the error to name the
 * likely cause (the app's current screen state) and the recovery (restart-app).
 */
const CRASH_MEMORY_MS = 10 * 60 * 1000;
const recentAppCrashes = new Map<string, number[]>();

function recordAppCrash(udid: string, bundleId: string): number {
  const key = `${udid}|${bundleId}`;
  const now = Date.now();
  const kept = (recentAppCrashes.get(key) ?? []).filter((t) => now - t < CRASH_MEMORY_MS);
  kept.push(now);
  recentAppCrashes.set(key, kept);
  return kept.length;
}

/** Transport shapes a dead runner produces; only meaningful once the child exited. */
function looksTransportDead(error: unknown): boolean {
  // "device-unattached" is excluded: it is a pre-send cable verdict, and its
  // connect-the-cable hint is the honest story even when the child also died.
  return isIosDeviceTransportError(error) && error.kind !== "device-unattached";
}

/**
 * The synthesized runner-death errors carry this marker so `recoverable()`
 * keys off a typed property instead of message text.
 */
function isRunnerExitedError(error: unknown): boolean {
  return (error as { runnerExited?: unknown } | null)?.runnerExited === true;
}

/**
 * Diagnose a command that failed mid-flight. A transport-dead shape is only
 * the death story when the child really exited; give a straggling exit event a
 * beat to land so the race between the failed dial and the exit callback can't
 * hide it. Returns the error `api.run` should throw: the original when the
 * runner is not provably dead (post-send losses with a live child are the
 * client's status recovery's job), or the enriched post-mortem — crash summary
 * from the newest .xcresult, death-count escalation, log path — once the exit
 * is confirmed.
 */
async function explainRunnerDeath(options: {
  error: unknown;
  command: Record<string, unknown>;
  udid: string;
  derivedDataPath: string;
  logPath: string;
  /** Resolves once the child has exited, or after `ms` — whichever first. */
  settleExit: (ms: number) => Promise<void>;
  /** undefined = still running; the exit code (possibly null) once dead. */
  getExitCode: () => number | null | undefined;
}): Promise<unknown> {
  const { error, command, udid } = options;
  if (!looksTransportDead(error)) return error;
  await options.settleExit(1_500);
  const exitCode = options.getExitCode();
  if (exitCode === undefined) return error;
  const bundleId = typeof command.appBundleId === "string" ? command.appBundleId : null;
  const deaths = bundleId ? recordAppCrash(udid, bundleId) : 0;
  const crash = await readRunnerCrashSummary(options.derivedDataPath);
  const recovery =
    deaths >= 2 && bundleId
      ? ` This is runner death #${deaths} touching ${bundleId} in the last ` +
        `${CRASH_MEMORY_MS / 60_000} minutes — the app's current screen state is likely ` +
        `crashing XCTest itself; call restart-app for ${bundleId} to reset that state, then retry.`
      : ` The runner respawns on the next call; re-observe the screen and retry.`;
  // The marker keeps recoverable() matching, so the registry still tears the
  // instance down and the next call respawns.
  return Object.assign(
    withFailureSignal(
      new Error(
        `iOS device runner exited (code ${exitCode}) while executing '${String(command.command)}'` +
          (crash ? ` — recorded crash: ${crash}.` : ".") +
          recovery +
          ` Log: ${options.logPath}`,
        { cause: error }
      ),
      {
        error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_EXITED,
        failure_stage: "ios_device_runner_exited",
        failure_area: "tool_server",
        error_kind: "subprocess",
        ...(typeof exitCode === "number" ? { failure_exit_code: exitCode } : {}),
      }
    ),
    { runnerExited: true }
  );
}

/**
 * Per-device XCUITest runner service for PHYSICAL iOS devices.
 *
 * The factory builds (or reuses) the signed runner artifact, launches it on
 * the device via detached `xcodebuild test-without-building`, and exposes a
 * command client over the usbmux-first transport. Startup is expensive — the
 * first ever call pays an xcodebuild build (minutes), every cold start pays
 * the testmanagerd ramp (~25s) — so the instance is cached by the registry
 * and disposed only on tool-server shutdown or `recoverable()` teardown.
 */
export interface IosDeviceRunnerApi {
  /** Low-level escape hatch: send a raw runner command. */
  run(
    command: Record<string, unknown>,
    opts?: { readOnly?: boolean; timeoutMs?: number }
  ): Promise<unknown>;
  /** The device UDID this runner drives. */
  udid: string;
}

export function iosDeviceRunnerRef(device: DeviceInfo): {
  urn: string;
  options: { device: DeviceInfo };
} {
  return {
    urn: `${IOS_DEVICE_RUNNER_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("no port assigned"))));
    });
  });
}

/** Runner startup budget: testmanagerd install + suspend-resume + listener bind. */
const RUNNER_READY_TIMEOUT_MS = 120_000;

export const iosDeviceRunnerBlueprint: ServiceBlueprint<IosDeviceRunnerApi, DeviceInfo> = {
  namespace: IOS_DEVICE_RUNNER_NAMESPACE,
  getURN(device: DeviceInfo) {
    return `${IOS_DEVICE_RUNNER_NAMESPACE}:${device.id}`;
  },
  async factory(_deps, payload, options): Promise<ServiceInstance<IosDeviceRunnerApi>> {
    const deviceFromOpts = (options as { device?: DeviceInfo } | undefined)?.device;
    // The registry hands the factory the parsed URN payload — always a string
    // (the udid); options.device is the richer channel iosDeviceRunnerRef fills.
    const udid = deviceFromOpts?.id ?? (typeof payload === "string" ? payload : undefined);
    if (!udid) {
      throw new FailureError(
        `${IOS_DEVICE_RUNNER_NAMESPACE}.factory could not determine the device — pass it via iosDeviceRunnerRef(device).`,
        {
          error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_FACTORY_OPTIONS_MISSING,
          failure_stage: "ios_device_runner_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    await ensureDeviceReady(udid);
    await killStaleRunnersForDevice(udid);

    const signing = resolveRunnerSigningConfig();

    const startRunner = async (
      artifact: RunnerArtifact
    ): Promise<{ launched: LaunchedRunner; client: RunnerClient; derivedDataPath: string }> => {
      const port = await getFreePort();
      const xctestrunPath = await prepareXctestrunWithPort(artifact.xctestrunPath, port);
      const launched = await launchRunner({
        udid,
        xctestrunPath,
        derivedDataPath: artifact.derivedDataPath,
      });
      const sender = createUsbmuxCommandSender();
      const client = createRunnerClient({
        udid,
        port,
        send: sender.sendCommand,
      });
      // The permanent "exit" listener attaches only after startRunner resolves,
      // so a child dying now (the profile-missing install rejection lands within
      // seconds) would otherwise leave the readiness poll grinding its full
      // budget against a runner that will never come up. Race the wait against
      // the exit; the rejection flows through the same catch as a poll timeout.
      let onExit!: (code: number | null) => void;
      const exited = new Promise<never>((_resolve, reject) => {
        onExit = (code) =>
          reject(new Error(`xcodebuild exited (code ${code}) before the runner became ready`));
      });
      // The race's loser must never surface as an unhandled rejection — a
      // post-kill exit on the timeout path still fires onExit.
      exited.catch(() => {});
      launched.child.once("exit", onExit);
      try {
        await Promise.race([
          waitForRunnerReady(client, { timeoutMs: RUNNER_READY_TIMEOUT_MS }),
          exited,
        ]);
      } catch (error) {
        killRunnerProcess(launched.child);
        const logText = await fs.readFile(launched.logPath, "utf8").catch(() => "");
        throw Object.assign(
          withFailureSignal(
            new Error(
              `The on-device runner did not become ready: ${String((error as Error).message)}. ` +
                `Check the xcodebuild log at ${launched.logPath} — signing/provisioning issues and ` +
                `a locked device screen are the two common causes. The device must be unlocked ` +
                `the first time so you can trust the developer app (Settings > General > VPN & ` +
                `Device Management) if iOS asks.`,
              { cause: error }
            ),
            {
              error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
              failure_stage: "ios_device_runner_ready",
              failure_area: "tool_server",
              error_kind: "timeout",
            }
          ),
          { runnerExited: true, runnerLogText: logText }
        );
      } finally {
        // Once ready, the factory's own "exit" listener becomes the sole owner
        // of exits, so "terminated" fires exactly once on a post-ready death.
        launched.child.removeListener("exit", onExit);
      }
      // derivedDataPath rides along for the crash post-mortem: xcodebuild
      // records a crashed session's failure text in the newest .xcresult
      // under this derived data.
      return { launched, client, derivedDataPath: artifact.derivedDataPath };
    };

    let started: Awaited<ReturnType<typeof startRunner>>;
    try {
      started = await startRunner(await ensureRunnerArtifact(signing));
    } catch (error) {
      const logText = (error as { runnerLogText?: string }).runnerLogText ?? "";
      if (!isProfileMissingDeviceFailure(logText)) throw error;
      // A newly connected device is not in the (locally provisioned) profile.
      // Rebuild against this concrete device so automatic signing regenerates
      // the profile to include it, then retry once.
      started = await startRunner(await rebuildRunnerArtifactForDevice(udid, signing));
    }
    const { launched, client, derivedDataPath } = started;

    const events = new TypedEventEmitter<ServiceEvents>();
    let disposed = false;
    // undefined = still running; the exit code (possibly null) once dead.
    let exitCode: number | null | undefined;
    const exitWaiters: Array<() => void> = [];
    launched.child.on("exit", (code) => {
      exitCode = code;
      for (const wake of exitWaiters.splice(0)) wake();
      if (!disposed) {
        events.emit(
          "terminated",
          new FailureError(`iOS device runner exited (code ${code}). Log: ${launched.logPath}`, {
            error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_TERMINATED,
            failure_stage: "ios_device_runner_process_exit",
            failure_area: "tool_server",
            error_kind: "subprocess",
          })
        );
      }
    });

    /** Resolves once the child has exited, or after `ms` — whichever first. */
    const settleExit = (ms: number): Promise<void> =>
      exitCode !== undefined
        ? Promise.resolve()
        : new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            exitWaiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });

    const api: IosDeviceRunnerApi = {
      udid,
      run: async (command, opts) => {
        try {
          return await client.run(command, opts);
        } catch (error) {
          throw await explainRunnerDeath({
            error,
            command,
            udid,
            derivedDataPath,
            logPath: launched.logPath,
            settleExit,
            getExitCode: () => exitCode,
          });
        }
      },
    };

    return {
      api,
      events,
      dispose: async () => {
        disposed = true;
        try {
          await client.run({ command: "shutdown" }, { readOnly: true, timeoutMs: 3_000 });
        } catch {
          /* best-effort graceful stop */
        }
        killRunnerProcess(launched.child);
      },
    };
  },
  recoverable(error: unknown): boolean {
    // Conservative: only the synthesized runner-death errors, where the child
    // provably exited. RunnerCommandError (the runner answered) is NOT
    // recoverable — the runner is alive; and transport losses while the child
    // still runs are handled by the client's status recovery, not by instance
    // teardown.
    return isRunnerExitedError(error);
  },
};
