/**
 * Screen-graph Phase C — the scripted policy (design §2.3 / §4).
 *
 * For this phase the "agent" is a deterministic policy, NOT an LLM: it decides,
 * per config and per step, which observation calls to issue after an action.
 * This module is the pure decision function; the device-facing runner executes
 * whatever it returns and tokenizes the resulting payloads. Isolating it here
 * makes the per-config behaviour — the thing the hypotheses are about — unit
 * testable without a device.
 *
 * The cost model the configs encode (design §3):
 *   per step tokens = c_outcome + [known ? c_summary : c_compact]
 *   per step RTT    = 1 (action+outcome) + [known ? 0 : 1]
 * Baseline (B1/B2): tokens = c_tree; RTT = 2–3 (action, [idle], describe).
 */
import type { BenchConfigId } from "./types";

/** What the policy asks the backend for after (or instead of) an action. */
export type ObservationKind =
  | "describe" // full re-read of the whole screen (baseline)
  | "query" // selector match, answer-sized (O1+)
  | "diff" // structural delta since a version (O1+, optional)
  | "graph-lookup" // host graph localization: cheap summary of a known screen
  | "none"; // the action outcome sufficed — no observation round-trip

export interface StepContext {
  /**
   * The action's own outcome, when the config's action path returns one (O2+).
   * `undefined` for B1/B2/O1, whose actions do not carry a before/after delta.
   */
  outcome?: { changed: boolean; newScreen: boolean };
  /** The resulting screen's structural hash is already a node in the graph. */
  knownScreen?: boolean;
  /** This step reaches a known target the graph can plan a route to (O5). */
  knownTarget?: boolean;
}

export interface PolicyDecision {
  /** Observation round-trips to make after the action, in order. */
  observations: ObservationKind[];
  /** O5: replace the tap+observe loop with a single `navigate-to` plan. */
  useNavigate: boolean;
}

/** Configs that route through the open device server (everything but B1). */
export function usesOpenServer(config: BenchConfigId): boolean {
  return config !== "B1";
}

/** Configs that consult the host screen graph. */
export function usesGraph(config: BenchConfigId): boolean {
  return config === "O3" || config === "O4" || config === "O5";
}

/** Configs whose action path requests an outcome (before/after fingerprint). */
export function usesOutcomes(config: BenchConfigId): boolean {
  return config === "O2" || config === "O3" || config === "O4" || config === "O5";
}

/**
 * The observation(s) the policy issues after ONE action step.
 *
 *  - B1 / B2: full `describe` after every action (re-read the whole screen).
 *  - O1: `query` instead of `describe` — ask only for what the step needs.
 *  - O2: rely on the action outcome; observe only when it changed the screen.
 *        An `outcome.changed === false` removes the read entirely (H2).
 *  - O3 / O4: as O2, but a screen already in the graph costs a `graph-lookup`
 *        (a cheap summary) rather than a `describe`/`query`; a NEW screen (cold
 *        store) still pays a full `describe` to render and insert it. Warm runs
 *        (O4) hit `graph-lookup` on revisits — the order-of-magnitude win (H3).
 *  - O5: for a step with a known target, a `navigate-to` plan replaces the
 *        tap+observe loop; verification is a `graph-lookup`. Otherwise it
 *        behaves like O4.
 */
export function observeAfterAction(config: BenchConfigId, ctx: StepContext = {}): PolicyDecision {
  switch (config) {
    case "B1":
    case "B2":
      return { observations: ["describe"], useNavigate: false };
    case "O1":
      return { observations: ["query"], useNavigate: false };
    case "O2": {
      // The outcome is the observation. Only a screen change costs a read.
      if (ctx.outcome && !ctx.outcome.changed) return { observations: ["none"], useNavigate: false };
      return { observations: ["query"], useNavigate: false };
    }
    case "O3":
    case "O4": {
      if (ctx.outcome && !ctx.outcome.changed) return { observations: ["none"], useNavigate: false };
      if (ctx.knownScreen) return { observations: ["graph-lookup"], useNavigate: false };
      // Cold path: render the new screen once to insert it into the graph.
      return { observations: ["describe"], useNavigate: false };
    }
    case "O5": {
      if (ctx.knownTarget) {
        // Plan + execute the route; verification of arrival is a graph lookup.
        return { observations: ["graph-lookup"], useNavigate: true };
      }
      if (ctx.outcome && !ctx.outcome.changed) return { observations: ["none"], useNavigate: false };
      if (ctx.knownScreen) return { observations: ["graph-lookup"], useNavigate: false };
      return { observations: ["describe"], useNavigate: false };
    }
  }
}

/**
 * How the final success assertion (element present) is read. `query` where the
 * backend has it (B2/O1–O5); B1 (proprietary) has no query RPC, so it scans the
 * element out of a `describe`.
 */
export function assertionObservation(config: BenchConfigId): ObservationKind {
  return config === "B1" ? "describe" : "query";
}
