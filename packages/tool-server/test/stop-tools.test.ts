import { describe, it, expect, vi } from "vitest";
import { Registry, ServiceState } from "@argent/registry";
import { createStopSimulatorServerTool } from "../src/tools/simulator/stop-simulator-server";
import { createStopAllSimulatorServersTool } from "../src/tools/simulator/stop-all-simulator-servers";
import { stopMetroTool } from "../src/tools/simulator/stop-metro";

function createMockRegistry(services: Map<string, { state: ServiceState; dependents: string[] }>) {
  return {
    getSnapshot: vi.fn(() => ({
      services,
      namespaces: [],
      tools: [],
    })),
    // The real `disposeService` returns the node to IDLE and LEAVES IT IN the
    // map (Registry._teardown), rather than removing it — so a second stop of
    // the same device still sees its URNs, in IDLE. Mirror that here: a mock
    // that forgets disposed nodes would hide exactly the sequence the
    // stop-one-then-stop-the-rest tests below exist to pin.
    disposeService: vi.fn(async (urn: string) => {
      const node = services.get(urn);
      if (node) node.state = ServiceState.IDLE;
    }),
  } as unknown as Registry;
}

describe("stop-simulator-server", () => {
  it("disposes the correct URN for a running simulator", async () => {
    const services = new Map([
      ["SimulatorServer:AAAA-BBBB", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "AAAA-BBBB" });

    expect(result).toEqual({ stopped: true, udid: "AAAA-BBBB" });
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:AAAA-BBBB");
  });

  it("returns stopped: false for a UDID with no running server", async () => {
    const services = new Map<string, { state: ServiceState; dependents: string[] }>();
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "CCCC-DDDD" });

    expect(result).toEqual({ stopped: false, udid: "CCCC-DDDD" });
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("returns stopped: false for an IDLE simulator", async () => {
    const services = new Map([
      ["SimulatorServer:EEEE-FFFF", { state: ServiceState.IDLE, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "EEEE-FFFF" });

    expect(result).toEqual({ stopped: false, udid: "EEEE-FFFF" });
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("returns stopped: false for an ERROR node (e.g. tvOS) but still cleans it up", async () => {
    // A tvOS UDID: the SimulatorServer blueprint throws on start, leaving the
    // node in ERROR. It never ran, so we must not report stopped: true — but we
    // still dispose to clear the dead node.
    const services = new Map([
      ["SimulatorServer:TV-UDID", { state: ServiceState.ERROR, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "TV-UDID" });

    expect(result).toEqual({ stopped: false, udid: "TV-UDID" });
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:TV-UDID");
  });

  it("reports stopped: true for a STARTING simulator", async () => {
    const services = new Map([
      ["SimulatorServer:GGGG-HHHH", { state: ServiceState.STARTING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "GGGG-HHHH" });

    expect(result).toEqual({ stopped: true, udid: "GGGG-HHHH" });
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:GGGG-HHHH");
  });

  it("stops the live TvControl daemon for a tvOS UDID whose SimulatorServer never ran", async () => {
    // A tvOS UDID (iOS-shaped) holds a live TvControl service that owns the
    // spawned tvos-ax / tvos-hid daemons, while its SimulatorServer node sits in
    // ERROR (the blueprint rejects tvOS). Stopping the device must reap the TV
    // daemon, not just clean up the dead SimulatorServer node.
    const udid = "12345678-1234-1234-1234-123456789012";
    const services = new Map([
      [`SimulatorServer:${udid}`, { state: ServiceState.ERROR, dependents: [] }],
      [`TvControl:${udid}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid });

    expect(result).toEqual({ stopped: true, udid });
    expect(registry.disposeService).toHaveBeenCalledWith(`SimulatorServer:${udid}`);
    expect(registry.disposeService).toHaveBeenCalledWith(`TvControl:${udid}`);
  });

  it("stops the live AndroidTvControl service for an Android TV serial", async () => {
    const serial = "emulator-5554";
    const services = new Map([
      [`AndroidTvControl:${serial}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: serial });

    expect(result).toEqual({ stopped: true, udid: serial });
    expect(registry.disposeService).toHaveBeenCalledWith(`AndroidTvControl:${serial}`);
  });

  it("does not target TvControl for a chromium id", async () => {
    const services = new Map([
      ["ChromiumCdp:chromium-cdp-9222", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "chromium-cdp-9222" });

    expect(result).toEqual({ stopped: true, udid: "chromium-cdp-9222" });
    expect(registry.disposeService).toHaveBeenCalledOnce();
    expect(registry.disposeService).toHaveBeenCalledWith("ChromiumCdp:chromium-cdp-9222");
  });
});

describe("stop-all-simulator-servers", () => {
  it("disposes all running SimulatorServer URNs", async () => {
    const services = new Map([
      ["SimulatorServer:AAA", { state: ServiceState.RUNNING, dependents: [] }],
      ["SimulatorServer:BBB", { state: ServiceState.RUNNING, dependents: [] }],
      ["JsRuntimeDebugger:CCC", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, {});

    expect(result).toEqual({
      stopped: ["SimulatorServer:AAA", "SimulatorServer:BBB"],
    });
    expect(registry.disposeService).toHaveBeenCalledTimes(2);
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:AAA");
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:BBB");
  });

  it("returns empty list when no simulators are running", async () => {
    const services = new Map<string, { state: ServiceState; dependents: string[] }>();
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, {});

    expect(result).toEqual({ stopped: [] });
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("skips IDLE simulators", async () => {
    const services = new Map([
      ["SimulatorServer:AAA", { state: ServiceState.IDLE, dependents: [] }],
      ["SimulatorServer:BBB", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, {});

    expect(result).toEqual({ stopped: ["SimulatorServer:BBB"] });
    expect(registry.disposeService).toHaveBeenCalledOnce();
  });

  it("disposes an ERROR node (e.g. tvOS) but omits it from the stopped list", async () => {
    const services = new Map([
      ["SimulatorServer:TV-UDID", { state: ServiceState.ERROR, dependents: [] }],
      ["SimulatorServer:BBB", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, {});

    // Both get disposed (cleanup), but only the live one is reported as stopped.
    expect(result).toEqual({ stopped: ["SimulatorServer:BBB"] });
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:TV-UDID");
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:BBB");
    expect(registry.disposeService).toHaveBeenCalledTimes(2);
  });

  it("stops the focus-driven TV control services (Apple TV + Android TV)", async () => {
    // The TvControl daemon owns the spawned tvos-ax / tvos-hid processes, so a
    // session-end stop must dispose it — not just the simulator-server/CDP nodes.
    const services = new Map([
      ["TvControl:APPLE-TV", { state: ServiceState.RUNNING, dependents: [] }],
      ["AndroidTvControl:emulator-5556", { state: ServiceState.RUNNING, dependents: [] }],
      ["SimulatorServer:BBB", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, {});

    expect(result).toEqual({
      stopped: ["TvControl:APPLE-TV", "AndroidTvControl:emulator-5556", "SimulatorServer:BBB"],
    });
    expect(registry.disposeService).toHaveBeenCalledWith("TvControl:APPLE-TV");
    expect(registry.disposeService).toHaveBeenCalledWith("AndroidTvControl:emulator-5556");
    expect(registry.disposeService).toHaveBeenCalledTimes(3);
  });
});

// The tool-server is a host-wide singleton, so an unscoped teardown reaps
// whatever device another agent is mid-session on. `devices` narrows the sweep
// to the ids the calling session actually used.
const MINE = "AAAA-1111";
const THEIRS = "BBBB-2222";

describe("stop-all-simulator-servers device scoping", () => {
  function twoAgentServices() {
    return new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
      ["ChromiumCdp:chromium-cdp-9222", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
  }

  it("disposes only the named device's URNs and leaves the other device live", async () => {
    const registry = createMockRegistry(twoAgentServices());
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`, `NativeDevtools:${MINE}`],
    });
    expect(registry.disposeService).toHaveBeenCalledTimes(2);
    expect(registry.disposeService).not.toHaveBeenCalledWith(`SimulatorServer:${THEIRS}`);
    expect(registry.disposeService).not.toHaveBeenCalledWith(`NativeDevtools:${THEIRS}`);
    expect(registry.disposeService).not.toHaveBeenCalledWith("ChromiumCdp:chromium-cdp-9222");
  });

  it("scopes across platforms when several device ids are named", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      ["AndroidDevtools:emulator-5554", { state: ServiceState.RUNNING, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE, "emulator-5554"] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`, "AndroidDevtools:emulator-5554"],
    });
    expect(registry.disposeService).toHaveBeenCalledTimes(2);
  });

  it("still disposes everything when no devices are named", async () => {
    const registry = createMockRegistry(twoAgentServices());
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, {});

    expect(result).toEqual({
      stopped: [
        `SimulatorServer:${MINE}`,
        `NativeDevtools:${MINE}`,
        `SimulatorServer:${THEIRS}`,
        `NativeDevtools:${THEIRS}`,
        "ChromiumCdp:chromium-cdp-9222",
      ],
    });
    expect(registry.disposeService).toHaveBeenCalledTimes(5);
    // Nothing was requested, so there is nothing that could have missed.
    expect(result).not.toHaveProperty("unmatched");
  });

  it("scopes the non-simulator namespaces too (ChromiumCdp / TvControl / AndroidTvControl)", async () => {
    // Every namespace in PREFIXES must honour `devices`, not just
    // SimulatorServer/NativeDevtools: a TvControl daemon left running holds two
    // spawned --timeout 3600 processes, and reaping another agent's is exactly
    // the cross-session damage scoping exists to prevent.
    const chromium = "chromium-cdp-9222";
    const appleTv = "APPLE-TV-UDID";
    const androidTv = "emulator-5556";
    const services = new Map([
      [`ChromiumCdp:${chromium}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`TvControl:${appleTv}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`AndroidTvControl:${androidTv}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`TvControl:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [chromium, appleTv, androidTv] });

    expect(result).toEqual({
      stopped: [`ChromiumCdp:${chromium}`, `TvControl:${appleTv}`, `AndroidTvControl:${androidTv}`],
    });
    expect(registry.disposeService).toHaveBeenCalledTimes(3);
    expect(registry.disposeService).not.toHaveBeenCalledWith(`TvControl:${THEIRS}`);
  });

  it("matches a transport-suffixed URN (NativeDevtools:<udid>:tcp)", async () => {
    const services = new Map([
      [`NativeDevtools:${MINE}:tcp`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${THEIRS}:tcp`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({ stopped: [`NativeDevtools:${MINE}:tcp`] });
    expect(registry.disposeService).toHaveBeenCalledOnce();
    expect(registry.disposeService).toHaveBeenCalledWith(`NativeDevtools:${MINE}:tcp`);
  });

  it("matches a device id that itself contains a colon (wireless adb serial)", async () => {
    const wireless = "192.168.1.5:5555";
    const services = new Map([
      [`AndroidDevtools:${wireless}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [wireless] });

    expect(result).toEqual({ stopped: [`AndroidDevtools:${wireless}`] });
    expect(registry.disposeService).toHaveBeenCalledOnce();
  });

  it("does not let a bare IP claim every wireless device at that address", async () => {
    // An adb serial is `ip:port`, so treating "anything after a colon" as the
    // transport discriminator would let a caller who dropped the port tear down
    // a second agent's device — and report nothing unmatched while doing it.
    const services = new Map([
      ["AndroidDevtools:192.168.1.5:5555", { state: ServiceState.RUNNING, dependents: [] }],
      ["SimulatorServer:192.168.1.5:5556", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: ["192.168.1.5"] });

    expect(result).toEqual({ stopped: [], unmatched: ["192.168.1.5"] });
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("matches the device id case-insensitively", async () => {
    // iOS UDIDs are conventionally upper-case, but an agent passes through
    // whatever it was handed — a case mismatch must not silently no-op.
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${MINE.toLowerCase()}:tcp`, { state: ServiceState.RUNNING, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE.toLowerCase()] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`, `NativeDevtools:${MINE.toLowerCase()}:tcp`],
    });
    expect(registry.disposeService).not.toHaveBeenCalledWith(`SimulatorServer:${THEIRS}`);
  });

  it("scopes to nothing for devices: [] rather than sweeping the machine", async () => {
    // A caller that computed a device list and got none must not fall back to
    // tearing down every other agent's services.
    const registry = createMockRegistry(twoAgentServices());
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [] });

    expect(result).toEqual({ stopped: [] });
    // No id was requested, so nothing missed: an empty `unmatched` would read
    // as a warning where there is nothing to warn about.
    expect(result).not.toHaveProperty("unmatched");
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("does not match a device id that is a prefix of another device's id", async () => {
    const services = new Map([
      ["SimulatorServer:AAAA", { state: ServiceState.RUNNING, dependents: [] }],
      ["SimulatorServer:AAAA-EXTRA", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: ["AAAA"] });

    expect(result).toEqual({ stopped: ["SimulatorServer:AAAA"] });
    expect(registry.disposeService).toHaveBeenCalledOnce();
  });

  it("skips an IDLE service on the named device", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.IDLE, dependents: [] }],
      [`NativeDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({ stopped: [`NativeDevtools:${MINE}`] });
    expect(registry.disposeService).toHaveBeenCalledOnce();
  });
});

describe("stop-all-simulator-servers unmatched ids", () => {
  // A scoped stop whose ids owned nothing used to return a bare `{ stopped: [] }`
  // — byte-identical to the answer on a genuinely clean machine. So a mistyped
  // id, a device *name* passed where an id was expected, or an empty string all
  // read as success while the services they were meant to reap (on tvOS, two
  // spawned --timeout 3600 daemons) stayed running. `unmatched` names them.

  it("names an unknown id in unmatched while still stopping the live device", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE, "GHOST-9999"] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`, `NativeDevtools:${MINE}`],
      unmatched: ["GHOST-9999"],
    });
    expect(registry.disposeService).toHaveBeenCalledTimes(2);
  });

  it("reports a typo, a device name, and an empty-string id — the shapes that used to look clean", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const typo = `${MINE}0`;
    const deviceName = "iPhone 15 Pro";
    const result = await tool.execute!({}, { devices: [MINE, typo, deviceName, ""] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`],
      unmatched: [typo, deviceName, ""],
    });
  });

  it("omits unmatched entirely when every requested id matched something", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      ["AndroidDevtools:emulator-5554", { state: ServiceState.RUNNING, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE, "emulator-5554"] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`, "AndroidDevtools:emulator-5554"],
    });
    // Absent, not an empty array — a clean scoped stop must carry no warning.
    expect(result).not.toHaveProperty("unmatched");
  });

  it("does not report an all-IDLE device as unmatched — it still owns those nodes", async () => {
    // `disposeService` returns a node to IDLE without removing it, so this is
    // precisely the state a device is left in by a stop THIS session already
    // performed. `unmatched` means "this id owns nothing on the machine, look
    // for a typo"; saying it about a device we just tore down ourselves is a
    // false alarm on the routine stop-one-then-stop-the-rest sequence.
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.IDLE, dependents: [] }],
      [`NativeDevtools:${MINE}`, { state: ServiceState.IDLE, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE, "GHOST-9999"] });

    // Nothing left to stop for MINE, but only the id that owns no node at all
    // is a miss.
    expect(result).toEqual({ stopped: [], unmatched: ["GHOST-9999"] });
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("reports nothing unmatched when the same device is stopped twice in a row", async () => {
    // The session-end sequence the argent rules prescribe: stop the device you
    // finished with, then sweep the rest. The second call finds every URN the
    // first one left behind in IDLE, and must not read that as a mistyped id.
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const first = await tool.execute!({}, { devices: [MINE] });
    expect(first).toEqual({
      stopped: [`SimulatorServer:${MINE}`, `NativeDevtools:${MINE}`],
    });
    expect(first).not.toHaveProperty("unmatched");

    const second = await tool.execute!({}, { devices: [MINE] });
    expect(second).toEqual({ stopped: [] });
    expect(second).not.toHaveProperty("unmatched");
    // The second call had nothing live to tear down.
    expect(registry.disposeService).toHaveBeenCalledTimes(2);
  });

  it("names a repeated missing id only once", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    // A device list assembled from several sources can repeat an id; the
    // warning is about the id, not about how many times it was passed.
    const result = await tool.execute!({}, { devices: [MINE, "GHOST-9999", MINE, "GHOST-9999"] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`],
      unmatched: ["GHOST-9999"],
    });
  });

  it("reports neither spelling when one device is named twice in different cases", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    // Matching is case-insensitive, so both spellings name the same device —
    // and the device matched. Neither is a miss.
    const result = await tool.execute!({}, { devices: [MINE, MINE.toLowerCase()] });

    expect(result).toEqual({ stopped: [`SimulatorServer:${MINE}`] });
    expect(result).not.toHaveProperty("unmatched");
    expect(registry.disposeService).toHaveBeenCalledOnce();
  });

  it("does not report an ERROR-only device as unmatched — its dead node was cleaned up", async () => {
    // The other side of the IDLE case above: neither state is a miss (both own
    // nodes), but an ERROR node is still DISPOSED — it never ran, so it never
    // shows up in `stopped`, yet the dead node has to be cleared.
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.ERROR, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.IDLE, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE, THEIRS] });

    expect(result).toEqual({ stopped: [] });
    expect(result).not.toHaveProperty("unmatched");
    expect(registry.disposeService).toHaveBeenCalledOnce();
    expect(registry.disposeService).toHaveBeenCalledWith(`SimulatorServer:${MINE}`);
  });

  it("counts a case-differing id as matched and echoes the caller's own spelling for the miss", async () => {
    // The registry holds the upper-case UDID; the caller passes lower-case.
    // The hit must not be reported as a miss (matching is case-insensitive),
    // and the miss must come back spelled exactly as the caller typed it so the
    // agent can find it in its own device list.
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE.toLowerCase(), "Mine-Typo"] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`],
      unmatched: ["Mine-Typo"],
    });
  });
});

describe("stop-metro", () => {
  it("defaults to port 8081", () => {
    expect(stopMetroTool.zodSchema).toBeDefined();
    const parsed = stopMetroTool.zodSchema!.parse({});
    expect(parsed.port).toBe(8081);
  });

  it("accepts a custom port", () => {
    const parsed = stopMetroTool.zodSchema!.parse({ port: 9090 });
    expect(parsed.port).toBe(9090);
  });

  it("returns stopped: false when no process on port", async () => {
    // Use a high port unlikely to have anything listening
    const result = await stopMetroTool.execute!({}, { port: 59999 });
    expect(result.stopped).toBe(false);
    expect(result.port).toBe(59999);
    expect(result.pids).toEqual([]);
  });
});
