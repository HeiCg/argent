import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Registry, type DeviceInfo } from "@argent/registry";
import {
  createIosSimInputBlueprint,
  iosSimInputRef,
  resolveSimInputBinary,
  swiftBuildEnv,
  type IosSimInputApi,
  type IosSimInputBlueprintDeps,
} from "../src/blueprints/ios-sim-input";
import { createStopSimulatorServerTool } from "../src/tools/simulator/stop-simulator-server";
import { createStopAllSimulatorServersTool } from "../src/tools/simulator/stop-all-simulator-servers";

/**
 * The sim-input registry service (iOS-4 ticket 5): one long-lived `sim-input`
 * process per simulator, owned by the registry. A fake spawn stands in for the
 * Swift binary; acks are pushed on the fake child's stdout.
 */

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  args: string[];
  written: string[];
}

const SIM_A: DeviceInfo = {
  id: "11111111-2222-3333-4444-555555555555",
  platform: "ios",
  kind: "simulator",
};
const SIM_B: DeviceInfo = {
  id: "66666666-7777-8888-9999-AAAAAAAAAAAA",
  platform: "ios",
  kind: "simulator",
};
const PHYSICAL: DeviceInfo = { id: "00008110-000978540290401E", platform: "ios", kind: "device" };
const ANDROID: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };

function harness(deps: Partial<IosSimInputBlueprintDeps> = {}) {
  const children: FakeChild[] = [];
  const spawn = vi.fn((_bin: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.args = args;
    child.written = [];
    child.kill = vi.fn(() => {
      setImmediate(() => child.emit("exit", null, "SIGTERM"));
      return true;
    });
    child.stdin.on("data", (buf: Buffer) => child.written.push(buf.toString("utf-8")));
    children.push(child);
    return child;
  });
  const clock = { t: 1_000_000 };
  const blueprint = createIosSimInputBlueprint({
    spawn: spawn as never,
    resolveBinary: async () => "/fake/sim-input",
    now: () => clock.t,
    ...deps,
  });
  const registry = new Registry();
  registry.registerBlueprint(blueprint);
  const resolve = (device: DeviceInfo) => {
    const ref = iosSimInputRef(device);
    return registry.resolveService<IosSimInputApi>(ref.urn, ref.options);
  };
  return { registry, resolve, spawn, children, clock };
}

/** The id of the last command written to `child`. */
function lastId(child: FakeChild): number {
  const lines = child.written.join("").trim().split("\n");
  return (JSON.parse(lines[lines.length - 1]!) as { id: number }).id;
}

function ack(child: FakeChild, obj: Record<string, unknown>): void {
  child.stdout.write(JSON.stringify(obj) + "\n");
}

/** Lets the stdin write callback and stdout data events run. */
const tick = () => new Promise((r) => setImmediate(r));

function crash(child: FakeChild): void {
  child.emit("exit", 1, null);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sim-input blueprint: start and cache", () => {
  it("resolves per simulator udid, spawns sim-input --udid once, and caches the instance", async () => {
    const h = harness();
    const a1 = await h.resolve(SIM_A);
    const a2 = await h.resolve(SIM_A);
    expect(a2).toBe(a1);
    expect(a1.udid).toBe(SIM_A.id);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.children[0]!.args).toEqual(["--udid", SIM_A.id]);

    const b = await h.resolve(SIM_B);
    expect(b).not.toBe(a1);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(h.children[1]!.args).toEqual(["--udid", SIM_B.id]);
  });

  it("sends a normalized tap and resolves with the combined ack", async () => {
    const h = harness();
    const api = await h.resolve(SIM_A);
    const p = api.sendTap({ x: 0.25, y: 0.5 });
    await tick();
    const cmd = JSON.parse(h.children[0]!.written.join("").trim());
    expect(cmd).toMatchObject({ type: "tap", x: 0.25, y: 0.5, screenWidth: 1, screenHeight: 1 });
    const timing = { recvAt: 1, sends: [{ sendStart: 1.1, sendEnd: 1.2 }], ackAt: 52 };
    ack(h.children[0]!, { id: cmd.id, ok: true, scheduledMs: 50, actualMs: 50.2, timing });
    await expect(p).resolves.toMatchObject({ id: cmd.id, scheduledMs: 50, actualMs: 50.2, timing });
  });
});

