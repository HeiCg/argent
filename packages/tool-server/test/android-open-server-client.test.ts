import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { AndroidOpenServerClient } from "../src/utils/android-open-server-client";

/**
 * Ported from device-stream's android-rpc client tests: framing, id correlation,
 * per-request timeout, single-in-flight serialization, and lazy reconnect after a
 * drop. Each test stands up a real loopback TCP server speaking newline-delimited
 * JSON-RPC 2.0, exactly as the on-device server does over `adb forward`.
 */

interface FakeServer {
  port: number;
  close: () => Promise<void>;
  connections: net.Socket[];
}

type LineHandler = (line: string, socket: net.Socket) => void;

async function startServer(onLine: LineHandler): Promise<FakeServer> {
  const connections: net.Socket[] = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line, socket);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of connections) c.destroy();
        server.close(() => resolve());
      }),
  };
}

const reply = (socket: net.Socket, obj: unknown) => socket.write(JSON.stringify(obj) + "\n");

let servers: FakeServer[] = [];
let clients: AndroidOpenServerClient[] = [];
afterEach(async () => {
  for (const c of clients) c.close();
  for (const s of servers) await s.close();
  servers = [];
  clients = [];
});

function makeClient(port: number, timeoutMs?: number): AndroidOpenServerClient {
  const c = new AndroidOpenServerClient("127.0.0.1", port, timeoutMs ? { timeoutMs } : {});
  clients.push(c);
  return c;
}

describe("AndroidOpenServerClient", () => {
  it("resolves a request with the reply's result, correlated by id", async () => {
    const s = await startServer((line, socket) => {
      const req = JSON.parse(line) as { id: number; method: string };
      reply(socket, { jsonrpc: "2.0", id: req.id, result: { status: "ok", echoed: req.method } });
    });
    servers.push(s);
    const c = makeClient(s.port);
    const res = (await c.request("ping")) as { status: string; echoed: string };
    expect(res.status).toBe("ok");
    expect(res.echoed).toBe("ping");
  });

  it("rejects with the RPC error message", async () => {
    const s = await startServer((line, socket) => {
      const req = JSON.parse(line) as { id: number };
      reply(socket, { jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "boom" } });
    });
    servers.push(s);
    const c = makeClient(s.port);
    await expect(c.request("tap")).rejects.toThrow("boom");
  });

  it("correlates each reply to its caller by id across sequential calls", async () => {
    const s = await startServer((line, socket) => {
      const req = JSON.parse(line) as { id: number };
      reply(socket, { id: req.id, result: `r${req.id}` });
    });
    servers.push(s);
    const c = makeClient(s.port);
    expect(await c.request("a")).toBe("r1");
    expect(await c.request("b")).toBe("r2");
    expect(await c.request("c")).toBe("r3");
  });

  it("ignores a reply whose id matches nothing pending", async () => {
    const s = await startServer((line, socket) => {
      const req = JSON.parse(line) as { id: number };
      // Emit a stray unmatched frame, then the real one.
      reply(socket, { id: 4242, result: "stray" });
      reply(socket, { id: req.id, result: "ok" });
    });
    servers.push(s);
    const c = makeClient(s.port);
    expect(await c.request("a")).toBe("ok");
  });

  it("serializes calls so only one request is in flight at a time", async () => {
    const seenConcurrent: number[] = [];
    let inFlight = 0;
    const s = await startServer((line, socket) => {
      const req = JSON.parse(line) as { id: number };
      inFlight++;
      seenConcurrent.push(inFlight);
      setTimeout(() => {
        inFlight--;
        reply(socket, { id: req.id, result: req.id });
      }, 20);
    });
    servers.push(s);
    const c = makeClient(s.port);
    await Promise.all([c.request("a"), c.request("b"), c.request("c")]);
    // Never more than one request being handled at once.
    expect(Math.max(...seenConcurrent)).toBe(1);
  });

  it("times out a silent request and destroys the socket", async () => {
    const s = await startServer(() => {
      /* never replies */
    });
    servers.push(s);
    const c = makeClient(s.port, 40);
    await expect(c.request("getState")).rejects.toThrow(/timed out after 40ms/);
  });

  it("recovers on the next call after a timeout (lazy reconnect)", async () => {
    let answer = false;
    const s = await startServer((line, socket) => {
      if (!answer) return; // first request is ignored → times out
      const req = JSON.parse(line) as { id: number };
      reply(socket, { id: req.id, result: "ok" });
    });
    servers.push(s);
    const c = makeClient(s.port, 40);
    await expect(c.request("first")).rejects.toThrow(/timed out/);
    answer = true;
    // A second call must reconnect and succeed.
    await expect(c.request("second")).resolves.toBe("ok");
  });

  it("reconnects after the server drops the connection", async () => {
    let drops = 0;
    const s = await startServer((line, socket) => {
      const req = JSON.parse(line) as { id: number; method: string };
      if (req.method === "drop") {
        drops++;
        socket.destroy();
        return;
      }
      reply(socket, { id: req.id, result: "ok" });
    });
    servers.push(s);
    const c = makeClient(s.port);
    await expect(c.request("drop")).rejects.toBeTruthy();
    expect(drops).toBe(1);
    await expect(c.request("again")).resolves.toBe("ok");
    // A fresh connection was opened for the retry.
    expect(s.connections.length).toBe(2);
  });

  it("splits multiple replies arriving in one TCP chunk", async () => {
    // The server batches two frames into one write; the client must split on \n.
    const s = await startServer((line, socket) => {
      const req = JSON.parse(line) as { id: number };
      socket.write(
        JSON.stringify({ id: 999, result: "stray" }) +
          "\n" +
          JSON.stringify({ id: req.id, result: "mine" }) +
          "\n"
      );
    });
    servers.push(s);
    const c = makeClient(s.port);
    await expect(c.request("x")).resolves.toBe("mine");
  });

  it("preserves U+2028 inside a string reply (ndjson framing, not readline)", async () => {
    const label = "line1 line2";
    const s = await startServer((line, socket) => {
      const req = JSON.parse(line) as { id: number };
      reply(socket, { id: req.id, result: { label } });
    });
    servers.push(s);
    const c = makeClient(s.port);
    const res = (await c.request("getInfo")) as { label: string };
    expect(res.label).toBe(label);
  });

  it("rejects in-flight requests when closed", async () => {
    const s = await startServer(() => {
      /* never replies */
    });
    servers.push(s);
    const c = makeClient(s.port);
    const p = c.request("hang");
    c.close();
    await expect(p).rejects.toThrow(/closed/);
  });

  it("rejects new requests after close", async () => {
    const s = await startServer(() => {});
    servers.push(s);
    const c = makeClient(s.port);
    c.close();
    await expect(c.request("nope")).rejects.toThrow(/closed/);
  });
});
