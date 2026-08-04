import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { discoverMetro, metroServerRunning } from "../../src/utils/debugger/discovery";

/**
 * `metroServerRunning` answers "is the dev server up", NOT "is an app attached
 * to it". The distinction is load-bearing for every `screen` gate: a Metro
 * serving one app has an EMPTY target list for the seconds after that app is
 * relaunched, which is exactly when the post-launch identity gate runs.
 *
 * These tests drive a real socket rather than a stub, because the defect they
 * pin was introduced by a stub: a test double answered "reachable" for a
 * zero-target list while the real `discoverMetro` throws on one, so the
 * post-launch connect budget silently lost its extension and the failure told
 * the author to start a server that was already running.
 */

let server: http.Server | undefined;

async function startMetro(targets: unknown[], status = "packager-status:running"): Promise<number> {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith("/status")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(status);
      return;
    }
    if (req.url?.startsWith("/json/list")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(targets));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server!.address() as { port: number }).port;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("metroServerRunning", () => {
  it("is true for a running server with NO attached targets — the post-launch window", async () => {
    const port = await startMetro([]);

    // The state this exists for: the server is plainly up ...
    await expect(metroServerRunning(port)).resolves.toBe(true);
    // ... while discovery, which additionally demands a target, rejects it.
    // Answering "is Metro up" with discovery is what read a relaunching app as
    // a down dev server.
    await expect(discoverMetro(port)).rejects.toThrow(/no CDP targets/);
  });

  it("is true for a running server that does have targets", async () => {
    const port = await startMetro([
      { id: "1", title: "app (Device)", description: "", webSocketDebuggerUrl: "ws://x" },
    ]);
    await expect(metroServerRunning(port)).resolves.toBe(true);
  });

  it("is false when nothing is listening on the port", async () => {
    const port = await startMetro([]);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await expect(metroServerRunning(port)).resolves.toBe(false);
  });

  it("is false when the port answers but is not Metro", async () => {
    const port = await startMetro([], "<!doctype html><html>some other server</html>");
    await expect(metroServerRunning(port)).resolves.toBe(false);
  });
});
