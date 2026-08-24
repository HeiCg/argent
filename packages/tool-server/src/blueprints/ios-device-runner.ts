import * as net from "node:net";
import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
  type ServiceInstance,
} from "@argent/registry";
import { deviceInfoDetails, ensureDeviceReady } from "../utils/ios-device/devicectl";
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
import { createRunnerRouteResolver } from "../utils/ios-device/runner-route";
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
  const message = String((error as Error)?.message ?? "");
  return /not listening|ECONNREFUSED|did not accept connection|timed out connecting/i.test(message);
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
    const udid =
      deviceFromOpts?.id ??
      (typeof payload === "string" ? payload : (payload as DeviceInfo | undefined)?.id);
    if (!udid) {
      throw new Error(
        `${IOS_DEVICE_RUNNER_NAMESPACE}.factory could not determine the device — pass it via iosDeviceRunnerRef(device).`
      );
    }

    await ensureDeviceReady(udid);
    await killStaleRunnersForDevice(udid);

    const signing = resolveRunnerSigningConfig();

    // Kept for the crash post-mortem: xcodebuild records a crashed session's
    // failure text in the newest .xcresult under this derived data.
    let lastDerivedDataPath = "";

    const startRunner = async (
      artifact: RunnerArtifact
    ): Promise<{ launched: LaunchedRunner; client: RunnerClient }> => {
      lastDerivedDataPath = artifact.derivedDataPath;
      const port = await getFreePort();
      const xctestrunPath = await prepareXctestrunWithPort(artifact.xctestrunPath, port);
      const launched = await launchRunner({
        udid,
        xctestrunPath,
        derivedDataPath: artifact.derivedDataPath,
        port,
      });
      const resolver = createRunnerRouteResolver({
        resolveTunnelIpAddress: async (deviceUdid: string) =>
          (await deviceInfoDetails(deviceUdid)).tunnelIpAddress,
      });
      const client = createRunnerClient({
        udid,
        port,
        send: resolver.sendCommand.bind(resolver),
      });
      try {
        await waitForRunnerReady(client, { timeoutMs: RUNNER_READY_TIMEOUT_MS });
      } catch (error) {
        killRunnerProcess(launched.child);
        const logText = await fs.readFile(launched.logPath, "utf8").catch(() => "");
        throw Object.assign(
          new Error(
            `The on-device runner did not become ready: ${String((error as Error).message)}. ` +
              `Check the xcodebuild log at ${launched.logPath} — signing/provisioning issues and ` +
              `a locked device screen are the two common causes. The device must be unlocked ` +
              `the first time so you can trust the developer app (Settings > General > VPN & ` +
              `Device Management) if iOS asks.`,
            { cause: error }
          ),
          { runnerLogText: logText }
        );
      }
      return { launched, client };
    };

    let started: { launched: LaunchedRunner; client: RunnerClient };
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
    const { launched, client } = started;

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
          new Error(`iOS device runner exited (code ${code}). Log: ${launched.logPath}`)
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
          // A transport-dead shape is only the death story when the child
          // really exited; give a straggling exit event a beat to land so the
          // race between the failed dial and the exit callback can't hide it.
          if (!looksTransportDead(error)) throw error;
          await settleExit(1_500);
          if (exitCode === undefined) throw error;
          const bundleId = typeof command.appBundleId === "string" ? command.appBundleId : null;
          const deaths = bundleId ? recordAppCrash(udid, bundleId) : 0;
          const crash = await readRunnerCrashSummary(lastDerivedDataPath);
          // "runner exited" keeps recoverable() matching, so the registry
          // still tears the instance down and the next call respawns.
          const recovery =
            deaths >= 2 && bundleId
              ? ` This is runner death #${deaths} touching ${bundleId} in the last ` +
                `${CRASH_MEMORY_MS / 60_000} minutes — the app's current screen state is likely ` +
                `crashing XCTest itself; call restart-app for ${bundleId} to reset that state, then retry.`
              : ` The runner respawns on the next call; re-observe the screen and retry.`;
          throw new Error(
            `iOS device runner exited (code ${exitCode}) while executing '${String(command.command)}'` +
              (crash ? ` — recorded crash: ${crash}.` : ".") +
              recovery +
              ` Log: ${launched.logPath}`,
            { cause: error }
          );
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
    // Conservative: only transport-dead shapes where the command provably never
    // executed. RunnerCommandError (the runner answered) is NOT recoverable —
    // the runner is alive; and post-send transport losses are handled by the
    // client's status recovery, not by instance teardown.
    const message = String((error as Error)?.message ?? "");
    return (
      message.includes("runner exited") ||
      message.includes("did not accept connection") ||
      message.includes("ECONNREFUSED")
    );
  },
};
