/**
 * Step navigate-to-addressable: the agent addresses a known screen by its label
 * or by a hash8 prefix, `describe tier=summary` lists the screens reachable from
 * the current one, and `navigate-to` reads the device once per hop.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: () => true };
});

let currentStore: ScreenGraphStore;
vi.mock("../src/utils/screen-graph-open-wiring", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/screen-graph-open-wiring")>(
    "../src/utils/screen-graph-open-wiring"
  );
  return {
    ...actual,
    resolveStoreForCurrentApp: async () => ({
      store: currentStore,
      packageName: "com.android.settings",
      versionCode: "35",
    }),
    screenGraphTemplatesEnabled: () => false,
  };
});

import type { Registry } from "@argent/registry";
import { ScreenGraphStore } from "../src/screen-graph/store";
import { buildSummary, renderSummary } from "../src/screen-graph/describe-tiers";
import { reachableScreens, resolveScreenTarget } from "../src/screen-graph/plan";
import type { Edge, ScreenNode } from "../src/screen-graph/types";
import { createNavigateToTool } from "../src/tools/navigate-to";
import { describeAndroidTiered } from "../src/tools/describe/platforms/android/tiered";
import { resolveDevice } from "../src/utils/device-info";

const NOW = 1_700_000_000_000;

const ROOT = "1111111100000000";
const NET = "2222222200000000";
const INTERNET = "3333333300000000";
const APPS_A = "4444444400000000";
const APPS_B = "5555555500000000";
const DETAIL_A = "deadbeef0000aaaa";
const DETAIL_B = "deadbeef0000bbbb";

const LABELS: Record<string, string> = {
  [ROOT]: "Settings",
  [NET]: "SubSettings: Network & internet",
  [INTERNET]: "SubSettings: Internet",
  [APPS_A]: "SubSettings: Apps",
  [APPS_B]: "SubSettings: Apps",
  [DETAIL_A]: "Detail A",
  [DETAIL_B]: "Detail B",
};

/** Each edge: from, tapped row text, to. */
const EDGES: Array<[string, string, string]> = [
  [ROOT, "Network & internet", NET],
  [NET, "Internet", INTERNET],
  [ROOT, "Apps", APPS_A],
  [ROOT, "App info", APPS_B],
  [ROOT, "Row A", DETAIL_A],
  [ROOT, "Row B", DETAIL_B],
];

let dir: string;

function buildStore(): ScreenGraphStore {
  const s = new ScreenGraphStore({
    packageName: "com.android.settings",
    versionCode: "35",
    baseDir: dir,
    now: () => NOW,
    debounceMs: 10_000_000,
  });
  for (const [hash, label] of Object.entries(LABELS)) {
    s.upsertNode({ hash, label, compact: "", index: {}, resourceIds: [`rid_${hash}`] });
  }
  for (const [from, text, to] of EDGES) {
    s.observe(from, { kind: "tap", target: { text } }, to, { selector: { text, via: "text" } });
  }
  return s;
}

interface FakeServer {
  getState: ReturnType<typeof vi.fn>;
  getInfo: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  tapWithOutcome: ReturnType<typeof vi.fn>;
  keyWithOutcome: ReturnType<typeof vi.fn>;
}

/** The key names the device server knows (KeyHandler.kt keyNameMap); others throw. */
const DEVICE_KEY_NAMES = new Set([
  "home",
  "back",
  "enter",
  "delete",
  "tab",
  "escape",
  "menu",
  "search",
  "volume_up",
  "volume_down",
  "power",
  "camera",
  "dpad_up",
  "dpad_down",
  "dpad_left",
  "dpad_right",
  "dpad_center",
  "recent_apps",
  "space",
]);

/**
 * A device that starts on ROOT. Every row text in EDGES is on screen once; a
 * tap on a row lands on the edge's `to`. `landOn` maps the screen a tap lands on
 * to the H_id the device reports for it (a drifted H_id); the tree keeps the
 * real screen's resource id, so the Jaccard fallback still recognises it.
 */
