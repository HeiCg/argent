import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IosOpenServerClient } from "../src/utils/ios-open-server-client";

// A fake NDJSON JSON-RPC server on loopback: it asserts the client's on-the-wire
// framing (one `\n`-terminated request line per call, id correlation) and lets
// the client's typed method wrappers round-trip against canned replies. This is
// the transport-framing test — no simulator, no Swift.

interface FakeServer {
  port: number;
  close: () => Promise<void>;
  requests: Array<{ raw: string; method: string; id: unknown }>;
}

function startFakeServer(
  handler: (req: { method: string; params: unknown; id: unknown }) => unknown
): Promise<FakeServer> {
  const requests: FakeServer["requests"] = [];
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim() === "") continue;
          const req = JSON.parse(line) as { method: string; params: unknown; id: unknown };
          requests.push({ raw: line, method: req.method, id: req.id });
          const result = handler(req);
          const reply =
            result && typeof result === "object" && "__error" in (result as Record<string, unknown>)
              ? { jsonrpc: "2.0", id: req.id, error: (result as { __error: unknown }).__error }
              : { jsonrpc: "2.0", id: req.id, result };
          socket.write(JSON.stringify(reply) + "\n");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        requests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

describe("IosOpenServerClient transport framing", () => {
  let fake: FakeServer;
  let client: IosOpenServerClient;

  afterEach(async () => {
    client?.close();
    await fake?.close();
  });

  it("frames one \\n-terminated JSON-RPC request per call and correlates by id", async () => {
    fake = await startFakeServer((req) => {
      if (req.method === "ping") return { status: "ok" };
      if (req.method === "getInfo") {
        return {
          bundleId: "com.apple.Preferences",
          orientation: "portrait",
          keyboardVisible: false,
          screenWidth: 390,
          screenHeight: 844,
          scale: 3,
          version: 1,
        };
      }
      return {};
    });
    client = new IosOpenServerClient({ port: fake.port });

    expect(await client.ping()).toEqual({ status: "ok" });
    const info = await client.getInfo();
    expect(info.bundleId).toBe("com.apple.Preferences");
    expect(info.screenWidth).toBe(390);

    // Each request was exactly one line; ids are distinct and monotonic.
    expect(fake.requests.length).toBe(2);
    for (const r of fake.requests) {
      expect(r.raw.includes("\n")).toBe(false);
      expect(JSON.parse(r.raw).jsonrpc).toBe("2.0");
    }
    expect(fake.requests[0]!.method).toBe("ping");
    expect(fake.requests[1]!.method).toBe("getInfo");
    expect(fake.requests[0]!.id).not.toBe(fake.requests[1]!.id);
  });

  it("passes screen-point coordinates through on tap", async () => {
    fake = await startFakeServer((req) => {
      if (req.method === "tap")
        return { success: true, dropped: false, dropReporting: "unsupported" };
      return {};
    });
    client = new IosOpenServerClient({ port: fake.port });

    const res = await client.tap(120, 340, { clickCount: 2 });
    expect(res).toEqual({ success: true, dropped: false, dropReporting: "unsupported" });
    const params = JSON.parse(fake.requests[0]!.raw).params;
    expect(params).toMatchObject({ x: 120, y: 340, clickCount: 2 });
  });

  it("rejects with the server's JSON-RPC error message", async () => {
    fake = await startFakeServer(() => ({
      __error: { code: -32004, message: "query is not implemented in this phase" },
    }));
    client = new IosOpenServerClient({ port: fake.port });
    await expect(client.getState()).rejects.toThrow(/not implemented in this phase/);
  });
});
