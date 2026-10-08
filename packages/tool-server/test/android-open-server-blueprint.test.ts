import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as net from "node:net";

// --- mocks: no real device, no real adb, but a REAL loopback socket ---
const spawn = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...a: unknown[]) => spawn(...a) }));

const runAdb = vi.fn();
vi.mock("../src/utils/adb", () => ({ runAdb: (...a: unknown[]) => runAdb(...a) }));

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: async () => "/usr/bin/adb",
}));

const ensureOpenDeviceServerInstalled = vi.fn(async () => {});
vi.mock("../src/utils/android-helper-install", () => ({
  ensureOpenDeviceServerInstalled: () => ensureOpenDeviceServerInstalled(),
}));

vi.mock("@argent/android-device-server", () => ({
  serverManifest: () => ({
    packageName: "com.argent.devicecontrol",
    instrumentationRunner: "com.argent.devicecontrol/.DeviceControlInstrumentation",
    versionName: "0.1.0",
    versionCode: 1,
    installFlags: ["-r", "-t"],
  }),
  bundledServerApkPath: () => "/tmp/x.apk",
}));

// Phase 3n.2: the scrcpy fast-inject backend was removed, so the fake @yume-chan
// backend mock and the fast-inject seam tests are gone.

import {
  androidOpenServerBlueprint,
  takeOpenServerWarmup,
} from "../src/blueprints/android-open-server";
import type { OpenDeviceServerApi } from "../src/blueprints/android-open-server";

const DEVICE = { id: "emulator-5554", platform: "android" } as never;
const DEVICE_PORT = 41999;

interface FakeProc extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}

let fakeServer: net.Server | null = null;
let localPort = 0;
let lastConn: net.Socket | null = null;

