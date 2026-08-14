import * as net from "node:net";
import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
  type ServiceInstance,
} from "@argent/registry";
import {
  deviceInfoDetails,
  ensureDeviceReady,
} from "../utils/ios-device/devicectl";
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
import {
  createRunnerClient,
  waitForRunnerReady,
  type RunnerClient,
} from "../utils/ios-device/runner-client";

const IOS_DEVICE_RUNNER_NAMESPACE = "ios-device-runner";

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
  run(command: Record<string, unknown>, opts?: { readOnly?: boolean; timeoutMs?: number }): Promise<unknown>;
  /** The device UDID this runner drives. */
  udid: string;
}

export function iosDeviceRunnerRef(device: DeviceInfo): { urn: string; options: { device: DeviceInfo } } {
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

    const startRunner = async (
      artifact: RunnerArtifact
    ): Promise<{ launched: LaunchedRunner; client: RunnerClient }> => {
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
    launched.child.on("exit", (code) => {
      if (!disposed) {
        events.emit(
          "terminated",
          new Error(`iOS device runner exited (code ${code}). Log: ${launched.logPath}`)
        );
      }
    });

    const api: IosDeviceRunnerApi = {
      udid,
      run: (command, opts) => client.run(command, opts),
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
