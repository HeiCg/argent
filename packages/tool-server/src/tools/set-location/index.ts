import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import type { SetLocationResult, SetLocationServices } from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS simulator UDID or Android emulator serial)."),
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .describe("Latitude in decimal degrees, -90 to 90 (positive = north)."),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .describe("Longitude in decimal degrees, -180 to 180 (positive = east)."),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  // Simulated GPS is a host-side override, so only virtual devices qualify.
  apple: { simulator: true },
  // Emulators only: `adb emu geo fix` needs the emulator console, and a
  // physical Android device has no location override without an installed
  // mock-location provider.
  android: { emulator: true },
};

export const setLocationTool: ToolDefinition<Params, SetLocationResult> = {
  id: "set-location",
  interaction: {
    startedMsg: ({ params }) => `Setting location to ${params.latitude}, ${params.longitude}`,
    completedMsg: ({ params }) => `Set location to ${params.latitude}, ${params.longitude}`,
    failedMsg: ({ failureSignal }) => `Failed to set location: ${failureSignal.error_code}`,
  },
  description: `Set the device's simulated GPS location to a fixed latitude/longitude.
Use during test setup to place the device somewhere specific before exercising maps, geofencing, "near me" results, or region-gated content — without moving physical hardware.
This sets where the device thinks it is, not whether an app may read it: use \`settings-permissions\` to grant the location permission, and launch or relaunch the app after setting the fix so it picks up the new coordinate.
Android emulator: pushes the coordinate through the emulator console (\`adb emu geo fix\`). iOS simulator: sets the simulated location via \`simctl location\`.
Returns { located: true, latitude, longitude }. Fails if the coordinate is out of range, the emulator console or simctl rejects it, or the target is a physical Android device or a physical / remote iOS device (unsupported — only local simulators and emulators have a host-side location override).`,
  searchHint: "location gps geo coordinates latitude longitude mock position maps geofence",
  zodSchema,
  capability,
  services: () => ({}),
  execute: dispatchByPlatform<
    SetLocationServices,
    SetLocationServices,
    Params,
    SetLocationResult
  >({
    toolId: "set-location",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
