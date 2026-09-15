import { describe, it, expect, beforeEach } from "vitest";
import {
  recordIncident,
  clearIncident,
  getIncident,
  incidentHint,
  incidentHeaderLine,
  __resetIncidents,
  type OpenServerIncidentCode,
} from "../src/utils/open-server-incident";
import { tiktokenCount } from "../src/screen-graph/bench/tokens";

const DEV = "emulator-5554";

beforeEach(() => __resetIncidents());

describe("incident state machine — set / count / reset", () => {
  it("records an incident and exposes it per device", () => {
    expect(getIncident(DEV)).toBeUndefined();
    const inc = recordIncident(DEV, {
      tool: "gesture-tap",
      code: "verify_not_found",
      message: "x",
    });
    expect(inc.consecutiveFailures).toBe(1);
    expect(getIncident(DEV)).toEqual(inc);
  });

  it("counts consecutive failures across codes", () => {
    recordIncident(DEV, { tool: "gesture-tap", code: "verify_not_found", message: "x" });
    recordIncident(DEV, { tool: "gesture-tap", code: "verify_ambiguous", message: "x" });
    const third = recordIncident(DEV, {
      tool: "gesture-swipe",
      code: "verify_mismatch",
      message: "x",
    });
    expect(third.consecutiveFailures).toBe(3);
    // Latest code/tool win; the count is about a device that keeps refusing.
    expect(third.tool).toBe("gesture-swipe");
    expect(third.code).toBe("verify_mismatch");
  });

  it("reset on success drops the incident and the count restarts", () => {
    recordIncident(DEV, { tool: "gesture-tap", code: "verify_not_found", message: "x" });
    recordIncident(DEV, { tool: "gesture-tap", code: "verify_not_found", message: "x" });
    clearIncident(DEV);
    expect(getIncident(DEV)).toBeUndefined();
    const next = recordIncident(DEV, { tool: "gesture-tap", code: "no_effect", message: "x" });
    expect(next.consecutiveFailures).toBe(1);
  });

  it("incidents are isolated per device", () => {
    recordIncident(DEV, { tool: "gesture-tap", code: "verify_not_found", message: "x" });
    recordIncident("emulator-5556", { tool: "gesture-tap", code: "timeout", message: "x" });
    expect(getIncident(DEV)?.code).toBe("verify_not_found");
    expect(getIncident("emulator-5556")?.consecutiveFailures).toBe(1);
  });
});

describe("hint table", () => {
  const expectHint = (code: OpenServerIncidentCode, label: string | undefined, hint: string) => {
    const inc = recordIncident(DEV, { tool: "gesture-tap", code, message: "x", label });
    expect(incidentHint(inc)).toBe(hint);
    __resetIncidents();
  };

  it("maps each code to its hint", () => {
    expectHint("verify_not_found", undefined, "re-describe and pick a visible label");
    expectHint("verify_ambiguous", undefined, "add a second field to the selector");
    expectHint("verify_mismatch", "Battery", "your coordinates point at Battery");
    expectHint("no_effect", undefined, "the tap changed nothing, re-describe");
    expectHint("timeout", undefined, "the device did not answer, retry");
  });

  it("mismatch without a label falls back gracefully", () => {
    const inc = recordIncident(DEV, { tool: "gesture-tap", code: "verify_mismatch", message: "x" });
    expect(incidentHint(inc)).toBe("your coordinates point at another element");
  });
});

describe("describe header line", () => {
  it("formats `incident: <tool> <code> ×<n> — <hint>`", () => {
    const inc = recordIncident(DEV, {
      tool: "gesture-tap",
      code: "verify_not_found",
      message: "x",
    });
    expect(incidentHeaderLine(inc)).toBe(
      "incident: gesture-tap verify_not_found ×1 — re-describe and pick a visible label"
    );
  });

  it("adds the escalation clause after 3 consecutive failures", () => {
    recordIncident(DEV, { tool: "gesture-tap", code: "verify_ambiguous", message: "x" });
    const two = recordIncident(DEV, {
      tool: "gesture-tap",
      code: "verify_ambiguous",
      message: "x",
    });
    expect(incidentHeaderLine(two)).not.toContain("consider a different approach");
    const three = recordIncident(DEV, {
      tool: "gesture-tap",
      code: "verify_ambiguous",
      message: "x",
    });
    expect(incidentHeaderLine(three)).toBe(
      "incident: gesture-tap verify_ambiguous ×3 — add a second field to the selector; consider a different approach"
    );
  });

  it("mismatch line names the element the coordinates hit", () => {
    const inc = recordIncident(DEV, {
      tool: "gesture-tap",
      code: "verify_mismatch",
      message: "x",
      label: "Network & internet",
    });
    expect(incidentHeaderLine(inc)).toBe(
      "incident: gesture-tap verify_mismatch ×1 — your coordinates point at Network & internet"
    );
  });
});

describe("token cost — the line is ≤ 30 tokens", () => {
  it("every code, at ×1 and escalated, stays within budget", () => {
    const codes: OpenServerIncidentCode[] = [
      "verify_not_found",
      "verify_ambiguous",
      "verify_mismatch",
      "no_effect",
      "timeout",
    ];
    let worst = 0;
    let worstLine = "";
    for (const code of codes) {
      __resetIncidents();
      // Push to 3 so the escalation clause is included in the measurement.
      const push = () =>
        recordIncident(DEV, {
          tool: "gesture-swipe",
          code,
          message: "x",
          label: "Network & internet",
        });
      push();
      push();
      const inc = push();
      const line = incidentHeaderLine(inc);
      const tokens = tiktokenCount(line);
      if (tokens > worst) {
        worst = tokens;
        worstLine = line;
      }
      expect(tokens).toBeLessThanOrEqual(30);
    }
    // Surface the measured worst case so the run log states it.
    console.log(`[incident] worst-case header line = ${worst} tokens: "${worstLine}"`);
  });
});
