import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The wiring tests below run the open-path tap, the describe tiers and navigate-to
// with every flag on; the pure recorder tests do not read flags.
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: () => true };
});
vi.mock("../src/utils/adb", () => ({
  adbShell: vi.fn(async () => "package:com.android.settings versionCode:35\n"),
}));

import type { Registry } from "@argent/registry";
import { ScreenGraphStore } from "../src/screen-graph/store";
import { recordObservation } from "../src/screen-graph/recorder";
import { plan, resolveScreenTarget } from "../src/screen-graph/plan";
import { selectorKeyForText, type CanonicalAction } from "../src/screen-graph/types";
import { EMPTY_TREE_HASH } from "../src/utils/screen-hash";
import type { OpenDeviceServerApi } from "../src/blueprints/android-open-server";
import { openServerTapWithOutcome } from "../src/utils/open-server-input";
import { resolveStoreForCurrentApp } from "../src/utils/screen-graph-open-wiring";
import { createNavigateToTool } from "../src/tools/navigate-to";
import { describeAndroidTiered } from "../src/tools/describe/platforms/android/tiered";
import { resolveDevice } from "../src/utils/device-info";

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-rec-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ACTION: CanonicalAction = { kind: "tap", target: { text: "Wi-Fi" } };
const store = () => new ScreenGraphStore({ packageName: "p", versionCode: "1", baseDir: tmpDir });

describe("recordObservation", () => {
  it("records the edge and inserts an unknown target from fetchScreen", async () => {
    const s = store();
    const fetchScreen = vi.fn(async () => ({
      compact: "wifi screen",
      stateHash: "st",
      index: {},
      label: "Wi-Fi",
    }));
    await recordObservation({
      store: s,
      action: ACTION,
      before: { hash: "root" },
      after: { hash: "wifi", stateHash: "st" },
      fetchScreen,
    });
    expect(fetchScreen).toHaveBeenCalledTimes(1);
    expect(s.hasNode("wifi")).toBe(true);
    expect(s.getNode("wifi")?.label).toBe("Wi-Fi");
    expect(s.edges).toHaveLength(1);
    expect(s.edges[0]).toMatchObject({ from: "root", to: "wifi" });
  });

  it("does not fetch when the target is already known — just bumps the visit", async () => {
    const s = store();
    s.upsertNode({ hash: "wifi", compact: "wifi screen", stateHash: "st" });
    const before = s.getNode("wifi")!.visits;
    const fetchScreen = vi.fn(async () => ({ compact: "x", stateHash: "y", index: {} }));
    await recordObservation({
      store: s,
      action: ACTION,
      before: { hash: "root" },
      after: { hash: "wifi", stateHash: "st" },
      fetchScreen,
    });
    expect(fetchScreen).not.toHaveBeenCalled();
    expect(s.getNode("wifi")!.visits).toBe(before + 1);
  });

  it("marks the target redacted when a secret preceded the observation", async () => {
    const s = store();
    const fetchScreen = vi.fn(async () => ({
      compact: "should-not-persist",
      stateHash: "st",
      index: {},
    }));
    await recordObservation({
      store: s,
      action: { kind: "typeText" },
      before: { hash: "login" },
      after: { hash: "loggedin", stateHash: "st" },
      secret: true,
      fetchScreen,
    });
    // Secret path never fetches (it must not cache the rendered screen).
    expect(fetchScreen).not.toHaveBeenCalled();
    expect(s.getNode("loggedin")?.redacted).toBe(true);
    expect(s.getNode("loggedin")?.compact).toBe("");
  });
});

