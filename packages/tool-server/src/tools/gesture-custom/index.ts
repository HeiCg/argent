import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { requireCurrentIosDeviceApp } from "../../utils/ios-device/app-session";
import {
  dragBetween,
  getViewport,
  longPressAt,
  toPoints,
} from "../../utils/ios-device/runner-commands";
import { resolveDevice } from "../../utils/device-info";
import { InvalidToolInputError } from "../../utils/capability";
import { sendCommand } from "../../utils/simulator-client";
import { interpolateEvents } from "../../utils/gesture-utils";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const eventSchema = z.object({
  type: z.enum(["Down", "Move", "Up"]).describe("Touch event type"),
  x: z.number().describe("Normalized x 0.0–1.0 (not pixels; same as tap/swipe)"),
  y: z.number().describe("Normalized y 0.0–1.0 (not pixels; same as tap/swipe)"),
  x2: z
    .number()
    .optional()
    .describe("Second touch x for two-finger gestures: normalized 0.0–1.0 (not pixels)"),
  y2: z
    .number()
    .optional()
    .describe("Second touch y for two-finger gestures: normalized 0.0–1.0 (not pixels)"),
  delayMs: z
    .number()
    .optional()
    .describe("Delay before this event in milliseconds (default 16ms ≈ 60fps)"),
});

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  events: z
    .array(eventSchema)
    .describe(
      "Sequence of touch events; x/y (and optional second touch) are normalized 0.0–1.0, not pixels"
    ),
  interpolate: z
    .number()
    .optional()
    .describe(
      "Number of intermediate Move events to auto-insert between each pair of consecutive events. " +
        "Smooths out gestures by linearly interpolating both primary (x,y) and secondary (x2,y2) coordinates. " +
        "The delay is split evenly across interpolated frames. Default: no interpolation."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  events: number;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

// Two Down/Up points within half a percent of the screen count as "the same
// place" — a press-hold, not a drag. Covers float jitter in agent-authored
// coordinates without swallowing genuine short drags.
const SAME_POINT_EPSILON = 0.005;

/**
 * Physical-iOS backend: XCTest has no raw HID stream, so instead of replaying
 * the event train it maps the two shapes the runner can execute faithfully —
 * a press-hold (`Down` then `Up` at the same point → runner `longPress`) and a
 * straight single-finger drag (`Down` then `Up` elsewhere → runner `drag`).
 * Everything else (second finger, waypoint `Move`s) is rejected up front with
 * authoring guidance rather than approximated into a different gesture. The
 * raw `events` are inspected, not the interpolated train: interpolation only
 * smooths the HID stream, and the runner plans its own gesture.
 */
async function runOnIosDevice(
  runner: IosDeviceRunnerApi,
  udid: string,
  events: Params["events"]
): Promise<Result> {
  const twoFinger = events.some((e) => e.x2 !== undefined || e.y2 !== undefined);
  if (twoFinger) {
    throw new InvalidToolInputError(
      "gesture-custom on a physical iOS device supports single-finger gestures only — " +
        "two-finger event trains (pinch/rotate) have no XCTest coordinate API."
    );
  }
  const [down, up] = events;
  if (events.length !== 2 || down?.type !== "Down" || up?.type !== "Up") {
    throw new InvalidToolInputError(
      "gesture-custom on a physical iOS device supports exactly a Down followed by an Up: " +
        "same point = press-hold, different points = straight drag. For scrolls use " +
        "gesture-swipe; waypoint Move events cannot be replayed through XCTest."
    );
  }
  const bundleId = requireCurrentIosDeviceApp(udid);
  const viewport = await getViewport(runner, bundleId);
  const durationMs = up.delayMs ?? 16;
  const isSamePoint =
    Math.abs(up.x - down.x) <= SAME_POINT_EPSILON && Math.abs(up.y - down.y) <= SAME_POINT_EPSILON;
  if (isSamePoint) {
    await longPressAt(runner, bundleId, toPoints(viewport, down.x, down.y), durationMs);
  } else {
    await dragBetween(
      runner,
      bundleId,
      toPoints(viewport, down.x, down.y),
      toPoints(viewport, up.x, up.y),
      durationMs
    );
  }
  return { events: 2 };
}

export const gestureCustomTool: ToolDefinition<Params, Result> = {
  id: "gesture-custom",
  interaction: {
    startedMsg: () => "Performing custom gesture",
    completedMsg: () => "Performed custom gesture",
    failedMsg: ({ failureSignal }) =>
      `Failed to perform custom gesture: ${failureSignal.error_code}`,
  },
  description: `Send a sequence of touch events for complex gestures.
Use for: long press, drag-and-drop, custom scroll, pinch (second touch point).
For simple taps use the gesture-tap tool. For straight-line scrolling use the gesture-swipe tool.
For pinch gestures use gesture-pinch. For rotation gestures use gesture-rotate.
All x/y values are normalized 0.0–1.0 (screen fractions, not pixels). delayMs controls the delay before each event (default 16ms ≈ 60fps).
Set interpolate to auto-generate smooth intermediate Move events between your keyframes.
On a physical iOS device only two shapes are executable (XCTest has no raw touch stream): a Down followed by an Up at the same point (press-hold) or at another point (straight drag) — no second finger, no Move waypoints; use gesture-swipe for scrolls there.
Returns { events: number } with the total count of events dispatched. Fails if the target device is not booted or an event type is invalid.

Example long-press at center:
  [{"type":"Down","x":0.5,"y":0.5},{"type":"Up","x":0.5,"y":0.5,"delayMs":800}]

Example smooth scroll down:
  [{"type":"Down","x":0.5,"y":0.7},
   {"type":"Move","x":0.5,"y":0.6},{"type":"Move","x":0.5,"y":0.5},{"type":"Move","x":0.5,"y":0.4},
   {"type":"Up","x":0.5,"y":0.3}]

Example pinch-to-zoom (with interpolate:10 for smoothness):
  events: [{"type":"Down","x":0.4,"y":0.5,"x2":0.6,"y2":0.5},
           {"type":"Up","x":0.2,"y":0.5,"x2":0.8,"y2":0.5}]
  interpolate: 10`,
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "ios" && device.kind === "device") {
      return { iosDeviceRunner: iosDeviceRunnerRef(device) };
    }
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    if (device.platform === "ios" && device.kind === "device") {
      return runOnIosDevice(
        services.iosDeviceRunner as IosDeviceRunnerApi,
        device.id,
        params.events
      );
    }
    const api = services.simulatorServer as SimulatorServerApi;
    const events =
      params.interpolate && params.interpolate > 0
        ? interpolateEvents(params.events, params.interpolate)
        : params.events;

    for (const event of events) {
      await sleep(event.delayMs ?? 16);
      sendCommand(api, {
        cmd: "touch",
        type: event.type,
        x: event.x,
        y: event.y,
        second_x: event.x2 ?? null,
        second_y: event.y2 ?? null,
      });
    }
    return { events: events.length };
  },
};
