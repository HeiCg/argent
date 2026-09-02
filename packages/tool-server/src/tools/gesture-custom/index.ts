import { z } from "zod";
import type { Registry, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";
import { interpolateEvents } from "../../utils/gesture-utils";
import {
  shouldUseOpenServer,
  openServerGesture,
  type NormalizedPointerPath,
} from "../../utils/open-server-input";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CustomEvent = { type: "Down" | "Move" | "Up"; x: number; y: number; x2?: number; y2?: number; delayMs?: number };

/**
 * Map a custom event list to synchronized open-server pointer paths, or null
 * when it isn't a shape the injector can represent (one continuous touch:
 * Down … Move … Up, with a fixed one- or two-finger count throughout). Anything
 * irregular — multiple downs, a finger appearing mid-gesture, a trailing Move —
 * returns null so the caller keeps the simulator-server path, which handles the
 * raw event train verbatim.
 */
function toOpenPointerPaths(events: CustomEvent[]): NormalizedPointerPath[] | null {
  if (events.length < 2) return null;
  if (events[0]!.type !== "Down" || events[events.length - 1]!.type !== "Up") return null;
  for (let i = 1; i < events.length - 1; i++) {
    if (events[i]!.type !== "Move") return null;
  }
  const twoFinger = events[0]!.x2 !== undefined && events[0]!.y2 !== undefined;
  const p0: NormalizedPointerPath["points"] = [];
  const p1: NormalizedPointerPath["points"] = [];
  let tMs = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (i > 0) tMs += e.delayMs ?? 16;
    p0.push({ x: e.x, y: e.y, tMs });
    if (twoFinger) {
      if (e.x2 === undefined || e.y2 === undefined) return null;
      p1.push({ x: e.x2, y: e.y2, tMs });
    } else if (e.x2 !== undefined || e.y2 !== undefined) {
      return null;
    }
  }
  return twoFinger ? [{ id: 0, points: p0 }, { id: 1, points: p1 }] : [{ id: 0, points: p0 }];
}

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

// On the open-device-server path a multi-pointer timeline is time-thinned before
// injection: frames are resampled to a ~16ms cadence, the first/last frame and
// the total duration are preserved, and dwell frames (a run of same-position
// keyframes — a hold) are kept intact so a momentum-free hold still decays the
// release velocity to ~0. Authored timing is honoured; only redundant
// intermediate frames between keyframes are dropped to cut per-event injection
// cost. The proprietary path replays every frame verbatim.

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

export function createGestureCustomTool(registry: Registry): ToolDefinition<Params, Result> {
  return {
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
    // Skip the proprietary server when the open path is active; resolved lazily
    // in execute only as a fallback (mirrors gesture-tap / gesture-swipe).
    if (shouldUseOpenServer(device)) return {};
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    const events =
      params.interpolate && params.interpolate > 0
        ? interpolateEvents(params.events, params.interpolate)
        : params.events;

    if (shouldUseOpenServer(device)) {
      const pointers = toOpenPointerPaths(events as CustomEvent[]);
      // Only route a gesture the injector can represent one-for-one; anything
      // irregular falls through to the simulator-server event train.
      if (pointers) {
        try {
          await openServerGesture(registry, device, pointers);
          return { events: events.length };
        } catch (err) {
          console.debug(
            `[gesture-custom] open-device-server failed, falling back to simulator-server: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }

    const ref = simulatorServerRef(device);
    const api = shouldUseOpenServer(device)
      ? await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options)
      : (services.simulatorServer as SimulatorServerApi);

    for (const event of events) {
      await sleep(event.delayMs ?? 16);
      await sendCommand(api, {
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
}
