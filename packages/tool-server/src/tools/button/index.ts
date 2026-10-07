import { z } from "zod";
import type {
  Platform,
  Registry,
  ServiceRef,
  ToolCapability,
  ToolDefinition,
} from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { pressButton, type RunnerButton } from "../../utils/ios-device/runner-commands";
import { RunnerCommandError } from "../../utils/ios-device/runner-client";
import { isIosPhysicalDevice, resolveDevice } from "../../utils/device-info";
import { UnsupportedOperationError } from "../../utils/capability";
import { sendCommand } from "../../utils/simulator-client";
import { ANDROID_BUTTON_KEYCODES, injectAndroidKeycode } from "../../utils/android-input";
import { ensureDep } from "../../utils/check-deps";
import {
  ACTION_SETTLE_BOUNDS,
  SETTLE_IGNORED_NOT_OPEN,
  actionSettleFields,
  openServerKeyWithOutcome,
  settleIgnoredAfterFallback,
  shouldUseOpenServer,
  type ActionSettleFields,
} from "../../utils/open-server-input";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  button: z
    .enum(["home", "back", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"])
    .describe("Hardware button to press"),
  settle: z
    .boolean()
    .optional()
    .describe(
      "Android open server only: wait for the screen to settle before returning: first event " +
        "≤600 ms, then 80 ms quiet capped at 1500 ms (up to ~2.1 s); settledMs covers both phases. " +
        "The reply carries settledMs, settled and screenChanged. Default false. The press then " +
        "goes through the open device server instead of adb. Elsewhere it is ignored and the " +
        "reply carries settleIgnored."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result extends Partial<ActionSettleFields> {
  pressed: string;
  /** `settle: true` that did not run, and why. */
  settleIgnored?: string;
}

/** Device server `key` names of the Android buttons (KeyHandler.kt keyNameMap). */
const OPEN_SERVER_KEY: Record<string, string> = {
  home: "home",
  back: "back",
  power: "power",
  volumeUp: "volume_up",
  volumeDown: "volume_down",
  appSwitch: "recent_apps",
};

/**
 * Per-platform buttons; the flat zod enum is the union of both platforms'.
 * Rejecting here keeps the error specific: `sendCommand` now surfaces the
 * server's rejection, but as a generic parse error naming the wire format
 * rather than the platform that lacks the button.
 */
export const BUTTONS_BY_PLATFORM: Record<Platform, ReadonlySet<Params["button"]>> = {
  "ios": new Set(["home", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"]),
  "ios-remote": new Set(["home", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"]),
  "android": new Set(["home", "back", "power", "volumeUp", "volumeDown", "appSwitch"]),
  // The capability gate excludes chromium; the empty set keeps the lookup total.
  "chromium": new Set([]),
  // Vega buttons / D-pad go through the `tv-remote` tool; the capability omits
  // `vega`, so this entry only keeps the record total.
  "vega": new Set([]),
};

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

// Hardware buttons the XCUITest runner can press. power and appSwitch have no XCTest API.
const PHYSICAL_IOS_BUTTONS: ReadonlySet<string> = new Set<RunnerButton>([
  "home",
  "volumeUp",
  "volumeDown",
  "actionButton",
]);

/** Wire code the runner answers for a button this particular hardware lacks. */
const RUNNER_UNSUPPORTED_OPERATION_CODE = "UNSUPPORTED_OPERATION";

/** Narrows an accepted button to the runner's `button` wire names. */
function isPhysicalIosButton(button: Params["button"]): button is RunnerButton {
  return PHYSICAL_IOS_BUTTONS.has(button);
}

/**
 * `registry` lets an Android `settle: true` press reach the open device server;
 * without it (the registry-less `buttonTool` export) the press stays on adb.
 */
export function createButtonTool(registry?: Registry): ToolDefinition<Params, Result> {
  return {
    id: "button",
    interaction: {
      startedMsg: ({ params }) => `Pressing ${params.button} button`,
      completedMsg: ({ params }) => `Pressed ${params.button} button`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to press ${params.button} button: ${failureSignal.error_code}`,
    },
    description: `Press a device hardware button (iOS simulator or physical device, Android emulator or device). iOS simulators send a Down then Up event automatically; Android injects a single \`adb\` key event.
Supported buttons depend on the platform: home, back, power, volumeUp, volumeDown, appSwitch, actionButton; buttons not present on the target platform (e.g. 'back' on iOS, 'actionButton' on Android, 'power' or 'appSwitch' on a physical iPhone) are rejected with a clear error.
Use when you need to trigger hardware button events.
Returns { pressed: buttonName }. Android open device server: pass settle: true to wait for the screen to settle after the press (the reply adds settledMs, settled, screenChanged).
Fails if the device backend is not reachable: the simulator-server for iOS, or \`adb\` for Android (Android presses are injected with \`adb shell input keyevent\`).`,
    zodSchema,
    capability,
    // Declare only the service the resolved path actually consumes. The Android
    // path uses `adb`, so a sim-server here would spawn a service the tool never
    // uses (up to a 30s ready-wait) and could throw ServiceInitializationError
    // before the adb path even runs.
    // Declare the runner only for a button this path can press. A rejected button must not pay a runner cold start.
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "android") return {};
      if (isIosPhysicalDevice(device)) {
        return isPhysicalIosButton(params.button)
          ? { iosDeviceRunner: iosDeviceRunnerRef(device) }
          : {};
      }
      return { simulatorServer: simulatorServerRef(device) };
    },
    async execute(services, params) {
      const device = resolveDevice(params.udid);
      const settle = params.settle === true;
      if (!BUTTONS_BY_PLATFORM[device.platform].has(params.button)) {
        throw new UnsupportedOperationError(
          "button",
          device,
          `button '${params.button}' is not available on ${device.platform}`
        );
      }
      if (isIosPhysicalDevice(device)) {
        if (!isPhysicalIosButton(params.button)) {
          throw new UnsupportedOperationError(
            "button",
            device,
            `button '${params.button}' is not available on a physical iOS device: XCUITest ` +
              "exposes no API for the power/lock button or the app switcher"
          );
        }
        try {
          await pressButton(services.iosDeviceRunner as IosDeviceRunnerApi, params.button);
        } catch (error) {
          // Only the device knows its hardware: actionButton on a non-Pro iPhone
          // comes back as UNSUPPORTED_OPERATION. That is the same capability
          // verdict as the platform checks above, not a runner fault.
          if (
            error instanceof RunnerCommandError &&
            error.code === RUNNER_UNSUPPORTED_OPERATION_CODE
          ) {
            throw new UnsupportedOperationError("button", device, error.message);
          }
          throw error;
        }
        return {
          pressed: params.button,
          ...(settle ? { settleIgnored: SETTLE_IGNORED_NOT_OPEN } : {}),
        };
      }
      if (device.platform === "android") {
        // settle-on-action: the press goes through the open server `key` RPC with the
        // settle bounds, and the reply carries the settle fields. With screen-graph
        // recording on, the same reply is recorded (one key RPC). A failure falls
        // back to adb below, without the settle.
        let settleIgnored: string | undefined;
        if (settle) {
          if (!shouldUseOpenServer(device)) settleIgnored = SETTLE_IGNORED_NOT_OPEN;
          else if (!registry) settleIgnored = "open server not reachable from this tool instance";
          else {
            const key = OPEN_SERVER_KEY[params.button]!;
            try {
              const outcome = await openServerKeyWithOutcome(
                registry,
                device,
                key,
                params.button === "back" ? { kind: "back" } : { kind: "key", key },
                { bounds: ACTION_SETTLE_BOUNDS, failOnDrop: true }
              );
              return { pressed: params.button, ...actionSettleFields(outcome) };
            } catch (err) {
              settleIgnored = settleIgnoredAfterFallback(err);
            }
          }
        }
        // `adb`, not the simulator-server's HID transport, which the guest silently
        // drops on AVDs created with `hw.keyboard = no` / `hw.mainKeys = no`; adb
        // lands regardless and surfaces a failure as a throw. The
        // BUTTONS_BY_PLATFORM guard above guarantees a keycode for every accepted
        // button.
        //
        // The tool declares no global `requires`, so preflight adb here for the
        // clean 424 install hint on a missing binary.
        await ensureDep("adb");
        await injectAndroidKeycode(params.udid, ANDROID_BUTTON_KEYCODES[params.button]!);
        return {
          pressed: params.button,
          ...(settleIgnored !== undefined ? { settleIgnored } : {}),
        };
      }
      const api = services.simulatorServer as SimulatorServerApi;
      await sendCommand(api, {
        cmd: "button",
        direction: "Down",
        button: params.button,
      });
      await sleep(50);
      await sendCommand(api, { cmd: "button", direction: "Up", button: params.button });
      return {
        pressed: params.button,
        ...(settle ? { settleIgnored: SETTLE_IGNORED_NOT_OPEN } : {}),
      };
    },
  };
}

export const buttonTool = createButtonTool();
