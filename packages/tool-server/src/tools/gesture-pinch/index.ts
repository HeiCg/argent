import { z } from "zod";
import type { Registry, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { sendTouchEvent } from "../../utils/gesture-utils";
import { sleep } from "../../utils/timing";
import {
  shouldUseOpenServer,
  openServerGesture,
  type NormalizedPointerPath,
} from "../../utils/open-server-input";

// Host frame budget ≈ 60fps; the open server injects the same per-frame timeline.
const FRAME_MS = 16;

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  centerX: z
    .number()
    .describe(
      "Center of pinch, horizontal: normalized 0.0–1.0 (fraction of screen width, not pixels)"
    ),
  centerY: z
    .number()
    .describe(
      "Center of pinch, vertical: normalized 0.0–1.0 (fraction of screen height, not pixels)"
    ),
  startDistance: z
    .number()
    .describe(
      "Initial distance between the two fingers: normalized 0.0–1.0 (fraction of screen, not pixels). " +
        "E.g. 0.2 = fingers 20% of screen apart. " +
        "Use a larger startDistance than endDistance to pinch in (zoom out)."
    ),
  endDistance: z
    .number()
    .describe(
      "Final distance between the two fingers: normalized 0.0–1.0 (fraction of screen, not pixels). " +
        "E.g. 0.6 = fingers 60% of screen apart. " +
        "Use a larger endDistance than startDistance to pinch out (zoom in)."
    ),
  endCenterX: z
    .number()
    .optional()
    .describe(
      "Final horizontal center of the pinch: normalized 0.0–1.0. When set, the centroid drifts " +
        "linearly from centerX to endCenterX over the gesture (e.g. to keep expanding fingers " +
        "on-screen near an edge). Omit for a fixed center."
    ),
  endCenterY: z
    .number()
    .optional()
    .describe(
      "Final vertical center of the pinch: normalized 0.0–1.0. When set, the centroid drifts " +
        "linearly from centerY to endCenterY over the gesture. Omit for a fixed center."
    ),
  angle: z
    .number()
    .optional()
    .describe("Axis angle in degrees along which the fingers are placed (default 0 = horizontal)."),
  durationMs: z
    .number()
    .optional()
    .describe("Total gesture duration in milliseconds (default 300)"),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  pinched: boolean;
  timestampMs: number;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

export function createGesturePinchTool(registry: Registry): ToolDefinition<Params, Result> {
  return {
  id: "gesture-pinch",
  interaction: {
    startedMsg: ({ params }) =>
      `Pinching ${params.endDistance > params.startDistance ? "out" : "in"} at (${Math.round(params.centerX * 100)}%, ${Math.round(params.centerY * 100)}%)`,
    completedMsg: ({ params }) =>
      `Pinched ${params.endDistance > params.startDistance ? "out" : "in"} at (${Math.round(params.centerX * 100)}%, ${Math.round(params.centerY * 100)}%)`,
    failedMsg: ({ failureSignal }) => `Failed to pinch: ${failureSignal.error_code}`,
  },
  description: `Execute a pinch-to-zoom gesture by moving two fingers toward or away from a center point to change the scale of on-screen content. All positions and distances are normalized 0.0–1.0 (fractions of screen width/height, not pixels)—same coordinate space as gesture-tap and gesture-swipe.
startDistance > endDistance = pinch in (zoom out). startDistance < endDistance = pinch out (zoom in).
Typical values: startDistance 0.2, endDistance 0.6 for a zoom-in pinch at screen center.
Auto-generates interpolated frames at ~60fps. The angle parameter controls the axis (0 = horizontal, 90 = vertical). Optional endCenterX/endCenterY drift the centroid linearly over the gesture (omitted = fixed center).
Use when you need to zoom in or out on a map, image, or zoomable view. Returns { pinched: true, timestampMs }. Fails if the simulator-server / emulator backend is not reachable for the given device.`,
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    // Skip the proprietary server when the open path is active; it is resolved
    // lazily in execute only as a fallback (mirrors gesture-tap / gesture-swipe).
    if (shouldUseOpenServer(device)) return {};
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    const duration = params.durationMs ?? 300;
    const steps = Math.max(1, Math.round(duration / 16));
    const angleDeg = params.angle ?? 0;
    const angleRad = (angleDeg * Math.PI) / 180;
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);
    const endCenterX = params.endCenterX ?? params.centerX;
    const endCenterY = params.endCenterY ?? params.centerY;

    // Single-source the geometry so the open (one gesture RPC) and simulator-
    // server (per-frame Move loop) paths dispatch the exact same frames.
    const frames: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const dist = params.startDistance + (params.endDistance - params.startDistance) * t;
      const halfDist = dist / 2;
      const cx = params.centerX + (endCenterX - params.centerX) * t;
      const cy = params.centerY + (endCenterY - params.centerY) * t;
      frames.push({
        x1: cx - halfDist * cosA,
        y1: cy - halfDist * sinA,
        x2: cx + halfDist * cosA,
        y2: cy + halfDist * sinA,
      });
    }

    const timestampMs = Date.now();

    if (shouldUseOpenServer(device)) {
      try {
        const pointers: NormalizedPointerPath[] = [
          { id: 0, points: frames.map((f, i) => ({ x: f.x1, y: f.y1, tMs: i * FRAME_MS })) },
          { id: 1, points: frames.map((f, i) => ({ x: f.x2, y: f.y2, tMs: i * FRAME_MS })) },
        ];
        await openServerGesture(registry, device, pointers);
        return { pinched: true, timestampMs };
      } catch (err) {
        console.debug(
          `[gesture-pinch] open-device-server failed, falling back to simulator-server: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    const ref = simulatorServerRef(device);
    const api = shouldUseOpenServer(device)
      ? await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options)
      : (services.simulatorServer as SimulatorServerApi);

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      const type = i === 0 ? "Down" : i === frames.length - 1 ? "Up" : "Move";
      await sendTouchEvent(api, type, f.x1, f.y1, f.x2, f.y2);
      if (i < frames.length - 1) await sleep(16);
    }

    return { pinched: true, timestampMs };
  },
  };
}