// Phase 3m.1 (3M-H1): the store must REFUSE to mint a node — or an edge into one —
// from an empty tree. This mirrors the device-side rule (an empty forest yields no
// fingerprint) on the host, exercised with the exact shape from the failed store of
// run 34827025184: `.bench-results/screen-graph/graph-store/com.android.settings/34.json`
// held a node `b2fbe9151b60b485` with `structuralHash == stateHash == EMPTY_TREE_HASH`
// as the SECOND destination of the multi-destination edge
// `"284ef0302b28c5de taptext=Internet"` — a transient empty frame minted as a screen
// because its `H_id` looked real (the device folds the package name into `H_id`).
describe("recordObservation — empty-tree guard (3M-H1)", () => {
  const INTERNET_TAP: CanonicalAction = { kind: "tap", target: { text: "Internet" } };

  it("refuses to mint a node whose structuralHash is EMPTY_TREE_HASH (run 34827025184 shape)", async () => {
    const s = store();
    const fetchScreen = vi.fn(async () => ({
      compact: "",
      stateHash: EMPTY_TREE_HASH,
      structuralHash: EMPTY_TREE_HASH,
      index: {},
    }));
    await recordObservation({
      store: s,
      action: INTERNET_TAP,
      // `284ef0302b28c5de` is the real origin; `b2fbe9151b60b485` the empty-frame id.
      before: { hash: "284ef0302b28c5de" },
      after: {
        hash: "b2fbe9151b60b485",
        stateHash: EMPTY_TREE_HASH,
        structuralHash: EMPTY_TREE_HASH,
      },
      fetchScreen,
    });
    // No node minted, no edge recorded, no fetch — the empty frame is not a screen.
    expect(fetchScreen).not.toHaveBeenCalled();
    expect(s.hasNode("b2fbe9151b60b485")).toBe(false);
    expect(s.edges).toHaveLength(0);
    // And no store-invariant violation could arise from it.
    expect(s.duplicateEdgeTargets()).toHaveLength(0);
    expect(s.duplicateScreens()).toHaveLength(0);
  });

  it("refuses when only the stateHash is EMPTY_TREE_HASH", async () => {
    const s = store();
    await recordObservation({
      store: s,
      action: INTERNET_TAP,
      before: { hash: "284ef0302b28c5de" },
      after: { hash: "b2fbe9151b60b485", stateHash: EMPTY_TREE_HASH },
    });
    expect(s.hasNode("b2fbe9151b60b485")).toBe(false);
    expect(s.edges).toHaveLength(0);
  });

  it("keeps the FIRST (real) destination as the sole edge target — no second empty destination", async () => {
    const s = store();
    // The real transition records normally...
    await recordObservation({
      store: s,
      action: INTERNET_TAP,
      before: { hash: "284ef0302b28c5de" },
      after: { hash: "af75c426f98239d2", stateHash: "realstate", structuralHash: "realstruct" },
      fetchScreen: async () => ({
        compact: "Internet screen",
        stateHash: "realstate",
        structuralHash: "realstruct",
        index: {},
      }),
    });
    // ...and the empty-frame re-observation of the SAME (from, action) is refused,
    // so the edge keeps exactly one destination (the D.3 invariant stays green).
    await recordObservation({
      store: s,
      action: INTERNET_TAP,
      before: { hash: "284ef0302b28c5de" },
      after: {
        hash: "b2fbe9151b60b485",
        stateHash: EMPTY_TREE_HASH,
        structuralHash: EMPTY_TREE_HASH,
      },
      fetchScreen: async () => ({
        compact: "",
        stateHash: EMPTY_TREE_HASH,
        structuralHash: EMPTY_TREE_HASH,
        index: {},
      }),
    });
    expect(s.hasNode("af75c426f98239d2")).toBe(true);
    expect(s.hasNode("b2fbe9151b60b485")).toBe(false);
    expect(s.duplicateEdgeTargets()).toHaveLength(0);
    const outgoing = s.outgoingEdges("284ef0302b28c5de");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.to).toBe("af75c426f98239d2");
  });
});

