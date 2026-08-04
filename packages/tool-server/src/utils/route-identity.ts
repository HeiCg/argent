import type { Registry, ToolContext } from "@argent/registry";
import { invokeSubTool } from "./sub-invoke";
import { sleepOrAbort } from "./timing";
import { discoverMetro, type CDPTarget, type MetroInfo } from "./debugger/discovery";
import { listIosSimulators } from "./ios-devices";
import { adbShell } from "./adb";

/**
 * React Native route identity — a stable answer to "which screen is this?".
 *
 * Every other screen check argent has proxies identity through one element of
 * the UI tree, and an element is a weak proxy: a shared header matches on two
 * screens, a positional id encodes how many siblings exist, and during a push
 * or modal presentation source and destination are in the tree together, so a
 * destination landmark matches while the destination is still animating in.
 * Worse, the vocabulary of the tree is source-dependent — iOS `describe`
 * prefers the ax-service and falls back to native-devtools when the AX read
 * comes back empty, flipping labels to testIDs mid-session.
 *
 * The focused React Navigation route path has none of that. It is read from
 * the app's own navigation state, so it is independent of the tree source, of
 * content (`/user/alice` and `/user/bob` share a route), and of locale. One
 * route names one screen.
 *
 * We read it the black-box way argent already uses for the RN component tree:
 * walk the fiber tree via `__REACT_DEVTOOLS_GLOBAL_HOOK__` and collect the
 * focused `route`/`navigation` prop pairs. No app cooperation is needed — the
 * app does not have to export its `navigationRef`. Only debuggable RN apps
 * served by Metro qualify; a release build, a fully native app, or a chromium
 * app has no reader, and callers fall back to element checks.
 *
 * Two limits, both accepted and both load-bearing for callers:
 *
 * 1. A native overlay ABOVE an RN screen (a system permission alert, a share
 *    sheet, an RN `<Modal>`) does not change the focused route, so the probe
 *    reports the screen beneath it. Route identity answers "which screen",
 *    never "is anything covering it".
 * 2. Navigation state commits when the navigator commits, which is BEFORE the
 *    transition finishes animating. Route identity is therefore not a
 *    readiness signal either — pair it with one.
 */

/** The focused navigation route path of the current screen, read at runtime. */
export interface RouteContext {
  /** Focused route names outermost→innermost, e.g. ["HomeTab", "Profile"]. */
  path: string[];
  /** The innermost (leaf) focused route name — the screen the user is looking at. */
  name: string;
  /** The leaf route's params (dynamic-segment values), or null. Data, not identity. */
  params: Record<string, unknown> | null;
}

/**
 * JS evaluated in the app's Hermes runtime (via debugger-evaluate). Walks the
 * React fiber tree, gathers every fiber carrying a `route.name` +
 * `navigation.isFocused()` prop pair (React Navigation's screen wrappers), keeps
 * the focused ones, and returns them ordered outermost→innermost by fiber
 * depth. Self-contained (no closures over TS scope), defensive (never throws
 * out), and bounded (fiber-count cap) so it can't hang navigation. Returns a
 * JSON string — debugger-evaluate serializes by value, and a plain string is
 * always safe (RN route/navigation objects are cyclic and would fail to
 * serialize).
 */
