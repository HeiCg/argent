import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TypedEventEmitter } from "@argent/registry";
import {
  chromiumJsRuntimeDebuggerBlueprint,
  chromiumJsRuntimeDebuggerRef,
  CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE,
} from "../src/blueprints/chromium-js-runtime-debugger";
import { resolveDevice } from "../src/utils/device-info";
import type { ChromiumCdpApi } from "../src/blueprints/chromium-cdp";
import type { CDPClientEvents } from "../src/utils/debugger/cdp-client";
import { takeReapedSession, __resetReapedSessionsForTesting } from "../src/utils/reaped-sessions";

function makeFakeChromiumCdpApi(): {
  api: ChromiumCdpApi;
  events: TypedEventEmitter<CDPClientEvents>;
  sendSpy: ReturnType<typeof vi.fn>;
  addBindingSpy: ReturnType<typeof vi.fn>;
} {
  const events = new TypedEventEmitter<CDPClientEvents>();
  const sendSpy = vi.fn().mockResolvedValue({});
  const addBindingSpy = vi.fn().mockResolvedValue(undefined);
  const cdp = {
    events,
    isConnected: () => true,
    send: sendSpy,
    evaluate: vi.fn().mockResolvedValue(null),
    addBinding: addBindingSpy,
    getLoadedScripts: () => new Map(),
    getEnabledDomains: () => new Set<string>(),
  };
  // Cast through unknown — the blueprint only touches `cdp`, `port`, and
  // the events the test exercises, so a partial fake is fine.
  const api = {
    port: 19222,
    cdp,
  } as unknown as ChromiumCdpApi;
  return { api, events, sendSpy, addBindingSpy };
}

const logDir = () => path.join(os.homedir(), ".argent", "tmp");

// The console-log server's bind is the one hard-failure path inside the factory,
// and it is reached through `http.createServer`. Every other case in this file
// needs a working one, so the flag is off by default.
const httpControl = vi.hoisted(() => ({ failCreateServer: false }));
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    default: actual,
    createServer: (...args: unknown[]) => {
      if (httpControl.failCreateServer) throw new Error("no sockets left");
      return (actual.createServer as (...a: unknown[]) => unknown)(...args);
    },
  };
});

