/**
 * Markdown helpers for the screen-graph bench report (`results-ci.md`) and the
 * MULTIHOP block's statistics + section (`multihop-results.md`).
 */
import { pct, ratio } from "./tokens";

/**
 * One `| key | value |` cell of the report's Environment table. Objects (the
 * `churn` gates, `settingsGraph`) are printed as compact JSON, not `String(v)`'s
 * `[object Object]` (review E-1 2026-10-07 finding 8); table pipes are escaped.
 */
export function formatEnvValue(v: unknown): string {
  const s = v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\|/g, "\\|");
}

/* -------------------------------------------------------------------------- */
/* MULTIHOP block                                                             */
/* -------------------------------------------------------------------------- */

/** Non-inferiority margin for paired success, in percentage points. */
export const MULTIHOP_SUCCESS_MARGIN_PP = 5;
/**
 * Paired success non-inferiority as pre-registered: the lower bound of the
 * graph − nograph interval stays ABOVE −{@link MULTIHOP_SUCCESS_MARGIN_PP} pp,
 * so a bound sitting exactly on the margin is not non-inferior.
 */
export function successNonInferior(lo: number): boolean {
  return Number.isFinite(lo) && lo > -MULTIHOP_SUCCESS_MARGIN_PP;
}
/** Pre-registered token bar (graph mean ÷ nograph mean). */
export const MULTIHOP_TOKENS_BAR = 0.7;

/**
 * The cost claims: graded with the graph target supplied by the harness. Tool
 * calls carry no bar: the graph arm is 2 calls and nograph 2k (k ≥ 3 hops) by
 * construction, so the ratio is reported, never graded.
 */
export const MULTIHOP_PREREGISTRATION_COST =
  `Cost claims (graph target supplied by the harness): observation tokens ≤ ` +
  `${MULTIHOP_TOKENS_BAR}× nograph (means over the pairs where both arms succeeded) and ` +
  `success non-inferior (paired by task + rep: the 95% task-bootstrap interval of graph − ` +
  `nograph success stays above −${MULTIHOP_SUCCESS_MARGIN_PP} pp); tool calls graph ÷ nograph ` +
  `is reported without a bar (2 vs 2k by construction).`;

/**
 * The discovery claim: whether the model could have named the target from what
 * it read (the root summary's reachable screens). Its own verdict, report only.
 */
export const MULTIHOP_PREREGISTRATION_DISCOVERY =
  "Discovery claim (report only): the rate of graph samples whose root summary lists the " +
  "target (targetInSummary), and per task the first route depth whose summary lists it.";

/**
 * The block's pre-registration, printed verbatim at the head of its section.
 * Fixed in code before any run produces data; it grades nothing that gates.
 */
export const MULTIHOP_PREREGISTRATION = `${MULTIHOP_PREREGISTRATION_COST} ${MULTIHOP_PREREGISTRATION_DISCOVERY}`;

/** The per-sample fields the report reads (a subset of `MultihopSample`). */
export interface MultihopReportSample {
  task: string;
  arm: "graph" | "nograph";
  rep: number;
  hops: number;
  plannedHops: number;
  toolCalls: number;
  obsTokens: number;
  rpcs: number;
  wallMs: number;
  success: boolean;
  /** Graph arm: the launch screen's summary listed the target. */
  targetInSummary?: boolean;
}

type MultihopMetric = "toolCalls" | "obsTokens" | "rpcs" | "wallMs" | "hops";

export interface WelchResult {
  /** mean(a) − mean(b). */
  diff: number;
  t: number;
  df: number;
  /** Two-sided p. */
  p: number;
}

export interface MultihopRatio {
  graphMean: number;
  nographMean: number;
  /** graphMean ÷ nographMean (3 decimals). */
  ratio: number;
  /** Pairs both arms succeeded on (the cost comparison's n). */
  n: number;
  /** 95% task-cluster bootstrap interval of the ratio. */
  lo: number;
  hi: number;
  welch: WelchResult | null;
  /** The pre-registered bar, when the metric has one. */
  bar?: number;
  met?: boolean;
}

