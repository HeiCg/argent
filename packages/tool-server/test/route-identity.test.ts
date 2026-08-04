import { describe, expect, it } from "vitest";
import type { Registry } from "@argent/registry";
import type { CDPTarget, MetroInfo } from "../src/utils/debugger/discovery";
import {
  connectRouteReader,
  parseRouteResult,
  pickLogicalDeviceId,
  probeRoute,
  routeFingerprint,
  verifyRouteFingerprint,
  type RouteContext,
  type RouteReader,
} from "../src/utils/route-identity";

const route = (path: string[], params: Record<string, unknown> | null = null): RouteContext => ({
  path,
  name: path[path.length - 1]!,
  params,
});

describe("routeFingerprint", () => {
  it("keys identity on the route PATH, ignoring params (the dynamic-screen collapse)", () => {
    const alice = route(["HomeTab", "Profile"], { name: "alice" });
    const bob = route(["HomeTab", "Profile"], { name: "bob" });
    expect(routeFingerprint(alice)).toBe("HomeTab>Profile");
    expect(routeFingerprint(alice)).toBe(routeFingerprint(bob));
  });

  it("distinguishes different route paths", () => {
    expect(routeFingerprint(route(["HomeTab", "Profile"]))).not.toBe(
      routeFingerprint(route(["SearchTab", "Profile"]))
    );
    expect(routeFingerprint(route(["HomeTab", "Feed"]))).not.toBe(
      routeFingerprint(route(["HomeTab", "Profile"]))
    );
  });
});

describe("parseRouteResult", () => {
  it("parses a successful probe payload (string or object)", () => {
    const payload = { ok: true, path: ["HomeTab", "Profile"], name: "Profile", params: { id: 7 } };
    const expected = { path: ["HomeTab", "Profile"], name: "Profile", params: { id: 7 } };
    expect(parseRouteResult(JSON.stringify(payload))).toEqual(expected);
    expect(parseRouteResult(payload)).toEqual(expected);
  });

  it("returns null for every failure shape", () => {
    expect(parseRouteResult(JSON.stringify({ ok: false, reason: "no-devtools-hook" }))).toBeNull();
    expect(parseRouteResult(JSON.stringify({ ok: true, path: [], name: "X" }))).toBeNull();
    expect(parseRouteResult(JSON.stringify({ ok: true, path: ["A"], name: "" }))).toBeNull();
    expect(parseRouteResult("not json")).toBeNull();
    expect(parseRouteResult(undefined)).toBeNull();
    expect(parseRouteResult(42)).toBeNull();
  });

  it("normalizes a non-object params to null and drops empty path segments", () => {
    expect(parseRouteResult({ ok: true, path: ["A", "", "B"], name: "B", params: "x" })).toEqual({
      path: ["A", "B"],
      name: "B",
      params: null,
    });
  });
});

/** Metro /json/list target shorthand. */
function target(opts: {
  logicalId?: string;
  appId?: string;
  title?: string;
  deviceName?: string;
}): CDPTarget {
  return {
    id: "t",
    title: opts.title ?? `${opts.appId ?? "app"} (${opts.deviceName ?? "device"})`,
    description: "React Native Bridge [C++ connection]",
    webSocketDebuggerUrl: "ws://localhost:8081/debugger",
    ...(opts.deviceName !== undefined ? { deviceName: opts.deviceName } : {}),
    ...(opts.appId !== undefined ? { appId: opts.appId } : {}),
    ...(opts.logicalId !== undefined ? { reactNative: { logicalDeviceId: opts.logicalId } } : {}),
  };
}