describe("ChromiumJsRuntimeDebugger blueprint", () => {
  const chromiumDevice = resolveDevice("chromium-cdp-19222");

  it("namespace + URN + ref are stable", () => {
    expect(CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE).toBe("ChromiumJsRuntimeDebugger");
    expect(chromiumJsRuntimeDebuggerBlueprint.namespace).toBe("ChromiumJsRuntimeDebugger");
    expect(chromiumJsRuntimeDebuggerBlueprint.getURN("chromium-cdp-9222")).toBe(
      "ChromiumJsRuntimeDebugger:chromium-cdp-9222"
    );
    const ref = chromiumJsRuntimeDebuggerRef(chromiumDevice);
    expect(ref.urn).toBe("ChromiumJsRuntimeDebugger:chromium-cdp-19222");
    expect(ref.options.device).toEqual(chromiumDevice);
  });

  it("declares ChromiumCdp as its dep so the registry resolves the page session first", () => {
    const deps = chromiumJsRuntimeDebuggerBlueprint.getDependencies!("chromium-cdp-19222");
    expect(deps).toEqual({ chromium: "ChromiumCdp:chromium-cdp-19222" });
  });

  it("factory rejects without options.device", async () => {
    await expect(
      chromiumJsRuntimeDebuggerBlueprint.factory(
        { chromium: makeFakeChromiumCdpApi().api },
        "chromium-cdp-19222",
        undefined
      )
    ).rejects.toThrow(/requires a resolved DeviceInfo/);
  });

  it("factory rejects when options.device.id disagrees with the payload", async () => {
    await expect(
      chromiumJsRuntimeDebuggerBlueprint.factory(
        { chromium: makeFakeChromiumCdpApi().api },
        "chromium-cdp-19222",
        { device: resolveDevice("chromium-cdp-9999") }
      )
    ).rejects.toThrow(/payload .* does not match/);
  });

  it("factory: produces a JsRuntimeDebuggerApi-shaped object and subscribes to consoleAPICalled", async () => {
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    try {
      expect(instance.api.port).toBe(19222);
      expect(instance.api.projectRoot).toBe("");
      expect(instance.api.logicalDeviceId).toBe("chromium-cdp-19222");
      expect(instance.api.isNewDebugger).toBe(true);
      expect(instance.api.cdp).toBe(fake.api.cdp);
      // sourceResolver / sourceMaps stubs exist (only used by locked-out
      // inspect-element, but the type contract must hold).
      expect(typeof instance.api.sourceResolver.symbolicate).toBe("function");
      expect(typeof instance.api.sourceMaps.waitForPending).toBe("function");
      await expect(instance.api.sourceMaps.waitForPending()).resolves.toBeUndefined();

      // Console events from the CDP feed through to the api's consoleEvents.
      const received: unknown[] = [];
      instance.api.consoleEvents.on("log", (entry) => received.push(entry));
      fake.events.emit("consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: "hello" }],
        timestamp: Date.now(),
      });
      expect(received).toHaveLength(1);
      expect((received[0] as { message: string }).message).toBe("hello");

      // Binding is registered best-effort so future tools using
      // evaluateWithBinding don't need their own setup.
      expect(fake.addBindingSpy).toHaveBeenCalledWith("__argent_callback");
    } finally {
      await instance.dispose();
    }
  });

  it("dispose unsubscribes from the underlying CDP — events do NOT keep firing", async () => {
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    const received: unknown[] = [];
    instance.api.consoleEvents.on("log", (entry) => received.push(entry));
    await instance.dispose();
    fake.events.emit("consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "after-dispose" }],
      timestamp: Date.now(),
    });
    expect(received).toHaveLength(0);
  });

  it("dispose leaves a reaped-session breadcrumb when it deletes captured history", async () => {
    // `debugger-log-registry` documents itself as working against Hermes AND
    // V8, and promises that an empty registry with no `note` means the app
    // logged nothing. `logWriter.close()` here unlinks the log file, and since
    // ChromiumJsRuntimeDebugger joined DEVICE_OWNED_NAMESPACES a
    // stop-all-simulator-servers (or a stop-simulator-server cascading through
    // ChromiumCdp) routinely triggers this dispose. Without the breadcrumb the
    // promise is false on V8: destroyed history reads as a silent app.
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    for (let i = 0; i < 18; i++) {
      instance.api.logWriter.write({
        id: i,
        timestamp: new Date(1710000000000 + i * 1000).toISOString(),
        level: "log",
        message: `captured ${i}`,
      });
    }
    await instance.dispose();

    const reaped = takeReapedSession("js-runtime-debugger", "chromium-cdp-19222");
    expect(reaped).toBeDefined();
    expect(reaped!.salvage).toContain("18 captured console entries");
    // A live socket at dispose is a teardown, and a teardown deletes the file.
    // Both readings are what `describeReapedSession` turns into "another agent
    // may have done this" rather than "your app died", and into a deletion
    // rather than a path.
    expect(reaped!.cause).toBe("teardown");
    expect(reaped!.keptAt).toBeUndefined();
    expect(reaped!.salvage).toContain("deleted on teardown");
  });

  it("keeps the log file and names it in the breadcrumb when the renderer died", async () => {
    // The V8 half of the Hermes crash case: a `disconnected` means the renderer
    // is gone, so dispose keeps the captured log instead of unlinking it — and
    // the breadcrumb must then point at that file rather than report a
    // deletion, which is what the caller reads after the registry restarts
    // empty.
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    instance.api.logWriter.write({
      id: 1,
      timestamp: new Date(1710000000000).toISOString(),
      level: "error",
      message: "CRITICAL pre-crash error",
    });
    const logPath = instance.api.logWriter.getFilePath();

    fake.events.emit("disconnected", new Error("renderer gone"));
    await instance.dispose();

    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");

    const reaped = takeReapedSession("js-runtime-debugger", "chromium-cdp-19222");
    expect(reaped?.salvage).toContain(logPath);
    expect(reaped?.salvage).not.toContain("deleted on teardown");
    // Blaming a stop-all for a renderer that died sends the reader hunting for
    // a tool call that never happened.
    expect(reaped?.cause).toBe("runtime-death");
    expect(reaped?.keptAt).toBe(logPath);

    fs.rmSync(logPath, { force: true });
  });

  it("keeps the log when the renderer's death cascades a teardown in before our listener runs", async () => {
    // What the direct-dispose case above does not model, and what production
    // actually does: `CDPClient` nulls its socket and then emits `disconnected`;
    // `ChromiumCdp` — registered on that event first, because its service is
    // built first — synchronously cascades a teardown into this service, and
    // this dispose unregisters its own handler while the emit is still walking
    // the listener set. `TypedEventEmitter` iterates the live set, so the
    // handler is skipped and never runs. Reading only the event therefore reads
    // false on exactly the path the keep-the-log rule exists for; against a real
    // headless Chrome, closing the connected tab deleted the pre-crash log.
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    let socketOpen = true;
    (fake.api.cdp as unknown as { isConnected: () => boolean }).isConnected = () => socketOpen;

    // Registered BEFORE the factory, as `ChromiumCdp`'s is in production —
    // that ordering is what makes this cascade land mid-emit, ahead of the
    // blueprint's own handler.
    const created: {
      instance?: Awaited<ReturnType<typeof chromiumJsRuntimeDebuggerBlueprint.factory>>;
    } = {};
    fake.events.on("disconnected", () => {
      void created.instance!.dispose();
    });

    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    created.instance = instance;
    instance.api.logWriter.write({
      id: 1,
      timestamp: new Date(1710000000000).toISOString(),
      level: "error",
      message: "CRITICAL pre-crash error",
    });
    const logPath = instance.api.logWriter.getFilePath();

    socketOpen = false;
    fake.events.emit("disconnected", new Error("renderer gone"));
    await new Promise((r) => setImmediate(r));

    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");
    const reaped = takeReapedSession("js-runtime-debugger", "chromium-cdp-19222");
    expect(reaped?.cause).toBe("runtime-death");
    expect(reaped?.salvage).toContain(logPath);

    fs.rmSync(logPath, { force: true });
  });

  it("closes the log writer when the factory throws before a dispose exists", async () => {
    // The console-log server bind is a documented hard-failure path, and it runs
    // after the writer is open. Nothing else can ever close that writer — the
    // factory never returns a dispose — so its fd, its file and its hourly
    // keepalive would last as long as the process, and the keepalive would keep
    // the file out of `pruneStaleLogs` for exactly that long.
    const before = new Set(fs.readdirSync(logDir()));
    httpControl.failCreateServer = true;
    try {
      await expect(
        chromiumJsRuntimeDebuggerBlueprint.factory(
          { chromium: makeFakeChromiumCdpApi().api },
          "chromium-cdp-19222",
          { device: chromiumDevice }
        )
      ).rejects.toThrow(/no sockets left/);
    } finally {
      httpControl.failCreateServer = false;
    }
    const leaked = fs.readdirSync(logDir()).filter((n) => !before.has(n));
    expect(leaked).toEqual([]);
  });

  it("keeps nothing when the renderer dies without having logged", async () => {
    // `keepFile` is gated on the same `captured` the breadcrumb is: a death that
    // captured nothing leaves an empty file that no breadcrumb names and that
    // the pruner only reclaims a day later — one per disconnect.
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    const logPath = instance.api.logWriter.getFilePath();

    fake.events.emit("disconnected", new Error("renderer gone"));
    await instance.dispose();

    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("dispose leaves NO breadcrumb when there was no history to lose", async () => {
    // A dispose of a session that captured nothing destroyed nothing, and
    // claiming otherwise would make every empty registry look like a lost one.
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    await instance.dispose();
    expect(takeReapedSession("js-runtime-debugger", "chromium-cdp-19222")).toBeUndefined();
  });

  it("dispose does NOT disconnect the underlying CDP — that belongs to ChromiumCdp", async () => {
    const fake = makeFakeChromiumCdpApi();
    // Track whether anything calls disconnect on the cdp.
    const disconnect = vi.fn();
    (fake.api.cdp as unknown as { disconnect: typeof disconnect }).disconnect = disconnect;
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    await instance.dispose();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("cdp.disconnected → events.terminated propagation, with the original error preserved", async () => {
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    try {
      const terminated: Array<Error | undefined> = [];
      instance.events.on("terminated", (err) => terminated.push(err));
      const cause = new Error("websocket closed by peer");
      fake.events.emit("disconnected", cause);
      expect(terminated).toHaveLength(1);
      expect(terminated[0]).toBe(cause);
    } finally {
      await instance.dispose();
    }
  });

  it("cdp.disconnected with no error still emits a terminated event with a synthetic Error", async () => {
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    try {
      const terminated: Array<Error | undefined> = [];
      instance.events.on("terminated", (err) => terminated.push(err));
      fake.events.emit("disconnected", undefined);
      expect(terminated).toHaveLength(1);
      expect(terminated[0]).toBeInstanceOf(Error);
      expect((terminated[0] as Error).message).toMatch(/Chromium CDP disconnected/);
    } finally {
      await instance.dispose();
    }
  });

  it("dispose detaches the disconnected listener — no terminated emission after dispose", async () => {
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    const terminated: unknown[] = [];
    instance.events.on("terminated", (err) => terminated.push(err));
    await instance.dispose();
    fake.events.emit("disconnected", new Error("late"));
    expect(terminated).toHaveLength(0);
  });

  it("a non-finite consoleAPICalled.timestamp is coerced — entry is captured, not silently dropped", async () => {
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    try {
      const received: Array<{ message: string; timestamp: number }> = [];
      instance.api.consoleEvents.on("log", (entry) =>
        received.push({ message: entry.message, timestamp: entry.timestamp })
      );
      const before = Date.now();
      fake.events.emit("consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: "nan-test" }],
        timestamp: Number.NaN,
      });
      const after = Date.now();
      expect(received).toHaveLength(1);
      expect(received[0].message).toBe("nan-test");
      // Coerced to Date.now() — must be finite and within the call window.
      expect(Number.isFinite(received[0].timestamp)).toBe(true);
      expect(received[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(received[0].timestamp).toBeLessThanOrEqual(after);
    } finally {
      await instance.dispose();
    }
  });
});