function fakeServer(
  opts: {
    landOn?: (to: string) => string;
    settled?: "quiet" | "timeout" | "no-event";
    start?: string;
    /** The screen a `back` key press lands on. */
    backTo?: string;
  } = {}
): FakeServer {
  let screen = opts.start ?? ROOT;
  let reported = screen;
  const rowAt = new Map<string, string>();
  EDGES.forEach(([, , to], i) => rowAt.set(`500:${100 + i * 100}`, to));
  const rows = EDGES.map(([, text], i) => ({
    text,
    bounds: { x1: 0, y1: 50 + i * 100, x2: 1000, y2: 150 + i * 100 },
  }));
  return {
    getState: vi.fn(async () => ({
      idHash: reported,
      hash: reported,
      stateHash: `st_${screen}`,
      info: { screenWidth: 1080, screenHeight: 1920 },
      tree: [
        {
          index: 0,
          className: "android.widget.TextView",
          resourceId: `rid_${screen}`,
          text: `Title of ${LABELS[screen]}`,
          bounds: { x1: 0, y1: 40, x2: 1080, y2: 160 },
        },
      ],
    })),
    getInfo: vi.fn(async () => ({
      currentPackage: "com.android.settings",
      currentActivity: "com.android.settings.SubSettings",
    })),
    query: vi.fn(async (sel: { text?: { contains: string } }) => ({
      nodes: rows.filter((r) => r.text.toLowerCase() === sel.text?.contains.toLowerCase()),
    })),
    tapWithOutcome: vi.fn(async (x: number, y: number) => {
      screen = rowAt.get(`${x}:${y}`) ?? screen;
      reported = opts.landOn ? opts.landOn(screen) : screen;
      return {
        changed: true,
        settled: opts.settled ?? "quiet",
        after: { idHash: reported, hash: reported, stateHash: `st_${screen}` },
      };
    }),
    keyWithOutcome: vi.fn(async (key: string) => {
      const name = key.toLowerCase();
      if (!DEVICE_KEY_NAMES.has(name)) throw new Error(`Unknown key: ${name}`);
      if (name === "back" && opts.backTo) screen = opts.backTo;
      reported = screen;
      return {
        changed: true,
        settled: "quiet",
        after: { idHash: reported, hash: reported, stateHash: `st_${screen}` },
      };
    }),
  };
}

async function navigate(server: FakeServer, target: Record<string, unknown>) {
  const registry = { resolveService: async () => server } as unknown as Registry;
  const tool = createNavigateToTool(registry);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return tool.execute({}, { udid: "emulator-5554", target } as any);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sg-nav-targets-"));
  currentStore = buildStore();
});