// Step sg-launch-node (review of the final runs, MULTIHOP point 1): the recorder
// minted only the DESTINATION node, and only `describe` minted the current one.
// An agent that opens the app and taps without a `describe` first left an edge
// whose origin was no node, and the store's referential-integrity sweep dropped
// it on the next flush — the first hop was lost and navigate-to from the launch
// screen answered "no known path" (the 3 graph-arm failures at rep 0).
describe("recordObservation — the launch screen as the source of the first action", () => {
  const TAP_NET: CanonicalAction = { kind: "tap", target: { text: "Network & internet" } };
  const bounded = () =>
    new ScreenGraphStore({
      packageName: "p",
      versionCode: "1",
      baseDir: tmpDir,
      enforceBounds: true,
    });
  const launchScreen = {
    compact: "Settings\n  Network & internet",
    index: {
      [selectorKeyForText("Network & internet")]: {
        bounds: { x1: 0, y1: 300, x2: 1080, y2: 400 },
        flags: 0,
      },
    },
    resourceIds: ["com.android.settings:id/toolbar_title"],
    label: "Settings",
    structuralHash: "h_launch",
  };
  const netScreen = async () => ({
    compact: "Network & internet",
    stateHash: "st_net",
    index: {},
    label: "SubSettings: Network & internet",
  });

  it("mints the unknown source from the before screen, so the edge survives the flush", async () => {
    const s = bounded();
    const fetchBeforeScreen = vi.fn(async () => launchScreen);
    await recordObservation({
      store: s,
      action: TAP_NET,
      before: { hash: "launch" },
      after: { hash: "net", stateHash: "st_net" },
      fetchScreen: netScreen,
      fetchBeforeScreen,
    });
    expect(fetchBeforeScreen).toHaveBeenCalledTimes(1);
    await s.flush();
    expect(s.danglingEdges()).toEqual([]);
    expect(s.hasNode("launch")).toBe(true);
    expect(s.getNode("launch")).toMatchObject({
      label: "Settings",
      compact: launchScreen.compact,
      resourceIds: launchScreen.resourceIds,
      structuralHash: "h_launch",
    });
    expect(s.outgoingEdges("launch").map((e) => e.to)).toEqual(["net"]);

    // Persisted: a fresh load plans from the launch screen to the destination.
    const reloaded = await ScreenGraphStore.load({
      packageName: "p",
      versionCode: "1",
      baseDir: tmpDir,
    });
    const graph = { edges: reloaded.edges, nodes: reloaded.nodes };
    const target = resolveScreenTarget(graph, { label: "SubSettings: Network & internet" });
    expect(target).toEqual({ kind: "node", hash: "net" });
    const route = plan(graph, "launch", "net");
    expect(route?.steps.map((st) => st.to)).toEqual(["net"]);
  });

  it("mints a bare source from its identity when there is no before screen", async () => {
    const s = bounded();
    await recordObservation({
      store: s,
      action: { kind: "back" },
      before: { hash: "launch" },
      after: { hash: "net", stateHash: "st_net" },
      fetchScreen: netScreen,
    });
    await s.flush();
    expect(s.hasNode("launch")).toBe(true);
    expect(s.outgoingEdges("launch")).toHaveLength(1);
    expect(s.danglingEdges()).toEqual([]);
  });

  it("falls back to a bare source when the before screen cannot be built", async () => {
    const s = bounded();
    await recordObservation({
      store: s,
      action: TAP_NET,
      before: { hash: "launch" },
      after: { hash: "net", stateHash: "st_net" },
      fetchScreen: netScreen,
      fetchBeforeScreen: async () => {
        throw new Error("no tree");
      },
    });
    await s.flush();
    expect(s.hasNode("launch")).toBe(true);
    expect(s.outgoingEdges("launch").map((e) => e.to)).toEqual(["net"]);
  });

  it("does not duplicate or touch a source that is already a node", async () => {
    const s = bounded();
    s.upsertNode({
      hash: "launch",
      compact: "described",
      stateHash: "st_launch",
      index: {},
      label: "Settings: Settings",
    });
    const fetchBeforeScreen = vi.fn(async () => launchScreen);
    await recordObservation({
      store: s,
      action: TAP_NET,
      before: { hash: "launch" },
      after: { hash: "net", stateHash: "st_net" },
      fetchScreen: netScreen,
      fetchBeforeScreen,
    });
    expect(fetchBeforeScreen).not.toHaveBeenCalled();
    expect(Object.keys(s.nodes).sort()).toEqual(["launch", "net"]);
    expect(s.getNode("launch")).toMatchObject({
      visits: 1,
      compact: "described",
      stateHash: "st_launch",
      label: "Settings: Settings",
    });
  });

  it("never reads the before screen on a secret observation (bare source only)", async () => {
    const s = bounded();
    const fetchBeforeScreen = vi.fn(async () => launchScreen);
    await recordObservation({
      store: s,
      action: { kind: "typeText" },
      before: { hash: "login" },
      after: { hash: "loggedin", stateHash: "st" },
      secret: true,
      fetchBeforeScreen,
    });
    expect(fetchBeforeScreen).not.toHaveBeenCalled();
    await s.flush();
    expect(s.hasNode("login")).toBe(true);
    expect(s.getNode("login")?.compact).toBe("");
    expect(s.outgoingEdges("login").map((e) => e.to)).toEqual(["loggedin"]);
  });

  it("records a first self-edge on an unknown screen with one node, one visit", async () => {
    const s = bounded();
    const fetchBeforeScreen = vi.fn(async () => launchScreen);
    await recordObservation({
      store: s,
      action: { kind: "tap", target: { text: "Toggle" } },
      before: { hash: "launch" },
      after: { hash: "launch", stateHash: "st_launch" },
      fetchScreen: async () => ({ compact: "settled launch", stateHash: "st_launch", index: {} }),
      fetchBeforeScreen,
    });
    await s.flush();
    expect(Object.keys(s.nodes)).toEqual(["launch"]);
    expect(s.getNode("launch")).toMatchObject({ visits: 1, compact: "settled launch" });
    expect(s.danglingEdges()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Live open path: launch, tap with outcome, flush, no describe               */
/* -------------------------------------------------------------------------- */

const PKG = "com.android.settings";
const LAUNCH = "aaaaaaaa00000001";
const NET = "bbbbbbbb00000002";
const W = 1080;
const H = 1920;

type El = {
  index: number;
  className: string;
  resourceId?: string;
  text?: string;
  clickable?: boolean;
  enabled?: boolean;
  bounds: { x1: number; y1: number; x2: number; y2: number };
};

const TREES: Record<string, El[]> = {
  [LAUNCH]: [
    {
      index: 0,
      className: "android.widget.TextView",
      resourceId: `${PKG}:id/toolbar_title`,
      text: "Settings",
      bounds: { x1: 0, y1: 40, x2: W, y2: 160 },
    },
    {
      index: 1,
      className: "android.widget.TextView",
      resourceId: "android:id/row_net",
      text: "Network & internet",
      clickable: true,
      enabled: true,
      bounds: { x1: 0, y1: 300, x2: W, y2: 400 },
    },
  ],
  [NET]: [
    {
      index: 0,
      className: "android.widget.TextView",
      resourceId: `${PKG}:id/toolbar_title`,
      text: "Network & internet",
      bounds: { x1: 0, y1: 40, x2: W, y2: 160 },
    },
  ],
};

/** A Settings device that starts on the launch screen; the row lands on NET. */
function fakeDevice(start: string = LAUNCH) {
  let screen = start;
  const fp = (s: string) => ({ version: 1, hash: `h_${s}`, stateHash: `st_${s}`, idHash: s });
  const state = () => ({
    tree: TREES[screen]!,
    info: { screenWidth: W, screenHeight: H, currentPackage: PKG },
    screenshot: "",
    waitedMs: 0,
    captureMs: 0,
    ...fp(screen),
  });
  return {
    getScreenSize: vi.fn(async () => ({ screenWidth: W, screenHeight: H, displayRotation: 0 })),
    getState: vi.fn(async () => state()),
    getInfo: vi.fn(async () => ({
      currentPackage: PKG,
      currentActivity: screen === LAUNCH ? `${PKG}.Settings` : `${PKG}.SubSettings`,
    })),
    query: vi.fn(async (sel: { text?: { contains: string } }) => ({
      nodes: TREES[screen]!.filter(
        (el) => el.text?.toLowerCase() === sel.text?.contains.toLowerCase()
      ),
    })),
    tapWithOutcome: vi.fn(async (_x: number, y: number) => {
      const before = fp(screen);
      if (screen === LAUNCH && y >= 300 && y <= 400) screen = NET;
      return {
        before,
        after: fp(screen),
        changed: before.idHash !== screen,
        newScreen: before.idHash !== screen,
        settled: "quiet",
        firstEventMs: 1,
        idleMs: 1,
      };
    }),
  };
}

const ENV_KEYS = ["HOME", "ARGENT_SG_RECORD", "ARGENT_SG_TEMPLATES"] as const;
let savedEnv: Record<string, string | undefined> = {};
let home: string;
let serialSeq = 0;
let serial: string;

describe("open path: the first tap from the launch screen, no describe", () => {
  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "sg-launch-"));
    process.env.HOME = home; // argentHomeDir() -> <home>/.argent
    delete process.env.ARGENT_SG_TEMPLATES;
    // A fresh serial per test: the wiring caches the store per serial|pkg|version.
    serial = `emulator-${5600 + serialSeq++ * 2}`;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const reg = (dev: ReturnType<typeof fakeDevice>) =>
    ({ resolveService: async () => dev }) as unknown as Registry;
  const storeOf = async (dev: ReturnType<typeof fakeDevice>) =>
    (await resolveStoreForCurrentApp(serial, dev as unknown as OpenDeviceServerApi)).store;

  it("keeps the first edge and its launch node through the flush; navigate-to plans from launch", async () => {
    const dev = fakeDevice();
    await openServerTapWithOutcome(reg(dev), resolveDevice(serial), 0.5, 350 / H, 1);

    const store = await storeOf(dev);
    await store.flush();
    expect(store.danglingEdges()).toEqual([]);
    expect(store.hasNode(LAUNCH)).toBe(true);
    // Built like describe builds a node (compact / index / label) from the before tree.
    const launch = store.getNode(LAUNCH)!;
    expect(launch.label).toBe("Settings");
    expect(launch.compact).toContain("Network & internet");
    expect(Object.keys(launch.index)).toContain(selectorKeyForText("Network & internet"));
    expect(store.outgoingEdges(LAUNCH).map((e) => e.to)).toEqual([NET]);

    const reloaded = await ScreenGraphStore.load({
      packageName: PKG,
      versionCode: "35",
      baseDir: path.join(home, ".argent", "screen-graph"),
    });
    expect(reloaded.hasNode(LAUNCH)).toBe(true);
    expect(reloaded.outgoingEdges(LAUNCH).map((e) => e.to)).toEqual([NET]);

    // The agent is back on the launch screen and asks for the destination.
    const again = fakeDevice(LAUNCH);
    const tool = createNavigateToTool(reg(again));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await tool.execute({}, {
      udid: serial,
      target: { label: "SubSettings: Network & internet" },
    } as any)) as any;
    expect(res.error).toBeUndefined();
    expect(res.reached).toBe(true);
    expect(res.hops).toBe(1);
    expect(res.path.map((p: { hash8: string }) => p.hash8)).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  });

  it("does not duplicate a launch node describe already minted", async () => {
    const dev = fakeDevice();
    const described = await describeAndroidTiered(reg(dev), resolveDevice(serial), "summary");
    expect(described.source).toBe("open-device-server");
    const store = await storeOf(dev);
    const seeded = { ...store.getNode(LAUNCH)! };

    await openServerTapWithOutcome(reg(dev), resolveDevice(serial), 0.5, 350 / H, 1);
    await store.flush();
    expect(Object.keys(store.nodes).sort()).toEqual([LAUNCH, NET].sort());
    expect(store.getNode(LAUNCH)).toMatchObject({
      visits: seeded.visits,
      label: seeded.label,
      compact: seeded.compact,
      stateHash: seeded.stateHash,
    });
  });

  it("renders a bare source fresh on the summary tier instead of serving an empty node", async () => {
    const dev = fakeDevice();
    const store = await storeOf(dev);
    // What the recorder mints for an action with no before tree (key, swipe).
    store.upsertNode({ hash: LAUNCH });
    store.observe(LAUNCH, { kind: "tap", target: { text: "Network & internet" } }, NET);
    store.upsertNode({ hash: NET, compact: "net", stateHash: `st_${NET}`, index: {} });

    const res = await describeAndroidTiered(reg(dev), resolveDevice(serial), "summary");
    expect(res.description).toMatch(/^screen: Settings: Settings/);
    expect(store.getNode(LAUNCH)?.compact).toContain("Network & internet");
  });
});
