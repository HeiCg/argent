import { z } from "zod";
import type { Registry, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { assertChromiumWindowVisible } from "../../utils/chromium-visibility";
import { resolveDevice } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";
import {
  shouldUseOpenServer,
  openServerTap,
  openServerTapWithOutcome,
  openServerVerifiedTap,
  type OpenServerVerify,
  type OpenServerVerifiedResult,
} from "../../utils/open-server-input";
import { verifyParamSchema } from "../../utils/open-server-verify";
import type { VerifyBounds, VerifyCandidate } from "../../utils/open-server-verify";
import { recordIncident, clearIncident } from "../../utils/open-server-incident";
import { shouldUseIosOpenServer, iosOpenServerTap } from "../../utils/ios-open-server-input";
import { screenGraphRecordingEnabled } from "../../utils/screen-graph-open-wiring";
import type { OpenServerActionOutcome } from "../../blueprints/android-open-server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
  x: z.number().describe("Normalized horizontal position 0.0–1.0 (left=0, right=1), not pixels"),
  y: z.number().describe("Normalized vertical position 0.0–1.0 (top=0, bottom=1), not pixels"),
  clickCount: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Number of taps/clicks dispatched as ONE multi-tap gesture (2 = double-tap / double-click). " +
        "The taps land inside the OS double-tap window; on Chromium each click carries an escalating " +
        "CDP clickCount so dblclick actually fires. Default 1."
    ),
  verify: verifyParamSchema
    .optional()
    .describe(
      "Android open-device-server only: verify a target on the LIVE accessibility tree before " +
        "tapping. Pass { selector, tolerancePx? } where selector is the ScreenSelector grammar " +
        "(id/text/class as a bare string = exact, or { contains|equals|regex, caseInsensitive? }; " +
        "index, visible, containsDescendant). The host runs the server-side `query` RPC and resolves " +
        "a UNIQUE node: exactly one match taps its bounds center (and refuses `verify_mismatch` if x/y " +
        "fall outside the match ± tolerancePx); zero matches refuses `verify_not_found`; several refuses " +
        "`verify_ambiguous` with up to 5 candidates — NO tap is issued on a refusal. Ignored off the " +
        "Android open path. When absent the tap path is unchanged."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  tapped: boolean;
  timestampMs: number;
  /**
   * Screen-graph Phase A: present only on the Android open-device-server path.
   * The before/after fingerprint delta of this tap, so a caller learns whether
   * the screen changed (and whether it's a new screen) without a follow-up read.
   */
  outcome?: OpenServerActionOutcome;
  /**
   * Ticket A1 (verified tap) — present only when `verify` was passed on the
   * Android open path. `true` when the selector resolved uniquely and the tap
   * landed on its center; `false` on a refusal (no tap issued). `verifyCode`
   * names the refusal; `resolvedBounds` / `version` / `verifyMs` describe the
   * `query` that resolved (or refused) the target.
   */
  verified?: boolean;
  verifyCode?: "verify_not_found" | "verify_ambiguous" | "verify_mismatch";
  resolvedBounds?: VerifyBounds;
  version?: number;
  verifyMs?: number;
  /** `verify_ambiguous`: up to 5 matches (label, bounds) — add a second field. */
  candidates?: VerifyCandidate[];
  /** `verify_mismatch`: the pixel coordinates the caller proposed. */
  requestedPx?: { x: number; y: number };
  /** `verify_mismatch`: the element the caller's coordinates actually hit. */
  mismatchLabel?: string;
}