/** A real loopback server the client's socket actually connects to. */
async function startFakeDeviceServer(onLine: (line: string, s: net.Socket) => void): Promise<void> {
  fakeServer = net.createServer((socket) => {
    lastConn = socket;
    let buf = "";
    socket.on("data", (c) => {
      buf += c.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line, socket);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => fakeServer!.listen(0, "127.0.0.1", r));
  localPort = (fakeServer!.address() as net.AddressInfo).port;
}

beforeEach(() => {
  spawn.mockReset();
  runAdb.mockReset();
  ensureOpenDeviceServerInstalled.mockClear();
  lastConn = null;
  takeOpenServerWarmup("emulator-5554");
});

afterEach(async () => {
  // Destroy the live client connection first, else close() waits on it forever.
  lastConn?.destroy();
  if (fakeServer) await new Promise<void>((r) => fakeServer!.close(() => r()));
  fakeServer = null;
});

function wireSpawnAndForward(): FakeProc {
  const proc = makeFakeProc();
  spawn.mockReturnValue(proc);
  // After the blueprint attaches its readline listener, emit the port marker.
  setImmediate(() => {
    proc.stdout.write(`INSTRUMENTATION_STATUS: port=${DEVICE_PORT}\n`);
  });
  // `adb forward tcp:0 tcp:<devicePort>` → prints the chosen local port.
  runAdb.mockImplementation(async (args: string[]) => {
    if (args.includes("forward") && args.includes("tcp:0")) {
      return { stdout: `${localPort}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return proc;
}

describe("androidOpenServerBlueprint.factory", () => {
  it("rejects a non-android device", async () => {
    await expect(
      androidOpenServerBlueprint.factory(
        {} as never,
        undefined as never,
        {
          device: { id: "UDID", platform: "ios" },
        } as never
      )
    ).rejects.toThrow(/Android-only/);
  });

  it("rejects when options.device is missing", async () => {
    await expect(
      androidOpenServerBlueprint.factory({} as never, undefined as never, undefined as never)
    ).rejects.toThrow(/requires a resolved DeviceInfo/);
  });

  it("does the port handshake, adb-forwards, and gates on ping", async () => {
    await startFakeDeviceServer((line, s) => {
      const req = JSON.parse(line) as { id: number; method: string };
      // Every method answers: the start also makes warm-up reads after the ping.
      s.write(JSON.stringify({ id: req.id, result: { status: "ok" } }) + "\n");
    });
    wireSpawnAndForward();

    const instance = await androidOpenServerBlueprint.factory(
      {} as never,
      undefined as never,
      {
        device: DEVICE,
      } as never
    );

    expect(ensureOpenDeviceServerInstalled).toHaveBeenCalledTimes(1);
    // adb forward tcp:0 tcp:<devicePort> was issued.
    const forwardCall = runAdb.mock.calls.find((c) => (c[0] as string[]).includes("forward"));
    expect(forwardCall![0]).toEqual([
      "-s",
      "emulator-5554",
      "forward",
      "tcp:0",
      `tcp:${DEVICE_PORT}`,
    ]);
    expect(instance.api.isReady()).toBe(true);

    await instance.dispose!();
  });

  it("exposes a working RPC surface over the forwarded socket", async () => {
    await startFakeDeviceServer((line, s) => {
      const req = JSON.parse(line) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      const results: Record<string, unknown> = {
        ping: { status: "ok" },
        getInfo: { screenWidth: 1080, screenHeight: 1920 },
        tap: { success: true },
        getAccessibilityTree: { tree: [] },
      };
      s.write(JSON.stringify({ id: req.id, result: results[req.method] ?? {} }) + "\n");
    });
    wireSpawnAndForward();

    const instance = await androidOpenServerBlueprint.factory(
      {} as never,
      undefined as never,
      {
        device: DEVICE,
      } as never
    );
    const api = instance.api as OpenDeviceServerApi;

    expect((await api.getInfo()).screenWidth).toBe(1080);
    expect((await api.tap(10, 20)).success).toBe(true);
    expect((await api.getAccessibilityTree()).tree).toEqual([]);

    await instance.dispose!();
  });

  // Phase 3m: fingerprints are opt-in on the read RPCs. The plain describe /
  // latency path must send NO `fingerprints` (so the device never forces a hash
  // rebuild), and the screen-graph path must send `fingerprints: true`.
  it("getState/getNestedState send `fingerprints` ONLY when the caller opts in", async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    await startFakeDeviceServer((line, s) => {
      const req = JSON.parse(line) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      seen.push({ method: req.method, params: req.params ?? {} });
      // getState (flat + nested) both hit the "getState" RPC; a minimal well-formed
      // reply is enough — the test only inspects the request params.
      const result =
        req.method === "getState"
          ? {
              tree: [],
              info: { screenWidth: 1080, screenHeight: 1920 },
              screenshot: "",
              waitedMs: 0,
              captureMs: 0,
              version: 0,
            }
          : req.method === "ping"
            ? { status: "ok" }
            : {};
      s.write(JSON.stringify({ id: req.id, result }) + "\n");
    });
    wireSpawnAndForward();

    const instance = await androidOpenServerBlueprint.factory(
      {} as never,
      undefined as never,
      { device: DEVICE } as never
    );
    const api = instance.api as OpenDeviceServerApi;
    // The start warm-up reads (step tap-latency) are not under test here.
    seen.length = 0;

    // Plain describe / latency shape: no fingerprints requested.
    await api.getState({ includeScreenshot: false });
    await api.getNestedState({});
    // Screen-graph / navigate-to shape: fingerprints requested.
    await api.getState({ includeScreenshot: false, fingerprints: true });
    await api.getNestedState({ fingerprints: true });

    const getStateReqs = seen.filter((r) => r.method === "getState");
    // 4 getState RPCs (getNestedState also dispatches "getState" with nested:true).
    expect(getStateReqs.length).toBe(4);

    // The plain flat getState (nested absent) with no opt-in: no `fingerprints`.
    const plainFlat = getStateReqs.find((r) => !r.params.nested && !r.params.fingerprints);
    expect(plainFlat).toBeTruthy();
    expect("fingerprints" in plainFlat!.params).toBe(false);

    // The plain nested getState (the describe path): no `fingerprints`.
    const plainNested = getStateReqs.find(
      (r) => r.params.nested === true && !r.params.fingerprints
    );
    expect(plainNested).toBeTruthy();
    expect("fingerprints" in plainNested!.params).toBe(false);

    // The screen-graph flat + nested reads: `fingerprints: true` on the wire.
    const fpReqs = getStateReqs.filter((r) => r.params.fingerprints === true);
    expect(fpReqs.length).toBe(2);
    expect(fpReqs.some((r) => !r.params.nested)).toBe(true); // flat (tiered / navigate-to)
    expect(fpReqs.some((r) => r.params.nested === true)).toBe(true); // nested (preflight)

    await instance.dispose!();
  });

  // Phase 3n.3 (3N2-M7): the host `flush` option (on the read RPCs) and the
  // `flushInput()` RPC are RETAINED after the scrcpy removal — the Kotlin
  // FlushInputHandler is still live (HierarchyHandler/StateHandler call it) and an
  // out-of-process injector can request the inline drain. The only test that covered the
  // wire semantics was deleted with the scrcpy blueprint tests; this restores it: `flush`
  // threads `flush:true` onto the wire ONLY when opted in, and `flushInput()` issues the
  // `flushInput` RPC.
  it("threads `flush:true` onto the read RPCs only when opted in, and flushInput() issues the RPC", async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    await startFakeDeviceServer((line, s) => {
      const req = JSON.parse(line) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      seen.push({ method: req.method, params: req.params ?? {} });
      const result =
        req.method === "getState"
          ? {
              tree: [],
              info: { screenWidth: 1080, screenHeight: 1920 },
              screenshot: "",
              waitedMs: 0,
              captureMs: 0,
              version: 0,
            }
          : req.method === "getAccessibilityTree"
            ? { tree: [] }
            : req.method === "flushInput"
              ? { success: true }
              : req.method === "ping"
                ? { status: "ok" }
                : {};
      s.write(JSON.stringify({ id: req.id, result }) + "\n");
    });
    wireSpawnAndForward();

    const instance = await androidOpenServerBlueprint.factory(
      {} as never,
      undefined as never,
      { device: DEVICE } as never
    );
    const api = instance.api as OpenDeviceServerApi;
    // The start warm-up reads (step tap-latency) are not under test here.
    seen.length = 0;

    // No opt-in: no `flush` key on the wire.
    await api.getAccessibilityTree({});
    await api.getNestedAccessibilityTree({});
    await api.getState({});
    await api.getNestedState({});
    // Opted in: `flush:true` on the wire.
    await api.getAccessibilityTree({ flush: true });
    await api.getNestedAccessibilityTree({ flush: true });
    await api.getState({ flush: true });
    await api.getNestedState({ flush: true });
    // The standalone drain RPC.
    expect((await api.flushInput()).success).toBe(true);

    const reads = seen.filter(
      (r) => r.method === "getState" || r.method === "getAccessibilityTree"
    );
    // 8 read RPCs: 4 without flush, 4 with. (getNested* dispatch the same method names.)
    expect(reads.length).toBe(8);
    const withFlush = reads.filter((r) => r.params.flush === true);
    const withoutFlush = reads.filter((r) => !("flush" in r.params));
    expect(withFlush.length).toBe(4);
    expect(withoutFlush.length).toBe(4);
    // flushInput() went to the wire as its own RPC.
    expect(seen.some((r) => r.method === "flushInput")).toBe(true);

    await instance.dispose!();
  });

  it("emits terminated when the helper process exits unexpectedly", async () => {
    await startFakeDeviceServer((line, s) => {
      const req = JSON.parse(line) as { id: number };
      s.write(JSON.stringify({ id: req.id, result: { status: "ok" } }) + "\n");
    });
    const proc = wireSpawnAndForward();

    const instance = await androidOpenServerBlueprint.factory(
      {} as never,
      undefined as never,
      {
        device: DEVICE,
      } as never
    );

    const terminated = new Promise<Error>((resolve) => {
      instance.events!.on("terminated", (err) => resolve(err as Error));
    });
    proc.emit("exit", 1, null);
    const err = await terminated;
    expect(String(err)).toMatch(/exited/);
  });

  it("dispose sends shutdown, kills the process, and removes the forward", async () => {
    let shutdownSeen = false;
    await startFakeDeviceServer((line, s) => {
      const req = JSON.parse(line) as { id: number; method: string };
      if (req.method === "shutdown") shutdownSeen = true;
      s.write(JSON.stringify({ id: req.id, result: { status: "ok" } }) + "\n");
    });
    const proc = wireSpawnAndForward();

    const instance = await androidOpenServerBlueprint.factory(
      {} as never,
      undefined as never,
      {
        device: DEVICE,
      } as never
    );
    await instance.dispose!();

    expect(shutdownSeen).toBe(true);
    expect(proc.kill).toHaveBeenCalled();
    const removeCall = runAdb.mock.calls.find(
      (c) => (c[0] as string[]).includes("forward") && (c[0] as string[]).includes("--remove")
    );
    expect(removeCall).toBeTruthy();
    expect(instance.api.isReady()).toBe(false);
  });
});

// Step tap-latency (plan close-gaps-2026-10 item 6): the server starts cold on every
// start. In run 37609765062 describe on ON-im-2 went from 82 to 35 ms over about 40
// calls, all of it in the JSON encode. The start makes discarded describe-shaped reads
// until 40 reads or a 1500 ms budget, whichever comes first, and stops at the first
// failure. No AOT compile: the APK is a debuggable build, which ART keeps at `verify`.
describe("androidOpenServerBlueprint.factory warm-up", () => {
  /**
   * Fake device: ping/getState/shutdown answer. `getState: "error"` makes the reads
   * answer a JSON-RPC error, `"hang"` makes them never answer; `delayMs` delays each
   * getState reply.
   */
  async function startWarmupServer(
    seen: Array<{ method: string; params: Record<string, unknown> }>,
    getState: "ok" | "error" | "hang" = "ok",
    delayMs = 0
  ): Promise<void> {
    await startFakeDeviceServer((line, s) => {
      const req = JSON.parse(line) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      seen.push({ method: req.method, params: req.params ?? {} });
      if (req.method === "getState" && getState === "hang") return;
      if (req.method === "getState" && getState === "error") {
        s.write(
          JSON.stringify({ id: req.id, error: { code: -32603, message: "no window" } }) + "\n"
        );
        return;
      }
      const result =
        req.method === "getState"
          ? {
              tree: [],
              info: { screenWidth: 1080, screenHeight: 1920 },
              waitedMs: 0,
              captureMs: 0,
            }
          : { status: "ok" };
      const reply = JSON.stringify({ id: req.id, result }) + "\n";
      if (req.method === "getState" && delayMs > 0) setTimeout(() => s.write(reply), delayMs);
      else s.write(reply);
    });
  }

  const startWith = () =>
    androidOpenServerBlueprint.factory(
      {} as never,
      undefined as never,
      {
        device: DEVICE,
      } as never
    );

  it("reads until the 40-read cap, flags each read warmup:true, and records the warm-up", async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    await startWarmupServer(seen);
    wireSpawnAndForward();

    const instance = await startWith();

    expect(seen[0]!.method).toBe("ping");
    const reads = seen.filter((r) => r.method === "getState");
    expect(reads.length).toBe(40);
    for (const r of reads) {
      // The describe path's read (nested, no screenshot, no fingerprints), with no
      // idle wait, flagged so the server leaves its per-method timeline alone.
      expect(r.params.nested).toBe(true);
      expect(r.params.includeScreenshot).toBe(false);
      expect(r.params.waitTimeoutMs).toBe(0);
      expect(r.params.warmup).toBe(true);
      expect("fingerprints" in r.params).toBe(false);
    }
    const w = takeOpenServerWarmup("emulator-5554")!;
    expect(w.reads).toBe(40);
    expect(w.stoppedBy).toBe("count");
    expect(w.ms).toBeGreaterThanOrEqual(0);
    // Taken once.
    expect(takeOpenServerWarmup("emulator-5554")).toBeUndefined();
    // No AOT compile: a debuggable APK stays at `verify`.
    expect(runAdb.mock.calls.some((c) => (c[0] as string[]).includes("compile"))).toBe(false);

    await instance.dispose!();
  });

  it("stops at the 1500 ms budget when reads are slow", async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    await startWarmupServer(seen, "ok", 100);
    wireSpawnAndForward();

    const instance = await startWith();

    const w = takeOpenServerWarmup("emulator-5554")!;
    expect(w.stoppedBy).toBe("budget");
    expect(w.reads).toBeGreaterThanOrEqual(10);
    expect(w.reads).toBeLessThanOrEqual(16);
    expect(w.ms).toBeGreaterThanOrEqual(1_400);
    expect(w.ms).toBeLessThan(1_800);
    expect(instance.api.isReady()).toBe(true);

    await instance.dispose!();
  });

  it("stops at the first failed read and the start still succeeds", async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    await startWarmupServer(seen, "error");
    wireSpawnAndForward();

    const instance = await startWith();

    expect(instance.api.isReady()).toBe(true);
    expect(seen.filter((r) => r.method === "getState").length).toBe(1);
    const w = takeOpenServerWarmup("emulator-5554")!;
    expect(w.stoppedBy).toBe("error");
    expect(w.reads).toBe(0);

    await instance.dispose!();
  });

  it("a read that never answers is cut at the budget", async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    await startWarmupServer(seen, "hang");
    wireSpawnAndForward();

    const t0 = Date.now();
    const instance = await startWith();
    const elapsed = Date.now() - t0;

    expect(instance.api.isReady()).toBe(true);
    expect(seen.filter((r) => r.method === "getState").length).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(2_500);
    expect(takeOpenServerWarmup("emulator-5554")!.stoppedBy).toBe("budget");

    // The timed-out read dropped the socket; the next call reconnects.
    lastConn?.destroy();
    await instance.dispose!();
  });
});

// Step tap-latency: tap is 1.5 ms slower than the official stack (CI [1.1, 2.0]) and
// it was never explained. `timing: true` asks the device for per-stage timings and
// adds the host's view of the same RPC, so the next bench run can split the gap.
describe("androidOpenServerBlueprint tap timing", () => {
  it("tap({timing:true}) sends timing:true and returns the RPC and device stages", async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    await startFakeDeviceServer((line, s) => {
      const req = JSON.parse(line) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      seen.push({ method: req.method, params: req.params ?? {} });
      const result =
        req.method === "tap"
          ? {
              success: true,
              strategy: "input-manager",
              stages: { parseMs: 0.2, injectMs: 50.4, injectOverheadMs: 0.4, handleMs: 50.9 },
            }
          : req.method === "getState"
            ? { tree: [], info: {}, waitedMs: 0, captureMs: 0 }
            : { status: "ok" };
      s.write(JSON.stringify({ id: req.id, result }) + "\n");
    });
    wireSpawnAndForward();

    const instance = await androidOpenServerBlueprint.factory(
      {} as never,
      undefined as never,
      { device: DEVICE } as never
    );
    const api = instance.api as OpenDeviceServerApi;
    seen.length = 0;

    const res = await api.tap(10, 20, { holdMs: 50, timing: true });
    expect(res.success).toBe(true);
    const tapReq = seen.find((r) => r.method === "tap")!;
    expect(tapReq.params.timing).toBe(true);

    expect(res.stages?.device).toEqual({
      parseMs: 0.2,
      injectMs: 50.4,
      injectOverheadMs: 0.4,
      handleMs: 50.9,
    });
    const rpc = res.stages!.rpc;
    for (const k of [
      "sendMs",
      "sentToFirstByteMs",
      "firstToLastByteMs",
      "roundTripMs",
      "parseMs",
      "rpcMs",
      "wireBytes",
    ] as const) {
      expect(typeof rpc[k]).toBe("number");
      expect(rpc[k]).toBeGreaterThanOrEqual(0);
    }
    // The whole RPC as the caller sees it covers the wire round trip and the parse.
    expect(rpc.rpcMs).toBeGreaterThanOrEqual(rpc.roundTripMs);
    // The device's own `stages` member is moved under `stages.device`, not duplicated.
    expect(Object.keys(res.stages!).sort()).toEqual(["device", "rpc"]);

    await instance.dispose!();
  });

  it("a plain tap sends no `timing` key and returns no stages", async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    await startFakeDeviceServer((line, s) => {
      const req = JSON.parse(line) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      seen.push({ method: req.method, params: req.params ?? {} });
      const result =
        req.method === "tap"
          ? { success: true }
          : req.method === "getState"
            ? { tree: [], info: {}, waitedMs: 0, captureMs: 0 }
            : { status: "ok" };
      s.write(JSON.stringify({ id: req.id, result }) + "\n");
    });
    wireSpawnAndForward();

    const instance = await androidOpenServerBlueprint.factory(
      {} as never,
      undefined as never,
      { device: DEVICE } as never
    );
    const api = instance.api as OpenDeviceServerApi;
    seen.length = 0;

    const res = await api.tap(10, 20, { holdMs: 50 });
    expect(res).toEqual({ success: true });
    const tapReq = seen.find((r) => r.method === "tap")!;
    expect("timing" in tapReq.params).toBe(false);

    await instance.dispose!();
  });
});
