import { execFile, execFileSync } from "node:child_process";
import type { spawn as nodeSpawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  TypedEventEmitter,
  FAILURE_CODES,
  FailureError,
  type DeviceInfo,
  type Registry,
  type ServiceBlueprint,
  type ServiceEvents,
  type ServiceInstance,
} from "@argent/registry";
import {
  IosSimInputService,
  SimInputNotSentError,
  simInputCrashBudgetError,
  type SimInputAck,
  type SimInputWireTiming,
} from "../utils/ios-sim-input-service";
import { shouldUseIosOpenServer } from "../utils/ios-open-server-input";
import { openDeviceServerMutex } from "../utils/device-mutex";

/**
 * Registry blueprint for `sim-input` (packages/ios-sim-input): one long-lived
 * HID process per iOS simulator, which injects touches and keys through the
 * simulator's private HID client with no XCUITest in the loop (iOS-4 ticket 5).
 * The process is `IosSimInputService` (the same driver the bench uses) with the
 * product guards on: a 5 s per-call timeout, and a crash budget of 3 restarts
 * per 60 s, after which the service reports `terminated` with the give-up error
 * and refuses to start again until the window has passed. Disposing the service
 * (registry teardown of the device's services, or `registry.dispose()`) stops
 * the process. Simulators only: a physical iPhone has no simulator HID client.
 *
 * The routing helpers at the bottom are what gesture-tap / gesture-swipe /
 * keyboard call under the `open-ios-device-server` flag (iOS-4 ticket 6).
 */

export const IOS_SIM_INPUT_NAMESPACE = "IosSimInput";

const DEFAULT_CALL_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
/**
 * sim-input holds each key 100 ms (IndigoHIDInput.key, a `usleep` outside the
 * pacer), so a `text` command takes ~0.1 s per character.
 */
const TEXT_TIMEOUT_PER_CHAR_MS = 200;
/** Gap between the taps of a multi-tap, as on the simulator-server path. */
const MULTI_TAP_GAP_MS = 100;

/** Which backend served an iOS-simulator input call under the open-iOS flag. */
export type IosInputBackend = "sim-input" | "runner" | "simulator-server";

/**
 * The sim-input service surface. Coordinates are NORMALIZED 0–1 (sim-input
 * divides by `screenWidth`/`screenHeight`, sent as 1), so no screen-size read
 * is needed.
 */
export interface IosSimInputApi {
  readonly udid: string;
  sendTap(args: { x: number; y: number; holdMs?: number }): Promise<SimInputAck>;
  /** `holdEndMs` > 0 holds the finger at the end point before the lift, so the
   * release velocity is ~0 (momentum-free swipe). */
  sendSwipe(args: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    durationMs: number;
    holdEndMs?: number;
  }): Promise<SimInputAck>;
  /** Printable ASCII only (see {@link isSimInputText}). */
  sendText(text: string): Promise<SimInputAck>;
}

/** Overrides for tests; production uses the defaults. */
export interface IosSimInputBlueprintDeps {
  spawn?: typeof nodeSpawn;
  resolveBinary?: () => Promise<string>;
  timeoutMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  now?: () => number;
}

type IosSimInputFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

