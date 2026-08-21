import { describe, it, expect } from "vitest";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type FailureSignal,
} from "@argent/registry";
import { classifyNotConnected, buildNotConnected } from "../../src/tools/debugger/not-connected";
import { pinsOnce } from "../helpers/pins";
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
    // failure. What replaces it depends on whether the app is still up, so the
    // override names --remote-debugging-port for the case that does relaunch
    // without letting a relaunch stand as the answer to all of them.
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

    // A renderer paused at a breakpoint times out exactly like a wedged one, and
    // quitting the app throws the debug session away.
    expect(chromium.guidance).toContain("breakpoint");
  });

  it("gives both Chromium overrides the whole recovery, not half of it each", () => {
    // Both route around restart-app, so each has to carry the whole recovery the
    // skill surfaces carry. Asserted in one loop: a per-reason assertion pins the
    // half it names on one override and leaves the twin free to lose it.
    for (const [reason, code] of [
      ["cdp_unreachable", FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE],
      ["runtime_unresponsive", FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT],
    ] as const) {
      const { guidance } = buildNotConnected(reason, coded(code), {
        port: 8081,
        device_id: "chromium-cdp-9222",
      });
      pinsOnce(guidance, "ask the user to start the browser again", reason);
      pinsOnce(guidance, "same CDP port", reason);
      pinsOnce(guidance, "chromium-cdp-<port> id from boot-device / list-devices", reason);
      // boot-device never stops an app, and nothing in the catalogue can tell a
      // broken-but-running one from an exited one, so the user is the only actor
      // that can end it - and the relaunch has to wait for that, or it lands on a
      // single-instance lock.
      pinsOnce(guidance, "ask the user to quit it", reason);
      pinsOnce(guidance, "then relaunch once it has exited", reason);
      // list-devices drops a live-but-windowless app exactly as it drops an exited
      // one, so an agent polling it for the exit relaunches into a running app.
      // Naming list-devices as the id source without this reads as an invitation
      // to do exactly that.
      pinsOnce(guidance, "list-devices cannot tell you whether it", reason);
      // The id tracks the port, so a relaunch returning on the same port keeps it.
      // A negative regex cannot hold this: it passes for every wording that does
      // not spell out the one phrase it names, the false ones included.
      pinsOnce(guidance, "a relaunch on a new port is a new id", reason);
      // Both relaunch mechanisms, on both reasons. An Electron app does not come
      // back by restarting a browser, and a browser restarted without the flag
      // exposes no CDP at all, so a surface carrying one branch strands whoever
      // is on the other.
      pinsOnce(guidance, "boot-device with electronAppPath relaunches an Electron app", reason);
      pinsOnce(guidance, "with --remote-debugging-port", reason);
    }
  });
});

describe("cdp_unreachable guidance vs the live-app codes behind it", () => {
  /** Serve one /json/list body from a throwaway CDP endpoint. */
  async function detailFor(targets: unknown[]): Promise<{ message: string; code: string }> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(targets));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const caught = await discoverPrimaryPage(port).then(
        () => undefined,
        (err: unknown) => err
      );
      // Returning the resolved case as a detail would let a throw site that
      // stopped throwing pass as one that throws something else.
      expect(caught, "expected discoverPrimaryPage to reject").toBeDefined();
      return {
        message: (caught as Error).message,
        code: String(getFailureSignal(caught)?.error_code),
      };
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
    // The message and the code are one pairing: routing is keyed off the code and
    // the wording off the message, so a throw site that re-codes keeps its prose
    // while landing on a different reason.
    for (const d of [devtoolsOnly, noPages]) {
      expect(d.code).toBe(FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET);
    }

    const { guidance } = buildNotConnected(
      "cdp_unreachable",
      coded(FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET),
      { port: 8081, device_id: "chromium-cdp-9222" }
    );
    for (const { message: detail } of [devtoolsOnly, noPages]) {
      const cue = /devtools:\/\//.test(detail) ? "devtools://" : "page target";
      expect(detail, "the discriminator the guidance names must be in the detail").toContain(cue);
      expect(guidance).toContain(cue);
    }
    // The clause that routes a live app away from a relaunch - both halves. The
    // diagnosis alone leaves the remedy free to become the relaunch this whole
    // branch exists to prevent.
    pinsOnce(
      guidance,
      "page targets (none at all, or only devtools:// ones) means the app is still " +
        "running and only lacks a window: ask the user to bring one back"
    );
    // The third state cdp_unreachable covers. CHROMIUM_CDP_INVALID_RESPONSE has
    // three throw sites in cdp-session.ts and none of them is a stopped app, so
    // this one is a relaunch away from a remedy too.
    pinsOnce(guidance, "check what is on it rather than relaunching");
    // A sequence, not a condition on whether it exited: nothing in the catalogue
    // can answer that condition, and quitting an app that already exited is a
    // no-op anyway.
    pinsOnce(guidance, "quit it, then relaunch once it has exited");
    // How the relaunch fails is per-app - a duplicate, an early exit behind
    // Electron's single-instance lock, a refusal behind Chrome's - so the
    // guidance states the rule and failure-scenarios.md carries the shapes.
    pinsOnce(guidance, "never recovers it");

    // Only the devtools:// variant names a window - the asymmetry
    // failure-scenarios.md's "App unreachable" row states, so a window hint added
    // here makes the row stale. Fix it there before relaxing this. (That the other
    // message asks about --remote-debugging-port on a port that just answered is
    // filed as #880.)
    expect(devtoolsOnly.message).toMatch(/window/i);
    expect(noPages.message, "the no-targets message gained a window hint").not.toMatch(/window/i);
  });
});
