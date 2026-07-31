import type { DeviceInfo, Registry, ToolDependency } from "@argent/registry";
import { axServiceRef, AXServiceApi } from "../../../../blueprints/ax-service";
import {
  buildAppStateMessage,
  isInjectableBundleId,
  NON_INJECTABLE_NATIVE_WARNING,
  nativeDevtoolsRef,
  NativeDevtoolsApi,
} from "../../../../blueprints/native-devtools";
import { resolveNativeTargetApp } from "../../../../utils/native-target-app";
import { isTvOsSimulator } from "../../../../utils/ios-devices";
import { parseNativeDescribeScreenResult } from "../../../native-devtools/native-describe-contract";
import { DescribeTreeData, parseDescribeResult, type DescribeNode } from "../../contract";
import { adaptAXDescribeToDescribeResult } from "./ios-ax-adapter";
import { adaptNativeDescribeToDescribeResult } from "./ios-native-adapter";

const DEGRADED_HINT =
  "This simulator was not booted through argent — system dialogs and native modals may not appear. You MUST call boot-device with force=true now to restart the simulator and apply full accessibility settings before continuing.";

// The ios-remote (sim-remote) path needs the TCP-transport ax-service binary and
// dylibs, which are shipped/built separately and can be absent in a local or old
// build. When they are, the ax-service factory throws a "TCP-transport ... not
// found" error that has nothing to do with the simulator's boot state — so
// steer clear of DEGRADED_HINT (which tells the agent to force-reboot, a dead
// end here) and surface the resolver's actionable message verbatim instead.
function tcpArtifactHint(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /TCP-transport (?:binary|dylib) not found/.test(message) ? message : undefined;
}

// tvOS classifies as platform "ios" by UDID shape. The `describe` tool routes
// TV targets to the focus-driven `describeTv` before this iOS branch runs, so
// the short-circuit below is only reached by internal callers that invoke
// `describeIos` directly (preview / match-element-frame). The iOS ax-service
// can't read the Apple TV focus engine — surface the right tool instead of
// spawning a daemon that times out and degrades with the misleading
// boot-device hint.
const TVOS_HINT =
  "This is an Apple TV (tvOS) simulator, which the iOS accessibility service does not support. " +
  "Use the `describe` tool to read the focused and focusable elements, `tv-remote` " +
  "(up/down/left/right/select/back/menu/home) to move focus, and `keyboard` to type. " +
  "See the argent-tv-interact skill.";

// Apple system apps (`com.apple.*`) can never load argent's injected dylib, so
// the native-devtools fallback can't read their view hierarchy and restarting
// them would never help — returning `should_restart` here puts the agent in an
// unbounded restart-app → describe loop. This hint is reached only once
// `describe`'s own ax-service path has already returned empty, so it leads with
// `screenshot` (re-recommending `describe` would be circular) and shares the
// `native-*` dead-end warning verbatim with the precheck throw and
// `native-devtools-status`.
const NON_INJECTABLE_HINT =
  "This is an Apple system app (com.apple.*), which cannot load argent's native-devtools " +
  "instrumentation — the native view hierarchy is unavailable and restarting the app will NOT " +
  "help. Take a `screenshot` to see the screen and interact by coordinate. " +
  NON_INJECTABLE_NATIVE_WARNING;

function emptyTree(): DescribeNode {
  return parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [],
  });
}

export interface DescribeIosParams {
  bundleId?: string;
}

export interface DescribeIosOptions {
  // Pre-resolved tvOS verdict, passed by poll/retry callers so the hot path
  // skips re-shelling `xcrun` each iteration. Omitted callers probe once.
  isTvOs?: boolean;
}

// describe on iOS resolves the ax-service via Registry; the blueprint factory
// shells out to `xcrun simctl spawn` (spawnDaemon).
// Without xcrun on PATH the spawn ENOENTs deep inside the factory and the
// HTTP layer returns a 500 with a raw "spawn xcrun ENOENT" message — declare
// the dep here so the preflight emits a 424 with the install hint instead,
// matching launch-app / restart-app / open-url / reinstall-app.
export const iosRequires: ToolDependency[] = ["xcrun"];

