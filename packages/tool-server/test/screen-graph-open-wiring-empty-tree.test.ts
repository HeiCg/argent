import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordOpenServerObservation,
  getSkippedNoIdHash,
  resetSkippedNoIdHash,
} from "../src/utils/screen-graph-open-wiring";
import { EMPTY_TREE_HASH } from "../src/utils/screen-hash";
import type {
  OpenDeviceServerApi,
  OpenServerActionOutcome,
} from "../src/blueprints/android-open-server";
import type { ActionInvocation } from "../src/screen-graph";
import type { DeviceInfo } from "@argent/registry";

/**
 * Phase 3m.1 (3M-H1): the open→graph wiring must treat an EMPTY-TREE fingerprint
 * like a missing id — count it in `skippedNoIdHash` and never key a node/edge off
 * it — even though its `H_id` is truthy (the device folds the package name into
 * `H_id`, so an empty forest still produces a real-looking `idHash`). This is the
 * exact failure of run 34827025184, which minted node `b2fbe9151b60b485`
 * (structural == state == EMPTY_TREE_HASH) and reported `skippedNoIdHash 1` where
 * every prior run reported 0.
 */
const DEVICE = { id: "emulator-5554" } as DeviceInfo;
const SIZE = { width: 1080, height: 1920 };
const INVOCATION: ActionInvocation = { kind: "tap", target: { text: "Internet" } };

// The empty-frame fingerprint the device emitted pre-versionCode-26: a package-only
// H_id, structural/state both the bare FNV offset.
const EMPTY_STATE = {
  tree: [] as never[],
  info: { screenWidth: 1080, screenHeight: 1920, currentPackage: "com.android.settings" },
  screenshot: "",
  waitedMs: 0,
  captureMs: 0,
  idHash: "b2fbe9151b60b485",
  hash: EMPTY_TREE_HASH,
  stateHash: EMPTY_TREE_HASH,
  version: 7,
};

let prevRecord: string | undefined;
beforeEach(() => {
  prevRecord = process.env.ARGENT_SG_RECORD;
  process.env.ARGENT_SG_RECORD = "1"; // record-only mode, no real flag needed
  resetSkippedNoIdHash();
});
afterEach(() => {
  if (prevRecord === undefined) delete process.env.ARGENT_SG_RECORD;
  else process.env.ARGENT_SG_RECORD = prevRecord;
  resetSkippedNoIdHash();
  vi.restoreAllMocks();
});

function outcome(before: OpenServerActionOutcome["before"]): OpenServerActionOutcome {
  return {
    before,
    after: before,
    changed: false,
    newScreen: false,
    settled: "quiet",
    firstEventMs: 1,
    idleMs: 1,
  };
}

describe("recordOpenServerObservation — empty-tree guard (3M-H1)", () => {
  it("skips + counts when the SETTLED after-read is an empty-tree fingerprint", async () => {
    const getState = vi.fn(async () => EMPTY_STATE);
    const getInfo = vi.fn(async () => {
      throw new Error("getInfo must not be reached for an empty-tree after-read");
    });
    const server = { getState, getInfo } as unknown as OpenDeviceServerApi;

    await recordOpenServerObservation(
      DEVICE,
      server,
      SIZE,
      INVOCATION,
      // A real before, so the flow proceeds to the settled read and its empty guard.
      outcome({ version: 6, hash: "abc", stateHash: "abc", idHash: "284ef0302b28c5de" })
    );

    expect(getState).toHaveBeenCalledTimes(1);
    expect(getInfo).not.toHaveBeenCalled(); // returned before any store resolution
    expect(getSkippedNoIdHash()).toBe(1);
  });

  it("skips + counts when the BEFORE outcome is an empty-tree fingerprint, before any read", async () => {
    const getState = vi.fn(async () => EMPTY_STATE);
    const server = { getState } as unknown as OpenDeviceServerApi;

    await recordOpenServerObservation(
      DEVICE,
      server,
      SIZE,
      INVOCATION,
      // before has a truthy (package-only) idHash but an EMPTY_TREE_HASH stateHash.
      outcome({
        version: 6,
        hash: EMPTY_TREE_HASH,
        stateHash: EMPTY_TREE_HASH,
        idHash: "b2fbe9151b60b485",
      })
    );

    expect(getState).not.toHaveBeenCalled(); // caught before the settled read
    expect(getSkippedNoIdHash()).toBe(1);
  });
});
