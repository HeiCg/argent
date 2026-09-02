import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ScreenGraphStore } from "../src/screen-graph/store";
import { recordObservation } from "../src/screen-graph/recorder";
import type { CanonicalAction } from "../src/screen-graph/types";

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
    const fetchScreen = vi.fn(async () => ({ compact: "should-not-persist", stateHash: "st", index: {} }));
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