describe("pickLogicalDeviceId", () => {
  const APP = "com.example.app";
  // The routine RN-dev shape: one Metro serving the same app on an iOS sim
  // AND an Android emulator (plus per-device Reanimated runtime targets).
  const shared = [
    target({ logicalId: "android1", appId: APP, deviceName: "sdk_gphone64_arm64 - 14 - API 34" }),
    target({ logicalId: "android1", appId: APP, deviceName: "sdk_gphone64_arm64 - 14 - API 34" }),
    target({ logicalId: "ios1", appId: APP, deviceName: "iPhone 17 Pro" }),
    target({ logicalId: "ios1", appId: APP, deviceName: "iPhone 17 Pro" }),
  ];

  it("singles out the right platform's device on a Metro shared across platforms", () => {
    expect(pickLogicalDeviceId(shared, APP, "ios")).toBe("ios1");
    expect(pickLogicalDeviceId(shared, APP, "android")).toBe("android1");
  });

  it("ignores foreign apps and matches by title when appId is absent (older RN)", () => {
    const targets = [
      target({ logicalId: "other", appId: "com.other.app", deviceName: "iPhone 15" }),
      target({ logicalId: "ios1", title: `${APP} (iPhone 17 Pro)`, deviceName: "iPhone 17 Pro" }),
    ];
    expect(pickLogicalDeviceId(targets, APP, "ios")).toBe("ios1");
  });

  it("refuses to guess between two same-platform devices running the app", () => {
    const twoSims = [
      target({ logicalId: "ios1", appId: APP, deviceName: "iPhone 17 Pro" }),
      target({ logicalId: "ios2", appId: APP, deviceName: "iPhone 16e" }),
    ];
    expect(pickLogicalDeviceId(twoSims, APP, "ios")).toBeUndefined();
  });

  it("pins strictly by device name when known — a foreign phone on the LAN never matches", () => {
    // The live incident shape: our sim ("iPhone 16 Pro") has no target yet
    // (dev-client launcher up), while a physical iPhone 17 Pro on the LAN
    // serves the same app from the same Metro. The heuristic would pick the
    // phone; the name pin must refuse.
    const foreignOnly = [target({ logicalId: "phone1", appId: APP, deviceName: "iPhone 17 Pro" })];
    expect(pickLogicalDeviceId(foreignOnly, APP, "ios", "iPhone 16 Pro")).toBeUndefined();
    expect(pickLogicalDeviceId(foreignOnly, APP, "ios", "iPhone 17 Pro")).toBe("phone1");
  });

  it("matches Android names by model prefix (Metro appends release and API level)", () => {
    const emulator = [
      target({
        logicalId: "android1",
        appId: APP,
        deviceName: "sdk_gphone64_arm64 - 14 - API 34",
      }),
    ];
    expect(pickLogicalDeviceId(emulator, APP, "android", "sdk_gphone64_arm64")).toBe("android1");
    expect(pickLogicalDeviceId(emulator, APP, "android", "Pixel 7")).toBeUndefined();
  });

  it("skips legacy-inspector targets (no logicalDeviceId) and empty lists", () => {
    expect(pickLogicalDeviceId([target({ appId: APP })], APP, "ios")).toBeUndefined();
    expect(pickLogicalDeviceId([], APP, "ios")).toBeUndefined();
  });
});

describe("connectRouteReader", () => {
  // Fake registry answering the two debugger tools connectRouteReader calls.
  function reg(
    opts: { connect: Record<string, unknown> | Error; evalResult?: unknown },
    calls: { tool: string; args: Record<string, unknown> }[] = []
  ): Registry {
    return {
      invokeTool: async (id: string, args: Record<string, unknown>) => {
        calls.push({ tool: id, args });
        if (id === "debugger-connect") {
          if (opts.connect instanceof Error) throw opts.connect;
          return opts.connect;
        }
        if (id === "debugger-evaluate") return { result: opts.evalResult };
        return {};
      },
    } as unknown as Registry;
  }

  const args = {
    udid: "SIM",
    bundleId: "com.example.app",
    metroPort: 8081,
    platform: "ios" as const,
  };
  /** No Metro reachable — forces the udid-fallback connect path. */
  const noMetro = async (): Promise<MetroInfo> => {
    throw new Error("Metro at port 8081 is not running");
  };

  const sharedMetro = async (): Promise<MetroInfo> => ({
    port: 8081,
    projectRoot: "",
    targets: [
      target({
        logicalId: "android1",
        appId: args.bundleId,
        deviceName: "sdk_gphone64_arm64 - 14 - API 34",
      }),
      target({ logicalId: "ios1", appId: args.bundleId, deviceName: "iPhone 17 Pro" }),
    ],
  });

  it("resolves the logicalDeviceId from Metro's target list and connects with it", async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const registry = reg(
      {
        // The connected app's own title — matchedByAppId skips the name guard.
        connect: { connected: true, logicalDeviceId: "ios1", appName: "whatever" },
        evalResult: JSON.stringify({ ok: true, path: ["Root"], name: "Root", params: null }),
      },
      calls
    );

    const reader = await connectRouteReader(
      registry,
      undefined,
      { ...args, deviceName: "iPhone 17 Pro" },
      sharedMetro
    );

    expect(reader).toBeDefined();
    expect(calls.find((c) => c.tool === "debugger-connect")?.args).toMatchObject({
      device_id: "ios1",
    });
    expect(await reader!()).toEqual({ path: ["Root"], name: "Root", params: null });
  });

  it("refuses (no udid fallback) when the app is served here but OUR device has no target", async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const registry = reg(
      { connect: { connected: true, logicalDeviceId: "phone1", appName: args.bundleId } },
      calls
    );

    const reader = await connectRouteReader(
      registry,
      undefined,
      { ...args, deviceName: "iPhone 16 Pro" },
      sharedMetro
    );

    expect(reader).toBeUndefined();
    // Falling through to a udid connect would bind a foreign device's runtime.
    expect(calls.filter((c) => c.tool === "debugger-connect")).toEqual([]);
  });

  it("returns a working reader when the connected app names our bundle", async () => {
    const registry = reg({
      connect: {
        connected: true,
        logicalDeviceId: "dev1",
        appName: "com.example.app (iPhone 17 Pro)",
      },
      evalResult: JSON.stringify({
        ok: true,
        path: ["HomeTab", "Home"],
        name: "Home",
        params: null,
      }),
    });
    const reader = await connectRouteReader(registry, undefined, args, noMetro);
    expect(reader).toBeDefined();
    expect(await reader!()).toEqual({ path: ["HomeTab", "Home"], name: "Home", params: null });
  });

  it("refuses (→ landmark fallback) when Metro serves a DIFFERENT app", async () => {
    // A foreign RN project's dev server on 8081: its title names another bundle.
    const registry = reg({
      connect: {
        connected: true,
        logicalDeviceId: "dev1",
        appName: "com.other.app (iPhone 17 Pro)",
      },
    });
    expect(await connectRouteReader(registry, undefined, args, noMetro)).toBeUndefined();
  });

  it("returns undefined when not connected or connect throws (non-RN app)", async () => {
    expect(
      await connectRouteReader(reg({ connect: { connected: false } }), undefined, args, noMetro)
    ).toBeUndefined();
    expect(
      await connectRouteReader(reg({ connect: new Error("Metro down") }), undefined, args, noMetro)
    ).toBeUndefined();
  });

  it("proceeds when the target title is unknown (no over-rejection)", async () => {
    const registry = reg({
      connect: { connected: true, logicalDeviceId: "dev1", appName: "" },
      evalResult: JSON.stringify({ ok: true, path: ["Root"], name: "Root", params: null }),
    });
    const reader = await connectRouteReader(registry, undefined, args, noMetro);
    expect(reader).toBeDefined();
    expect(await reader!()).toEqual({ path: ["Root"], name: "Root", params: null });
  });
});