export interface MultihopTaskRow {
  task: string;
  plannedHops: number;
  /** Pairs (task, rep) with both arms. */
  n: number;
  graphOk: number;
  nographOk: number;
  graphN: number;
  nographN: number;
  graph: Record<MultihopMetric, number>;
  nograph: Record<MultihopMetric, number>;
}

export interface MultihopPaired {
  pairs: number;
  both: number;
  graphOnly: number;
  nographOnly: number;
  neither: number;
  /** graph − nograph success over the pairs, in pp (1 decimal). */
  diffPp: number;
  lo: number;
  hi: number;
  nonInferior: boolean;
}

export interface MultihopSummary {
  perTask: MultihopTaskRow[];
  aggregate: Record<MultihopMetric, MultihopRatio>;
  paired: MultihopPaired;
}

const METRICS: MultihopMetric[] = ["toolCalls", "obsTokens", "rpcs", "wallMs", "hops"];
const METRIC_LABEL: Record<MultihopMetric, string> = {
  toolCalls: "tool calls",
  obsTokens: "observation tokens",
  rpcs: "device RPCs",
  wallMs: "wall ms",
  hops: "hops",
};
const BARS: Partial<Record<MultihopMetric, number>> = {
  obsTokens: MULTIHOP_TOKENS_BAR,
};

const BOOTSTRAP_B = 10_000;
const BOOTSTRAP_SEED = 0x5eed_c0de;

