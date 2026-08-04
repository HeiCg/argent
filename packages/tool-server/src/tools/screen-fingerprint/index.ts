import { z } from "zod";
import type { Registry, ToolContext, ToolDefinition } from "@argent/registry";
import { resolveFlowDevice } from "../flows/flow-device";
import { connectRouteReader, probeRoute, routeFingerprint } from "../../utils/route-identity";
import { metroServerRunning } from "../../utils/debugger/discovery";

/**
 * Whether a Metro dev server is answering on `port` at all. Never throws.
 *
 * Asks only whether the SERVER is up — see {@link metroServerRunning}. Target
 * discovery cannot answer it: a Metro serving one app reports an empty target
 * list for the several seconds after that app relaunches, which is exactly
 * when this tool is called, and reading that as "Metro is down" produced the
 * one message the branch below exists to avoid.
 */
async function metroReachable(port: number): Promise<boolean> {
  return metroServerRunning(port);
}

/**
 * Read the current screen's route fingerprint from the running app — the
 * recorder's source for a flow's `await: { screen: … }` gate. A thin,
 * device-only probe: nothing is tapped and no file is touched.
 */

export const SCREEN_FINGERPRINT_TOOL_ID = "screen-fingerprint";

// chromium is deliberately absent: an Electron app has no React Navigation
// state to read, so there is nothing this tool could return for it.
const FINGERPRINT_PLATFORMS = ["ios", "android", "vega"] as const;

const zodSchema = z.object({
  app_id: z
    .string()
    .min(1)
    .describe(
      "Bundle id / package name of the app under test — guards against reading a foreign " +
        "app's Metro on the same port."
    ),
  platform: z
    .enum(FINGERPRINT_PLATFORMS)
    .optional()
    .describe(
      "Platform of the device under test. Only needed to disambiguate when several platforms " +
        "have a booted device."
    ),
  device: z
    .string()
    .optional()
    .describe(
      "Device id to probe (iOS UDID, Android/Vega serial). Auto-detected from the single " +
        "booted device when omitted."
    ),
  metro_port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe("Metro dev-server port the app was launched from (default 8081)."),
});

type Params = z.infer<typeof zodSchema>;

export interface ScreenFingerprintResult {
  /** false = no reader for this app (not a Metro-served debuggable RN app). */
  available: boolean;
  /** The fingerprint to gate on, or null when none could be read. */
  route: string | null;
  /** Focused route names outermost→innermost (what `route` joins). */
  path?: string[];
  /**
   * The leaf route's params — evidence the screen is parameterized (one route
   * serves every instance). Data about the screen, never its identity.
   */
  params?: Record<string, unknown> | null;
  reason?: string;
  hint?: string;
}

export function createScreenFingerprintTool(
  registry: Registry
): ToolDefinition<Params, ScreenFingerprintResult> {
  return {
    id: SCREEN_FINGERPRINT_TOOL_ID,
    interaction: {
      startedMsg: ({ params }) => `Reading screen identity of ${params.app_id}`,
      // A read that returns no route still succeeds, so the message has to say
      // which of the two happened — "read the screen" would imply a fingerprint
      // that the caller may not have got.
      completedMsg: ({ params, result }) =>
        result.route === null
          ? `Read no focused route for ${params.app_id}`
          : `Read screen ${result.route}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to read screen identity of ${params.app_id}: ${failureSignal.error_code}`,
    },
    description: `Read which screen the app is on, as its focused React Navigation route path ("HomeTab>Profile"), via the RN debugger over Metro.
This is screen IDENTITY, and it is stronger than any element check: it comes from the app's own navigation state, so it does not depend on which tree source rendered \`describe\`, on content, on count, or on locale, and every instance of a parameterized screen (one profile vs another) shares one route. Gate a flow on it with \`await: { screen: "HomeTab>Profile" }\`, or record that step by passing this command to \`flow-add-step\`.
It answers "which screen" and nothing else. It does NOT prove the screen finished animating (navigation state commits before the transition ends) and it does NOT see a native overlay above the screen (a permission alert, a share sheet, an RN <Modal> leave the route unchanged) — pair it with \`await: { idle: true }\` for readiness and an element check for the overlay.
Only Metro-served debuggable RN apps have routes: \`available: false\` means this app has no reader (release build, fully native, chromium) — gate on elements instead. \`route: null\` with \`available: true\` means no focused route right now (a native screen, or a transition mid-flight) — let the screen settle and probe again.`,
    searchHint:
      "screen identity fingerprint which screen route react navigation current screen prove navigation",
    zodSchema,
    services: () => ({}),
    async execute(_services, params, ctx?: ToolContext) {
      const device = await resolveFlowDevice(registry, ctx, {
        ...(params.device !== undefined ? { device: params.device } : {}),
        ...(params.platform !== undefined ? { platform: params.platform } : {}),
      });
      const metroPort = params.metro_port ?? 8081;
      if (device.platform === "chromium") {
        return {
          available: false,
          route: null,
          reason:
            "chromium apps have no React Navigation route identity — gate on a destination-only " +
            "element instead.",
        };
      }
      // "ios-remote" is an iOS simulator over a remote bridge — same runtime.
      const platform = device.platform === "ios-remote" ? "ios" : device.platform;
      const reader = await connectRouteReader(registry, ctx, {
        udid: device.id,
        bundleId: params.app_id,
        metroPort,
        platform,
      });
      if (reader === undefined) {
        // Which cause holds is checkable, so check it. Asserting "Metro is
        // down" while Metro is demonstrably up — the routine case, because an
        // app re-registers a few seconds AFTER it relaunches and the recorder
        // probes immediately — sent authors to repair a working dev server,
        // and the conclusion the old wording drew for them ("screens of this
        // app can only be recognized by element checks") deleted the identity
        // proof for the whole flow on the strength of a transient miss.
        const metroUp = await metroReachable(metroPort);
        return {
          available: false,
          route: null,
          reason: metroUp
            ? `Metro is running on port ${metroPort}, but no debuggable target for ` +
              `${params.app_id} is registered there. If the app was just launched or restarted, ` +
              `it re-registers a few seconds later — wait for the screen to settle and probe ` +
              `again. If it stays this way, the app is not a debuggable RN build, or this port ` +
              `serves a different app.`
            : `No Metro dev server is answering on port ${metroPort}, so ${params.app_id} has ` +
              `no route reader. Start Metro (or pass the right \`metro_port\`); if this app is ` +
              `not a debuggable RN build at all, its screens can only be recognized by element ` +
              `checks.`,
        };
      }
      const route = await probeRoute(reader, {
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      if (route === null) {
        return {
          available: true,
          route: null,
          reason:
            "The app exposes no focused React Navigation route right now — a fully native " +
            "screen, or a transition mid-flight. Let the screen settle and probe again; if it " +
            "stays null, this screen has no route identity (gate on an element instead).",
        };
      }
      const fingerprint = routeFingerprint(route);
      return {
        available: true,
        route: fingerprint,
        path: route.path,
        params: route.params,
        hint:
          `Gate on it with: - await: { screen: "${fingerprint}" }, PAIRED with a readiness ` +
          `check — navigation state commits before the screen renders, so this route is already ` +
          `reported while the app is still blank. If the screen you just navigated FROM reports ` +
          `this same route, the two are one route and gating on it would prove nothing: use a ` +
          `destination-only element instead. ` +
          `Non-null params mean the screen is parameterized — the route still identifies it, ` +
          `but do not also gate on the specific instance's content.`,
      };
    },
  };
}
