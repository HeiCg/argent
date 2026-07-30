import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  isInjectableBundleId,
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
  type NativeDevtoolsAppState,
  type NativeDevtoolsInitFailedResult,
} from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { ensureDeps } from "../../utils/check-deps";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z.string().describe("Bundle ID of the app to check (e.g. com.example.MyApp)"),
});

type Params = z.infer<typeof zodSchema>;
type Result =
  | NativeDevtoolsInitFailedResult
  | {
      envSetup: boolean;
      appRunning: boolean;
      connected: boolean;
      requiresRestart: boolean;
      /**
       * Omitted for a non-injectable app: `injectable: false` is terminal on its
       * own, and no connection diagnosis is run for a process that can never
       * load the dylib.
       */
      state?: NativeDevtoolsAppState;
      nextLaunchWillBeInjected: boolean;
      injectable: boolean;
    };

export const nativeDevtoolsStatusTool: ToolDefinition<Params, Result> = {
  id: "native-devtools-status",
  interaction: {
    startedMsg: ({ params }) => `Checking native inspection for ${params.bundleId}`,
    completedMsg: ({ params }) => `Checked native inspection for ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to check native inspection for ${params.bundleId}: ${failureSignal.error_code}`,
  },
  capability: { apple: { simulator: true, device: true }, appleRemote: { simulator: true } },
  // The "injectable is false" recovery sentence inlines NON_INJECTABLE_RECOVERY
  // verbatim: the description must stay a plain literal so scripts/extract-tools.mjs
  // can read it statically for the spidershield scan. The verbatim match is pinned
  // by native-devtools-status.test.ts.
  description: `Check whether native devtools are connected to a specific app and whether the next launch is prepared for injection.
Use when you need to verify native devtools readiness before calling native-full-hierarchy, native-describe-screen, or native-network-logs.

Returns { envSetup, appRunning, connected, requiresRestart, state, nextLaunchWillBeInjected, injectable }:
- envSetup: DYLD_INSERT_LIBRARIES is configured in the simulator's launchd environment
- appRunning: the target bundle currently has a running UIKit process on the simulator
- connected: the dylib is active in the current running process for this bundleId
- requiresRestart: the app is already running and needs a fresh process — its current one is not injected, or could not be inspected to prove otherwise. Always false for a non-injectable app, and false when state is unregistered, where a relaunch cannot help.
- state: why devtools are or aren't live, measured from the running process. "connected"; "not_running"; "stale_process" (the process was launched before argent's instrumentation was in place, so restart-app fixes it); "unregistered" (the process IS injected and pointed at this simulator's devtools endpoint yet the service never registered it, so restarting the app cannot help); "indeterminate" (the process could not be inspected). Omitted when injectable is false, which is terminal on its own.
- nextLaunchWillBeInjected: if you launch this bundle now, native devtools env setup is already in place (always false for a non-injectable app)
- injectable: whether native devtools can ever be injected into this app. Apple system apps (bundle ids under com.apple.) are platform binaries with library validation, so the dylib can never load into them.

Call this before using app-scoped native hierarchy tools or native-network-logs.
If injectable is false: this is a TERMINAL state — the app can never be injected. Do NOT restart/retry. Use the standard \`describe\` tool (its accessibility path reads the screen without injection) or \`screenshot\` (then interact by coordinate). Do not fall back to the native-devtools feature tools (native-describe-screen, native-find-views, native-full-hierarchy, native-network-logs, native-view-at-point, native-user-interactable-view-at-point) — they run the same injection precheck and fail with the same non-injectable error.
If appRunning is false and nextLaunchWillBeInjected is true: use launch-app normally.
If requiresRestart is true: call restart-app, then proceed with the native feature.
If state is unregistered: do NOT restart the app again — it already launched under the terms a restart would recreate. Restart the tool-server (\`argent server stop && argent server start\`), then retry.
Returns { status: "init_failed", message, attempts } instead when the simulator's native-devtools environment failed to initialize.
Fails if the simulator server is not running for the given UDID.`,
  zodSchema,
  services: (params) => ({
    nativeDevtools: nativeDevtoolsRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    await ensureDeps(device.platform === "ios-remote" ? ["sim-remote"] : ["xcrun"]);

    const api = services.nativeDevtools as NativeDevtoolsApi;

    // Terminal case first, mirroring precheckNativeDevtools: non-injectable
    // apps (Apple system apps) can never load the dylib no matter how many
    // times they relaunch, and injectability is a static property of the
    // bundle id — so a broken env must not mask this terminal state behind the
    // precheck's init_failed block, whose "re-boot the simulator" guidance can
    // never make a system app injectable. Report a terminal state so agents
    // stop looping restart-app → retry: no restart is required and the next
    // launch will not be injected either. appRunning/connected are still
    // measured and envSetup is read from the cached latch — unlike the
    // injectable path below, there is no point running the precheck's env
    // init or reverifying the env for an app that can never inject.
    if (!isInjectableBundleId(params.bundleId)) {
      let appRunning: boolean;
      try {
        appRunning = await api.isAppRunning(params.bundleId);
      } catch (err) {
        // The app-running probe (a simctl spawn) failed — typically a sim that
        // is shut down or unreachable, exactly where env init fails too. Fall
        // back to the precheck so a broken sim still surfaces the structured
        // init_failed guidance (re-booting IS corrective for a dead sim)
        // instead of a raw subprocess error; with a healthy env, surface the
        // probe failure itself.
        const blocked = await precheckNativeDevtools(api, params.udid);
        if (blocked) return blocked;
        throw err;
      }
      return {
        envSetup: api.isEnvSetup(),
        appRunning,
        connected: api.isConnected(params.bundleId),
        requiresRestart: false,
        nextLaunchWillBeInjected: false,
        injectable: false,
      };
    }

    const blocked = await precheckNativeDevtools(api, params.udid);
    if (blocked) return blocked;

    // Diagnoses the connection AND re-applies the launchd env on its way — an
    // out-of-band simulator reboot wipes DYLD_INSERT_LIBRARIES while
    // isEnvSetup() still reports the stale `true`, so the reported envSetup /
    // nextLaunchWillBeInjected must be read after it. Idempotent when correct.
    const state = await api
      .appConnectionState(params.bundleId)
      .catch(() => "indeterminate" as const);
    const connected = state === "connected";

    // Running-ness comes out of the same measurement rather than a second
    // `launchctl list`: four of the five states are only reachable for a live
    // process, and `not_running` IS the absence of one. Reading it separately
    // cost an extra simctl round-trip and — because `appConnectionState`
    // re-verifies the env first, putting seconds between the two snapshots —
    // let the two fields contradict each other, e.g. `appRunning: true` beside
    // `state: "not_running"`. Only `indeterminate` leaves running-ness genuinely
    // unanswered, so only it pays for its own probe.
    const appRunning =
      state === "indeterminate" ? await api.isAppRunning(params.bundleId) : state !== "not_running";
    const envSetup = api.isEnvSetup();

    return {
      envSetup,
      appRunning,
      connected,
      // Derived from the one state, so it can never disagree with it. An
      // `unregistered` process is the case where a relaunch provably changes
      // nothing; `not_running` needs a launch, not a restart of something that
      // isn't there. That leaves the two states a fresh process actually fixes
      // — `indeterminate` among them, since an uninspectable host (ios-remote)
      // can support no finer reading.
      requiresRestart: appRunning && (state === "stale_process" || state === "indeterminate"),
      state,
      nextLaunchWillBeInjected: envSetup,
      injectable: true,
    };
  },
};
