import { describe, expect, it } from "vitest";
import { buildSummary, renderSummary } from "../src/screen-graph/describe-tiers";
import type { PlanGraph } from "../src/screen-graph/plan";
import { MULTIHOP_TASKS } from "../src/screen-graph/bench/tasks";
import {
  chooseGraphTarget,
  countDeviceRpcs,
  listedFromDepth,
  runMultihopBlock,
  runMultihopSample,
  targetInSummary,
  type MultihopDeps,
} from "../src/screen-graph/bench/multihop";
import type { BenchTask } from "../src/screen-graph/bench/types";
import type { Edge, ScreenNode } from "../src/screen-graph/types";

/*
 * A fake tool-server over a three-level Settings tree. Every device-facing call
 * bumps one RPC counter (the bench's measured count); the plumbing `locate`
 * costs 2 RPCs (query + getInfo), a `gesture-tap` 1, a `describe` 1 and a
 * `navigate-to` the RPCs it reports. The clock moves 10 ms per call. A `describe
 * tier=summary` lists `listed` under "reachable screens" (the root's summary).
 */
interface Screen {
  label: string;
  rows: Record<string, string>; // row text -> destination screen
  text: string[]; // what the oracle and describe see
}
const SCREENS: Record<string, Screen> = {
  root: { label: "Settings", rows: { "Network & internet": "net" }, text: ["Network & internet"] },
  net: {
    label: "Network & internet",
    rows: { Internet: "inet" },
    text: ["Internet", "Calls & SMS"],
  },
  inet: {
    label: "Internet",
    rows: { "Network preferences": "prefs" },
    text: ["Network preferences", "Add network"],
  },
  prefs: { label: "Network preferences", rows: {}, text: ["Install certificates"] },
};

const TASK: BenchTask = {
  id: "mh-fake",
  app: "settings",
  description: "root -> net -> inet -> prefs",
  steps: [
    { action: { kind: "launch" } },
    { action: { kind: "tap", selector: { text: "Network & internet" } } },
    { action: { kind: "tap", selector: { text: "Internet" } } },
    { action: { kind: "tap", selector: { text: "Network preferences" } } },
  ],
  assertion: { text: "Install certificates" },
};

const NOW = 1_700_000_000_000;
const gnode = (hash: string, label?: string): ScreenNode => ({
  hash,
  firstSeen: NOW,
  lastSeen: NOW,
  visits: 1,
  compact: "",
  index: {},
  ...(label !== undefined ? { label } : {}),
});
const tapEdge = (from: string, to: string, text: string): Edge => ({
  from,
  to,
  action: { kind: "tap", target: { text } },
  count: 1,
  successes: 1,
  lastSeen: NOW,
});
const describeText = (s: Screen): string => `screen ${s.label}\n${s.text.join("\n")}`;
const compactText = (s: Screen): string => `compact ${s.label}: ${s.text.join(", ")}`;
const summaryText = (s: Screen, listed: string[]): string =>
  [
    `screen: ${s.label}  visits: 1`,
    "reachable screens:",
    ...listed.map((l, i) => `- ${String(i).repeat(8)}  ${l}  (1 hop)`),
  ].join("\n");

interface Fake {
  deps: MultihopDeps;
  calls: string[];
  args: Array<Record<string, unknown>>;
  screen: () => string;
  rpcs: () => number;
}

