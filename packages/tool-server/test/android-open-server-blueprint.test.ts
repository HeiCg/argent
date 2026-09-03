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

// Fast-inject seam (phase 3f): a controllable fake scrcpy backend so we can drive
// the success path (touch goes to scrcpy; flush folds into the next read) and the
// failure path (scrcpy throws → fall back to the Kotlin RPC + count it), with no
// real @yume-chan / device.
const fi = vi.hoisted(() => ({
  tapImpl: async (_x: number, _y: number, _o?: unknown): Promise<void> => {},
  swipeImpl: async (): Promise<void> => {},
  gestureImpl: async (): Promise<void> => {},
  disposed: false,
}));
vi.mock("../src/utils/scrcpy-inject-backend", () => ({
  createScrcpyInjectBackend: () => ({
    tap: (x: number, y: number, o?: unknown) => fi.tapImpl(x, y, o),
    swipe: (...a: unknown[]) => (fi.swipeImpl as (...a: unknown[]) => Promise<void>)(...a),
    gesture: (...a: unknown[]) => (fi.gestureImpl as (...a: unknown[]) => Promise<void>)(...a),
    dispose: async () => {
      fi.disposed = true;
    },
  }),
}));

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


// A fake device server that records every JSON-RPC request and answers a fixed
// result map — lets a test assert which methods (and params) actually hit Kotlin.
async function startRecordingServer(
  recorded: Array<{ method: string; params: Record<string, unknown> }>
): Promise<void> {
  await startFakeDeviceServer((line, s) => {
    const req = JSON.parse(line) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    recorded.push({ method: req.method, params: req.params ?? {} });
    const results: Record<string, unknown> = {
      ping: { status: "ok" },
      getInfo: { screenWidth: 1080, screenHeight: 1920, currentPackage: "x", keyboardVisible: false, displayRotation: 0 },
      tap: { success: true },
      swipe: { success: true },
      gesture: { success: true },
      flushInput: { success: true },
      getState: { tree: [], info: {}, waitedMs: 0, captureMs: 0 },
      getAccessibilityTree: { tree: [] },
    };
    s.write(JSON.stringify({ id: req.id, result: results[req.method] ?? {} }) + "\n");
  });
}

describe("androidOpenServerBlueprint fast-inject seam (phase 3f)", () => {
  beforeEach(() => {
    fi.tapImpl = async () => {};
    fi.swipeImpl = async () => {};
    fi.gestureImpl = async () => {};
    fi.disposed = false;
  });

  it("folds the flush into the next read (no per-action flushInput RPC) — item 2", async () => {
    const recorded: Array<{ method: string; params: Record<string, unknown> }> = [];
    await startRecordingServer(recorded);
    wireSpawnAndForward();
    const instance = await androidOpenServerBlueprint.factory({} as never, undefined as never, {
      device: DEVICE,
      fastInject: "scrcpy",
    } as never);
    const api = instance.api as OpenDeviceServerApi;

    // Success path: the tap goes to scrcpy, so NO Kotlin "tap" and NO "flushInput".
    await api.tap(100, 200);
    expect(recorded.some((r) => r.method === "tap")).toBe(false);
    expect(recorded.some((r) => r.method === "flushInput")).toBe(false);

    // The next read carries flush:true (the fold), draining the queue inline.
    await api.getNestedState();
    const firstState = recorded.filter((r) => r.method === "getState");
    expect(firstState).toHaveLength(1);
    expect(firstState[0]!.params.flush).toBe(true);

    // A second read with no intervening inject does NOT flush (pending cleared).
    await api.getNestedState();
    const allState = recorded.filter((r) => r.method === "getState");
    expect(allState).toHaveLength(2);
    expect(allState[1]!.params.flush).toBeUndefined();

    // Still no separate flushInput RPC anywhere.
    expect(recorded.some((r) => r.method === "flushInput")).toBe(false);

    await instance.dispose!();
  });

  it("falls back to the Kotlin channel on a scrcpy error and counts it — item 3", async () => {
    const recorded: Array<{ method: string; params: Record<string, unknown> }> = [];
    await startRecordingServer(recorded);
    wireSpawnAndForward();
    const instance = await androidOpenServerBlueprint.factory({} as never, undefined as never, {
      device: DEVICE,
      fastInject: "scrcpy",
    } as never);
    const api = instance.api as OpenDeviceServerApi;

    // scrcpy tap fails → the closure must re-enter the Kotlin `tap` RPC (never the
    // tool-level proprietary fallback) and still report success.
    fi.tapImpl = async () => {
      throw new Error("scrcpy control channel down");
    };
    const res = await api.tap(5, 6);
    expect(res.success).toBe(true);
    const kotlinTap = recorded.find((r) => r.method === "tap");
    expect(kotlinTap).toBeTruthy();
    expect(kotlinTap!.params).toMatchObject({ x: 5, y: 6 });

    // The fallback is counted and surfaced on getInfo (not silently swallowed).
    const info = await api.getInfo();
    expect(info.fastInjectFallbacks).toBe(1);

    await instance.dispose!();
  });
});