/** The bench's seeded PRNG (same as the matrix bootstrap), so intervals regenerate. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs: readonly number[]): number =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;

function variance(xs: readonly number[]): number {
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}

/** ln Γ(x), Lanczos (g = 7, n = 9). */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61503916999185, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction of the regularized incomplete beta (Numerical Recipes `betacf`). */
function betacf(a: number, b: number, x: number): number {
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  return x < (a + 1) / (a + b + 2)
    ? (bt * betacf(a, b, x)) / a
    : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/**
 * Welch's unequal-variance two-sample t: `diff = mean(a) − mean(b)`, the
 * Welch–Satterthwaite df and the two-sided p from Student's t. `null` when a
 * side has fewer than 2 values or both sides have zero variance.
 */
export function welch(a: number[], b: number[]): WelchResult | null {
  if (a.length < 2 || b.length < 2) return null;
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  const se2 = va + vb;
  if (!(se2 > 0)) return null;
  const diff = mean(a) - mean(b);
  const t = diff / Math.sqrt(se2);
  const df = (se2 * se2) / ((va * va) / (a.length - 1) + (vb * vb) / (b.length - 1));
  const p = incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return { diff, t, df, p };
}

const keyOf = (s: MultihopReportSample): string => `${s.task}\u001f${s.rep}`;

interface Pair {
  task: string;
  graph: MultihopReportSample;
  nograph: MultihopReportSample;
}

function pairsOf(samples: readonly MultihopReportSample[]): Pair[] {
  const g = new Map<string, MultihopReportSample>();
  const ng = new Map<string, MultihopReportSample>();
  for (const s of samples) (s.arm === "graph" ? g : ng).set(keyOf(s), s);
  const out: Pair[] = [];
  for (const [k, gs] of g) {
    const ns = ng.get(k);
    if (ns) out.push({ task: gs.task, graph: gs, nograph: ns });
  }
  return out;
}

/** 2.5 / 97.5 percentiles of a task-cluster bootstrap of `stat` over `pairs`. */
function clusterBootstrap(
  pairs: readonly Pair[],
  stat: (ps: readonly Pair[]) => number
): { lo: number; hi: number } {
  const byTask = new Map<string, Pair[]>();
  for (const p of pairs) byTask.set(p.task, [...(byTask.get(p.task) ?? []), p]);
  const tasks = [...byTask.keys()];
  if (tasks.length === 0) return { lo: NaN, hi: NaN };
  const rng = mulberry32(BOOTSTRAP_SEED);
  const boots: number[] = [];
  for (let b = 0; b < BOOTSTRAP_B; b++) {
    const sample: Pair[] = [];
    for (let i = 0; i < tasks.length; i++) {
      sample.push(...byTask.get(tasks[Math.floor(rng() * tasks.length)]!)!);
    }
    const v = stat(sample);
    if (Number.isFinite(v)) boots.push(v);
  }
  if (boots.length === 0) return { lo: NaN, hi: NaN };
  boots.sort((x, y) => x - y);
  return {
    lo: boots[Math.floor(0.025 * boots.length)]!,
    hi: boots[Math.min(boots.length - 1, Math.ceil(0.975 * boots.length) - 1)]!,
  };
}

const ratioOf = (ps: readonly Pair[], m: MultihopMetric): number =>
  mean(ps.map((p) => p.graph[m])) / mean(ps.map((p) => p.nograph[m]));
const successDiffPp = (ps: readonly Pair[]): number =>
  ps.length
    ? ((ps.filter((p) => p.graph.success).length - ps.filter((p) => p.nograph.success).length) /
        ps.length) *
      100
    : NaN;
const round = (x: number, d: number): number => (Number.isFinite(x) ? Number(x.toFixed(d)) : x);

/**
 * The block's numbers: success paired by (task, rep) with a task-cluster
 * bootstrap interval of graph − nograph, and every cost metric as a graph ÷
 * nograph ratio of means over the pairs where BOTH arms succeeded (a failed run
 * stops early and would look cheap), with its bootstrap interval and Welch t.
 * `excludeTasks` (the tasks whose warm-up failed) are left out of every number:
 * a harness failure is not an arm outcome.
 */
export function multihopSummary(
  all: MultihopReportSample[],
  opts: { excludeTasks?: readonly string[] } = {}
): MultihopSummary {
  const excluded = new Set(opts.excludeTasks ?? []);
  const samples = all.filter((x) => !excluded.has(x.task));
  const pairs = pairsOf(samples);
  const both = pairs.filter((p) => p.graph.success && p.nograph.success);
  const aggregate = {} as Record<MultihopMetric, MultihopRatio>;
  for (const m of METRICS) {
    const gm = mean(both.map((p) => p.graph[m]));
    const nm = mean(both.map((p) => p.nograph[m]));
    const ci = clusterBootstrap(both, (ps) => ratioOf(ps, m));
    const r = ratio(gm, nm);
    const bar = BARS[m];
    aggregate[m] = {
      graphMean: gm,
      nographMean: nm,
      ratio: r,
      n: both.length,
      lo: round(ci.lo, 3),
      hi: round(ci.hi, 3),
      welch: welch(
        both.map((p) => p.graph[m]),
        both.map((p) => p.nograph[m])
      ),
      ...(bar !== undefined ? { bar, met: Number.isFinite(r) && r <= bar } : {}),
    };
  }
  const graphOnly = pairs.filter((p) => p.graph.success && !p.nograph.success).length;
  const nographOnly = pairs.filter((p) => !p.graph.success && p.nograph.success).length;
  const diffCi = clusterBootstrap(pairs, successDiffPp);
  const paired: MultihopPaired = {
    pairs: pairs.length,
    both: both.length,
    graphOnly,
    nographOnly,
    neither: pairs.length - both.length - graphOnly - nographOnly,
    diffPp: round(successDiffPp(pairs), 1),
    lo: round(diffCi.lo, 1),
    hi: round(diffCi.hi, 1),
    nonInferior: successNonInferior(diffCi.lo),
  };
  const tasks = [...new Set(samples.map((s) => s.task))];
  const perTask = tasks.map((task): MultihopTaskRow => {
    const g = samples.filter((s) => s.task === task && s.arm === "graph");
    const ng = samples.filter((s) => s.task === task && s.arm === "nograph");
    const agg = (xs: MultihopReportSample[]): Record<MultihopMetric, number> => {
      const out = {} as Record<MultihopMetric, number>;
      for (const m of METRICS) {
        out[m] =
          m === "wallMs"
            ? pct(
                xs.map((x) => x[m]).sort((a, b) => a - b),
                50
              )
            : mean(xs.map((x) => x[m]));
      }
      return out;
    };
    return {
      task,
      plannedHops: (g[0] ?? ng[0])?.plannedHops ?? 0,
      n: pairs.filter((p) => p.task === task).length,
      graphOk: g.filter((s) => s.success).length,
      nographOk: ng.filter((s) => s.success).length,
      graphN: g.length,
      nographN: ng.length,
      graph: agg(g),
      nograph: agg(ng),
    };
  });
  return { perTask, aggregate, paired };
}

const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : "n/a");
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "n/a");
const pv = (p: number): string => (p < 0.001 ? "<0.001" : p.toFixed(3));