describe("sim-input blueprint: crash and restart", () => {
  it("restarts sim-input after a crash; the next call runs on the new process", async () => {
    const h = harness();
    const api = await h.resolve(SIM_A);
    const inFlight = api.sendTap({ x: 0.1, y: 0.1 });
    await tick();
    crash(h.children[0]!);
    await expect(inFlight).rejects.toThrow(/exited/);

    const next = api.sendTap({ x: 0.2, y: 0.2 });
    await tick();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    ack(h.children[1]!, { id: lastId(h.children[1]!), ok: true });
    await expect(next).resolves.toMatchObject({ id: lastId(h.children[1]!) });
  });

  it("a 4th crash inside 60 s gives up with a visible error, also on a new resolve", async () => {
    const h = harness();
    const api = await h.resolve(SIM_A);
    // Crashes 1-3 each get a restart.
    for (let i = 0; i < 3; i++) {
      const p = api.sendTap({ x: 0.5, y: 0.5 });
      await tick();
      crash(h.children[h.children.length - 1]!);
      await expect(p).rejects.toThrow();
      h.clock.t += 5_000;
    }
    const p4 = api.sendTap({ x: 0.5, y: 0.5 });
    await tick();
    expect(h.spawn).toHaveBeenCalledTimes(4);
    crash(h.children[3]!);
    await expect(p4).rejects.toThrow();

    await expect(api.sendTap({ x: 0.5, y: 0.5 })).rejects.toThrow(/crashed 4 times in 60 s/);
    expect(h.spawn).toHaveBeenCalledTimes(4);
    await tick();
    await expect(h.resolve(SIM_A)).rejects.toThrow(/crashed 4 times in 60 s/);

    // Outside the window the budget is back.
    h.clock.t += 61_000;
    const fresh = await h.resolve(SIM_A);
    expect(h.spawn).toHaveBeenCalledTimes(5);
    expect(fresh.udid).toBe(SIM_A.id);
  });

  it("crashes spread over more than 60 s do not give up", async () => {
    const h = harness();
    const api = await h.resolve(SIM_A);
    for (let i = 0; i < 5; i++) {
      const p = api.sendTap({ x: 0.5, y: 0.5 });
      await tick();
      crash(h.children[h.children.length - 1]!);
      await expect(p).rejects.toThrow();
      h.clock.t += 30_000;
    }
    const ok = api.sendTap({ x: 0.5, y: 0.5 });
    await tick();
    const child = h.children[h.children.length - 1]!;
    ack(child, { id: lastId(child), ok: true });
    await expect(ok).resolves.toMatchObject({ id: lastId(child) });
  });
});

describe("sim-input blueprint: per-call timeout", () => {
  it("defaults to 5 s; a timeout kills sim-input, rejects every pending call, and the next call restarts it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    const api = await h.resolve(SIM_A);
    const stuck = api.sendTap({ x: 0.1, y: 0.1 });
    const stuckErr = stuck.catch((e: Error) => e);
    await tick();
    const queued = api.sendTap({ x: 0.2, y: 0.2 });
    const queuedErr = queued.catch((e: Error) => e);
    await tick();
    vi.advanceTimersByTime(4_999);
    await tick();
    expect(h.children[0]!.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(((await stuckErr) as Error).message).toMatch(/timed out after 5000 ms/);
    // The queued command could still land after a fallback: it goes too.
    expect(((await queuedErr) as Error).message).toMatch(/timed out/);
    expect(h.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");

    const next = api.sendSwipe({ fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.2, durationMs: 250 });
    await tick();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    const fresh = h.children[1]!;
    ack(fresh, { id: lastId(fresh), ok: true, scheduledMs: 220 });
    await expect(next).resolves.toMatchObject({ id: lastId(fresh), scheduledMs: 220 });
  });

  it("timeouts count toward the crash budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    const api = await h.resolve(SIM_A);
    for (let i = 0; i < 4; i++) {
      const p = api.sendTap({ x: 0.5, y: 0.5 }).catch((e: Error) => e);
      await tick();
      vi.advanceTimersByTime(5_000);
      expect(await p).toBeInstanceOf(Error);
      await tick();
    }
    expect(h.spawn).toHaveBeenCalledTimes(4);
    await expect(api.sendTap({ x: 0.5, y: 0.5 })).rejects.toThrow(/4 times in 60 s/);
  });
});