describe("probeRoute", () => {
  it("retries a null read (mid-transition) and returns the route once it appears", async () => {
    let reads = 0;
    const reader = async (): Promise<RouteContext | null> =>
      ++reads < 3 ? null : route(["HomeTab", "Feed"]);

    const result = await probeRoute(reader, { retryMs: 1 });

    expect(result).toEqual(route(["HomeTab", "Feed"]));
    expect(reads).toBe(3);
  });

  it("concedes null after the attempts are exhausted", async () => {
    let reads = 0;
    const reader = async (): Promise<RouteContext | null> => {
      reads++;
      return null;
    };

    expect(await probeRoute(reader, { attempts: 2, retryMs: 1 })).toBeNull();
    expect(reads).toBe(2);
  });

  it("returns null immediately on an aborted signal without reading", async () => {
    const controller = new AbortController();
    controller.abort();
    let reads = 0;
    const reader = async (): Promise<RouteContext | null> => {
      reads++;
      return route(["A"]);
    };

    expect(await probeRoute(reader, { signal: controller.signal })).toBeNull();
    expect(reads).toBe(0);
  });
});

// The verification primitive the flow `screen` gate is built on. Its whole
// value is keeping "read a different screen" and "read nothing" apart: the
// first is a verdict about the app, the second is a broken probe, and
// collapsing them is how a green run comes to prove nothing.
describe("verifyRouteFingerprint", () => {
  const reads = (...values: Array<RouteContext | null>): RouteReader => {
    const queue = [...values];
    return async () => queue.shift() ?? null;
  };

  it("passes on the first probe when the route already matches", async () => {
    const outcome = await verifyRouteFingerprint(
      reads(route(["HomeTab", "Profile"])),
      "HomeTab>Profile",
      0,
      1
    );
    expect(outcome).toEqual({ ok: true, observedRoute: "HomeTab>Profile" });
  });

  it("keeps polling through the transition until the route commits", async () => {
    const outcome = await verifyRouteFingerprint(
      reads(null, route(["HomeTab", "Feed"]), route(["HomeTab", "Profile"])),
      "HomeTab>Profile",
      2000,
      1
    );
    expect(outcome.ok).toBe(true);
  });

  it("reports the screen it actually observed when the route is wrong", async () => {
    const outcome = await verifyRouteFingerprint(
      reads(route(["HomeTab", "Feed"])),
      "HomeTab>Profile",
      0,
      1
    );
    expect(outcome).toEqual({ ok: false, observedRoute: "HomeTab>Feed" });
  });

  it("reports NO observed route when every probe came back null", async () => {
    // Absent observedRoute is the caller's signal that identity is unknown
    // rather than wrong — it must not be dressed up as arrival or as failure.
    const outcome = await verifyRouteFingerprint(reads(null), "Home", 0, 1);
    expect(outcome).toEqual({ ok: false });
  });

  it("reports an abort distinctly from a failed match", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await verifyRouteFingerprint(
      reads(route(["A"])),
      "B",
      500,
      1,
      controller.signal
    );
    expect(outcome).toEqual({ ok: false, aborted: true });
  });
});
