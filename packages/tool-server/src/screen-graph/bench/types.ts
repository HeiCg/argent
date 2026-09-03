/**
 * Screen-graph Phase C evaluation harness — shared types (design §4).
 *
 * The harness drives the SAME scripted tasks through seven configurations
 * (B1/B2/O1–O5) and measures per-step observation tokens, RTTs, wall time,
 * device serialization time and success. These types are the device-free
 * contract shared by the pure task/policy/token logic (unit-tested) and the
 * device-facing runner in `scripts/bench-screen-graph.ts`.
 */

export type BenchApp = "settings" | "chrome";

/** A selector the scripted policy resolves against the device / graph. */
export interface BenchSelector {
  /** Resource-id (unqualified name accepted, e.g. `search`). */
  id?: string;
  /** Visible text / content-desc (case-insensitive substring). */
  text?: string;
}

export type BenchAction =
  | { kind: "launch" }
  | { kind: "tap"; selector: BenchSelector }
  | {
      /**
       * Coordinate tap at a FIXED normalized point (0–1), no selector/locate.
       * Used by the same-screen H2 tasks for no-op taps (empty space, disabled
       * rows, slider positions) that must not navigate.
       */
      kind: "tapXY";
      x: number;
      y: number;
      /** Human label for reports/precompute logs. */
      label?: string;
    }
  | { kind: "swipe"; direction: "up" | "down" }
  | { kind: "type"; selector: BenchSelector; text: string }
  | { kind: "back" };

export interface BenchStep {
  action: BenchAction;
  /**
   * The step reaches a screen whose target is known ahead of time — O5 may
   * replace the tap+observe loop with a single `navigate-to` plan.
   */
  knownTarget?: boolean;
  /**
   * This step is INTENDED to keep the SAME screen (no structural navigation).
   * The H2 hypothesis (outcome removes ≥1 RTT/step) is measured over these
   * steps only — the navigation steps change the screen every time, leaving
   * O2's outcome nothing to skip against.
   */
  sameScreen?: boolean;
}

export interface BenchTask {
  id: string;
  app: BenchApp;
  description: string;
  /** Ordered actions; the harness observes after each per the config policy. */
  steps: BenchStep[];
  /**
   * Success assertion: this selector must be present on the final screen. Read
   * with `query` where the backend has it (B2/O1–O5), else scanned from a
   * `describe` (B1 proprietary has no query RPC).
   */
  assertion: BenchSelector;
  /** Ultimate target for O5 `navigate-to` (a screen the graph can plan to). */
  navTarget?: BenchSelector;
}

/**
 * The seven configurations (design §4 / ticket):
 *  - B1 argent proprietary (flag off, vendored 0.22.1 binaries)
 *  - B2 open server, no graph
 *  - O1 open + query/diff observations (query instead of describe)
 *  - O2 O1 + outcomes (skip the read when the outcome says unchanged/known)
 *  - O3 O2 + screen graph COLD (empty store)
 *  - O4 O3 re-run WARM (store persisted from O3)
 *  - O5 O4 + `navigate-to` for tasks with a known target
 */
export type BenchConfigId = "B1" | "B2" | "O1" | "O2" | "O3" | "O4" | "O5";

export const BENCH_CONFIG_IDS: readonly BenchConfigId[] = [
  "B1",
  "B2",
  "O1",
  "O2",
  "O3",
  "O4",
  "O5",
] as const;
