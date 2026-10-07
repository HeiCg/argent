import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ScreenGraphStore } from "../src/screen-graph/store";
import { fnv1aHex } from "../src/screen-graph/template";
import { FLAG_PASSWORD, actionSignature, selectorKeyForId } from "../src/screen-graph/types";
import type { CanonicalAction } from "../src/screen-graph/types";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-store-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const TAP: CanonicalAction = { kind: "tap", target: { text: "Network & internet" } };

function newStore(pkg = "com.android.settings", vc = "35"): ScreenGraphStore {
  return new ScreenGraphStore({ packageName: pkg, versionCode: vc, baseDir: tmpDir });
}

describe("ScreenGraphStore observe / persist / load round-trip", () => {
  it("persists nodes and edges and reloads them", async () => {
    const store = newStore();
    store.upsertNode({
      hash: "aaaa",
      compact: "root screen",
      stateHash: "s1",
      index: {},
      label: "Settings",
    });
    store.upsertNode({ hash: "bbbb", compact: "network screen", stateHash: "s2", index: {} });
    store.observe("aaaa", TAP, "bbbb");
    await store.flush();

    expect(fs.existsSync(store.filePath())).toBe(true);

    const loaded = await ScreenGraphStore.load({
      packageName: "com.android.settings",
      versionCode: "35",
      baseDir: tmpDir,
    });
    expect(loaded.hasNode("aaaa")).toBe(true);
    expect(loaded.getNode("aaaa")?.label).toBe("Settings");
    expect(loaded.getNode("bbbb")?.compact).toBe("network screen");
    const edges = loaded.edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: "aaaa", to: "bbbb", count: 1, successes: 1 });
  });

  it("keys the file path by package and versionCode", () => {
    const store = newStore("com.example.app", "1200");
    expect(store.filePath()).toBe(path.join(tmpDir, "com.example.app", "1200.json"));
  });

  it("aggregates repeated observations into one edge with counts", async () => {
    const store = newStore();
    store.observe("aaaa", TAP, "bbbb");
    store.observe("aaaa", TAP, "bbbb");
    store.observe("aaaa", TAP, "bbbb", { success: false });
    const edges = store.edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ count: 3, successes: 2 });
  });

  it("bumps visits and lastSeen on re-upsert of a known node", () => {
    let t = 1_000;
    const store = new ScreenGraphStore({
      packageName: "p",
      versionCode: "1",
      baseDir: tmpDir,
      now: () => t,
    });
    store.upsertNode({ hash: "n1", compact: "c" });
    expect(store.getNode("n1")?.visits).toBe(1);
    t = 2_000;
    store.upsertNode({ hash: "n1" });
    expect(store.getNode("n1")?.visits).toBe(2);
    expect(store.getNode("n1")?.firstSeen).toBe(1_000);
    expect(store.getNode("n1")?.lastSeen).toBe(2_000);
  });
});

describe("ScreenGraphStore secret redaction", () => {
  it("never persists compact text for a node flagged secret", async () => {
    const store = newStore();
    store.upsertNode({
      hash: "sek",
      compact: "user@example.com hunter2",
      stateHash: "s",
      secret: true,
    });
    expect(store.getNode("sek")?.redacted).toBe(true);
    expect(store.getNode("sek")?.compact).toBe("");
    await store.flush();

    const raw = await fsp.readFile(store.filePath(), "utf8");
    expect(raw).not.toContain("hunter2");

    const loaded = await ScreenGraphStore.load({
      packageName: "com.android.settings",
      versionCode: "35",
      baseDir: tmpDir,
    });
    expect(loaded.getNode("sek")?.redacted).toBe(true);
    expect(loaded.getNode("sek")?.compact).toBe("");
  });

  it("redacts a node whose index holds a FLAG_PASSWORD entry", async () => {
    const store = newStore();
    store.upsertNode({
      hash: "pwd",
      compact: "secret-field-text",
      index: {
        [selectorKeyForId("password")]: {
          bounds: { x1: 0, y1: 0, x2: 1, y2: 1 },
          flags: FLAG_PASSWORD,
        },
      },
    });
    await store.flush();
    const raw = await fsp.readFile(store.filePath(), "utf8");
    expect(raw).not.toContain("secret-field-text");
    expect(store.getNode("pwd")?.redacted).toBe(true);
  });
});

