import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import * as fs from "node:fs";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { createDebuggerLogRegistryTool } from "../../src/tools/debugger/debugger-log-registry";
import { __resetReapedSessionsForTesting } from "../../src/utils/reaped-sessions";

/**
 * The console log file must outlive the app: when the CDP socket drops
 * (the app crashed or was force-quit) the registry's terminated cascade
 * disposes the debugger service, and the log written before the crash is
 * exactly the artifact the developer came for.
 */

let mockServer: http.Server;
let wss: WebSocketServer;
let cdpConn: WebSocket | null = null;
let mockPort: number;
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
    expect(after.note).not.toContain("deleted on teardown");

    fs.rmSync(logPath, { force: true });
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