function fake(
  opts: { warmTarget?: "none" | "label"; listed?: string[]; screens?: Record<string, Screen> } = {}
): Fake {
  const SC = opts.screens ?? SCREENS;
  // The fake recorder: a tap that moves records its edge, as the wiring does.
  const recorded = new Map<string, Edge>();
  let current = "root";
  let rpcs = 0;
  let clock = 0;
  let pending: { x: number; y: number; to: string; row: string } | null = null;
  const calls: string[] = [];
  const argsLog: Array<Record<string, unknown>> = [];
  const tick = () => {
    clock += 10;
  };
  const deps: MultihopDeps = {
    udid: "emulator-5554",
    async invokeTool(name, args) {
      tick();
      calls.push(name);
      argsLog.push(args);
      if (name === "gesture-tap") {
        rpcs += 1;
        if (pending && pending.x === args.x && pending.y === args.y) {
          recorded.set(`${current}>${pending.to}`, tapEdge(current, pending.to, pending.row));
          current = pending.to;
        }
        return { outcome: { changed: true, newScreen: true } };
      }
      if (name === "describe") {
        rpcs += 1;
        if (args.tier === "summary") {
          return {
            description: summaryText(SC[current]!, opts.listed ?? ["Network & internet"]),
          };
        }
        return { description: describeText(SC[current]!) };
      }
      if (name === "navigate-to") {
        const target = (args.target ?? {}) as { label?: string };
        const dest = Object.keys(SC).find((k) => SC[k]!.label === target.label);
        if (!dest) {
          rpcs += 2;
          return { reached: false, error: "no known screen", rpcCount: 2 };
        }
        current = dest;
        rpcs += 8;
        return {
          reached: true,
          hops: 3,
          readsSkipped: 3,
          rpcCount: 8,
          compact: compactText(SC[dest]!),
          path: [],
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
    async launch() {
      tick();
      current = "root";
    },
    async locate(sel) {
      tick();
      rpcs += 2;
      const to = SC[current]!.rows[sel.text ?? ""];
      if (!to) return { xNorm: 0.5, yNorm: 0.5, found: false };
      pending = { x: 0.25, y: 0.75, to, row: sel.text ?? "" };
      return { xNorm: 0.25, yNorm: 0.75, found: true };
    },
    async oracle(needle) {
      tick();
      return { matched: SC[current]!.text.includes(needle) };
    },
    async currentTarget() {
      if (opts.warmTarget === "none") return null;
      return { label: SC[current]!.label };
    },
    async currentHash() {
      return current;
    },
    async graph() {
      const nodes: Record<string, ScreenNode> = { root: gnode("root", SC.root!.label) };
      for (const e of recorded.values()) nodes[e.to] = gnode(e.to, SC[e.to]!.label);
      return { nodes, edges: [...recorded.values()] };
    },
    rpcs: () => rpcs,
    now: () => clock,
    countTokens: (s: string) => s.length,
  };
  return { deps, calls, args: argsLog, screen: () => current, rpcs: () => rpcs };
}

describe("MULTIHOP sample: graph arm", () => {
  it("reads the root summary, then ONE navigate-to by label; both observations count", async () => {
    const f = fake();
    const s = await runMultihopSample(f.deps, TASK, "graph", 0, { label: "Network preferences" });
    expect(f.calls).toEqual(["describe", "navigate-to"]);
    expect(f.args[0]).toEqual({ udid: "emulator-5554", tier: "summary" });
    expect(s.toolCalls).toBe(2);
    const summaryLen = summaryText(SCREENS.root!, ["Network & internet"]).length;
    expect(s.obsTokens).toBe(summaryLen + compactText(SCREENS.prefs!).length);
    expect(s.targetInSummary).toBe(false);
    expect(s.hops).toBe(3);
    expect(s.plannedHops).toBe(3);
    // 1 describe + navigate-to's 8.
    expect(s.rpcs).toBe(9);
    expect(s.navRpcCount).toBe(8);
    expect(s.readsSkipped).toBe(3);
    expect(s.reached).toBe(true);
    expect(s.success).toBe(true);
    expect(s.target).toEqual({ label: "Network preferences" });
  });

  it("records whether the root summary lists the target", async () => {
    const f = fake({ listed: ["Network & internet", "Network preferences"] });
    const s = await runMultihopSample(f.deps, TASK, "graph", 0, { label: "Network preferences" });
    expect(s.targetInSummary).toBe(true);
    expect(s.success).toBe(true);
  });

  it("fails without a call when warm-up produced no target", async () => {
    const f = fake();
    const s = await runMultihopSample(f.deps, TASK, "graph", 0, null);
    expect(f.calls).toEqual([]);
    expect(s.toolCalls).toBe(0);
    expect(s.success).toBe(false);
    expect(s.error).toMatch(/warm-up/);
  });

  it("is a failure when navigate-to refuses", async () => {
    const f = fake();
    const s = await runMultihopSample(f.deps, TASK, "graph", 0, { label: "Nowhere" });
    expect(s.toolCalls).toBe(2);
    expect(s.reached).toBe(false);
    expect(s.success).toBe(false);
    expect(s.obsTokens).toBe(summaryText(SCREENS.root!, ["Network & internet"]).length);
  });
});

describe("MULTIHOP sample: nograph arm", () => {
  it("is locate + tap + describe per hop; locate is plumbing", async () => {
    const f = fake();
    const s = await runMultihopSample(f.deps, TASK, "nograph", 0, null);
    expect(f.calls).toEqual([
      "gesture-tap",
      "describe",
      "gesture-tap",
      "describe",
      "gesture-tap",
      "describe",
    ]);
    expect(s.toolCalls).toBe(6);
    // The same renderer as navigate-to's `compact` reply.
    for (const a of f.args.filter((_, i) => f.calls[i] === "describe")) {
      expect(a).toEqual({ udid: "emulator-5554", tier: "compact" });
    }
    expect(s.hops).toBe(3);
    const describes = ["net", "inet", "prefs"].map((k) => describeText(SCREENS[k]!).length);
    expect(s.obsTokens).toBe(describes.reduce((a, b) => a + b, 0));
    // 3 taps + 3 describes measured; the 3 locates (2 RPCs each) are plumbing.
    expect(s.rpcs).toBe(6);
    expect(s.plumbingRpcs).toBe(6);
    expect(s.reached).toBe(true);
    expect(s.success).toBe(true);
    expect(f.screen()).toBe("prefs");
  });

  it("stops at the first hop it cannot locate and fails", async () => {
    const f = fake();
    const broken: BenchTask = {
      ...TASK,
      steps: [
        TASK.steps[0]!,
        TASK.steps[1]!,
        { action: { kind: "tap", selector: { text: "Missing row" } } },
        TASK.steps[3]!,
      ],
    };
    const s = await runMultihopSample(f.deps, broken, "nograph", 0, null);
    expect(s.hops).toBe(1);
    expect(s.toolCalls).toBe(2);
    expect(s.reached).toBe(false);
    expect(s.success).toBe(false);
    expect(s.error).toMatch(/hop 2/);
  });
});

describe("MULTIHOP block", () => {
  it("warms each task once off the clock, then n samples per arm in alternating order", async () => {
    const f = fake();
    const res = await runMultihopBlock(f.deps, [TASK], { reps: 4 });
    // Warm-up: the route by locate + tap, no describe and no navigate-to.
    expect(f.calls.slice(0, 3)).toEqual(["gesture-tap", "gesture-tap", "gesture-tap"]);
    // Warm-up cost, route only (after the launch): 3 locates (2 RPCs) + 3 taps, 6 calls x 10 ms.
    expect(res.warmups).toEqual([
      {
        task: "mh-fake",
        ok: true,
        target: { label: "Network preferences" },
        taps: 3,
        rpcs: 9,
        wallMs: 60,
        // root -> net -> inet -> prefs: the root's summary already lists prefs (3 hops, under the cap).
        listedFromDepth: 0,
      },
    ]);
    expect(res.samples.filter((s) => s.arm === "graph")).toHaveLength(4);
    expect(res.samples.filter((s) => s.arm === "nograph")).toHaveLength(4);
    const firstArm = (rep: number) => res.samples.find((s) => s.rep === rep)!.arm;
    expect([0, 1, 2, 3].map(firstArm)).toEqual(["graph", "nograph", "graph", "nograph"]);
    expect(res.samples.every((s) => s.success)).toBe(true);
    // Counts per sample are the arm's own, never the warm-up's.
    expect(res.samples.filter((s) => s.arm === "graph").every((s) => s.toolCalls === 2)).toBe(true);
    expect(res.samples.filter((s) => s.arm === "nograph").every((s) => s.toolCalls === 6)).toBe(
      true
    );
  });

  it("computes listedFromDepth once, on the store every warm-up filled", async () => {
    // Three 3-hop routes from one root, z warmed FIRST. Alone, z's root summary
    // lists z3 (depth 0). Once a and b are warmed the root holds 6 screens at
    // hops 1-2 plus a3, b3 at hop 3 = the cap of 8, and z3 (sorted last) is cut.
    const SCR: Record<string, Screen> = { root: { label: "Root", rows: {}, text: [] } };
    const tasks: BenchTask[] = [];
    for (const p of ["z", "a", "b"]) {
      SCR.root!.rows[`${p}1`] = `${p}1`;
      for (let i = 1; i <= 3; i++) {
        SCR[`${p}${i}`] = {
          label: `${p}${i}`,
          rows: i < 3 ? { [`${p}${i + 1}`]: `${p}${i + 1}` } : {},
          text: i === 3 ? [`needle ${p}`] : [],
        };
      }
      tasks.push({
        id: `mh-${p}`,
        app: "settings",
        description: p,
        steps: [
          { action: { kind: "launch" } },
          ...[1, 2, 3].map((i) => ({
            action: { kind: "tap" as const, selector: { text: `${p}${i}` } },
          })),
        ],
        assertion: { text: `needle ${p}` },
      });
    }
    const f = fake({ screens: SCR });
    const res = await runMultihopBlock(f.deps, tasks, { reps: 1 });
    expect(res.warmups.map((w) => [w.task, w.listedFromDepth])).toEqual([
      ["mh-z", 1],
      ["mh-a", 0],
      ["mh-b", 0],
    ]);
  });

  it("still measures nograph when warm-up yields no graph target", async () => {
    const f = fake({ warmTarget: "none" });
    const res = await runMultihopBlock(f.deps, [TASK], { reps: 2 });
    expect(res.warmups[0]).toMatchObject({ task: "mh-fake", ok: false });
    expect(res.samples.filter((s) => s.arm === "graph").every((s) => !s.success)).toBe(true);
    expect(res.samples.filter((s) => s.arm === "nograph").every((s) => s.success)).toBe(true);
  });
});

describe("targetInSummary", () => {
  const SUMMARY = [
    "screen: Settings  visits: 4",
    "affordances:",
    '- tap "Internet" -> Internet (3)',
    "reachable screens:",
    "- 1a2b3c4d  Network & internet  (1 hop)",
    "- 5e6f7a8b  Internet  (2 hops)",
    "- 9c0d1e2f  (2 hops)",
    "- 3a4b5c6d  An extremely long screen label that is cu…  (3 hops)",
  ].join("\n");

  it("finds a label or an address on a reachable line only", () => {
    expect(targetInSummary(SUMMARY, { label: "internet" })).toBe(true);
    expect(targetInSummary(SUMMARY, { screen: "9c0d1e2f" })).toBe(true);
    expect(targetInSummary(SUMMARY, { label: "Network preferences" })).toBe(false);
    expect(targetInSummary(SUMMARY, { screen: "ffffffff" })).toBe(false);
  });

  it("matches a label cut with an ellipsis by its prefix", () => {
    expect(
      targetInSummary(SUMMARY, {
        label: "An extremely long screen label that is cut at forty characters",
      })
    ).toBe(true);
  });

  it("is false without a reachable list", () => {
    expect(
      targetInSummary("screen: Settings  visits: 1\naffordances: (none known)", {
        label: "Settings",
      })
    ).toBe(false);
  });
});

describe("the MULTIHOP routes on the real summary (review round 2)", () => {
  // The warmed store the six routes leave: one node per route prefix, one tap edge per hop.
  const nodes: Record<string, ScreenNode> = { root: gnode("root", "Settings") };
  const edges: Edge[] = [];
  const routes = MULTIHOP_TASKS.map((t) =>
    t.steps.flatMap((s) => (s.action.kind === "tap" ? [s.action.selector.text!] : []))
  );
  const hashOf = (rows: string[]): string => (rows.length ? rows.join(">") : "root");
  for (const rows of routes) {
    for (let i = 0; i < rows.length; i++) {
      const to = hashOf(rows.slice(0, i + 1));
      nodes[to] = gnode(to, rows[i]);
      if (!edges.some((e) => e.to === to))
        edges.push(tapEdge(hashOf(rows.slice(0, i)), to, rows[i]!));
    }
  }
  const graph: PlanGraph = { nodes, edges };

  it("never lists a depth-3 target in the root summary (9 screens at hops 1-2 fill the cap of 8)", () => {
    const text = renderSummary(
      buildSummary(
        nodes.root!,
        edges.filter((e) => e.from === "root"),
        nodes,
        { edges }
      )
    );
    for (const rows of routes) {
      expect(targetInSummary(text, { label: rows[2]! }), rows.join(" > ")).toBe(false);
    }
  });

  it("lists every target from the hop-1 screen on (offline, from the warmed graph)", () => {
    for (const rows of routes) {
      const route = [0, 1, 2].map((i) => hashOf(rows.slice(0, i)));
      expect(listedFromDepth(graph, route, hashOf(rows)), rows.join(" > ")).toBe(1);
    }
  });

  it("is null when no screen of the route lists the target", () => {
    expect(listedFromDepth(graph, ["root"], "nowhere")).toBeNull();
  });
});

describe("chooseGraphTarget", () => {
  const n = gnode;
  const edges: Edge[] = [];

  it("addresses a uniquely labelled screen by its label", () => {
    const nodes = { aaaaaaaa11: n("aaaaaaaa11", "Internet"), bbbbbbbb22: n("bbbbbbbb22", "Apps") };
    expect(chooseGraphTarget({ nodes, edges }, "aaaaaaaa11")).toEqual({ label: "Internet" });
  });

  it("falls back to the hash8 address when the label is ambiguous or absent", () => {
    const nodes = {
      aaaaaaaa11: n("aaaaaaaa11", "Internet"),
      cccccccc33: n("cccccccc33", "internet"),
      dddddddd44: n("dddddddd44"),
    };
    expect(chooseGraphTarget({ nodes, edges }, "aaaaaaaa11")).toEqual({ screen: "aaaaaaaa" });
    expect(chooseGraphTarget({ nodes, edges }, "dddddddd44")).toEqual({ screen: "dddddddd" });
  });

  it("returns null for a screen the graph does not hold", () => {
    expect(chooseGraphTarget({ nodes: {}, edges }, "eeeeeeee55")).toBeNull();
  });
});

describe("countDeviceRpcs", () => {
  it("counts every device-facing method call on the shared server and restores it", async () => {
    const server = {
      async getState() {
        return { ok: 1 };
      },
      async tapWithOutcome() {
        return { ok: 2 };
      },
      isReady() {
        return true;
      },
    };
    const counter = countDeviceRpcs(server);
    await server.getState();
    await server.tapWithOutcome();
    expect(server.isReady()).toBe(true);
    expect(counter.count()).toBe(2);
    counter.restore();
    await server.getState();
    expect(counter.count()).toBe(2);
  });
});