export async function describeIos(
  registry: Registry,
  device: DeviceInfo,
  params: DescribeIosParams,
  options: DescribeIosOptions = {}
): Promise<DescribeTreeData> {
  // tvOS short-circuit: the focus-engine accessibility tree is served by the
  // tv-control daemons, not the iOS ax-service. Without this, describe would
  // try to spawn ax-service inside the Apple TV sim, time out on the daemon
  // connection, and degrade with the wrong (boot-device) hint.
  const isTvOs = options.isTvOs ?? (await isTvOsSimulator(device.id));
  if (isTvOs) {
    return { tree: emptyTree(), source: "ax-service", hint: TVOS_HINT };
  }

  let tree: DescribeNode;
  let hint: string | undefined;

  try {
    const axRef = axServiceRef(device);
    const axApi = await registry.resolveService<AXServiceApi>(axRef.urn, axRef.options);
    const response = await axApi.describe();
    tree = adaptAXDescribeToDescribeResult(response);
    hint = axApi.degraded ? DEGRADED_HINT : undefined;
  } catch (err) {
    // ax-service failed to start or timed out — treat as degraded with an
    // empty tree so we still attempt the native-devtools fallback below. A
    // missing TCP-transport artifact (ios-remote) is a config error, not a boot
    // state one: surface its actionable message instead of the reboot hint.
    tree = emptyTree();
    hint = tcpArtifactHint(err) ?? DEGRADED_HINT;
  }

  if (tree.children.length > 0) {
    return { tree, source: "ax-service", hint };
  }

  // A non-injectable system app can never connect, and the launchd env carrying
  // the bootstrap dylib is simulator-wide — so its process inherits the very
  // tokens the measurement reads and scores as injected. Which unconnected state
  // that lands on is just its age against this service's listener:
  // `stale_process` (already running when the service bound) with a restart-app
  // remedy, or `unregistered` (launched after) with a tool-server one. Both are
  // wrong for an app no restart of anything can help, and the first rebuilds the
  // restart-app → describe loop. Return the (empty) AX result with the terminal
  // screenshot hint instead.
  // The gate sits BEFORE the native-devtools fallback: injectability is a
  // static property of the explicit bundle id, so the terminal hint must not
  // depend on service resolution succeeding (a downed ios-remote tunnel or a
  // dispose race would otherwise swallow it into the generic catch below), and
  // no native-devtools service is spawned for an app that can never inject.
  // Auto-resolution (no bundleId) needs no gate — it only ever yields a
  // connected, hence injected, app. If the ax-service was degraded (sim not
  // booted through argent, so `hint` is DEGRADED_HINT), keep that re-boot
  // guidance: a proper boot may let the ax-service read this system app's tree
  // (Settings et al. expose a full AX tree), at which point `describe` — not a
  // screenshot — is the right tool. On a healthy sim `hint` is undefined and
  // this falls back to the terminal non-injectable hint.
  if (params.bundleId && !isInjectableBundleId(params.bundleId)) {
    return { tree, source: "ax-service", hint: hint ?? NON_INJECTABLE_HINT };
  }

  // AX returned zero elements (or failed entirely) — attempt native-devtools fallback
  try {
    const ndRef = nativeDevtoolsRef(device);
    const nativeApi = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);

    const target = await resolveNativeTargetApp(nativeApi, params.bundleId);

    // A rejection here (the env re-apply this runs first fails on a sim that
    // went away mid-call) must not fall through to the outer catch: that path
    // returns the empty tree with no hint at all, so the read looks merely
    // empty rather than unexplained. Degrade to the state that says exactly
    // that, matching every other consumer of this call.
    const state = await nativeApi
      .appConnectionState(target.bundleId)
      .catch(() => "indeterminate" as const);
    if (state !== "connected") {
      // The diagnosis rides out as a hint for every state, because `hint` is the
      // only channel describe has for prose: `should_restart` reaches the agent
      // as a bare JSON boolean, and the one place it is rendered as English —
      // await-ui-element's timeout note — spells it "call restart-app and
      // retry", the loop instruction with no escape. `indeterminate` is where
      // that costs the most: its message is the one carrying "do not keep
      // restarting the app", and it is the only state a *running* app can reach
      // on ios-remote, whose app processes live on the orchestrator and so
      // cannot be inspected — without the hint that path has no exit at all.
      //
      // `should_restart` itself is the agent-facing instruction to relaunch, so
      // it stays limited to the states a relaunch actually fixes. An
      // `unregistered` process already launched under the terms a restart would
      // recreate, and a `connecting` one is mid-handshake, which exec is what
      // begins — flagging either would rebuild the restart-app → describe loop
      // this gate exists to avoid.
      const diagnosis = buildAppStateMessage(target.bundleId, state);
      const merged = hint ? `${hint} ${diagnosis}` : diagnosis;
      return state === "unregistered" || state === "connecting"
        ? { tree, source: "ax-service", hint: merged }
        : { tree, source: "ax-service", should_restart: true, hint: merged };
    }

    const rawResult = (await nativeApi.queryViewHierarchy(
      target.bundleId,
      "ViewHierarchy.describeScreen"
    )) as { screenFrame?: unknown; elements?: unknown[]; error?: string };

    if (rawResult.error) {
      return { tree, source: "ax-service", hint };
    }

    const parsed = parseNativeDescribeScreenResult(rawResult);
    const nativeTree = adaptNativeDescribeToDescribeResult(parsed);
    return { tree: nativeTree, source: "native-devtools", hint };
  } catch {
    // Native devtools unavailable or no connected app — return the empty AX result
    return { tree, source: "ax-service", hint };
  }
}