export function iosSimInputRef(device: DeviceInfo): {
  urn: string;
  options: IosSimInputFactoryOptions;
} {
  return { urn: `${IOS_SIM_INPUT_NAMESPACE}:${device.id}`, options: { device } };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export function createIosSimInputBlueprint(
  deps: IosSimInputBlueprintDeps = {}
): ServiceBlueprint<IosSimInputApi, string> {
  const now = deps.now ?? Date.now;
  const maxRestarts = deps.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const restartWindowMs = deps.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const resolveBinary = deps.resolveBinary ?? (() => resolveSimInputBinary());
  // Crash history per udid, kept across instances: the registry re-creates the
  // service after a give-up, and the new one must not get a fresh budget.
  const crashLog = new Map<string, number[]>();

  return {
    namespace: IOS_SIM_INPUT_NAMESPACE,

    getURN(udid: string) {
      return `${IOS_SIM_INPUT_NAMESPACE}:${udid}`;
    },

    async factory(_deps, _payload, options) {
      const opts = options as unknown as IosSimInputFactoryOptions | undefined;
      if (!opts?.device) {
        throw new FailureError(
          `${IOS_SIM_INPUT_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
            `Use iosSimInputRef(device) when resolving the service.`,
          {
            error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_FACTORY_OPTIONS_MISSING,
            failure_stage: "ios_sim_input_factory_options",
            failure_area: "tool_server",
            error_kind: "validation",
          }
        );
      }
      const { device } = opts;
      if (device.platform !== "ios" || device.kind !== "simulator") {
        throw new FailureError(
          `${IOS_SIM_INPUT_NAMESPACE} drives iOS simulators only. The target '${device.id}' ` +
            `is ${device.platform}/${device.kind}.`,
          {
            error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_WRONG_PLATFORM,
            failure_stage: "ios_sim_input_factory_options",
            failure_area: "tool_server",
            error_kind: "validation",
          }
        );
      }
      const udid = device.id;
      const budget = simInputCrashBudgetError(crashLog, udid, now(), maxRestarts, restartWindowMs);
      if (budget) {
        throw new FailureError(budget.message, {
          error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_TERMINATED,
          failure_stage: "ios_sim_input_lifecycle",
          failure_area: "tool_server",
          error_kind: "subprocess",
        });
      }

      const binary = await resolveBinary();
      const events = new TypedEventEmitter<ServiceEvents>();
      let disposed = false;
      const service = new IosSimInputService({
        binary,
        ...(deps.spawn ? { spawn: deps.spawn } : {}),
        timeoutMs,
        maxRestarts,
        restartWindowMs,
        now,
        crashLog,
        onGiveUp: (_udid, err) => {
          if (disposed) return;
          events.emit(
            "terminated",
            new FailureError(err.message, {
              error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_TERMINATED,
              failure_stage: "ios_sim_input_lifecycle",
              failure_area: "tool_server",
              error_kind: "subprocess",
            })
          );
        },
      });
      service.start(udid);

      const api: IosSimInputApi = {
        udid,
        sendTap: ({ x, y, holdMs }) =>
          service.tap(udid, {
            x: clamp01(x),
            y: clamp01(y),
            width: 1,
            height: 1,
            ...(holdMs !== undefined ? { holdMs } : {}),
          }),
        sendSwipe: ({ fromX, fromY, toX, toY, durationMs, holdEndMs }) =>
          service.swipe(udid, {
            fromX: clamp01(fromX),
            fromY: clamp01(fromY),
            toX: clamp01(toX),
            toY: clamp01(toY),
            durationMs,
            ...(holdEndMs !== undefined && holdEndMs > 0 ? { holdEndMs } : {}),
            width: 1,
            height: 1,
          }),
        sendText: (text) =>
          service.typeText(udid, text, {
            timeoutMs: timeoutMs + text.length * TEXT_TIMEOUT_PER_CHAR_MS,
          }),
      };

      const instance: ServiceInstance<IosSimInputApi> = {
        api,
        dispose: async () => {
          disposed = true;
          await service.stop(udid);
        },
        events,
      };
      return instance;
    },
  };
}

export const iosSimInputBlueprint = createIosSimInputBlueprint();

// ---- binary resolution ----

/** packages/ios-sim-input, from src/blueprints or dist/blueprints. */
const DEFAULT_PACKAGE_DIR = path.resolve(__dirname, "..", "..", "..", "ios-sim-input");

const execFileAsync = promisify(execFile);

export interface ResolveSimInputBinaryOptions {
  env?: NodeJS.ProcessEnv;
  packageDir?: string;
  isExecutable?: (file: string) => Promise<boolean>;
  /** Whether `packageDir` holds the Swift package (its `Package.swift`). */
  hasPackage?: (packageDir: string) => Promise<boolean>;
  /** Builds the release product into `<packageDir>/.build/release`. */
  build?: (packageDir: string) => Promise<void>;
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `xcode-select -p`, or null when it fails. */
function xcodeSelectPath(): string | null {
  try {
    const out = execFileSync("xcode-select", ["-p"], { encoding: "utf-8", timeout: 10_000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The environment for `swift build`: `DEVELOPER_DIR` pinned as
 * packages/ios-sim-input/scripts/build-sim-input.sh does (the caller's value,
 * else `xcode-select -p`, else the default Xcode.app). SimulatorKit resolves
 * only under a full Xcode, not the Command Line Tools.
 */
export function swiftBuildEnv(
  env: NodeJS.ProcessEnv,
  xcodeSelect: () => string | null = xcodeSelectPath
): NodeJS.ProcessEnv {
  const developerDir =
    env.DEVELOPER_DIR || xcodeSelect() || "/Applications/Xcode.app/Contents/Developer";
  return { ...env, DEVELOPER_DIR: developerDir };
}

async function hasSwiftPackage(packageDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(packageDir, "Package.swift"));
    return true;
  } catch {
    return false;
  }
}

async function swiftBuildRelease(packageDir: string): Promise<void> {
  await execFileAsync("swift", ["build", "-c", "release", "--package-path", packageDir], {
    timeout: 600_000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
    env: swiftBuildEnv(process.env),
  });
}

/**
 * One build per package dir per process. Concurrent resolves share the build in
 * flight; a successful build is dropped (the product is on disk), and a failed
 * one stays, so later calls fail at once with the same reason instead of
 * building again on every tool call.
 */
const buildLocks = new Map<string, Promise<void>>();

/**
 * The sim-input binary to spawn, in this order: `ARGENT_SIM_INPUT_BIN` (or the
 * bench's `IOS_SIM_INPUT_BINARY`), which must be executable; the prebuilt
 * release product `packages/ios-sim-input/.build/release/sim-input`; the
 * product `scripts/build-sim-input.sh` copies to `packages/ios-sim-input/bin`.
 * When none exists, one `swift build -c release` under a lock (SwiftPM also
 * locks `.build` against other processes), then the release product.
 */
export async function resolveSimInputBinary(
  opts: ResolveSimInputBinaryOptions = {}
): Promise<string> {
  const env = opts.env ?? process.env;
  const packageDir = opts.packageDir ?? DEFAULT_PACKAGE_DIR;
  const isExecutable = opts.isExecutable ?? isExecutableFile;
  const hasPackage = opts.hasPackage ?? hasSwiftPackage;
  const build = opts.build ?? swiftBuildRelease;

  const configuredVar = env.ARGENT_SIM_INPUT_BIN
    ? "ARGENT_SIM_INPUT_BIN"
    : env.IOS_SIM_INPUT_BINARY
      ? "IOS_SIM_INPUT_BINARY"
      : undefined;
  if (configuredVar) {
    const configured = env[configuredVar]!;
    if (await isExecutable(configured)) return configured;
    throw new Error(`${configuredVar}=${configured} is not an executable sim-input binary`);
  }

  const release = path.join(packageDir, ".build", "release", "sim-input");
  if (await isExecutable(release)) return release;
  const copied = path.join(packageDir, "bin", "sim-input");
  if (await isExecutable(copied)) return copied;

  // The package dir resolves from the tool-server's src/ or dist/ only. A
  // bundled install (e.g. @swmansion/argent) ships no Swift sources there, so
  // it has to name the binary through ARGENT_SIM_INPUT_BIN.
  if (!buildLocks.has(packageDir) && !(await hasPackage(packageDir))) {
    throw new Error(
      `no sim-input binary and no Swift package at ${packageDir}: ` +
        "set ARGENT_SIM_INPUT_BIN to a built sim-input binary"
    );
  }
  let lock = buildLocks.get(packageDir);
  if (!lock) {
    console.warn(
      `[sim-input] no binary at ${release}: building sim-input (swift build -c release); ` +
        "the first call may take minutes"
    );
    lock = build(packageDir).then(() => {
      buildLocks.delete(packageDir);
    });
    buildLocks.set(packageDir, lock);
  }
  try {
    await lock;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`swift build -c release of sim-input failed: ${reason}`);
  }
  if (await isExecutable(release)) return release;
  throw new Error(`swift build -c release did not produce ${release}`);
}

// ---- routing helpers (gesture-tap / gesture-swipe / keyboard) ----

/**
 * Whether sim-input is the first input backend for this device: an iOS
 * simulator with the `open-ios-device-server` flag on. Physical iPhones keep
 * their runner; the flag off keeps the simulator-server.
 */
export function shouldUseIosSimInput(device: DeviceInfo): boolean {
  return device.kind === "simulator" && shouldUseIosOpenServer(device) && !simInputDisabledByEnv();
}

/**
 * `ARGENT_SIM_INPUT=off` (or `0` / `false`) keeps input on the runner under the
 * flag: a switch for a host where sim-input misbehaves, and what the bench's
 * ON-xcuitest arm sets to measure the runner alone.
 */
function simInputDisabledByEnv(): boolean {
  const v = process.env.ARGENT_SIM_INPUT?.trim().toLowerCase();
  return v === "off" || v === "0" || v === "false";
}

/**
 * Whether a momentum-free swipe (`momentum: false`) may go to sim-input, with
 * its `holdEndMs` end hold: only with `ARGENT_SIM_INPUT_MOMENTUM_FREE=1`
 * (experimental, default off). The end hold has not been measured on a
 * simulator yet, so by default the swipe stays on the runner.
 */
export function simInputMomentumFreeEnabled(): boolean {
  return process.env.ARGENT_SIM_INPUT_MOMENTUM_FREE?.trim() === "1";
}

/**
 * A multi-tap failed after `landedTaps` of its taps were acked. The next
 * backend sends the whole multi-tap again, so the screen may see more taps.
 */
export class SimInputPartialTapError extends Error {
  override readonly name = "SimInputPartialTapError";
  constructor(
    message: string,
    readonly landedTaps: number
  ) {
    super(message);
  }
}

/** Whether a failed sim-input multi-tap had already landed at least one tap. */
export function simInputTapsLanded(err: unknown): boolean {
  return err instanceof SimInputPartialTapError && err.landedTaps > 0;
}

/**
 * Whether a failed sim-input `text` command may have typed some characters:
 * true unless the command never reached sim-input. The runner then types the
 * whole text again, so the field can hold a partial copy before it.
 */
export function simInputMayHaveTyped(err: unknown): boolean {
  return !(err instanceof SimInputNotSentError);
}

/**
 * Text sim-input can type: printable ASCII (0x20–0x7E), the characters its
 * keyboard map decomposes. Anything else (accents, emoji, newline) goes to the
 * runner, so sim-input never types part of a string and fails on the rest.
 */
export function isSimInputText(text: string): boolean {
  return /^[\x20-\x7E]+$/.test(text);
}

/** The ack timing a tool result carries when sim-input served the call. */
export interface SimInputResultFields {
  /** Last frame's deadline after the Down (tap / swipe only). */
  scheduledMs?: number;
  /** Down→Up as measured by sim-input (tap / swipe only). */
  actualMs?: number;
  /** `actualMs - scheduledMs` (tap / swipe only). */
  overshootMs?: number;
  /** Worst frame wake past its deadline (tap / swipe only). */
  maxFrameLateMs?: number;
  /** sim-input's receive / per-message send / ack times; null from an older binary. */
  timing: SimInputWireTiming | null;
  /** Host write to host ack, ms. */
  hostRoundTripMs: number;
}

export function simInputResultFields(ack: SimInputAck): SimInputResultFields {
  return {
    ...(ack.scheduledMs !== undefined ? { scheduledMs: ack.scheduledMs } : {}),
    ...(ack.actualMs !== undefined ? { actualMs: ack.actualMs } : {}),
    ...(ack.overshootMs !== undefined ? { overshootMs: ack.overshootMs } : {}),
    ...(ack.maxFrameLateMs !== undefined ? { maxFrameLateMs: ack.maxFrameLateMs } : {}),
    timing: ack.timing,
    hostRoundTripMs: Math.round((ack.hostAckAt - ack.hostWriteAt) * 1000) / 1000,
  };
}

/**
 * Report a sim-input failure at `console.warn` and return the `fallbackReason`
 * the result carries when the runner serves the call instead.
 */
export function simInputFallbackReason(tag: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  console.warn(`[${tag}] sim-input failed, falling back to the runner: ${reason}`);
  return `sim-input: ${reason}`;
}

/**
 * The `fallbackReason` when the runner also failed: the sim-input reason first
 * (when sim-input was tried), then the runner's.
 */
export function chainFallbackReason(
  simInputReason: string | undefined,
  runnerReason: string
): string {
  return simInputReason ? `${simInputReason}; runner: ${runnerReason}` : runnerReason;
}

function withSimInput<T>(
  registry: Registry,
  device: DeviceInfo,
  fn: (api: IosSimInputApi) => Promise<T>
): Promise<T> {
  const ref = iosSimInputRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    let api: IosSimInputApi;
    try {
      api = await registry.resolveService<IosSimInputApi>(ref.urn, ref.options);
    } catch (err) {
      throw new SimInputNotSentError(err instanceof Error ? err.message : String(err));
    }
    return fn(api);
  });
}

/**
 * Tap at normalized coordinates via sim-input. A multi-tap is `clickCount`
 * taps 100 ms apart (inside the double-tap window); resolves with the last ack.
 */
export function iosSimInputTap(
  registry: Registry,
  device: DeviceInfo,
  xNorm: number,
  yNorm: number,
  clickCount: number
): Promise<SimInputAck> {
  return withSimInput(registry, device, async (api) => {
    let ack = await api.sendTap({ x: xNorm, y: yNorm });
    for (let i = 2; i <= clickCount; i++) {
      await new Promise((r) => setTimeout(r, MULTI_TAP_GAP_MS));
      try {
        ack = await api.sendTap({ x: xNorm, y: yNorm });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new SimInputPartialTapError(
          `${reason} (tap ${i} of ${clickCount}; ${i - 1} landed)`,
          i - 1
        );
      }
    }
    return ack;
  });
}

/**
 * Swipe between two normalized points over `durationMs` via sim-input;
 * `holdEndMs` > 0 holds at the end point before the lift (momentum-free).
 */
export function iosSimInputSwipe(
  registry: Registry,
  device: DeviceInfo,
  fromXNorm: number,
  fromYNorm: number,
  toXNorm: number,
  toYNorm: number,
  durationMs: number,
  holdEndMs?: number
): Promise<SimInputAck> {
  return withSimInput(registry, device, (api) =>
    api.sendSwipe({
      fromX: fromXNorm,
      fromY: fromYNorm,
      toX: toXNorm,
      toY: toYNorm,
      durationMs,
      ...(holdEndMs !== undefined && holdEndMs > 0 ? { holdEndMs } : {}),
    })
  );
}

/** Type printable-ASCII text into the focused field via sim-input. */
export function iosSimInputTypeText(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<SimInputAck> {
  return withSimInput(registry, device, (api) => api.sendText(text));
}
