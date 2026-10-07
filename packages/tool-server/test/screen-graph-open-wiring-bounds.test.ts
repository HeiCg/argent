import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenDeviceServerApi } from "../src/blueprints/android-open-server";

vi.mock("../src/utils/adb", () => ({
  adbShell: vi.fn(async () => "package:com.sg.bounds versionCode:7\n"),
}));

import {
  resolveStoreForCurrentApp,
  screenGraphTemplatesEnabled,
} from "../src/utils/screen-graph-open-wiring";

/**
 * Review E-1 finding 8 (default bounds): with recording on and
 * `ARGENT_SG_TEMPLATES` unset, the wiring's store must still apply the
 * 300-node cap + LRU on flush. Before the fix the bounded store was gated on
 * the templates env, so the OFF arm grew without limit (E-1: 203 KB, +9
 * nodes / +9 edges per session).
 */
const ENV_KEYS = ["HOME", "ARGENT_SG_RECORD", "ARGENT_SG_TEMPLATES"] as const;
let saved: Record<string, string | undefined> = {};
let home: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sg-wiring-bounds-"));
  process.env.HOME = home; // argentHomeDir() -> <home>/.argent
  process.env.ARGENT_SG_RECORD = "1";
  delete process.env.ARGENT_SG_TEMPLATES;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("screen-graph wiring: bounded store by default (review E-1 finding 8)", () => {
  it("caps the store at 300 nodes without ARGENT_SG_TEMPLATES", async () => {
    expect(screenGraphTemplatesEnabled()).toBe(false);
    const server = {
      getInfo: vi.fn(async () => ({ currentPackage: "com.sg.bounds" })),
    } as unknown as OpenDeviceServerApi;

    const { store, versionCode } = await resolveStoreForCurrentApp("emulator-bounds", server);
    expect(versionCode).toBe("7");
    expect(store.filePath().startsWith(path.join(home, ".argent"))).toBe(true);

    for (let i = 0; i < 305; i++) {
      store.upsertNode({ hash: `n${i}`, compact: "x", stateHash: `s${i}`, index: {} });
    }
    await store.flush();

    expect(Object.keys(store.nodes)).toHaveLength(300);
    expect(store.pruneStats().evictedNodes).toBe(5);
  });
});