describe("sim-input blueprint: wire details", () => {
  it("a swipe with holdEndMs carries it on the wire", async () => {
    const h = harness();
    const api = await h.resolve(SIM_A);
    const p = api.sendSwipe({
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.2,
      durationMs: 250,
      holdEndMs: 120,
    });
    await tick();
    const cmd = JSON.parse(h.children[0]!.written.join("").trim());
    expect(cmd).toMatchObject({ type: "swipe", durationMs: 250, holdEndMs: 120 });
    ack(h.children[0]!, { id: cmd.id, ok: true });
    await p;
  });

  it("stderr forwarding never carries typed text or key usages (older binary logs per key)", async () => {
    const forwarded: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      forwarded.push(args.map(String).join(" "));
    });
    try {
      const h = harness();
      const api = await h.resolve(SIM_A);
      const p = api.sendText("s3cret");
      await tick();
      const child = h.children[0]!;
      // What a binary with the per-key log writes for "s3cret".
      const usages = [0x16, 0x20, 0x06, 0x15, 0x08, 0x17];
      const lines = [
        "sim-input ready (udid=X)",
        ...usages.map((u) => `[hid] key page=7 usage=${u} modifiers=[] hold=100000us`),
        "text: unsupported character 's'",
        "[hid] symbols resolved — mouse:true",
      ];
      child.stderr.write(lines.join("\n") + "\n");
      ack(child, { id: lastId(child), ok: true });
      await p;
      await tick();
      const all = forwarded.join("\n");
      expect(all).toContain("sim-input ready");
      expect(all).toContain("symbols resolved");
      expect(all).not.toContain("s3cret");
      expect(all).not.toMatch(/usage=/);
      expect(all).not.toMatch(/\[hid\] key/);
      expect(all).not.toMatch(/character/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("sim-input blueprint: teardown", () => {
  it("disposing the service (device teardown) stops sim-input and rejects pending calls", async () => {
    const h = harness();
    const api = await h.resolve(SIM_A);
    const pending = api.sendTap({ x: 0.5, y: 0.5 });
    const pendingErr = pending.catch((e: Error) => e);
    await tick();
    await h.registry.disposeService(iosSimInputRef(SIM_A).urn);
    expect(h.children[0]!.kill).toHaveBeenCalled();
    expect(await pendingErr).toBeInstanceOf(Error);
    // A stop is not a crash: re-resolving starts a fresh process.
    await tick();
    await h.resolve(SIM_A);
    expect(h.spawn).toHaveBeenCalledTimes(2);
  });

  it("registry.dispose stops every sim-input process", async () => {
    const h = harness();
    await h.resolve(SIM_A);
    await h.resolve(SIM_B);
    await h.registry.dispose();
    expect(h.children[0]!.kill).toHaveBeenCalled();
    expect(h.children[1]!.kill).toHaveBeenCalled();
  });
});

describe("sim-input blueprint: stops with the device", () => {
  it("stop-simulator-server on the simulator stops its sim-input process", async () => {
    const h = harness();
    await h.resolve(SIM_A);
    await h.resolve(SIM_B);
    const stop = createStopSimulatorServerTool(h.registry);
    const result = await stop.execute({}, { udid: SIM_A.id });
    expect(result).toEqual({ stopped: true, udid: SIM_A.id });
    expect(h.children[0]!.kill).toHaveBeenCalled();
    expect(h.children[1]!.kill).not.toHaveBeenCalled();
  });

  it("stop-all-simulator-servers scoped to the simulator stops its sim-input process", async () => {
    const h = harness();
    await h.resolve(SIM_A);
    await h.resolve(SIM_B);
    const stopAll = createStopAllSimulatorServersTool(h.registry);
    const result = await stopAll.execute({}, { devices: [SIM_B.id] });
    expect(result.stopped).toEqual([iosSimInputRef(SIM_B).urn]);
    expect(h.children[1]!.kill).toHaveBeenCalled();
    expect(h.children[0]!.kill).not.toHaveBeenCalled();
  });
});

describe("sim-input blueprint: simulators only", () => {
  it("a physical iPhone does not resolve and spawns nothing", async () => {
    const h = harness();
    await expect(h.resolve(PHYSICAL)).rejects.toThrow(/simulator/);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("a non-iOS device does not resolve", async () => {
    const h = harness();
    await expect(h.resolve(ANDROID)).rejects.toThrow(/simulator/);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe("resolveSimInputBinary", () => {
  const PKG = "/repo/packages/ios-sim-input";
  const RELEASE = `${PKG}/.build/release/sim-input`;

  it("ARGENT_SIM_INPUT_BIN wins when it is executable", async () => {
    const build = vi.fn(async () => {});
    const bin = await resolveSimInputBinary({
      env: { ARGENT_SIM_INPUT_BIN: "/opt/sim-input" },
      packageDir: PKG,
      isExecutable: async (f) => f === "/opt/sim-input" || f === RELEASE,
      build,
    });
    expect(bin).toBe("/opt/sim-input");
    expect(build).not.toHaveBeenCalled();
  });

  it("a configured path that is not executable is an error, not a silent build", async () => {
    const build = vi.fn(async () => {});
    await expect(
      resolveSimInputBinary({
        env: { ARGENT_SIM_INPUT_BIN: "/missing/sim-input" },
        packageDir: PKG,
        isExecutable: async () => false,
        build,
      })
    ).rejects.toThrow(/ARGENT_SIM_INPUT_BIN/);
    expect(build).not.toHaveBeenCalled();
  });

  it("uses the prebuilt release product when it exists", async () => {
    const build = vi.fn(async () => {});
    const bin = await resolveSimInputBinary({
      env: {},
      packageDir: PKG,
      isExecutable: async (f) => f === RELEASE,
      build,
    });
    expect(bin).toBe(RELEASE);
    expect(build).not.toHaveBeenCalled();
  });

  it("a failed build is cached for the process: later resolves fail fast with the same reason", async () => {
    const build = vi.fn(async () => {
      throw new Error("xcrun: error: unable to find utility");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const opts = {
        env: {},
        packageDir: "/repo/failing/ios-sim-input",
        isExecutable: async () => false,
        hasPackage: async () => true,
        build,
      };
      await expect(resolveSimInputBinary(opts)).rejects.toThrow(/unable to find utility/);
      await expect(resolveSimInputBinary(opts)).rejects.toThrow(/unable to find utility/);
      expect(build).toHaveBeenCalledTimes(1);
      // The first build says so: the first call can take minutes.
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/building sim-input.*minutes/));
    } finally {
      warn.mockRestore();
    }
  });

  it("swiftBuildEnv pins DEVELOPER_DIR like scripts/build-sim-input.sh", () => {
    expect(swiftBuildEnv({ DEVELOPER_DIR: "/X.app/Contents/Developer" }, () => "/Y")).toMatchObject(
      { DEVELOPER_DIR: "/X.app/Contents/Developer" }
    );
    expect(swiftBuildEnv({}, () => "/Applications/Xcode-26.app/Contents/Developer")).toMatchObject({
      DEVELOPER_DIR: "/Applications/Xcode-26.app/Contents/Developer",
    });
    expect(swiftBuildEnv({}, () => null)).toMatchObject({
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
    });
  });

  it("no binary and no Swift package (a bundled install) is an error naming ARGENT_SIM_INPUT_BIN, no build", async () => {
    const build = vi.fn(async () => {});
    await expect(
      resolveSimInputBinary({
        env: {},
        packageDir: "/bundle/ios-sim-input",
        isExecutable: async () => false,
        hasPackage: async () => false,
        build,
      })
    ).rejects.toThrow(/ARGENT_SIM_INPUT_BIN/);
    expect(build).not.toHaveBeenCalled();
  });

  it("builds once (swift build -c release) when no product exists, under one lock", async () => {
    let built = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const build = vi.fn(async () => {
      await gate;
      built = true;
    });
    const opts = {
      env: {},
      packageDir: PKG,
      isExecutable: async (f: string) => built && f === RELEASE,
      hasPackage: async () => true,
      build,
    };
    const first = resolveSimInputBinary(opts);
    const second = resolveSimInputBinary(opts);
    release();
    await expect(first).resolves.toBe(RELEASE);
    await expect(second).resolves.toBe(RELEASE);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith(PKG);
  });
});
