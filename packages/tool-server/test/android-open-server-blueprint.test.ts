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

import { androidOpenServerBlueprint } from "../src/blueprints/android-open-server";
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
      if (req.method === "ping")
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
          ? { tree: [], info: { screenWidth: 1080, screenHeight: 1920 }, screenshot: "", waitedMs: 0, captureMs: 0, version: 0 }
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
    const plainNested = getStateReqs.find((r) => r.params.nested === true && !r.params.fingerprints);
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
          ? { tree: [], info: { screenWidth: 1080, screenHeight: 1920 }, screenshot: "", waitedMs: 0, captureMs: 0, version: 0 }
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

    const reads = seen.filter((r) => r.method === "getState" || r.method === "getAccessibilityTree");
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

