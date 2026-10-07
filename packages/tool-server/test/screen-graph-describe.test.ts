import { describe, expect, it, vi } from "vitest";
import {
  buildSummary,
  renderSummary,
  resolveCompactTier,
  type CompactTierDeps,
} from "../src/screen-graph/describe-tiers";
import type { Edge, ScreenNode } from "../src/screen-graph/types";

const NOW = 1_700_000_000_000;

function node(hash: string, over: Partial<ScreenNode> = {}): ScreenNode {
  return { hash, firstSeen: NOW, lastSeen: NOW, visits: 1, compact: "", index: {}, ...over };
}

function edge(from: string, to: string, count: number, text: string): Edge {
  return {
    from,
    to,
    action: { kind: "tap", target: { text } },
    count,
    successes: count,
    lastSeen: NOW,
  };
}

// Android Settings root fixture (mirrors the Phase A screen-hash Settings tree
// shape): a labelled root with the usual top-level destinations.
const SETTINGS_ROOT = node("h1settings", { label: "Settings", visits: 4 });
const SETTINGS_NODES: Record<string, ScreenNode> = {
  h1settings: SETTINGS_ROOT,
  n_net: node("n_net", { label: "SubSettings: Network & internet" }),
  n_dev: node("n_dev", { label: "SubSettings: Connected devices" }),
  n_app: node("n_app", { label: "SubSettings: Apps" }),
  n_not: node("n_not", { label: "SubSettings: Notifications" }),
  n_bat: node("n_bat", { label: "SubSettings: Battery" }),
  n_sto: node("n_sto", { label: "SubSettings: Storage" }),
};
const SETTINGS_EDGES: Edge[] = [
  edge("h1settings", "n_net", 12, "Network & internet"),
  edge("h1settings", "n_dev", 9, "Connected devices"),
  edge("h1settings", "n_app", 7, "Apps"),
  edge("h1settings", "n_not", 5, "Notifications"),
  edge("h1settings", "n_bat", 4, "Battery"),
  edge("h1settings", "n_sto", 2, "Storage"),
];

const tokens = (s: string) => Math.ceil(s.length / 4);

describe("summary tier", () => {
  it("renders the Settings fixture summary within the ~120 token budget", () => {
    const summary = buildSummary(
      SETTINGS_ROOT,
      SETTINGS_EDGES.filter((e) => e.from === "h1settings"),
      SETTINGS_NODES
    );
    const text = renderSummary(summary);
    expect(tokens(text)).toBeLessThanOrEqual(120);
  });

  it("lists top-N affordances by count with their targets' labels", () => {
    const summary = buildSummary(SETTINGS_ROOT, SETTINGS_EDGES, SETTINGS_NODES, { topN: 3 });
    expect(summary.screen).toBe("Settings");
    expect(summary.visits).toBe(4);
    expect(summary.affordances).toHaveLength(3);
    expect(summary.affordances[0]).toMatchObject({
      action: 'tap "Network & internet"',
      to: "SubSettings: Network & internet",
      count: 12,
    });
    // sorted by count descending
    expect(summary.affordances.map((a) => a.count)).toEqual([12, 9, 7]);
  });

  it("lists no reachable screens unless the caller passes the graph edges", () => {
    const text = renderSummary(buildSummary(SETTINGS_ROOT, SETTINGS_EDGES, SETTINGS_NODES));
    expect(text).not.toContain("reachable screens");
  });

  it("lists the Settings destinations, nearest first, within ~200 tokens", () => {
    const text = renderSummary(
      buildSummary(SETTINGS_ROOT, SETTINGS_EDGES, SETTINGS_NODES, { edges: SETTINGS_EDGES })
    );
    expect(text).toContain("reachable screens:");
    // An unlabelled id prints its hash prefix; every edge here is one hop.
    expect(text).toContain("- n_app  SubSettings: Apps  (1 hop)");
    expect(text.split("\n").filter((l) => l.endsWith("(1 hop)"))).toHaveLength(6);
    expect(tokens(text)).toBeLessThanOrEqual(200);
  });

  it("uses hash8 when a screen has no label and reports changedSince", () => {
    const bare = node("abcdef0123456789", { visits: 1 });
    const summary = buildSummary(bare, [], {}, { changedSince: 3 });
    const text = renderSummary(summary);
    expect(summary.screen).toBe("abcdef01");
    expect(text).toContain("changedSince: 3");
  });
});

describe("compact tier cache reconciliation", () => {
  const cached = node("h1", { compact: "CACHED TREE", stateHash: "s1" });

  function deps(): CompactTierDeps & {
    patch: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  } {
    return {
      patch: vi.fn(async () => "PATCHED TREE"),
      refresh: vi.fn(async () => "REFRESHED TREE"),
    };
  }

  it("serves the cache with no client call when stateHash matches", async () => {
    const d = deps();
    const res = await resolveCompactTier(cached, { hash: "h1", stateHash: "s1" }, d);
    expect(res).toEqual({ text: "CACHED TREE", mode: "cache" });
    expect(d.patch).not.toHaveBeenCalled();
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it("patches from a diff when only text changed (same structural hash)", async () => {
    const d = deps();
    const res = await resolveCompactTier(cached, { hash: "h1", stateHash: "s2" }, d);
    expect(res).toEqual({ text: "PATCHED TREE", mode: "patch" });
    expect(d.patch).toHaveBeenCalledTimes(1);
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it("refreshes when the structural hash changed", async () => {
    const d = deps();
    const res = await resolveCompactTier(cached, { hash: "h2", stateHash: "s2" }, d);
    expect(res).toEqual({ text: "REFRESHED TREE", mode: "refresh" });
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(d.patch).not.toHaveBeenCalled();
  });

  it("never serves an empty cached compact (a volatile node persisted without it)", async () => {
    const d = deps();
    const emptied = node("h1", { compact: "", stateHash: "s1" });
    const res = await resolveCompactTier(emptied, { hash: "h1", stateHash: "s1" }, d);
    expect(res.mode).not.toBe("cache");
    expect(res.text).toBe("PATCHED TREE");
  });

  it("refreshes a redacted node rather than serving stale secret text", async () => {
    const d = deps();
    const redacted = node("h1", { compact: "", stateHash: "s1", redacted: true });
    const res = await resolveCompactTier(redacted, { hash: "h1", stateHash: "s1" }, d);
    expect(res.mode).toBe("refresh");
  });
});