/** The block's markdown section (`multihop-results.md`, appended to the run's report). */
export function renderMultihopReport(input: {
  samples: MultihopReportSample[];
  warmups: Array<{
    task: string;
    ok: boolean;
    target?: { label: string } | { screen: string };
    error?: string;
    taps?: number;
    rpcs?: number;
    wallMs?: number;
    listedFromDepth?: number | null;
  }>;
  reps: number;
  /** Whether the app's graph was emptied before the warm-up (BENCH_FRESH_STORE). */
  storeReset?: { reset: boolean; packageName: string; nodesBefore: number; edgesBefore: number };
}): string {
  const failed = input.warmups.filter((w) => !w.ok).map((w) => w.task);
  const s = multihopSummary(input.samples, { excludeTasks: failed });
  const graphSamples = input.samples.filter(
    (x) => x.arm === "graph" && !failed.includes(x.task) && x.targetInSummary !== undefined
  );
  const L: string[] = [];
  L.push("## MULTIHOP: one navigate-to vs locate + tap + describe per hop\n");
  L.push(
    `**Pre-registration** (fixed in code before the run; measurement only, no promotion gate): ${MULTIHOP_PREREGISTRATION}\n`
  );
  L.push(
    "Cost claims hold with the graph target supplied by the harness, not discovered by the model. The discovery claim is graded on its own (section below).\n"
  );
  L.push(
    "- `graph`: `describe tier=summary` of the launch screen, then ONE `navigate-to` by label (the destination's hash8 when its label is not unique) on a store warmed by one pass over the route before measurement; the reply's `compact` is the observation after it. 2 tool calls; tokens = the summary + that compact. The label is the harness's (read off the store); `targetInSummary` says whether the summary the model read actually listed it.\n" +
      "- `nograph`: per hop, the scripted locate (plumbing, neither a call nor an observation), `gesture-tap`, then `describe tier=compact`. 2 tool calls per hop; tokens = the describes.\n" +
      "- Tokens: o200k, same renderer on both arms (`describe tier=compact` and navigate-to's `compact` reply are the same compact tier). No harness settle on either arm (both rely on the open server's settled tap). Device RPCs: one counter on the shared open-server instance for both arms, the nograph locate excluded. Success: the route completed AND the oracle found the needle (read after the clock stops).\n" +
      `- ${input.reps} rounds; per round every task runs both arms, graph first on even rounds. Pairs are (task, rep).\n`
  );

  if (input.storeReset) {
    const r = input.storeReset;
    L.push(
      `store reset before the warm-up: ${r.reset ? "yes" : "no, BENCH_FRESH_STORE unset"} ` +
        `(${r.packageName} held ${r.nodesBefore} nodes, ${r.edgesBefore} edges).\n`
    );
  }
  L.push("### Warm-up (one locate + tap pass per task, off the clock; cost of the route only)\n");
  L.push(
    "| task | warm-up | graph target | taps | device RPCs | wall ms | target listed from depth |"
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const w of input.warmups) {
    const target = !w.target
      ? "none"
      : "label" in w.target
        ? `target \`${w.target.label.replace(/\|/g, "\\|")}\` (label)`
        : `target \`${w.target.screen}\` (screen)`;
    const num = (x?: number): string => (typeof x === "number" ? String(x) : "n/a");
    L.push(
      `| ${w.task} | ${w.ok ? "ok" : `FAILED: ${(w.error ?? "").replace(/\|/g, "\\|")}`} | ${target} | ` +
        `${num(w.taps)} | ${num(w.rpcs)} | ${num(w.wallMs)} | ` +
        `${w.listedFromDepth === undefined ? "n/a" : w.listedFromDepth === null ? "never" : w.listedFromDepth} |`
    );
  }
  L.push("");
  if (failed.length > 0) {
    L.push(
      `warm-up failed: ${failed.length} task${failed.length === 1 ? "" : "s"} excluded (${failed.join(", ")}); ` +
        "not measured in any table below.\n"
    );
  }

  L.push("### Per task (means over every sample of the arm; wall ms is the p50)\n");
  L.push(
    "| task | hops | pairs | success graph | success nograph | tool calls g / ng | tokens g / ng | RPCs g / ng | wall ms p50 g / ng |"
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of s.perTask) {
    L.push(
      `| ${r.task} | ${r.plannedHops} | ${r.n} | ${r.graphOk}/${r.graphN} | ${r.nographOk}/${r.nographN} | ` +
        `${f1(r.graph.toolCalls)} / ${f1(r.nograph.toolCalls)} | ${f1(r.graph.obsTokens)} / ${f1(r.nograph.obsTokens)} | ` +
        `${f1(r.graph.rpcs)} / ${f1(r.nograph.rpcs)} | ${f1(r.graph.wallMs)} / ${f1(r.nograph.wallMs)} |`
    );
  }
  L.push("");

  const n = s.aggregate.toolCalls.n;
  L.push(`### Aggregate (pairs where both arms succeeded, n = ${n})\n`);
  L.push(
    "| metric | graph mean | nograph mean | ratio | 95% CI (task bootstrap) | Welch t (df), p | pre-registered |"
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const m of METRICS) {
    const a = s.aggregate[m];
    const w = a.welch
      ? `${a.welch.t.toFixed(2)} (${a.welch.df.toFixed(1)}), ${pv(a.welch.p)}`
      : "n/a";
    const bar =
      m === "toolCalls"
        ? "structural (2 vs 2k)"
        : a.bar === undefined
          ? "—"
          : `≤ ${a.bar}: ${a.met ? "met" : "not met"}`;
    L.push(
      `| ${METRIC_LABEL[m]} | ${f1(a.graphMean)} | ${f1(a.nographMean)} | ${f3(a.ratio)} | ${f3(a.lo)}–${f3(a.hi)} | ${w} | ${bar} |`
    );
  }
  L.push("");
  L.push(
    "The task bootstrap interval is the primary one; the Welch p is unpaired (it treats the (task, rep) samples as independent) and only a cross-check.\n"
  );

  const p = s.paired;
  L.push("### Paired success (by task + rep)\n");
  L.push(
    `pairs ${p.pairs}: both ${p.both}, graph only ${p.graphOnly}, nograph only ${p.nographOnly}, neither ${p.neither}. ` +
      `graph − nograph = ${p.diffPp >= 0 ? "+" : ""}${f1(p.diffPp)} pp (95% task bootstrap ${f1(p.lo)} to ${f1(p.hi)}); ` +
      `non-inferior at −${MULTIHOP_SUCCESS_MARGIN_PP} pp: ${p.nonInferior ? "yes" : "no"}.\n`
  );

  const listed = graphSamples.filter((x) => x.targetInSummary).length;
  L.push("### Discovery claim (report only)\n");
  L.push(
    `target listed in the root summary: ${listed}/${graphSamples.length} graph samples. ` +
      `the model can address a depth ≥3 target from the root summary only if it is listed; with the ` +
      `current cap of 8 and this Settings graph it is ${listed}/${graphSamples.length}` +
      `${listed < graphSamples.length ? " — product gap, see plan Amendments (summary cap)" : ""}. ` +
      "The warm-up table gives, per task, the first route depth whose summary lists the target.\n"
  );
  return L.join("\n");
}