function tapDescription(params: Params, tense: "present" | "past"): string {
  const count = params.clickCount ?? 1;
  const action =
    count === 1
      ? tense === "present"
        ? "Tapping"
        : "Tapped"
      : count === 2
        ? tense === "present"
          ? "Double-tapping"
          : "Double-tapped"
        : `${tense === "present" ? "Tapping" : "Tapped"} ${count} times`;
  return `${action} at (${Math.round(params.x * 100)}%, ${Math.round(params.y * 100)}%)`;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

// Timings keep a multi-tap inside the OS double-tap window, which separate
// tool calls could not guarantee.
const TAP_HOLD_MS = 50;
const MULTI_TAP_GAP_MS = 100;

async function tapChromium(
  api: ChromiumCdpApi,
  x: number,
  y: number,
  clickCount: number
): Promise<void> {
  const vp = api.getViewport();
  const pxX = Math.max(0, Math.min(vp.width, x * vp.width));
  const pxY = Math.max(0, Math.min(vp.height, y * vp.height));
  await api.dispatchMouseEvent({ type: "mouseMoved", x: pxX, y: pxY });
  // dblclick fires off the escalating clickCount, not off timing.
  for (let i = 1; i <= clickCount; i++) {
    if (i > 1) await sleep(MULTI_TAP_GAP_MS);
    await api.dispatchMouseEvent({ type: "mousePressed", x: pxX, y: pxY, clickCount: i });
    await sleep(TAP_HOLD_MS);
    await api.dispatchMouseEvent({ type: "mouseReleased", x: pxX, y: pxY, clickCount: i });
  }
}

export function createGestureTapTool(registry: Registry): ToolDefinition<Params, Result> {
  return {
    id: "gesture-tap",
    interaction: {
      startedMsg: ({ params }) => tapDescription(params, "present"),
      completedMsg: ({ params }) => tapDescription(params, "past"),
      failedMsg: ({ params, failureSignal }) =>
        `Failed to tap at (${Math.round(params.x * 100)}%, ${Math.round(params.y * 100)}%): ${failureSignal.error_code}`,
    },
    description: `Press the device screen (iOS simulator, Android emulator, or Chromium app) at normalized coordinates: x and y are fractions of screen width and height in 0.0–1.0 (not pixels).
Sends a Down event followed by an Up event at the same point. For Chromium, this dispatches a CDP mouse-press/release on the renderer.
Set clickCount: 2 for a double-tap / double-click — the taps are dispatched as one gesture with proper click counting, which two separate tap calls cannot guarantee.
Use when you need to tap a button, link, or any tappable element on the screen.
Returns { tapped: true, timestampMs }. Fails if the simulator-server / emulator backend / Chromium CDP is not reachable for the given device.
Before tapping, determine the correct coordinates by using discovery tools — pick by platform: iOS / Android use \`describe\`, \`native-describe-screen\`, or \`debugger-component-tree\`; Chromium uses \`describe\` (the DOM walker), since the native and RN-specific discovery tools don't apply. More information in \`argent-device-interact\` skill`,
    alwaysLoad: true,
    searchHint: "tap press button element device simulator emulator chromium touch down up click",
    zodSchema,
    capability,
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "chromium") {
        return { chromium: chromiumCdpRef(device) };
      }
      // With the open-device-server flag on, the simulator-server is resolved
      // lazily in execute only if the open path fails, so a healthy open backend
      // never spawns the proprietary server.
      if (shouldUseOpenServer(device) || shouldUseIosOpenServer(device)) {
        return {};
      }
      return { simulatorServer: simulatorServerRef(device) };
    },
    async execute(services, params) {
      const device = resolveDevice(params.udid);
      const timestampMs = Date.now();
      const clickCount = params.clickCount ?? 1;
      if (device.platform === "chromium") {
        const chromium = services.chromium as ChromiumCdpApi;
        // Mouse dispatch stalls at ~5s per event on a hidden window.
        await assertChromiumWindowVisible(chromium, "tap", "chromium_tap_window_hidden");
        await tapChromium(chromium, params.x, params.y, clickCount);
        return { tapped: true, timestampMs };
      }
      let api: SimulatorServerApi;
      if (shouldUseIosOpenServer(device)) {
        // Open iOS server (XCUITest runner) behind the `open-ios-device-server`
        // flag. Falls back to the proprietary simulator-server on any failure.
        try {
          await iosOpenServerTap(registry, device, params.x, params.y, clickCount);
          return { tapped: true, timestampMs };
        } catch (err) {
          console.debug(
            `[gesture-tap] ios open-device-server failed, falling back to simulator-server: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          const ref = simulatorServerRef(device);
          api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
        }
      } else if (shouldUseOpenServer(device) && params.verify) {
        // Ticket A1 (verified tap): resolve the target on the LIVE tree first and
        // tap its center, or refuse WITHOUT injecting. No fallback to the
        // proprietary path — a verify the open path cannot run must not become a
        // silent unverified tap on the closed backend.
        const verify: OpenServerVerify = params.verify;
        let vr: OpenServerVerifiedResult;
        try {
          vr = await openServerVerifiedTap(
            registry,
            device,
            params.x,
            params.y,
            clickCount,
            verify
          );
        } catch (err) {
          recordIncident(device.id, {
            tool: "gesture-tap",
            code: "timeout",
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        if (vr.outcome === "tapped") {
          if (vr.changed) {
            clearIncident(device.id);
          } else {
            // Landed but moved nothing — a no-effect tap the caller asked to
            // verify counts as a failure for the incident (part B).
            recordIncident(device.id, {
              tool: "gesture-tap",
              code: "no_effect",
              message: "verified tap landed but the screen did not change",
            });
          }
          return {
            tapped: true,
            timestampMs,
            verified: true,
            resolvedBounds: vr.resolvedBounds,
            version: vr.version,
            verifyMs: vr.verifyMs,
            ...(vr.actionOutcome ? { outcome: vr.actionOutcome } : {}),
          };
        }
        const verifyCode =
          vr.outcome === "not_found"
            ? "verify_not_found"
            : vr.outcome === "ambiguous"
              ? "verify_ambiguous"
              : "verify_mismatch";
        recordIncident(device.id, {
          tool: "gesture-tap",
          code: verifyCode,
          message: `verify refused: ${verifyCode}`,
          ...(vr.label !== undefined ? { label: vr.label } : {}),
        });
        return {
          tapped: false,
          timestampMs,
          verified: false,
          verifyCode,
          version: vr.version,
          verifyMs: vr.verifyMs,
          ...(vr.resolvedBounds ? { resolvedBounds: vr.resolvedBounds } : {}),
          ...(vr.candidates ? { candidates: vr.candidates } : {}),
          ...(vr.requestedPx ? { requestedPx: vr.requestedPx } : {}),
          ...(vr.label !== undefined ? { mismatchLabel: vr.label } : {}),
        };
      } else if (shouldUseOpenServer(device)) {
        try {
          // Default (screen-graph off): plain `tap` RPC, pre-merge semantics — no
          // `outcome` request leaves the host, so `runAction` is the pass-through
          // and no per-tap `settleAfterAction` wait is paid. The +800–1000ms
          // settle only belongs when the graph is being built/recorded, which is
          // exactly what `screenGraphRecordingEnabled()` gates (the `screen-graph`
          // flag, or the bench's `ARGENT_SG_RECORD` record-only mode). `outcome`
          // stays optional on the result and is absent here.
          if (!screenGraphRecordingEnabled()) {
            await openServerTap(registry, device, params.x, params.y, clickCount);
            clearIncident(device.id);
            return { tapped: true, timestampMs };
          }
          const outcome = await openServerTapWithOutcome(
            registry,
            device,
            params.x,
            params.y,
            clickCount
          );
          clearIncident(device.id);
          return { tapped: true, timestampMs, outcome };
        } catch (err) {
          console.debug(
            `[gesture-tap] open-device-server failed, falling back to simulator-server: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          const ref = simulatorServerRef(device);
          api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
        }
      } else {
        api = services.simulatorServer as SimulatorServerApi;
      }
      for (let i = 1; i <= clickCount; i++) {
        if (i > 1) await sleep(MULTI_TAP_GAP_MS);
        await sendCommand(api, {
          cmd: "touch",
          type: "Down",
          x: params.x,
          y: params.y,
          second_x: null,
          second_y: null,
        });
        await sleep(TAP_HOLD_MS);
        await sendCommand(api, {
          cmd: "touch",
          type: "Up",
          x: params.x,
          y: params.y,
          second_x: null,
          second_y: null,
        });
      }
      return { tapped: true, timestampMs };
    },
  };
}
