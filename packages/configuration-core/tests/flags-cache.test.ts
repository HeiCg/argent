import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isFlagEnabled, getFlagsPath, setFlag, unsetFlag } from "../src/flags.js";

// Phase 3i: `isFlagEnabled` runs on every Android describe. The cache validates a
// parsed flag map against the file's mtime + size (one statSync, no readFileSync /
// no project-root walk when unchanged) — so it elides the re-parse of an unchanged
// file yet STILL observes a cross-process write (`argent flags set …` runs in the
// separate CLI process, so the tool-server must see it without a restart).

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
  it("does not re-parse an UNCHANGED file (mtime + size match served from cache)", () => {
    setFlag("open-device-server", true, "project");
    // Pin the mtime to a round-ms value so it round-trips exactly through utimes
    // (a Date captured from statSync loses sub-ms precision).
    const p = getFlagsPath("project");
    const pinned = new Date(1_600_000_000_000);
    fs.utimesSync(p, pinned, pinned);
    const size = fs.statSync(p).size;
    expect(isFlagEnabled("open-device-server")).toBe(true); // warms cache at (pinned, size)

    // Overwrite with same-length GARBAGE and restore the SAME pinned mtime + size.
    // A cache that validates on (mtime, size) returns the warmed value; one that
    // re-read disk would parse the garbage and return false.
    fs.writeFileSync(p, "g".repeat(size));
    fs.utimesSync(p, pinned, pinned);
    expect(fs.statSync(p).size).toBe(size);
    expect(fs.statSync(p).mtimeMs).toBe(pinned.getTime());
    expect(isFlagEnabled("open-device-server")).toBe(true); // served from cache, not re-parsed
  });

  it("OBSERVES a cross-process write without a restart (the CLI toggles the flag)", () => {
    // Cold: no file -> false, and the empty result is cached against a MISSING stat.
    expect(isFlagEnabled("gamma")).toBe(false);
    // Another process (`argent flags set`) writes the global flags file.
    const globalPath = getFlagsPath("global");
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, JSON.stringify({ flags: { gamma: true } }));
    // The stat now succeeds and differs from the cached MISSING -> re-read -> true.
    expect(isFlagEnabled("gamma")).toBe(true);
    // A cross-process rewrite is likewise observed (mtime/size change).
    fs.writeFileSync(globalPath, JSON.stringify({ flags: { gamma: false } }));
    expect(isFlagEnabled("gamma")).toBe(false);
    // A cross-process delete is observed too (stat -> MISSING).
    fs.rmSync(globalPath, { force: true });
    expect(isFlagEnabled("gamma")).toBe(false);
  });

  it("a local setFlag is seen by the next read", () => {
    setFlag("alpha", true, "global");
    expect(isFlagEnabled("alpha")).toBe(true);
    setFlag("alpha", false, "global");
    expect(isFlagEnabled("alpha")).toBe(false);
  });

  it("a local unsetFlag is seen by the next read", () => {
    setFlag("beta", true, "project");
    expect(isFlagEnabled("beta")).toBe(true);
    unsetFlag("beta", "project");
    expect(isFlagEnabled("beta")).toBe(false);
  });
});
