import { describe, it, expect, vi } from "vitest";
import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";

// Two consumers of the measured state shipped with no coverage at all: the
// full-hierarchy path flows resolve selectors against, and the ios-remote host's
// own `inspectRunningApp`. Both decide what an agent is told to do next, and on
// ios-remote the running/indeterminate split is the ONLY distinction available —
// it drives `requiresRestart` and `describe`'s `should_restart`.

const remote = vi.hoisted(() => ({ stdout: "", calls: 0, fail: false }));

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/dylibs/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTcp: () => "/fake/dylibs/tcp/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTvos: () => "/fake/dylibs/tvos/libArgentInjectionBootstrap.dylib",
  tcpInjectionDylibs: () => [],
  axServiceBinaryPath: () => "/fake/ax-service",
  axServiceBinaryPathTcp: () => "/fake/ax-service-tcp",
}));

vi.mock("../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/sim-remote")>()),
  simctlSpawn: vi.fn(async () => {
    remote.calls += 1;
    if (remote.fail) throw new Error("tunnel down");
    return { stdout: remote.stdout, stderr: "" };
  }),
}));

import { remoteIosHost } from "../src/utils/ios-host";
import { queryFullHierarchyTree } from "../src/tools/flows/flow-ios-tree";
import type { DeviceInfo, Registry } from "@argent/registry";

const UDID = "AAAAAAAA-1111-2222-3333-444444444444";
const BUNDLE = "com.example.app";
const DEVICE: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };

describe("remoteIosHost.inspectRunningApp", () => {
  it("reports running-ness from the orchestrator and leaves the process unknown", async () => {
    remote.stdout = `4242\t0\tUIKitApplication:${BUNDLE}[dffa][rb-legacy]\n`;
    remote.calls = 0;

    const inspection = await remoteIosHost.inspectRunningApp(UDID, BUNDLE);

    // `running` must come off the real row, not be assumed: assuming true makes
    // every stopped remote app `indeterminate` (requiresRestart: true) and
    // assuming false makes every running one `not_running`.
    expect(inspection.running).toBe(true);
    // The app processes live on the orchestrator, so the local process table
    // has nothing to say — a fabricated process here would be judged against
    // this listener and reported as a definite verdict.
    expect(inspection.process).toBeNull();
    expect(remote.calls).toBe(1);
  });

  it("reports not running when no row backs the bundle", async () => {
    remote.stdout = `4242\t0\tUIKitApplication:com.other.app[dffa][rb-legacy]\n`;

    await expect(remoteIosHost.inspectRunningApp(UDID, BUNDLE)).resolves.toEqual({
      running: false,
      process: null,
    });
  });
});

describe("queryFullHierarchyTree surfaces the measured diagnosis", () => {
  function registryWith(overrides: Partial<NativeDevtoolsApi>): Registry {
    const api = {
      listConnectedBundleIds: () => [BUNDLE],
      getAppState: async () => ({
        bundleId: BUNDLE,
        applicationState: "active",
        foregroundActiveSceneCount: 1,
        foregroundInactiveSceneCount: 0,
        backgroundSceneCount: 0,
        unattachedSceneCount: 0,
        isFrontmostCandidate: true,
      }),
      appConnectionState: async () => "connected",
      ...overrides,
    } as unknown as NativeDevtoolsApi;
    return { resolveService: async () => api } as unknown as Registry;
  }

  it("raises the state's own remedy rather than a blanket relaunch", async () => {
    // `unregistered` is the case that matters: telling a flow author to relaunch
    // here sends them round a loop the app cannot exit.
    const registry = registryWith({ appConnectionState: async () => "unregistered" });

    await expect(queryFullHierarchyTree(registry, DEVICE)).rejects.toThrow(
      /argent server stop && argent server start --detach/
    );
    await expect(queryFullHierarchyTree(registry, DEVICE)).rejects.not.toThrow(/relaunch it/);
  });

  it("degrades a rejected measurement instead of leaking the subprocess error", async () => {
    // The measurement re-applies the launchd env before it can answer anything,
    // so a sim that goes away mid-run rejects here. The other consumers degrade
    // to `indeterminate`; a raw `Command failed: xcrun simctl spawn …` carries
    // none of the guidance the diagnosis does.
    const registry = registryWith({
      appConnectionState: async () => {
        throw new Error("Command failed: xcrun simctl spawn UDID launchctl setenv");
      },
    });

    await expect(queryFullHierarchyTree(registry, DEVICE)).rejects.toThrow(
      /could not be inspected/
    );
    await expect(queryFullHierarchyTree(registry, DEVICE)).rejects.not.toThrow(/Command failed/);
  });
});