export const ROUTE_PROBE_EXPRESSION = `(() => {
  try {
    var g = typeof globalThis !== "undefined" ? globalThis : global;
    var hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || typeof hook.getFiberRoots !== "function") {
      return JSON.stringify({ ok: false, reason: "no-devtools-hook" });
    }
    var rendererIds = [];
    try {
      if (hook.renderers && typeof hook.renderers.keys === "function") {
        var it = hook.renderers.keys();
        for (var step = it.next(); !step.done; step = it.next()) rendererIds.push(step.value);
      }
    } catch (e) {}
    if (rendererIds.length === 0) rendererIds = [1];
    var roots = [];
    for (var i = 0; i < rendererIds.length; i++) {
      try {
        hook.getFiberRoots(rendererIds[i]).forEach(function (r) { roots.push(r); });
      } catch (e) {}
    }
    if (roots.length === 0) return JSON.stringify({ ok: false, reason: "no-fiber-roots" });
    var byKey = {};
    var stack = [];
    for (var j = 0; j < roots.length; j++) {
      if (roots[j] && roots[j].current) stack.push({ f: roots[j].current, d: 0 });
    }
    var visited = 0;
    while (stack.length) {
      var top = stack.pop();
      var fiber = top.f;
      var depth = top.d;
      visited++;
      if (visited > 300000) break;
      var props = fiber.memoizedProps;
      if (
        props && props.route && typeof props.route.name === "string" &&
        props.navigation && typeof props.navigation.isFocused === "function"
      ) {
        var key = props.route.key || props.route.name;
        var entry = byKey[key];
        if (!entry) {
          var focused = false;
          try { focused = props.navigation.isFocused(); } catch (e) {}
          var params = null;
          try {
            var raw = props.route.params;
            if (raw && typeof raw === "object") {
              params = {};
              var ks = Object.keys(raw);
              for (var k = 0; k < ks.length && k < 20; k++) {
                var v = raw[ks[k]];
                var t = typeof v;
                params[ks[k]] =
                  t === "string" || t === "number" || t === "boolean" || v === null
                    ? v : "<" + t + ">";
              }
            }
          } catch (e) {}
          byKey[key] = { name: props.route.name, depth: depth, params: params, focused: focused };
        } else if (depth < entry.depth) {
          entry.depth = depth;
        }
      }
      if (fiber.sibling) stack.push({ f: fiber.sibling, d: depth });
      if (fiber.child) stack.push({ f: fiber.child, d: depth + 1 });
    }
    var focused = [];
    for (var key2 in byKey) { if (byKey[key2].focused) focused.push(byKey[key2]); }
    focused.sort(function (a, b) { return a.depth - b.depth; });
    if (focused.length === 0) return JSON.stringify({ ok: false, reason: "no-focused-route" });
    var leaf = focused[focused.length - 1];
    return JSON.stringify({
      ok: true,
      path: focused.map(function (r) { return r.name; }),
      name: leaf.name,
      params: leaf.params,
    });
  } catch (e) {
    return JSON.stringify({ ok: false, reason: String((e && e.message) || e) });
  }
})()`;

/** A route reader: one probe of the currently focused route, null on any failure. */
export type RouteReader = () => Promise<RouteContext | null>;

// Android's RN inspector registers devices with Metro as
// "<Build.MODEL> - <release> - API <sdk>"; iOS registers a bare device name.
// The suffix is the only platform signal the target list carries — the names
// themselves are runtime-reported and need not match simctl/adb labels.
const ANDROID_DEVICE_NAME_PATTERN = / - API \d+$/;

/**
 * The name OUR device would register with Metro under: an iOS simulator
 * registers as its simctl device name ("iPhone 16 Pro"); Android registers
 * "<Build.MODEL> - …" (prefix-matched by the caller). Best-effort — undefined
 * (no strict pinning possible) when the lookup fails or the platform has no
 * stable convention (vega).
 */
async function metroDeviceName(
  udid: string,
  platform: "ios" | "android" | "vega"
): Promise<string | undefined> {
  try {
    if (platform === "ios") {
      const sims = await listIosSimulators();
      return sims.find((sim) => sim.udid === udid)?.name;
    }
    if (platform === "android") {
      const model = (await adbShell(udid, "getprop ro.product.model")).trim();
      return model === "" ? undefined : model;
    }
  } catch {
    // Lookup tooling unavailable — the caller falls back to the platform
    // heuristic below.
  }
  return undefined;
}

function targetNameMatches(
  target: CDPTarget,
  platform: "ios" | "android" | "vega",
  deviceName: string
): boolean {
  const name = target.deviceName ?? "";
  if (platform === "android") return name === deviceName || name.startsWith(`${deviceName} - `);
  return name === deviceName;
}

/**
 * The Metro logicalDeviceId of OUR device running `bundleId`, from a
 * /json/list target dump — or undefined when no target can be pinned to the
 * device (never guess: reading a foreign runtime's route would fingerprint
 * every screen of the app under test with another device's state — a physical
 * phone on the LAN sharing the dev Metro is a routine setup).
 *
 * Needed because debugger-connect matches targets by logicalDeviceId, which a
 * sim udid / adb serial never equals. When `deviceName` is known the match is
 * strict: only a target registered under that name counts, and zero matches
 * means OUR device has no target (an unloaded dev-client, a foreign device's
 * target sitting on the list). Only when the name is unknown does the
 * platform-shaped-name heuristic run, and only a unique candidate wins.
 * Legacy-inspector targets (no logicalDeviceId) are always skipped — they
 * cannot be singled out of a shared Metro.
 */
