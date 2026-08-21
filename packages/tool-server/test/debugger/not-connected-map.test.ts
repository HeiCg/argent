import { describe, it, expect } from "vitest";
import { FAILURE_CODES, FailureError, type FailureSignal } from "@argent/registry";
import { classifyNotConnected, buildNotConnected } from "../../src/tools/debugger/not-connected";

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
  });
});

describe("guidance content", () => {
  // A crashed session's console log is reachable only through the note
  // debugger-log-registry hands out, and these two strings are how the answers
  // that do not carry one — debugger-status', above all — send the agent to it.
  // Lose the clause and the answer that reports the app is gone says nothing
  // about the one artifact the crash left behind, and the agent relaunches over
  // it. An answer that IS carrying the note says so itself; that is pinned in
  // log-registry-not-connected.test.ts.
  it.each(["no_app_connected", "stale_connection"] as const)(
    "%s guidance points at the note that names the kept log",
    (reason) => {
      const { guidance } = buildNotConnected(
        reason,
        coded(FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS),
        {
          port: 8081,
          device_id: "emulator-5554",
        }
      );
      expect(guidance).toContain("debugger-log-registry");
      // Hedged, because a session that captured nothing keeps no file: guidance
      // that promises one unconditionally sends readers after a path that will
      // not be in the note.
      expect(guidance).toContain("when there is one");
    }
  );

  // And scoped to the sessions that keep one: `keepFile` is
  // `runtimeDied && captured > 0`, so an explicit teardown deletes the file
  // however much it had captured. Promising the file to every session that
  // logged sends a reader after a path no note will name.
  it("no_app_connected: promises the file only to a session whose runtime died", () => {
    const { guidance } = buildNotConnected(
      "no_app_connected",
      coded(FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS),
      { port: 8081, device_id: "emulator-5554" }
    );
    expect(guidance).toContain("whose runtime died holding console logs keeps its file");
  });

  // The same errand read from the tool that runs it. debugger-log-registry
  // reports the note itself, so this clause would send an agent holding the
  // answer back to the tool that produced it — for a note that answer either
  // already carries or has just said it does not have.
  it("no_app_connected: the answer that reports the note itself does not send the reader to fetch it", () => {
    const { guidance } = buildNotConnected(
      "no_app_connected",
      coded(FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS),
      { port: 8081, device_id: "emulator-5554" },
      { reportsOwnNote: true }
    );
    expect(guidance).not.toContain("debugger-log-registry");
    // Still the same state, and still the same recovery.
    expect(guidance).toContain("a crashed app reads as this too");
    expect(guidance).toContain("launch-app / restart-app");
  });

  // Only the reasons whose shared string names the tool need an override, and
  // the rest must keep reading identically from either caller — an override map
  // that grew a second entry by accident would fork guidance no reason needs.
  it("every other reason reads the same from the tool that reports the note", () => {
    const params = { port: 8081, device_id: "emulator-5554" };
    for (const reason of [
      "metro_not_running",
      "device_mismatch",
      "cdp_unreachable",
      "runtime_unresponsive",
      "reconnecting",
    ] as const) {
      const err = coded(FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING);
      expect(buildNotConnected(reason, err, params, { reportsOwnNote: true }).guidance).toBe(
        buildNotConnected(reason, err, params).guidance
      );
    }
  });
});
