import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ScreenGraphStore } from "../src/screen-graph/store";
import { FLAG_PASSWORD, selectorKeyForId } from "../src/screen-graph/types";
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
    store.upsertNode({ hash: "aaaa", compact: "root screen", stateHash: "s1", index: {}, label: "Settings" });
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
    expect(store.filePath()).toBe(
      path.join(tmpDir, "com.example.app", "1200.json")
    );
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
    store.upsertNode({ hash: "sek", compact: "user@example.com hunter2", stateHash: "s", secret: true });
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
      index: { [selectorKeyForId("password")]: { bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, flags: FLAG_PASSWORD } },
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
