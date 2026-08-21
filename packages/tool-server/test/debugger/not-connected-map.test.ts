import { describe, it, expect } from "vitest";
import { FAILURE_CODES, FailureError, type FailureSignal } from "@argent/registry";
import { classifyNotConnected, buildNotConnected } from "../../src/tools/debugger/not-connected";
import { discoverPrimaryPage } from "../../src/chromium-server/cdp-session";
import * as http from "node:http";

/**
 * Pins EVERY entry of NOT_CONNECTED_CODE_MAP. The map is the contract that
 * turns a classified resolution failure into a structured not_connected result
 * — deleting any single entry silently reverts that code to a thrown tool
 * failure (the regression the map exists to prevent), so each row is asserted
 * individually here.
 */

function coded(
  error_code: FailureSignal["error_code"],
  message = "x",
  error_kind: FailureSignal["error_kind"] = "network"
) {
  return new FailureError(message, {
    error_code,
    failure_stage: "test_stage",
    failure_area: "tool_server",
    error_kind,
  });
}

const MAP: Array<[FailureSignal["error_code"], string]> = [
  [FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING, "metro_not_running"],
  [FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS, "no_app_connected"],
  [FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH, "device_mismatch"],
  [FAILURE_CODES.DEBUGGER_CDP_CONNECT_FAILED, "cdp_unreachable"],
  [FAILURE_CODES.DEBUGGER_CDP_SOCKET_CLOSED_BEFORE_OPEN, "cdp_unreachable"],
  [FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED, "cdp_unreachable"],
  [FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED, "cdp_unreachable"],
  [FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT, "runtime_unresponsive"],
  [FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE, "cdp_unreachable"],
  [FAILURE_CODES.CHROMIUM_CDP_INVALID_RESPONSE, "cdp_unreachable"],
  [FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET, "cdp_unreachable"],
  [FAILURE_CODES.REGISTRY_SERVICE_TERMINATING, "reconnecting"],
];

describe("classifyNotConnected code map", () => {
  it.each(MAP)("%s → %s", (code, reason) => {
    expect(classifyNotConnected(coded(code))).toBe(reason);
  });

  it("an unmapped classified code stays unclassified (rethrow path)", () => {
    expect(
      classifyNotConnected(coded(FAILURE_CODES.REGISTRY_SERVICE_INITIALIZATION_FAILED))
    ).toBeUndefined();
  });

  it("a plain Error stays unclassified (rethrow path)", () => {
    expect(classifyNotConnected(new Error("boom"))).toBeUndefined();
  });
});

describe("guidance platform-correctness", () => {
  it("chromium cdp_unreachable guidance never points at launch-app (a documented no-op on Chromium)", () => {
    const result = buildNotConnected(
      "cdp_unreachable",
      coded(FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE),
      { port: 8081, device_id: "chromium-cdp-9222" }
    );
    // The Metro phrasing "Verify the app is running (launch-app)" must not
    // appear — following it on Chromium manufactures a guaranteed second
    // failure. The actionable path is a relaunch with --remote-debugging-port.
    expect(result.guidance).not.toMatch(/\(launch-app\)/);
    expect(result.guidance).toContain("--remote-debugging-port");
    expect(result.guidance).toContain("launch-app cannot start a Chromium app");
  });

  it("Metro cdp_unreachable keeps the launch-app guidance (it IS actionable there)", () => {
    const result = buildNotConnected(
      "cdp_unreachable",
      coded(FAILURE_CODES.DEBUGGER_CDP_CONNECT_FAILED),
      { port: 8081, device_id: "emulator-5554" }
    );
    expect(result.guidance).toContain("launch-app");
    expect(result.guidance).not.toContain("--remote-debugging-port");
  });

  it("runtime_unresponsive guidance warns about the per-attempt timeout on both platforms", () => {
    const metro = buildNotConnected(
      "runtime_unresponsive",
      coded(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT),
      { port: 8081, device_id: "emulator-5554" }
    );
    const chromium = buildNotConnected(
      "runtime_unresponsive",
      coded(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT),
      { port: 8081, device_id: "chromium-cdp-9222" }
    );
    for (const r of [metro, chromium]) {
      expect(r.guidance).toMatch(/Do not retry in a loop/);
      expect(r.guidance).toMatch(/timeout/);
    }
    expect(metro.guidance).toContain("restart-app");
    expect(chromium.guidance).not.toContain("restart-app");
    expect(chromium.guidance).toContain("electronAppPath");

    // The two Chromium overrides are the only recovery an agent meets with no
    // skill open, so each carries what the skill surfaces carry: who performs
    // the browser half, and where the id is re-read once a relaunch moves it.
    for (const r of [
      buildNotConnected("cdp_unreachable", coded(FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE), {
        port: 8081,
        device_id: "chromium-cdp-9222",
      }),
      chromium,
    ]) {
      expect(r.guidance).toContain("ask the user");
      expect(r.guidance).toContain("same");
      // The id is only new when the port is, so the flat claim must not come back.
      expect(r.guidance).toContain("list-devices");
      // boot-device never stops an app, so every relaunch these strings order
      // has to be gated on the app being gone - the invariant the skill rows carry.
      expect(r.guidance).toMatch(/exited|quit it/);
      expect(r.guidance).not.toMatch(/under a new chromium-cdp/);
    }
    // A renderer paused at a breakpoint times out exactly like a wedged one, and
    // quitting the app throws the debug session away.
    expect(chromium.guidance).toContain("breakpoint");
  });
});

describe("cdp_unreachable guidance vs the live-app codes behind it", () => {
  /** Serve one /json/list body from a throwaway CDP endpoint. */
  async function detailFor(targets: unknown[]): Promise<string> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(targets));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await discoverPrimaryPage(port);
      throw new Error("expected discoverPrimaryPage to reject");
    } catch (err) {
      return (err as Error).message;
    } finally {
      server.close();
    }
  }

  it("routes both CHROMIUM_CDP_NO_PAGE_TARGET details away from a relaunch", async () => {
    // This code maps to cdp_unreachable, but the endpoint answered — the app is
    // alive and only lacks a window, where a relaunch adds a second copy rather
    // than recovering. It has two messages and the guidance has to catch both,
    // so drive them out of the real throw sites instead of restating them.
    const devtoolsOnly = await detailFor([
      {
        id: "1",
        type: "page",
        title: "DevTools",
        url: "devtools://devtools/bundled/inspector.html",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1",
      },
    ]);
    const noPages = await detailFor([{ id: "2", type: "service_worker", title: "sw", url: "x" }]);

    const { guidance } = buildNotConnected(
      "cdp_unreachable",
      coded(FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET),
      { port: 8081, device_id: "chromium-cdp-9222" }
    );
    for (const detail of [devtoolsOnly, noPages]) {
      const cue = /devtools:\/\//.test(detail) ? "devtools://" : "page target";
      expect(detail, "the discriminator the guidance names must be in the detail").toContain(cue);
      expect(guidance).toContain(cue);
    }
    expect(guidance).toMatch(/still running/);
    expect(guidance).toMatch(/second copy/);

    // Only the inspector variant names a window; the ordinary closed-window case
    // (no DevTools open) lands on the other one and gets a --remote-debugging-port
    // question on a port that just answered. failure-scenarios.md's "App
    // unreachable" row states that asymmetry, so a window hint added here makes
    // the row stale — fix it there before relaxing this.
    expect(devtoolsOnly).toMatch(/window/i);
    expect(noPages, "the no-targets message gained a window hint").not.toMatch(/window/i);
  });
});
