import { describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { ScreenGraphStore } from "../src/screen-graph/store";
import {
  FLAG_PASSWORD,
  parseSelectorKey,
  selectorKeyForId,
  selectorKeyForText,
} from "../src/screen-graph/types";
import { buildScreenPayload } from "../src/utils/screen-graph-open-wiring";
import { indexEntryForBucket, resolveTapPoint } from "../src/tools/navigate-to";
import type { OpenServerElement } from "../src/tools/describe/platforms/android/open-server-tree";
import type { CanonicalAction } from "../src/screen-graph";

function makeStore(): ScreenGraphStore {
  return new ScreenGraphStore({
    packageName: "com.example",
    versionCode: "1",
    baseDir: path.join(os.tmpdir(), `sg-b1-${Math.random().toString(36).slice(2)}`),
    now: () => 1000,
  });
}

describe("Phase B1 — version stored on the node (item 1)", () => {
  it("upsertNode persists the device version and it survives a merge", () => {
    const store = makeStore();
    store.upsertNode({ hash: "h1", compact: "c", stateHash: "s1", version: 7, index: {} });
    expect(store.getNode("h1")?.version).toBe(7);

    // A later visit without a fresh render keeps the version; with one, updates it.
    store.upsertNode({ hash: "h1", compact: "c2", stateHash: "s2", version: 9, index: {} });
    expect(store.getNode("h1")?.version).toBe(9);
    store.dispose();
  });

  it("buildScreenPayload carries the version through to the fetched screen", () => {
    const els: OpenServerElement[] = [
      { index: 1, className: "android.widget.TextView", text: "Hi", bounds: { x1: 0, y1: 0, x2: 10, y2: 10 } },
    ];
    const payload = buildScreenPayload(els, 100, 200, "MainActivity", "state-hash", 42);
    expect(payload.version).toBe(42);
  });
});

describe("Phase B1 — password redaction from the device flag (item 2)", () => {
  it("an isPassword element makes the node hold a secret → redacted, no compact", () => {
    const els: OpenServerElement[] = [
      {
        index: 1,
        className: "android.widget.EditText",
        resourceId: "com.example:id/pw",
        text: "hunter2",
        bounds: { x1: 0, y1: 0, x2: 100, y2: 40 },
        isPassword: true,
      },
    ];
    const payload = buildScreenPayload(els, 100, 200, "Login", "s1");
    // The index entry carries the password bit.
    const entry = payload.index[selectorKeyForId("com.example:id/pw")];
    expect(entry).toBeDefined();
    expect((entry!.flags & FLAG_PASSWORD) !== 0).toBe(true);

    const store = makeStore();
    store.upsertNode({
      hash: "h1",
      compact: payload.compact,
      stateHash: payload.stateHash,
      index: payload.index,
    });
    const node = store.getNode("h1")!;
    expect(node.redacted).toBe(true);
    expect(node.compact).toBe("");
    expect(node.stateHash).toBeUndefined();
    store.dispose();
  });
});

describe("Phase B1 — selector key round-trip", () => {
  it("parseSelectorKey reverses selectorKeyForId / selectorKeyForText", () => {
    expect(parseSelectorKey(selectorKeyForId("com.example:id/ok"))).toEqual({ id: "com.example:id/ok" });
    expect(parseSelectorKey(selectorKeyForText("Sign in"))).toEqual({ text: "Sign in" });
    expect(parseSelectorKey("garbage")).toBeNull();
  });
});

describe("Phase B1 — navigate-to bucket guard (item 3)", () => {
  const SIZE = { width: 1600, height: 1600 }; // 1 cell = 100px on a 1/16 grid.
  // An element centred at (150,150) → grid cell (1,1).
  const index = {
    [selectorKeyForText("Buy")]: { bounds: { x1: 100, y1: 100, x2: 200, y2: 200 }, flags: 0 },
  };
  const bucketAction: CanonicalAction = { kind: "tap", bucket: { x: 1, y: 1 } };

  it("indexEntryForBucket finds the selector stored in the cell", () => {
    expect(indexEntryForBucket(index, { x: 1, y: 1 }, SIZE)).toEqual({ text: "Buy" });
    expect(indexEntryForBucket(index, { x: 5, y: 5 }, SIZE)).toBeNull();
  });

  it("taps the live position when the stored selector is still present", async () => {
    const server = {
      query: vi.fn(async () => ({
        version: 1,
        hash: "h",
        stateHash: "s",
        nodes: [{ class: "Button", bounds: { x1: 120, y1: 120, x2: 220, y2: 220 }, flags: 0, path: [0] }],
      })),
    } as never;
    const point = await resolveTapPoint(server, SIZE, bucketAction, index);
    expect(point).toEqual({ cx: 170, cy: 170 }); // centre of the live bounds
  });

  it("diverges when the stored selector is no longer on screen", async () => {
    const server = {
      query: vi.fn(async () => ({ version: 1, hash: "h", stateHash: "s", nodes: [] })),
    } as never;
    const point = await resolveTapPoint(server, SIZE, bucketAction, index);
    expect(point).toEqual({ diverge: true });
  });

  it("diverges when nothing was indexed in the bucket cell", async () => {
    const server = { query: vi.fn() } as never;
    const point = await resolveTapPoint(server, SIZE, { kind: "tap", bucket: { x: 9, y: 9 } }, index);
    expect(point).toEqual({ diverge: true });
    expect((server as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });

  it("falls back to the bucket centre when the from-node has no stored index", async () => {
    const server = { query: vi.fn() } as never;
    const point = await resolveTapPoint(server, SIZE, bucketAction, undefined);
    // Cell (1,1) centre on a 1600px/16 grid = (150,150).
    expect(point).toEqual({ cx: 150, cy: 150 });
  });
});