afterEach(() => {
  currentStore.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveScreenTarget (plan.ts)", () => {
  const graph = () => ({ edges: currentStore.edges, nodes: currentStore.nodes });

  it("matches a label case-insensitively", () => {
    expect(resolveScreenTarget(graph(), { label: "subsettings: INTERNET" })).toEqual({
      kind: "node",
      hash: INTERNET,
    });
  });

  it("falls back to the title half of an `Activity: title` label", () => {
    expect(resolveScreenTarget(graph(), { label: "network & internet" })).toEqual({
      kind: "node",
      hash: NET,
    });
  });

  it("reports every node that holds an ambiguous label", () => {
    const r = resolveScreenTarget(graph(), { label: "SubSettings: Apps" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect([...r.hashes].sort()).toEqual([APPS_A, APPS_B]);
  });

  it("resolves a unique hash8 prefix and refuses an ambiguous one", () => {
    expect(resolveScreenTarget(graph(), { screen: "33333333" })).toEqual({
      kind: "node",
      hash: INTERNET,
    });
    const r = resolveScreenTarget(graph(), { screen: "DEADBEEF" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect([...r.hashes].sort()).toEqual([DETAIL_A, DETAIL_B]);
  });

  it("does not treat a prefix shorter than 8 hex as an address", () => {
    expect(resolveScreenTarget(graph(), { screen: "3333" })).toEqual({ kind: "none" });
  });
});

describe("navigate-to target.label / hash8 (tool)", () => {
  it("routes to a unique label and reports path, hops and reads skipped", async () => {
    const server = fakeServer();
    const res = await navigate(server, { label: "subsettings: internet" });
    expect(res.reached).toBe(true);
    expect(res.hops).toBe(2);
    expect(res.path).toEqual([
      { hash8: "11111111", label: "Settings" },
      { hash8: "22222222", label: "SubSettings: Network & internet" },
      { hash8: "33333333", label: "SubSettings: Internet" },
    ]);
  });

  it("fails closed on an ambiguous label and lists the candidates", async () => {
    const server = fakeServer();
    const res = await navigate(server, { label: "SubSettings: Apps" });
    expect(res.reached).toBe(false);
    expect(res.error).toMatch(/ambiguous target: 2 screens have the label/);
    expect(res.candidates).toEqual([
      { hash8: "44444444", label: "SubSettings: Apps" },
      { hash8: "55555555", label: "SubSettings: Apps" },
    ]);
    expect(server.tapWithOutcome).not.toHaveBeenCalled();
  });

  it("routes to a unique hash8 prefix", async () => {
    const server = fakeServer();
    const res = await navigate(server, { screen: "33333333" });
    expect(res.reached).toBe(true);
    expect(res.finalScreen).toBe("SubSettings: Internet");
    expect(res.hops).toBe(2);
  });

  it("fails closed on an ambiguous hash8 prefix with a longer prefix per candidate", async () => {
    const server = fakeServer();
    const res = await navigate(server, { screen: "deadbeef" });
    expect(res.reached).toBe(false);
    expect(res.error).toMatch(/ambiguous target: 2 screens match the prefix deadbeef/);
    expect(res.candidates).toEqual([
      { hash8: "deadbeef0000a", label: "Detail A" },
      { hash8: "deadbeef0000b", label: "Detail B" },
    ]);
    expect(server.tapWithOutcome).not.toHaveBeenCalled();
  });

  it("names an unknown label in the error", async () => {
    const res = await navigate(fakeServer(), { label: "Bluetooth" });
    expect(res.reached).toBe(false);
    expect(res.error).toMatch(/no known screen has the label "Bluetooth"/);
  });
});

describe("navigate-to reads the device once per hop", () => {
  it("skips the post-tap getState on a quiet settle at the planned H_id (final compact cached)", async () => {
    currentStore.upsertNode({ hash: NET, compact: "CACHED NET TREE", stateHash: `st_${NET}` });
    const server = fakeServer();
    const res = await navigate(server, { screen: NET });
    expect(res.reached).toBe(true);
    expect(res.readsSkipped).toBe(1);
    expect(res.compact).toBe("CACHED NET TREE");
    // Only the initial read before planning: the cache answers for the final screen.
    expect(server.getState).toHaveBeenCalledTimes(1);
  });

  it("skips every intermediate read and reads the final screen once for its compact", async () => {
    const server = fakeServer();
    const res = await navigate(server, { screen: INTERNET });
    expect(res.reached).toBe(true);
    expect(res.readsSkipped).toBe(2);
    // Initial read + one read of the final screen (its node has no cached compact).
    expect(server.getState).toHaveBeenCalledTimes(2);
  });

  it("never serves an empty cached compact: a quiet landing on a volatile node reads", async () => {
    // A volatile node is persisted with `compact: ""` and keeps its stateHash.
    currentStore.upsertNode({ hash: NET, compact: "", stateHash: `st_${NET}` });
    const server = fakeServer();
    const res = await navigate(server, { screen: NET });
    expect(res.readsSkipped).toBe(1);
    expect(res.compact).toContain("Title of SubSettings: Network & internet");
    expect(server.getState).toHaveBeenCalledTimes(2);
  });

  it("reads the screen after a hop whose settle timed out, even at the planned H_id", async () => {
    const server = fakeServer({ settled: "timeout" });
    const res = await navigate(server, { screen: NET });
    expect(res.reached).toBe(true);
    expect(res.readsSkipped).toBe(0);
    // Initial read + the post-hop read; the compact reuses the post-hop read.
    expect(server.getState).toHaveBeenCalledTimes(2);
  });

  it("reads the screen when the tap reports a different H_id (Jaccard fallback)", async () => {
    const server = fakeServer({ landOn: (to) => `${to}-drift` });
    const res = await navigate(server, { screen: NET });
    // The live read still reports the drifted H_id but shows rid_NET, so the
    // resource-id Jaccard accepts the arrival.
    expect(res.reached).toBe(true);
    expect(res.readsSkipped).toBe(0);
    expect(server.getState).toHaveBeenCalledTimes(2);
  });
});

describe("navigate-to returns the final compact tree", () => {
  it("equals what describe tier=compact renders for the same device state", async () => {
    const server = fakeServer();
    const res = await navigate(server, { label: "SubSettings: Internet" });
    expect(res.reached).toBe(true);
    expect(res.compact).toBeTruthy();
    expect(res.compact).toContain("Title of SubSettings: Internet");
    const registry = { resolveService: async () => server } as unknown as Registry;
    const described = await describeAndroidTiered(
      registry,
      resolveDevice("emulator-5554"),
      "compact"
    );
    expect(res.compact).toBe(described.description);
  });

  it("equals describe tier=compact on the cache path too", async () => {
    // Seed the cache the way describe does: a compact read on NET.
    const atNet = fakeServer({ start: NET });
    const reg = (srv: FakeServer) => ({ resolveService: async () => srv }) as unknown as Registry;
    const device = resolveDevice("emulator-5554");
    const seeded = await describeAndroidTiered(reg(atNet), device, "compact");
    expect(currentStore.getNode(NET)?.stateHash).toBe(`st_${NET}`);
    // Navigate from ROOT: the quiet landing on NET matches the cached state.
    const server = fakeServer();
    const res = await navigate(server, { screen: NET });
    expect(res.readsSkipped).toBe(1);
    expect(server.getState).toHaveBeenCalledTimes(1);
    const described = await describeAndroidTiered(reg(server), device, "compact");
    expect(res.compact).toBe(described.description);
    expect(res.compact).toBe(seeded.description);
  });

  it("keeps the summary next to the compact tree", async () => {
    const res = await navigate(fakeServer(), { screen: NET });
    expect(res.summary).toMatch(/^screen: SubSettings: Network & internet/);
    expect(res.compact).toBeTruthy();
  });

  it("has no compact on a refusal (no action ran)", async () => {
    const res = await navigate(fakeServer(), { label: "SubSettings: Apps" });
    expect(res.compact).toBeUndefined();
  });
});

describe("summary tier lists reachable screens", () => {
  const graph = () => ({ edges: currentStore.edges, nodes: currentStore.nodes });

  it("reachableScreens orders by hops, then label, and leaves out the start", () => {
    const r = reachableScreens(graph(), ROOT);
    expect(r.map((x) => [x.hash, x.hops])).toEqual([
      [DETAIL_A, 1],
      [DETAIL_B, 1],
      [APPS_A, 1],
      [APPS_B, 1],
      [NET, 1],
      [INTERNET, 2],
    ]);
  });

  it("caps the list at 8 destinations", () => {
    const edges: Edge[] = [];
    const nodes: Record<string, ScreenNode> = {
      s: { hash: "s", firstSeen: NOW, lastSeen: NOW, visits: 1, compact: "", index: {} },
    };
    for (let i = 0; i < 20; i++) {
      const h = `n${String(i).padStart(2, "0")}`;
      nodes[h] = { hash: h, firstSeen: NOW, lastSeen: NOW, visits: 1, compact: "", index: {} };
      edges.push({
        from: "s",
        to: h,
        action: { kind: "tap", target: { text: h } },
        count: 1,
        successes: 1,
        lastSeen: NOW,
      });
    }
    expect(reachableScreens({ edges, nodes }, "s")).toHaveLength(8);
  });

  it("stays within 200 tokens with 16 one-hop destinations, labels cut to 40 characters", () => {
    const edges: Edge[] = [];
    const mk = (hash: string, label?: string): ScreenNode => ({
      hash,
      firstSeen: NOW,
      lastSeen: NOW,
      visits: 3,
      compact: "",
      index: {},
      ...(label ? { label } : {}),
    });
    const nodes: Record<string, ScreenNode> = {
      a0a0a0a0a0a0a0a0: mk("a0a0a0a0a0a0a0a0", "SubSettings: Network & internet"),
    };
    // Twice the cap: 16 one-hop destinations, each label longer than 40 characters.
    for (let i = 0; i < 16; i++) {
      const h = `${(i + 1).toString(16)}b`.padEnd(16, "c");
      nodes[h] = mk(h, `SubSettings: Connected devices preferences page number ${i}`);
      edges.push({
        from: "a0a0a0a0a0a0a0a0",
        to: h,
        action: { kind: "tap", target: { text: `Connected devices preferences ${i}` } },
        count: 16 - i,
        successes: 16 - i,
        lastSeen: NOW,
      });
    }
    // A self-loop swipe stays an affordance (no reachable line repeats it).
    edges.push({
      from: "a0a0a0a0a0a0a0a0",
      to: "a0a0a0a0a0a0a0a0",
      action: { kind: "swipe", dir: "up" },
      count: 30,
      successes: 30,
      lastSeen: NOW,
    });
    const root = nodes.a0a0a0a0a0a0a0a0!;
    const text = renderSummary(
      buildSummary(
        root,
        edges.filter((e) => e.from === root.hash),
        nodes,
        { edges }
      )
    );
    const listed = text.split("\n").filter((l) => /\(\d+ hops?\)$/.test(l));
    expect(listed).toHaveLength(8);
    for (const l of listed) {
      const label = l.slice(2).split("  ")[1]!;
      expect(label.length).toBeLessThanOrEqual(40);
    }
    expect(listed[0]).toContain("SubSettings: Connected devices preferen…");
    // No 1-hop destination prints as an affordance, listed or not (8 of 16 listed).
    expect(text).toContain("affordances:\n- swipe up -> SubSettings: Network & internet (30)\n");
    expect(text).not.toMatch(/tap "Connected devices preferences \d+"/);
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(200);
  });

  it("renders `hash8  label  (N hops)` lines in the summary", () => {
    const node = currentStore.getNode(ROOT)!;
    const text = renderSummary(
      buildSummary(node, currentStore.outgoingEdges(ROOT), currentStore.nodes, {
        edges: currentStore.edges,
      })
    );
    expect(text).toContain("reachable screens:");
    expect(text).toContain("- 22222222  SubSettings: Network & internet  (1 hop)");
    expect(text).toContain("- 33333333  SubSettings: Internet  (2 hops)");
    const lines = text.split("\n");
    const at = lines.indexOf("reachable screens:");
    expect(lines.slice(at + 1, at + 7).map((l) => l.slice(2, 10))).toEqual([
      "deadbeef",
      "deadbeef",
      "44444444",
      "55555555",
      "22222222",
      "33333333",
    ]);
  });

  it("omits the section when the graph has no edges", () => {
    const lone: ScreenNode = {
      hash: ROOT,
      firstSeen: NOW,
      lastSeen: NOW,
      visits: 1,
      compact: "",
      index: {},
      label: "Settings",
    };
    const text = renderSummary(buildSummary(lone, [], { [ROOT]: lone }, { edges: [] }));
    expect(text).not.toContain("reachable screens");
  });
});

describe("navigate-to replays a back edge with the device key name", () => {
  it("sends keyWithOutcome('back'), the name KeyHandler.kt knows, and lands", async () => {
    currentStore.observe(INTERNET, { kind: "back" }, NET);
    const server = fakeServer({ start: INTERNET, backTo: NET });
    const res = await navigate(server, { screen: "22222222" });
    expect(server.keyWithOutcome).toHaveBeenCalledTimes(1);
    expect(server.keyWithOutcome.mock.calls[0]![0]).toBe("back");
    expect(res.reached).toBe(true);
    expect(res.hops).toBe(1);
  });
});