describe("ScreenGraphStore debounced writes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces rapid writes into a single flush after the debounce window", () => {
    const store = new ScreenGraphStore({
      packageName: "p",
      versionCode: "1",
      baseDir: tmpDir,
      debounceMs: 500,
    });
    const flushSpy = vi.spyOn(store, "flush").mockResolvedValue();

    store.observe("a", TAP, "b");
    store.observe("a", TAP, "c");
    store.upsertNode({ hash: "b" });
    expect(flushSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(499);
    expect(flushSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it("load returns an empty store when no document exists", async () => {
    vi.useRealTimers();
    const loaded = await ScreenGraphStore.load({
      packageName: "nope",
      versionCode: "0",
      baseDir: tmpDir,
    });
    expect(loaded.edges).toHaveLength(0);
    expect(Object.keys(loaded.nodes)).toHaveLength(0);
  });
});

describe("ScreenGraphStore text-safe separators (review E-1 finding 8a)", () => {
  it("store.ts holds no NUL byte, so git diffs it as text", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/screen-graph/store.ts"));
    expect(src.includes(0)).toBe(false);
  });

  it("keys edges and duplicate screens with the unit separator U+001F", () => {
    const store = newStore();
    store.observe("aaaa", TAP, "bbbb");
    store.observe("aaaa", TAP, "cccc");
    const dups = store.duplicateEdgeTargets();
    expect(dups).toHaveLength(1);
    expect(dups[0]!.key).toBe(`aaaa\u001f${actionSignature(TAP)}`);
    expect(dups[0]!.key).not.toContain("\u0000");
    store.dispose();
  });
});

describe("ScreenGraphStore hashed item texts (review E-1 finding 8b, R5)", () => {
  it("persists fnv1a(normalized item text), never the item text itself", async () => {
    const store = newStore();
    const tpl: CanonicalAction = {
      kind: "tap",
      template: { containerKey: "CK", itemTemplate: "IT" },
    };
    store.observe("FEED", tpl, "TPL", {
      template: {
        containerKey: "CK",
        itemTemplate: "IT",
        concreteTo: "d1",
        itemText: "  Private Story 7 ",
      },
    });
    const e = store.edges[0]!;
    expect(e.template?.lastItemHashes).toEqual([fnv1aHex("private story 7")]);
    expect(e.template).not.toHaveProperty("lastItemTexts");
    await store.flush();
    const raw = await fsp.readFile(store.filePath(), "utf8");
    expect(raw).not.toContain("Private Story 7");
    expect(raw.toLowerCase()).not.toContain("private story");
  });
});

describe("ScreenGraphStore clear (MULTIHOP: start the warm-up from an empty graph)", () => {
  it("forgets this package's nodes and edges and persists the empty graph, other packages untouched", async () => {
    const other = newStore("com.example.other", "1");
    other.upsertNode({ hash: "cccc", compact: "other", stateHash: "s", index: {} });
    await other.flush();
    const store = newStore();
    store.upsertNode({ hash: "aaaa", compact: "root", stateHash: "s1", index: {} });
    store.upsertNode({ hash: "bbbb", compact: "net", stateHash: "s2", index: {} });
    store.observe("aaaa", TAP, "bbbb");
    await store.flush();

    store.clear();
    expect(store.nodes).toEqual({});
    expect(store.edges).toEqual([]);
    await store.flush();

    const reloaded = await ScreenGraphStore.load({
      packageName: "com.android.settings",
      versionCode: "35",
      baseDir: tmpDir,
    });
    expect(Object.keys(reloaded.nodes)).toEqual([]);
    expect(reloaded.edges).toEqual([]);
    const otherReloaded = await ScreenGraphStore.load({
      packageName: "com.example.other",
      versionCode: "1",
      baseDir: tmpDir,
    });
    expect(otherReloaded.hasNode("cccc")).toBe(true);
  });
});
