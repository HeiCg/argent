/**
 * Ticket Artemis A1 (part B) — execution incident, kept per device in the
 * tool-server's memory so `describe` (open path) can warn the agent about the
 * LAST failing action IN CONTEXT, the way google/artemis keeps a consecutive-
 * failure count across steps (the 2026-09-13 note: ideas, not code — episodic
 * memory, complementary to the semantic screen graph).
 *
 * `lastIncident` is updated on every tool failure the open path can classify
 * (verify refusals, a no-effect tap the caller asked to `verify`, an RPC
 * timeout) and RESET on the next success. `describe` prepends ONE line while an
 * incident is active. Nothing here persists across a tool-server restart (a
 * plain in-memory Map) and no RPC touches the device — this is host state only.
 */

/** A classified open-path failure a caller records against a device. */
export interface OpenServerIncident {
  /** The tool that failed, e.g. `gesture-tap`. */
  tool: string;
  /**
   * Failure code. `verify_not_found` / `verify_ambiguous` / `verify_mismatch`
   * are the verify refusals; `no_effect` is a verified tap that landed but moved
   * nothing; `timeout` is an RPC the device did not answer.
   */
  code: OpenServerIncidentCode;
  /** Human message (never rendered into the describe line, kept for logs). */
  message: string;
  /** Epoch ms of the last update. */
  at: number;
  /** How many failures in a row on this device (reset clears it). */
  consecutiveFailures: number;
  /**
   * The element the caller's coordinates actually pointed at, for the
   * `verify_mismatch` hint (`your coordinates point at <label>`). Absent for the
   * other codes.
   */
  label?: string;
}

export type OpenServerIncidentCode =
  | "verify_not_found"
  | "verify_ambiguous"
  | "verify_mismatch"
  | "no_effect"
  | "timeout";

// Per-device incident, keyed by device serial (`DeviceInfo.id`, which for
// Android equals the `udid` describe/gesture-tap both resolve from).
const incidents = new Map<string, OpenServerIncident>();

/** After this many consecutive failures the line adds the escalation clause. */
const ESCALATE_AT = 3;

/**
 * Record a classified failure against `deviceId`. Increments the consecutive
 * count off whatever incident was already active (any code counts — the count
 * is about a device that keeps refusing, not one specific code) and returns the
 * updated incident.
 */
export function recordIncident(
  deviceId: string,
  input: { tool: string; code: OpenServerIncidentCode; message: string; label?: string }
): OpenServerIncident {
  const prev = incidents.get(deviceId);
  const incident: OpenServerIncident = {
    tool: input.tool,
    code: input.code,
    message: input.message,
    at: Date.now(),
    consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
    ...(input.label !== undefined ? { label: input.label } : {}),
  };
  incidents.set(deviceId, incident);
  return incident;
}

/** Reset the device's incident on a success. Idempotent when none is active. */
export function clearIncident(deviceId: string): void {
  incidents.delete(deviceId);
}

/** The active incident for a device, or undefined when the last action succeeded. */
export function getIncident(deviceId: string): OpenServerIncident | undefined {
  return incidents.get(deviceId);
}

/** Test seam: drop all in-memory incidents. */
export function __resetIncidents(): void {
  incidents.clear();
}

// The hint table (ticket §B). `verify_mismatch` is dynamic (it names the element
// the coordinates hit), so it is built in `incidentHint`, not stored here.
const HINTS: Record<Exclude<OpenServerIncidentCode, "verify_mismatch">, string> = {
  verify_not_found: "re-describe and pick a visible label",
  verify_ambiguous: "add a second field to the selector",
  no_effect: "the tap changed nothing, re-describe",
  timeout: "the device did not answer, retry",
};

/** The bare hint clause for an incident (no tool / count / escalation). */
export function incidentHint(incident: OpenServerIncident): string {
  if (incident.code === "verify_mismatch") {
    return `your coordinates point at ${incident.label ?? "another element"}`;
  }
  return HINTS[incident.code];
}

/**
 * The ONE line `describe` (open path) prepends while an incident is active:
 *   `incident: <tool> <code> ×<n> — <hint>`
 * plus `; consider a different approach` after 3 consecutive failures. Kept
 * short on purpose — the token cost is asserted (≤ 30) by the unit test.
 */
export function incidentHeaderLine(incident: OpenServerIncident): string {
  const base = `incident: ${incident.tool} ${incident.code} ×${incident.consecutiveFailures} — ${incidentHint(
    incident
  )}`;
  return incident.consecutiveFailures >= ESCALATE_AT
    ? `${base}; consider a different approach`
    : base;
}
