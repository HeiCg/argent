import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isFlagEnabled, getFlagsPath, setFlag, unsetFlag } from "../src/flags.js";

// Phase 3i: `isFlagEnabled` runs on every Android describe. These tests pin the
// process-local read cache: repeat reads between writes must NOT re-hit disk, and
// any local `setFlag`/`unsetFlag` must invalidate so the next read sees the write.
// Cross-process writes are deliberately not observed (documented below).

let tmpHome: string;
let tmpProject: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-flagscache-home-")));
  tmpProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-flagscache-proj-")));
  fs.writeFileSync(path.join(tmpProject, "package.json"), "{}");
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalCwd = process.cwd();
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.chdir(tmpProject);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpProject, { recursive: true, force: true });
});

describe("isFlagEnabled process cache (phase 3i)", () => {
  it("serves repeat reads from cache without re-reading disk", () => {
    // Seed a project flag (this write invalidates any prior cache state).
    setFlag("open-device-server", true, "project");
    // Cold read populates the cache from disk.
    expect(isFlagEnabled("open-device-server")).toBe(true);

    // Delete the file out-of-band. A cache that re-read disk on every call would
    // now return the default (false); a working cache keeps returning the warmed
    // value until a local write invalidates it.
    fs.rmSync(getFlagsPath("project"), { force: true });
    for (let i = 0; i < 20; i++) {
      expect(isFlagEnabled("open-device-server")).toBe(true);
    }
  });

  it("a local setFlag invalidates the cache so the next read sees the new value", () => {
    setFlag("alpha", true, "global");
    expect(isFlagEnabled("alpha")).toBe(true); // caches global {alpha:true}
    setFlag("alpha", false, "global"); // same-process write -> invalidate
    expect(isFlagEnabled("alpha")).toBe(false);
  });

  it("a local unsetFlag invalidates the cache", () => {
    setFlag("beta", true, "project");
    expect(isFlagEnabled("beta")).toBe(true);
    unsetFlag("beta", "project"); // invalidate
    expect(isFlagEnabled("beta")).toBe(false);
  });

  it("a fresh flag file created after a cached miss is picked up once a local write invalidates", () => {
    // Cold miss: no file yet -> false, and the empty result is cached.
    expect(isFlagEnabled("gamma", { default: false })).toBe(false);
    // An out-of-band (cross-process) write is deliberately NOT observed while the
    // cache is warm — this documents the phase 3i design decision.
    const globalPath = getFlagsPath("global");
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, JSON.stringify({ flags: { gamma: true } }));
    expect(isFlagEnabled("gamma")).toBe(false); // still cached-empty
    // A local write invalidates; the read-modify-write also folds in the disk state.
    setFlag("delta", true, "global");
    expect(isFlagEnabled("gamma")).toBe(true);
    expect(isFlagEnabled("delta")).toBe(true);
  });
});
