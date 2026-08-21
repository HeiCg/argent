import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { createDebuggerLogRegistryTool } from "../../src/tools/debugger/debugger-log-registry";
import { createDebuggerStatusTool } from "../../src/tools/debugger/debugger-status";
import { resolveDebuggerService } from "../../src/tools/debugger/not-connected";
import { __resetReapedSessionsForTesting } from "../../src/utils/reaped-sessions";

/**
 * The console log file must outlive the app: when the CDP socket drops
 * (the app crashed or was force-quit) the registry's terminated cascade
 * disposes the debugger service, and the log written before the crash is
 * exactly the artifact the developer came for.
 */

// The console-log server's bind is the one hard-failure path inside the
// factory, reached through `http.createServer`. Everything else here — this
// file's own mock Metro included — needs a working one, so the flag is off by
// default and flipped for exactly one call.
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

const logDir = () => path.join(os.homedir(), ".argent", "tmp");

let mockServer: http.Server;
let wss: WebSocketServer;
let cdpConn: WebSocket | null = null;
let mockPort: number;
/** A crashed app stops being listed by Metro, which is how the tools find out. */
let targetsGone = false;
let registry: Registry;

function handleCDPMessage(ws: WebSocket, raw: string) {
  const msg = JSON.parse(raw);
  const { id, method } = msg;
  if (method === "Debugger.enable") {
    ws.send(JSON.stringify({ id, result: { debuggerId: "mock-debugger" } }));
    ws.send(
      JSON.stringify({
        method: "Debugger.scriptParsed",
        params: {
          scriptId: "1",
          url: "http://localhost/index.bundle?platform=ios&dev=true",
          startLine: 0,
          endLine: 50000,
        },
      })
    );
    return;
  }
  ws.send(JSON.stringify({ id, result: {} }));
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    mockServer = http.createServer((req, res) => {
      if (req.url === "/status") {
        res.setHeader("X-React-Native-Project-Root", "/mock/project");
        res.end("packager-status:running");
        return;
      }
      if (req.url === "/json/list") {
        res.setHeader("Content-Type", "application/json");
        if (targetsGone) {
          res.end("[]");
          return;
        }
        res.end(
          JSON.stringify([
            {
              id: "page-1",
              title: "React Native (mock)",
              description: "[C++ connection]",
              webSocketDebuggerUrl: `ws://localhost:${mockPort}/inspector/debug?device=0&page=1`,
              deviceName: "MockDevice",
              reactNative: { capabilities: { prefersFuseboxFrontend: true } },
            },
          ])
        );
        return;
      }
      res.statusCode = 404;
      res.end("Not found");
    });

    wss = new WebSocketServer({ server: mockServer });
    wss.on("connection", (ws) => {
      cdpConn = ws;
      ws.on("message", (r) => handleCDPMessage(ws, r.toString()));
    });

    mockServer.listen(0, () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });

  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(debuggerConnectTool);
  registry.registerTool(createDebuggerLogRegistryTool(registry));
  registry.registerTool(createDebuggerStatusTool(registry));
});

afterAll(async () => {
  await registry.dispose();
  cdpConn?.close();
  await new Promise<void>((resolve) => {
    wss.close(() => mockServer.close(() => resolve()));
  });
});

