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
import { getCandidateChromiumPorts } from "../../src/utils/chromium-discovery";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

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
      // Both name the paused state, so both owe it a branch. Nothing here can
      // resume a runtime - there is no Debugger.resume anywhere in the tool-server -
      // and the other instruction on offer ends the session the user is sitting in,
      // on Metro through restart-app exactly as on Chromium through the quit.
      expect(r.guidance).toContain("paused at a breakpoint");
      pinsOnce(r.guidance, "If it is paused, ask the user to resume it — nothing here can");
    }
    expect(metro.guidance).toContain("restart-app");

    // A renderer paused at a breakpoint times out exactly like a wedged one, and
    // the two states take opposite actions: quitting a paused app throws the
    // user's debug session away. Naming the state without branching it leaves
    // the quit as the only instruction on offer for both.
    expect(chromium.guidance).toContain("breakpoint");
    pinsOnce(chromium.guidance, "Check the app first.");
    pinsOnce(
      chromium.guidance,
      "If it is paused, ask the user to resume it — nothing here can, and quitting throws " +
        "the debug session away"
    );
    pinsOnce(chromium.guidance, "If it is hung, ask the user to quit it");
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
      pinsOnce(guidance, "then relaunch once it has exited", reason);
      // The order, not the wording: the two overrides phrase the quit differently
      // (one knows the app is up, the other is reached only when nothing answers),
      // and a relaunch-first rewrite keeps every needle above while telling the
      // reader to relaunch into a running app. Positions are what rule that out.
      const quitAt = guidance.indexOf("quit");
      expect(quitAt, `${reason}: names a quit`).toBeGreaterThan(-1);
      expect(quitAt, `${reason}: quit must precede any relaunch`).toBeLessThan(
        guidance.indexOf("relaunch")
      );
      // The one retry-discipline clause each override has. Its twin's 'do not retry
      // in a loop' is pinned above; without this one 'retry once' can become
      // 'retry until it connects' on the reason that waits out a full timeout.
      pinsOnce(guidance, "Then retry once.", reason);
      // The way out of the one state list-devices cannot show: the id carries the
      // port, so a browser the user names is drivable whether or not it is listed.
      pinsOnce(guidance, "use chromium-cdp-<that port> directly", reason);
      // Both dead ends, on both overrides. restart-app is refused by the gate and
      // launch-app is a documented no-op that reports launched: true, so either
      // one named as an action manufactures a guaranteed second failure - and a
      // per-reason negative leaves the twin free to take up the one it was not
      // checked against.
      expect(guidance, reason).not.toContain("restart-app");
      expect(guidance, reason).not.toMatch(/\(launch-app\)/);
      pinsOnce(guidance, "launch-app cannot start a Chromium app", reason);
      // The premise the manual quit rests on, worded the same way the four prose
      // surfaces word it.
      pinsOnce(guidance, "only starts an app and never stops one", reason);
      // Absence of a list-devices entry is not the exit, on either reason: probePort
      // drops an app that is up with no drivable page exactly as it drops an exited
      // one. The converse reads as the more useful statement - still listed, so
      // still up - and is false in the direction the reader needs, so the claim is
      // pinned together with the mechanism that makes it actionable.
      pinsOnce(guidance, "list-devices cannot confirm the exit", reason);
      pinsOnce(
        guidance,
        "it drops an app that is up with no drivable page exactly as it drops an exited one",
        reason
      );
      // The rule needs its consequence: without it a reader takes 'never recovers
      // it' for 'has no effect' and tries the relaunch anyway.
      pinsOnce(guidance, "the relaunch either duplicates the app or fails", reason);
      // The id is re-readable only where discovery looks: getCandidateChromiumPorts
      // probes 9222, the env list and the ports boot-device opened. Without this the
      // new-port clause reads as an invitation to relaunch anywhere and re-read.
      pinsOnce(guidance, "not listed at all", reason);
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

  it("names the probe set discovery actually has, not a restated one", () => {
    // The closing clause tells the reader where the new id can be read back. A
    // literal that drifts from getCandidateChromiumPorts sends them to look on a
    // port nothing probes, so derive it: with the env list and the persisted file
    // both out of the way, what is left is the default the prose has to name.
    const prevList = process.env.ARGENT_CHROMIUM_PORTS;
    const prevFile = process.env.ARGENT_CHROMIUM_PORTS_FILE;
    delete process.env.ARGENT_CHROMIUM_PORTS;
    process.env.ARGENT_CHROMIUM_PORTS_FILE = path.join(os.tmpdir(), "argent-absent-ports.json");
    try {
      const { guidance } = buildNotConnected(
        "cdp_unreachable",
        coded(FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE),
        { port: 8081, device_id: "chromium-cdp-9222" }
      );
      for (const port of getCandidateChromiumPorts()) pinsOnce(guidance, String(port));
      // And the env var it names is the one discovery reads - the name is prose on
      // both sides, so nothing but a round trip through the function pins it.
      process.env.ARGENT_CHROMIUM_PORTS = "9333";
      expect(getCandidateChromiumPorts()).toContain(9333);
      pinsOnce(guidance, "ARGENT_CHROMIUM_PORTS");
    } finally {
      if (prevList === undefined) delete process.env.ARGENT_CHROMIUM_PORTS;
      else process.env.ARGENT_CHROMIUM_PORTS = prevList;
      if (prevFile === undefined) delete process.env.ARGENT_CHROMIUM_PORTS_FILE;
      else process.env.ARGENT_CHROMIUM_PORTS_FILE = prevFile;
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
    for (const [detail, cue] of [
      [devtoolsOnly.message, "devtools://"],
      [noPages.message, "page target"],
    ] as const) {
      expect(detail, "the discriminator the guidance names must be in the detail").toContain(cue);
      expect(guidance).toContain(cue);
    }
    pinsOnce(guidance, "or is up with no usable page");
    // The clause that routes a live app away from a relaunch - both halves. The
    // diagnosis alone leaves the remedy free to become the relaunch this whole
    // branch exists to prevent.
    pinsOnce(
      guidance,
      "page targets (none at all, or only devtools:// ones) means the app is still " +
        "running and only lacks a window: ask the user to bring one back. Otherwise"
    );
    // The third state cdp_unreachable covers, and no relaunch is its remedy. Only
    // two of CHROMIUM_CDP_INVALID_RESPONSE's three throw sites can reach a
    // not_connected result - fetchJson's !res.ok and its non-JSON body; the third
    // (browserWebSocketUrl) is called only from chromium-tabs, which throws
    // instead. Naming the unreachable one gives the reader a shape to match that
    // never arrives, so the list has to track the reachable sites, not the file's.
    pinsOnce(
      guidance,
      "a non-2xx status, or a body that is not JSON — means something else holds that port"
    );
    expect(guidance, "names a shape no cdp_unreachable detail can carry").not.toContain(
      "browser socket"
    );
    // Naming the state without a way out is what left this branch a dead end:
    // there is no port-inspecting tool, so the actor is the user, and the id is
    // gone either way.
    pinsOnce(guidance, "pass on what the detail says, since nothing here can free a port");
    // Its remedy, which deletes without a red otherwise - and is the step the
    // create-flow row was missing.
    pinsOnce(guidance, "for an Electron app boot-device takes a free port and returns the new id");
    pinsOnce(guidance, "a browser has to come back on a port nothing else holds");
    // This arm is reached only when nothing answered the port at all, so the quit
    // is a precaution rather than a diagnosis - and it still has to come first,
    // since the one case it guards against is an app that is somehow still up.
    pinsOnce(guidance, "ask the user to quit the app if it is still up, then relaunch");
    // How the relaunch fails is per-app - a duplicate, an early exit behind
    // Electron's single-instance lock, a refusal behind Chrome's - so the
    // guidance states the rule and failure-scenarios.md carries the shapes.
    pinsOnce(guidance, "relaunching a live app never recovers it");

    // Only the devtools:// variant names a window - the asymmetry
    // failure-scenarios.md's "App unreachable" row states, so a window hint added
    // here makes the row stale. Fix it there before relaxing this. (That the other
    // message asks about --remote-debugging-port on a port that just answered is
    // filed as #880.)
    expect(devtoolsOnly.message).toMatch(/window/i);
    expect(noPages.message, "the no-targets message gained a window hint").not.toMatch(/window/i);
  });
});
