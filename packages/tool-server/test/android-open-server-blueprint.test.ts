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
