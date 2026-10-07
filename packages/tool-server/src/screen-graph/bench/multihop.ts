/**
 * Screen-graph MULTIHOP block: what `navigate-to` saves the model on a route of
 * 3+ hops, measured against the scripted per-hop loop.
 *
 * E-1 measured template navigation and D.4.1 one-hop routes; the multi-hop
 * case (the one the graph exists for) was never measured. Two arms over the same
 * Settings routes (`MULTIHOP_TASKS`), the same device and the same relaunch:
 *
 *  - `graph`: `describe tier=summary` of the launch screen (where the model reads
 *    the screens it can name), then ONE `navigate-to {label}` (or `{screen}` when
 *    the label is not unique) on a store warmed by one pass over the route BEFORE
 *    measurement. The reply's `compact` (the final screen's tree) is the
 *    observation after it. 2 tool calls; tokens = the summary + that compact.
 *    `targetInSummary` records whether the summary actually lists the target: the
 *    label is the harness's (read off the store after the warm-up), and with the
 *    summary's cap of 8 reachable screens a 3-hop destination behind 8 nearer
 *    ones is not listed. That rate is a finding about the summary, not the harness.
 *  - `nograph`: per hop, the scripted policy's locate (plumbing: it stands in for
 *    reading coordinates off the previous describe, so it is neither a tool call
 *    nor an observation), `gesture-tap`, then `describe tier=compact` of the
 *    screen it opened (the renderer of navigate-to's `compact`, so the token ratio
 *    compares one renderer). 2 tool calls per hop; tokens = the describes.
 *
 * The nograph arm pays no observation of the launch screen (the scripted locate
 * stands in for it), and neither arm runs a harness settle: both rely on the open server's
 * tap, which returns once the screen changed and went quiet, the same wait
 * `navigate-to` takes between its own hops. Device RPCs are counted by one
 * counter on the shared open-server instance (`countDeviceRpcs`), so both arms
 * are measured the same way; `navigate-to`'s self-reported `rpcCount` is kept for
 * cross-checking. Success is the existing oracle (`evaluateAssertion` over the
 * live tree) run after the clock stops, AND the arm completing its route.
 *
 * Device-free: every effect goes through {@link MultihopDeps}, which the bench
 * script binds to its registry and the unit test to a fake tool-server.
 */
import { reachableScreens, resolveScreenTarget, screenAddress, type PlanGraph } from "../plan";
import type { BenchSelector, BenchTask } from "./types";

export type MultihopArm = "graph" | "nograph";

/** How the graph arm addresses the destination screen (`navigate-to` target). */
export type GraphTarget = { label: string } | { screen: string };

export interface MultihopLocate {
  xNorm: number;
  yNorm: number;
  found: boolean;
  ambiguous?: boolean;
}

export interface MultihopDeps {
  udid: string;
  /** A tool-server tool call: what the model would issue (counted as a turn). */
  invokeTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Bring the app to its launch screen (before the clock starts). */
  launch(task: BenchTask): Promise<void>;
  /** Plumbing: a selector's normalized centre on the live screen. */
  locate(sel: BenchSelector): Promise<MultihopLocate>;
  /** The success oracle on the live screen (after the clock stops). */
  oracle(needle: string): Promise<{ matched: boolean; error?: boolean }>;
  /** The graph address of the screen now shown (read after a warm-up pass). */
  currentTarget(): Promise<GraphTarget | null>;
  /** The identity hash (H_id) of the screen now shown, read once it settled; "" when unknown. */
  currentHash(): Promise<string>;
  /** The current app's graph as the store holds it now. */
  graph(): Promise<PlanGraph>;
  /** Device RPCs issued so far (monotonic). */
  rpcs(): number;
  now(): number;
  /** Observation token count (o200k in the bench). */
  countTokens(s: string): number;
  log?(m: string): void;
}

export interface MultihopSample {
  task: string;
  arm: MultihopArm;
  rep: number;
  /** Hops performed: `navigate-to`'s planned hops, or the taps the nograph arm issued. */
  hops: number;
  /** Taps the route takes (the task's depth). */
  plannedHops: number;
  /** Tool calls the model would make (= turns). */
  toolCalls: number;
  /** Observation tokens the model would read. */
  obsTokens: number;
  /** Device RPCs inside the measured window, plumbing excluded. */
  rpcs: number;
  /** Device RPCs of the nograph locate (plumbing; 0 on the graph arm). */
  plumbingRpcs: number;
  /** `navigate-to`'s own `rpcCount` (graph arm), to cross-check `rpcs`. */
  navRpcCount?: number;
  readsSkipped?: number;
  /** Wall time of the arm's calls, plumbing excluded. */
  wallMs: number;
  /** The arm completed its route (navigate reached / every hop tapped). */
  reached: boolean;
  /** `reached` and the oracle found the needle. */
  success: boolean;
  /** The oracle could not be read. */
  oracleError: boolean;
  target?: GraphTarget;
  /** Graph arm: the launch screen's summary lists the target under "reachable screens". */
  targetInSummary?: boolean;
  error?: string;
}