export function pickLogicalDeviceId(
  targets: CDPTarget[],
  bundleId: string,
  platform: "ios" | "android" | "vega",
  deviceName?: string
): string | undefined {
  const wanted = bundleId.toLowerCase();
  const ids = new Set<string>();
  for (const target of targets) {
    const logicalId = target.reactNative?.logicalDeviceId;
    if (!logicalId) continue;
    const appId = target.appId?.toLowerCase() ?? "";
    // Older RN omits appId; its titles read "<bundleId> (<device>)".
    const ownsApp = appId !== "" ? appId === wanted : target.title.toLowerCase().includes(wanted);
    if (!ownsApp) continue;
    if (deviceName !== undefined) {
      if (!targetNameMatches(target, platform, deviceName)) continue;
    } else {
      const androidName = ANDROID_DEVICE_NAME_PATTERN.test(target.deviceName ?? "");
      if ((platform === "android") !== androidName) continue;
    }
    ids.add(logicalId);
  }
  if (ids.size !== 1) return undefined;
  return ids.values().next().value;
}

/**
 * Attach a JS-runtime debugger to a Metro-served RN app and return a route
 * reader ({@link RouteReader}). A failure to connect (Metro down, not an RN
 * app, a release build with no inspector) is expected and non-fatal: return
 * undefined so the caller falls back to landmarks. Best-effort — never throws.
 *
 * `discover` is injectable for tests; production always reads the real Metro.
 */
export async function connectRouteReader(
  registry: Registry,
  ctx: ToolContext | undefined,
  opts: {
    udid: string;
    bundleId: string;
    metroPort: number;
    platform: "ios" | "android" | "vega";
    /** Metro registration name of the device; resolved from udid when omitted. */
    deviceName?: string;
  },
  discover: (port: number) => Promise<MetroInfo> = discoverMetro
): Promise<RouteReader | undefined> {
  // Resolve the target ourselves when possible (see pickLogicalDeviceId).
  let connectId = opts.udid;
  let matchedByAppId = false;
  try {
    const metro = await discover(opts.metroPort);
    // Name lookup only once the app is known to be served here — it shells
    // simctl/adb, which is wasted on the (common) no-Metro / foreign-Metro
    // paths.
    const served = metro.targets.some(
      (t) =>
        t.reactNative?.logicalDeviceId !== undefined &&
        ((t.appId ?? "").toLowerCase() === opts.bundleId.toLowerCase() ||
          ((t.appId ?? "") === "" && t.title.toLowerCase().includes(opts.bundleId.toLowerCase())))
    );
    if (served) {
      const deviceName = opts.deviceName ?? (await metroDeviceName(opts.udid, opts.platform));
      const logicalId = pickLogicalDeviceId(
        metro.targets,
        opts.bundleId,
        opts.platform,
        deviceName
      );
      if (logicalId !== undefined) {
        connectId = logicalId;
        matchedByAppId = true;
      } else if (deviceName !== undefined) {
        // The app is served on this Metro but no target is pinned to OUR
        // device (its dev-client hasn't loaded the app, or only foreign
        // devices are attached). The udid fallback below would land on a
        // foreign device's runtime — refuse instead.
        return undefined;
      }
    }
  } catch {
    // Metro unreachable or unparseable — let the connect below be the judge.
  }
  let deviceId: string;
  try {
    const res = await invokeSubTool<{
      logicalDeviceId?: string;
      connected?: boolean;
      appName?: string;
    }>(registry, ctx, "debugger-connect", { port: opts.metroPort, device_id: connectId });
    if (!res.connected) return undefined;
    // Guard the udid-fallback path against binding to a FOREIGN app's Metro:
    // an unmatched udid makes debugger-connect fall back to whichever single
    // app Metro serves on this port. If that is a different app (another
    // project's dev server on 8081), its route would fingerprint EVERY screen
    // of the app under test — strictly worse than landmarks. The RN inspector
    // titles a target "<bundleId> (<device>)", so require the connected app to
    // name our bundle; when the title is unrecognizable (empty), proceed
    // rather than over-reject. A target resolved by appId already proved
    // ownership.
    const appName = res.appName ?? "";
    if (
      !matchedByAppId &&
      appName &&
      !appName.toLowerCase().includes(opts.bundleId.toLowerCase())
    ) {
      return undefined;
    }
    // Subsequent debugger-* calls must be pinned to the session's logical id.
    deviceId = res.logicalDeviceId ?? connectId;
  } catch {
    return undefined;
  }
  return async () => {
    try {
      const res = await invokeSubTool<{ result: unknown }>(registry, ctx, "debugger-evaluate", {
        port: opts.metroPort,
        device_id: deviceId,
        expression: ROUTE_PROBE_EXPRESSION,
      });
      return parseRouteResult(res.result);
    } catch {
      // A transient eval failure (runtime busy, reload in flight) must not fail
      // the observation — the caller falls back to landmarks for this read.
      return null;
    }
  };
}