describe("console logs across an app crash", () => {
  it("keeps the log file on disk when the CDP socket drops", async () => {
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "mock-device" });

    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "CRITICAL pre-crash error" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));

    const before = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "mock-device",
    })) as { file: string; totalEntries: number };

    expect(before.totalEntries).toBe(1);
    const logPath = before.file;
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");

    // The app dies: socket terminated server-side, no close handshake.
    cdpConn!.terminate();
    await new Promise((r) => setTimeout(r, 500));

    // The file the tool already handed to the caller must still be readable.
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");

    fs.rmSync(logPath, { force: true });
  });

  it("points a post-crash reader at the file the crash left behind", async () => {
    // The half the surviving file does not fix on its own: an agent that only
    // calls `debugger-log-registry` AFTER the crash resolves a fresh session
    // and reads `totalEntries: 0`. The teardown breadcrumb is what stops that
    // being read as "the app logged nothing" — and because this teardown KEPT
    // the file, the breadcrumb has to name it rather than report a deletion.
    __resetReapedSessionsForTesting();
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "crash-note" });

    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "CRITICAL pre-crash error" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));

    const { file: logPath } = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "crash-note",
    })) as { file: string };

    cdpConn!.terminate();
    await new Promise((r) => setTimeout(r, 500));

    const after = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "crash-note",
    })) as { totalEntries: number; file: string; note?: string };

    expect(after.totalEntries).toBe(0);
    expect(after.file).not.toBe(logPath);
    expect(after.note).toBeDefined();
    // The path, and a file actually there to be read at it.
    expect(after.note).toContain(logPath);
    expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");
    // Never the reaped-by-stop-all wording: nothing was deleted here.
    expect(after.note).not.toContain("no log file was left behind");
    // And never the teardown family either. No tool was called and no other
    // agent was involved — the app crashed — so a note that opens by blaming a
    // stop-all sends the reader after a cause that does not exist, then
    // contradicts itself with a salvage clause about a dead runtime.
    expect(after.note).toContain("its debugger connection dropped instead of being closed");
    expect(after.note).not.toContain("stop-all-simulator-servers");
    expect(after.note).not.toContain("another agent");

    fs.rmSync(logPath, { force: true });
  });

  it("names the kept file when the crashed app has dropped off Metro's target list", async () => {
    // What a crash actually looks like to the next tool call: the app is gone
    // from `/json/list`, so resolving a session fails and
    // `debugger-log-registry` answers `not_connected` instead of an empty
    // registry. That answer is the whole conversation — the breadcrumb is
    // consumed nowhere else on this path, and the guidance's restart-app leaves
    // no trace of the app that died — so it has to carry the path itself.
    __resetReapedSessionsForTesting();
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "gone-target" });
    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "CRITICAL pre-crash error" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));
    const { file: logPath } = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "gone-target",
    })) as { file: string };

    cdpConn!.terminate();
    await new Promise((r) => setTimeout(r, 500));
    targetsGone = true;

    try {
      const after = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: "gone-target",
      })) as { status: string; reason: string; note?: string };

      expect(after.status).toBe("not_connected");
      expect(after.reason).toBe("no_app_connected");
      expect(after.note).toBeDefined();
      expect(after.note).toContain(logPath);
      expect(after.note).toContain("its debugger connection dropped instead of being closed");
      expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");
    } finally {
      targetsGone = false;
      fs.rmSync(logPath, { force: true });
    }
  });

  it("reports the kept file from debugger-connect, the step crash recovery prescribes", async () => {
    // `debugger-connect` consumes the breadcrumb — deliberately, so a stale one
    // cannot explain some later unrelated empty read — and it is also exactly
    // where the crash-recovery guidance sends the agent (`debugger-status`'s
    // stale_connection guidance, and the skill's "app may have crashed" row,
    // both say restart-app then debugger-connect). Consuming it silently makes
    // the kept file unreachable: nothing else records the path, and the
    // reconnected session stops being empty — the one state
    // `debugger-log-registry` reports a breadcrumb in — as soon as the
    // relaunched app logs a line.
    __resetReapedSessionsForTesting();
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "reconnect-note" });
    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "CRITICAL pre-crash error" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));
    const { file: logPath } = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "reconnect-note",
    })) as { file: string };

    cdpConn!.terminate();
    await new Promise((r) => setTimeout(r, 500));

    const reconnect = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: "reconnect-note",
    })) as { note?: string };

    expect(reconnect.note).toBeDefined();
    expect(reconnect.note).toContain(logPath);
    expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");

    fs.rmSync(logPath, { force: true });
  });

  it("keeps the log when debugger-status disposes the session in the CLOSING window", async () => {
    // The sibling teardown on the same dying runtime. `debugger-status`'s
    // stale_connection branch fires only when the socket has stopped being OPEN
    // and the close event has not dispatched yet — i.e. the far end has already
    // gone — and it disposes the service to force a fresh reconnect. Reading
    // just the `disconnected` event would call that an explicit teardown and
    // unlink the pre-crash log; the socket state is what makes it a death.
    //
    // The window is real but lasts a handful of microtasks, so it is held open
    // here at the seam the production code consults.
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "closing-device" });
    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "CRITICAL pre-crash error" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));

    const before = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "closing-device",
    })) as { file: string; totalEntries: number };
    expect(before.totalEntries).toBe(1);

    const api = await resolveDebuggerService(registry, {
      port: mockPort,
      device_id: "closing-device",
    });
    const socketClosing = vi.spyOn(api.cdp, "isConnected").mockReturnValue(false);
    const status = (await registry.invokeTool("debugger-status", {
      port: mockPort,
      device_id: "closing-device",
    })) as { reason?: string };
    socketClosing.mockRestore();

    expect(status.reason).toBe("stale_connection");
    expect(fs.existsSync(before.file)).toBe(true);
    expect(fs.readFileSync(before.file, "utf-8")).toContain("CRITICAL pre-crash error");

    fs.rmSync(before.file, { force: true });
  });

  it("keeps nothing when the app dies without having logged", async () => {
    // `keepFile` is gated on the same `captured` the breadcrumb is: a death that
    // captured nothing leaves an empty file that no breadcrumb names and that
    // the pruner only reclaims a day later — one per disconnect.
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "silent-device" });
    const { file } = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "silent-device",
    })) as { file: string };
    expect(fs.existsSync(file)).toBe(true);

    cdpConn!.terminate();
    await new Promise((r) => setTimeout(r, 500));

    expect(fs.existsSync(file)).toBe(false);
  });

  it("closes the log writer when the factory throws before a dispose exists", async () => {
    // Nothing else can ever close that writer — the factory never returns a
    // dispose — so its fd, its file and its hourly keepalive would last as long
    // as the process, and the keepalive would hold the file out of
    // `pruneStaleLogs` for exactly that long.
    const before = new Set(fs.readdirSync(logDir()));
    const socketsBefore = wss.clients.size;
    httpControl.failCreateServer = true;
    try {
      await expect(
        registry.invokeTool("debugger-connect", { port: mockPort, device_id: "throwing-device" })
      ).rejects.toThrow(/no sockets left/);
    } finally {
      httpControl.failCreateServer = false;
    }

    expect(fs.readdirSync(logDir()).filter((n) => !before.has(n))).toEqual([]);
    // The CDP socket the factory opened on the way here is the other thing
    // nothing would ever close.
    for (let i = 0; i < 40 && wss.clients.size > socketsBefore; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(wss.clients.size).toBe(socketsBefore);
  });

  it("says the log file could not be created rather than sending a reader to grep it", async () => {
    // `open()` swallows its failure and buffers, so the counts and clusters are
    // real while `file` names a path that has never existed — and the documented
    // next step is to grep exactly that path.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "argent-ro-home-"));
    const logs = path.join(tmpHome, ".argent", "tmp");
    fs.mkdirSync(logs, { recursive: true });
    fs.chmodSync(logs, 0o555);
    const savedHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "nofile-device" });

      // Before anything is logged: an unwritable directory shows up here first,
      // and an empty registry handing back a path is the same trap.
      const empty = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: "nofile-device",
      })) as { totalEntries: number; note?: string };
      expect(empty.totalEntries).toBe(0);
      expect(empty.note).toContain("could not be created");

      cdpConn!.send(
        JSON.stringify({
          method: "Runtime.consoleAPICalled",
          params: {
            type: "error",
            args: [{ type: "string", value: "buffered only" }],
            executionContextId: 1,
            timestamp: Date.now(),
          },
        })
      );
      await new Promise((r) => setTimeout(r, 200));

      const result = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: "nofile-device",
      })) as { totalEntries: number; file: string; note?: string };

      expect(result.totalEntries).toBe(1);
      expect(fs.existsSync(result.file)).toBe(false);
      expect(result.note).toContain("could not be created");
      expect(result.note).toContain(result.file);
    } finally {
      fs.chmodSync(logs, 0o755);
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("removes the log file on an explicit teardown", async () => {
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "explicit-device" });
    const { file } = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "explicit-device",
    })) as { file: string };
    expect(fs.existsSync(file)).toBe(true);

    await registry.disposeService(`JsRuntimeDebugger:${mockPort}:explicit-device`);

    expect(fs.existsSync(file)).toBe(false);
  });
});