export interface MultihopWarmup {
  task: string;
  ok: boolean;
  target?: GraphTarget;
  error?: string;
  /** The warm-up's cost, route only (after the launch): taps issued, device RPCs, wall ms. */
  taps: number;
  rpcs: number;
  wallMs: number;
  /**
   * The first route position (0 = the launch screen, 1 = after hop 1, …) whose
   * summary lists the target under "reachable screens", computed off the clock
   * once every warm-up ran (the store the measured summaries read); null when
   * none does, absent when the warm-up failed.
   */
  listedFromDepth?: number | null;
}

export interface MultihopBlockResult {
  samples: MultihopSample[];
  warmups: MultihopWarmup[];
}

/** The task's route: the selectors of its tap steps, in order. */
function routeOf(task: BenchTask): BenchSelector[] {
  return task.steps.flatMap((s) => (s.action.kind === "tap" ? [s.action.selector] : []));
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function judge(
  deps: MultihopDeps,
  task: BenchTask,
  reached: boolean
): Promise<{ success: boolean; oracleError: boolean }> {
  if (!reached) return { success: false, oracleError: false };
  try {
    const o = await deps.oracle(task.assertion.text ?? task.assertion.id ?? "");
    return { success: o.matched && !o.error, oracleError: Boolean(o.error) };
  } catch {
    return { success: false, oracleError: true };
  }
}

/** One measured sample of one arm on one task (launch and oracle off the clock). */
export async function runMultihopSample(
  deps: MultihopDeps,
  task: BenchTask,
  arm: MultihopArm,
  rep: number,
  target: GraphTarget | null
): Promise<MultihopSample> {
  const route = routeOf(task);
  const base: MultihopSample = {
    task: task.id,
    arm,
    rep,
    hops: 0,
    plannedHops: route.length,
    toolCalls: 0,
    obsTokens: 0,
    rpcs: 0,
    plumbingRpcs: 0,
    wallMs: 0,
    reached: false,
    success: false,
    oracleError: false,
  };
  if (arm === "graph" && !target) {
    return { ...base, error: "no graph target: the warm-up did not reach the destination" };
  }
  await deps.launch(task);

  if (arm === "graph") {
    const r0 = deps.rpcs();
    const t0 = deps.now();
    let summary = "";
    let reply: {
      reached?: boolean;
      hops?: number;
      readsSkipped?: number;
      rpcCount?: number;
      compact?: string;
      error?: string;
    } = {};
    let error: string | undefined;
    try {
      const d = (await deps.invokeTool("describe", { udid: deps.udid, tier: "summary" })) as {
        description?: string;
      };
      summary = d?.description ?? "";
    } catch (e) {
      error = `summary: ${errText(e)}`;
    }
    try {
      reply = ((await deps.invokeTool("navigate-to", { udid: deps.udid, target })) ??
        {}) as typeof reply;
      if (!reply.reached) error = reply.error ?? "navigate-to did not reach the target";
    } catch (e) {
      error = errText(e);
    }
    const sample: MultihopSample = {
      ...base,
      target: target!,
      targetInSummary: targetInSummary(summary, target!),
      toolCalls: 2,
      wallMs: deps.now() - t0,
      rpcs: deps.rpcs() - r0,
      hops: reply.hops ?? 0,
      obsTokens: deps.countTokens(summary) + (reply.compact ? deps.countTokens(reply.compact) : 0),
      reached: Boolean(reply.reached),
      ...(typeof reply.rpcCount === "number" ? { navRpcCount: reply.rpcCount } : {}),
      ...(typeof reply.readsSkipped === "number" ? { readsSkipped: reply.readsSkipped } : {}),
      ...(error ? { error } : {}),
    };
    return { ...sample, ...(await judge(deps, task, sample.reached)) };
  }

  // nograph: locate (plumbing) + gesture-tap + describe per hop.
  const r0 = deps.rpcs();
  const t0 = deps.now();
  let plumbingRpcs = 0;
  let plumbingMs = 0;
  let toolCalls = 0;
  let obsTokens = 0;
  let hops = 0;
  let error: string | undefined;
  for (const [i, sel] of route.entries()) {
    const p0 = deps.rpcs();
    const pt0 = deps.now();
    const loc = await deps
      .locate(sel)
      .catch((): MultihopLocate => ({ xNorm: 0.5, yNorm: 0.5, found: false }));
    plumbingRpcs += deps.rpcs() - p0;
    plumbingMs += deps.now() - pt0;
    if (!loc.found) {
      error = `hop ${i + 1} (${JSON.stringify(sel)}) ${loc.ambiguous ? "ambiguous" : "not found"}`;
      break;
    }
    try {
      toolCalls += 1;
      await deps.invokeTool("gesture-tap", { udid: deps.udid, x: loc.xNorm, y: loc.yNorm });
      toolCalls += 1;
      const d = (await deps.invokeTool("describe", { udid: deps.udid, tier: "compact" })) as {
        description?: string;
      };
      obsTokens += deps.countTokens(d?.description ?? "");
    } catch (e) {
      error = `hop ${i + 1}: ${errText(e)}`;
      break;
    }
    hops += 1;
  }
  const sample: MultihopSample = {
    ...base,
    hops,
    toolCalls,
    obsTokens,
    rpcs: deps.rpcs() - r0 - plumbingRpcs,
    plumbingRpcs,
    wallMs: deps.now() - t0 - plumbingMs,
    reached: hops === route.length,
    ...(error ? { error } : {}),
  };
  return { ...sample, ...(await judge(deps, task, sample.reached)) };
}

/**
 * Warm the store for one task: launch, then locate + tap every hop (recording
 * on, no describe, nothing counted), and read the destination's graph address.
 */
/** A warm-up's outcome plus the route it walked (screen hashes, then the target's). */
interface WarmupRun {
  warmup: MultihopWarmup;
  route?: { hashes: string[]; target: string };
}

async function warmUp(deps: MultihopDeps, task: BenchTask): Promise<WarmupRun> {
  let taps = 0;
  let r0 = deps.rpcs();
  let t0 = deps.now();
  let bookRpcs = 0;
  let bookMs = 0;
  const cost = () => ({
    taps,
    rpcs: deps.rpcs() - r0 - bookRpcs,
    wallMs: deps.now() - t0 - bookMs,
  });
  try {
    await deps.launch(task);
    r0 = deps.rpcs();
    t0 = deps.now();
    const routeHashes: string[] = [];
    for (const [i, sel] of routeOf(task).entries()) {
      // The H_id read is bookkeeping for `listedFromDepth`, not warm-up cost.
      const hr = deps.rpcs();
      const ht = deps.now();
      routeHashes.push(await deps.currentHash());
      bookRpcs += deps.rpcs() - hr;
      bookMs += deps.now() - ht;
      const loc = await deps.locate(sel);
      if (!loc.found) {
        return {
          warmup: {
            task: task.id,
            ok: false,
            error: `warm-up hop ${i + 1} ${JSON.stringify(sel)}`,
            ...cost(),
          },
        };
      }
      await deps.invokeTool("gesture-tap", { udid: deps.udid, x: loc.xNorm, y: loc.yNorm });
      taps += 1;
    }
    const spent = cost();
    const target = await deps.currentTarget();
    if (!target) {
      return {
        warmup: { task: task.id, ok: false, error: "destination not in the graph", ...spent },
      };
    }
    return {
      warmup: { task: task.id, ok: true, target, ...spent },
      route: { hashes: routeHashes, target: await deps.currentHash() },
    };
  } catch (e) {
    return { warmup: { task: task.id, ok: false, error: `warm-up: ${errText(e)}`, ...cost() } };
  }
}

/**
 * The first position along `route` (screen hashes, launch screen first) whose
 * summary's "reachable screens" list holds `target` (the same `reachableScreens`
 * and cap the summary tier uses); null when no screen of the route lists it.
 */
export function listedFromDepth(graph: PlanGraph, route: string[], target: string): number | null {
  for (const [i, from] of route.entries()) {
    if (from && reachableScreens(graph, from).some((r) => r.hash === target)) return i;
  }
  return null;
}

/**
 * Whether a rendered summary lists `target` on one of its "reachable screens"
 * lines (`- <address>  <label>  (<n> hops)`): the address by prefix either way,
 * the label case-insensitively, a label cut with `…` by its prefix.
 */
export function targetInSummary(summary: string, target: GraphTarget): boolean {
  const lines = summary.split("\n");
  const start = lines.findIndex((l) => l.trim() === "reachable screens:");
  if (start < 0) return false;
  for (const line of lines.slice(start + 1)) {
    const m = /^- (\S+)(?: {2}(.*?))? {2}\(\d+ hops?\)$/.exec(line.trim());
    if (!m) break;
    const [, address, label] = m;
    if ("screen" in target) {
      const want = target.screen.trim().toLowerCase();
      const have = address!.toLowerCase();
      if (have.startsWith(want) || want.startsWith(have)) return true;
      continue;
    }
    if (label === undefined) continue;
    const want = target.label.trim().toLowerCase();
    const have = label.trim().toLowerCase();
    if (have === want) return true;
    if (have.endsWith("…") && want.startsWith(have.slice(0, -1))) return true;
  }
  return false;
}

/**
 * The block: one warm-up per task (off the clock), then `reps` rounds over every
 * task, both arms per task, the arm order alternating by round (graph first on
 * even rounds) so drift over the run lands on both arms alike.
 */
export async function runMultihopBlock(
  deps: MultihopDeps,
  tasks: BenchTask[],
  opts: { reps: number }
): Promise<MultihopBlockResult> {
  const warmups: MultihopWarmup[] = [];
  const routes = new Map<MultihopWarmup, { hashes: string[]; target: string }>();
  const targets = new Map<string, GraphTarget | null>();
  for (const task of tasks) {
    const { warmup: w, route } = await warmUp(deps, task);
    warmups.push(w);
    if (route) routes.set(w, route);
    targets.set(task.id, w.target ?? null);
    deps.log?.(
      `[bench-sg] multihop warm-up ${task.id}: ${w.ok ? JSON.stringify(w.target) : `FAILED ${w.error}`}`
    );
  }
  // listedFromDepth on the store EVERY warm-up filled (the one the measured
  // summaries read), once, off the clock: a later route can push an earlier
  // task's target past the summary's cap.
  if (routes.size > 0) {
    const graph = await deps.graph();
    for (const [w, route] of routes) {
      w.listedFromDepth = listedFromDepth(graph, route.hashes, route.target);
    }
  }
  const samples: MultihopSample[] = [];
  for (let rep = 0; rep < opts.reps; rep++) {
    const order: MultihopArm[] = rep % 2 === 0 ? ["graph", "nograph"] : ["nograph", "graph"];
    for (const task of tasks) {
      for (const arm of order) {
        const s = await runMultihopSample(deps, task, arm, rep, targets.get(task.id) ?? null);
        samples.push(s);
        if (s.error) deps.log?.(`[bench-sg] multihop ${task.id}/${arm}/rep${rep}: ${s.error}`);
      }
    }
  }
  return { samples, warmups };
}

/**
 * The address the graph arm passes to `navigate-to` for `hash`: its label when
 * that label names this one node (the way the model reads it off the summary),
 * else its hash8 (`describe tier=summary` prints both). `null` when the graph
 * does not hold the node.
 */
export function chooseGraphTarget(graph: PlanGraph, hash: string): GraphTarget | null {
  const node = graph.nodes[hash];
  if (!node || node.template) return null;
  if (node.label !== undefined && node.label.trim() !== "") {
    const r = resolveScreenTarget(graph, { label: node.label });
    if (r.kind === "node" && r.hash === hash) return { label: node.label };
  }
  return { screen: screenAddress(graph, hash) };
}

/**
 * The open-server methods that cross to the device (the same set `navigate-to`
 * counts for its own `rpcCount`).
 */
export const DEVICE_RPC_METHODS: readonly string[] = [
  "getInfo",
  "getState",
  "getNestedState",
  "query",
  "diff",
  "awaitChange",
  "waitForIdle",
  "screenshot",
  "getScreenSize",
  "getAccessibilityTree",
  "getNestedAccessibilityTree",
  "tap",
  "tapWithOutcome",
  "longPress",
  "longPressWithOutcome",
  "swipe",
  "swipeWithOutcome",
  "gesture",
  "gestureWithOutcome",
  "key",
  "keyWithOutcome",
  "typeText",
  "typeTextWithOutcome",
  "batch",
  "scrollContainer",
];

/**
 * Count every device RPC issued through `server` by wrapping its methods in
 * place. Tools resolve the same registry-cached instance, so a tool's RPCs and
 * the bench's own are counted by the one counter. `restore` puts the original
 * methods back (the count is kept).
 */
export function countDeviceRpcs(
  server: object,
  methods: readonly string[] = DEVICE_RPC_METHODS
): { count(): number; restore(): void } {
  let n = 0;
  const target = server as Record<string, unknown>;
  const saved: Array<[string, unknown, boolean]> = [];
  for (const m of methods) {
    const fn = target[m];
    if (typeof fn !== "function") continue;
    saved.push([m, fn, Object.prototype.hasOwnProperty.call(target, m)]);
    target[m] = (...args: unknown[]) => {
      n += 1;
      return (fn as (...a: unknown[]) => unknown).apply(server, args);
    };
  }
  return {
    count: () => n,
    restore: () => {
      for (const [m, fn, own] of saved) {
        if (own) target[m] = fn;
        else delete target[m];
      }
    },
  };
}