/** Parse the probe's JSON-string result into a RouteContext, or null on any failure. */
export function parseRouteResult(raw: unknown): RouteContext | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (rec.ok !== true) return null;
  const path = rec.path;
  const name = rec.name;
  if (!Array.isArray(path) || path.length === 0 || typeof name !== "string" || name.length === 0) {
    return null;
  }
  const cleanPath = path.filter((p): p is string => typeof p === "string" && p.length > 0);
  if (cleanPath.length === 0) return null;
  const params =
    rec.params && typeof rec.params === "object" && !Array.isArray(rec.params)
      ? (rec.params as Record<string, unknown>)
      : null;
  return { path: cleanPath, name, params };
}

/**
 * The fingerprint string a screen records: the focused route PATH joined with
 * ">" ("HomeTab>Profile"). Params are deliberately excluded so every instance
 * of a parameterized screen shares one fingerprint.
 */
export function routeFingerprint(route: RouteContext): string {
  return route.path.join(">");
}

// The route state lags the visual transition by a beat; a single null read
// right after a tap does not mean "no route".
const ROUTE_PROBE_ATTEMPTS = 3;
const ROUTE_PROBE_RETRY_MS = 250;

/**
 * Probe the focused route, retrying a null read (mid-transition, runtime busy)
 * a few times before conceding. Returns null when every attempt failed or the
 * signal aborted — callers re-check the signal themselves.
 */
export async function probeRoute(
  reader: RouteReader,
  opts?: { attempts?: number; retryMs?: number; signal?: AbortSignal }
): Promise<RouteContext | null> {
  const attempts = opts?.attempts ?? ROUTE_PROBE_ATTEMPTS;
  const retryMs = opts?.retryMs ?? ROUTE_PROBE_RETRY_MS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts?.signal?.aborted) return null;
    const route = await reader();
    if (route !== null) return route;
    if (attempt < attempts - 1 && !(await sleepOrAbort(retryMs, opts?.signal))) return null;
  }
  return null;
}

/** Verdict of {@link verifyRouteFingerprint}. */
export interface RouteVerifyOutcome {
  /** True only when a probe read the expected fingerprint before the deadline. */
  ok: boolean;
  /** The run was cancelled mid-poll — not a verdict about the app. */
  aborted?: boolean;
  /**
   * Fingerprint of the last SUCCESSFUL probe. Absent means every probe came
   * back null (the reader died, the screen is native, or the transition never
   * settled) — the caller must not report the app as being on a screen it
   * never actually read.
   */
  observedRoute?: string;
}

/**
 * Poll the route reader until the focused route's fingerprint equals
 * `expected` or the deadline passes. `timeoutMs: 0` probes exactly once — the
 * immediate "am I where I claim to be" check.
 *
 * A null probe (transition mid-flight, runtime busy, reader lost) keeps
 * polling rather than deciding: the distinction between "read a different
 * screen" and "read nothing" is the whole diagnostic value here, so it is
 * carried out in {@link RouteVerifyOutcome.observedRoute} rather than
 * collapsed into a boolean.
 */
export async function verifyRouteFingerprint(
  readRoute: RouteReader,
  expected: string,
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal
): Promise<RouteVerifyOutcome> {
  const deadline = Date.now() + timeoutMs;
  let observedRoute: string | undefined;
  for (;;) {
    if (signal?.aborted) return { ok: false, aborted: true };
    const route = await readRoute();
    if (route !== null) {
      observedRoute = routeFingerprint(route);
      if (observedRoute === expected) return { ok: true, observedRoute };
    }
    if (signal?.aborted) return { ok: false, aborted: true };
    if (Date.now() >= deadline) {
      return { ok: false, ...(observedRoute !== undefined ? { observedRoute } : {}) };
    }
    if (!(await sleepOrAbort(pollMs, signal))) return { ok: false, aborted: true };
  }
}
