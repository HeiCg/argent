import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  FLAG_REGISTRY,
  getFlagDefinition,
  getFlagsPath,
  isFlagEnabled,
  readEffectiveFlags,
  readFlags,
  resolveProjectRoot,
  setFlag,
  unsetFlag,
  withForwardedFlags,
  type FlagDefinition,
  type FlagsPathOptions,
} from "../src/flags.js";

// Hermetic registry for getFlagDefinition's injectable-registry path so the
// test never depends on which flags ship in the production FLAG_REGISTRY.
const TEST_REGISTRY: readonly FlagDefinition[] = [
  { name: "my-feature-flag", description: "Primary test flag." },
];

// All tests redirect global+project storage into tmp dirs by mutating
// process.env.HOME (consumed by os.homedir()) and process.cwd().

let tmpHome: string;
let tmpProject: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalCwd: string;

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Pins both scopes to this test's tmp dirs through the options param instead of
// the ambient HOME/cwd swap. Called inside a test so it sees the beforeEach dirs.
function tmpOptions(): FlagsPathOptions {
  return { homeDir: tmpHome, cwd: tmpProject };
}

beforeEach(() => {
  // realpath unwraps macOS's /var → /private/var tmpdir symlink so the path
  // we hand back from getFlagsPath matches what process.cwd() reports after
  // chdir().
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-flags-home-")));
  tmpProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-flags-proj-")));
  // Drop a marker so resolveProjectRoot stops here instead of walking up to
  // the actual user's repo and writing into it.
  fs.writeFileSync(path.join(tmpProject, "package.json"), "{}");

  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalCwd = process.cwd();
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.chdir(tmpProject);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpProject, { recursive: true, force: true });
});

describe("getFlagsPath", () => {
  it("defaults global path under ~/.argent/flags.json", () => {
    expect(getFlagsPath("global")).toBe(path.join(tmpHome, ".argent", "flags.json"));
  });

  it("project path lives at <project-root>/.argent/flags.json", () => {
    expect(getFlagsPath("project")).toBe(path.join(tmpProject, ".argent", "flags.json"));
  });

  it("respects explicit cwd / homeDir overrides", () => {
    const altHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "argent-flags-alt-home-"))
    );
    const altProj = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "argent-flags-alt-proj-"))
    );
    fs.writeFileSync(path.join(altProj, "package.json"), "{}");
    try {
      expect(getFlagsPath("global", { homeDir: altHome })).toBe(
        path.join(altHome, ".argent", "flags.json")
      );
      expect(getFlagsPath("project", { cwd: altProj })).toBe(
        path.join(altProj, ".argent", "flags.json")
      );
    } finally {
      fs.rmSync(altHome, { recursive: true, force: true });
      fs.rmSync(altProj, { recursive: true, force: true });
    }
  });
});

describe("resolveProjectRoot", () => {
  it("walks up to the nearest marker", () => {
    const nested = path.join(tmpProject, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveProjectRoot(nested)).toBe(tmpProject);
  });

  it("returns startDir when no marker exists in ancestry", () => {
    // A bare tmpdir guaranteed to have no project markers between it and /
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-flags-noroot-")));
    try {
      expect(resolveProjectRoot(bare)).toBe(bare);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it("treats existing .argent as a marker", () => {
    fs.rmSync(path.join(tmpProject, "package.json"));
    const argentDir = path.join(tmpProject, ".argent");
    fs.mkdirSync(argentDir);
    const nested = path.join(tmpProject, "sub");
    fs.mkdirSync(nested);
    expect(resolveProjectRoot(nested)).toBe(tmpProject);
  });

  it("treats existing .git as a marker", () => {
    fs.rmSync(path.join(tmpProject, "package.json"));
    fs.mkdirSync(path.join(tmpProject, ".git"));
    const nested = path.join(tmpProject, "sub");
    fs.mkdirSync(nested);
    expect(resolveProjectRoot(nested)).toBe(tmpProject);
  });
});

describe("setFlag / unsetFlag / readFlags", () => {
  it("writes the flag to disk and reads it back", () => {
    setFlag("alpha", true, "global");
    expect(readFlags("global")).toEqual({ alpha: true });

    const file = readJsonFile(getFlagsPath("global"));
    expect(file).toEqual({ flags: { alpha: true } });
  });

  it("preserves other flags when setting one", () => {
    setFlag("alpha", true, "global");
    setFlag("beta", false, "global");
    expect(readFlags("global")).toEqual({ alpha: true, beta: false });
  });

  it("overwrites a flag with a new value", () => {
    setFlag("alpha", true, "global");
    setFlag("alpha", false, "global");
    expect(readFlags("global")).toEqual({ alpha: false });
  });

  it("unsetFlag removes the entry and reports whether it existed", () => {
    setFlag("alpha", true, "global");
    setFlag("beta", true, "global");
    expect(unsetFlag("alpha", "global")).toBe(true);
    expect(readFlags("global")).toEqual({ beta: true });
    expect(unsetFlag("missing", "global")).toBe(false);
  });

  it("removes the file (and empty .argent dir) when the last flag is unset", () => {
    setFlag("alpha", true, "global");
    unsetFlag("alpha", "global");
    expect(fs.existsSync(getFlagsPath("global"))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, ".argent"))).toBe(false);
  });

  it("keeps the .argent dir when sibling state lives next to flags.json", () => {
    setFlag("alpha", true, "global");
    const sibling = path.join(tmpHome, ".argent", "tool-server.json");
    fs.writeFileSync(sibling, "{}");
    unsetFlag("alpha", "global");
    expect(fs.existsSync(getFlagsPath("global"))).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".argent"))).toBe(true);
  });

  it("project + global live in separate files", () => {
    setFlag("alpha", true, "global");
    setFlag("alpha", false, "project");
    expect(readFlags("global")).toEqual({ alpha: true });
    expect(readFlags("project")).toEqual({ alpha: false });
  });

  it("recovers from malformed JSON by treating storage as empty", () => {
    const file = getFlagsPath("global");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not json");
    expect(readFlags("global")).toEqual({});
    setFlag("alpha", true, "global");
    expect(readFlags("global")).toEqual({ alpha: true });
  });

  it("ignores non-boolean values in the stored flags object", () => {
    const file = getFlagsPath("global");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ flags: { real: true, bogus: "yes", numeric: 1, nested: {} } })
    );
    expect(readFlags("global")).toEqual({ real: true });
  });

  it("treats missing .argent dir as empty without throwing", () => {
    expect(readFlags("global")).toEqual({});
    expect(readFlags("project")).toEqual({});
  });

  it("writes are atomic — no .tmp leftover in the .argent dir", () => {
    setFlag("alpha", true, "global");
    setFlag("beta", true, "global");
    const dir = path.join(tmpHome, ".argent");
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("isFlagEnabled", () => {
  it("returns false for an unknown flag", () => {
    expect(isFlagEnabled("unknown")).toBe(false);
  });

  it("project value overrides global value (explicit false masks global true)", () => {
    setFlag("alpha", true, "global");
    setFlag("alpha", false, "project");
    expect(isFlagEnabled("alpha")).toBe(false);

    setFlag("beta", false, "global");
    setFlag("beta", true, "project");
    expect(isFlagEnabled("beta")).toBe(true);
  });

  it("falls through to global when project does not set it", () => {
    setFlag("alpha", true, "global");
    expect(isFlagEnabled("alpha")).toBe(true);
  });

  it("falls through to project-only when global is unset", () => {
    setFlag("alpha", true, "project");
    expect(isFlagEnabled("alpha")).toBe(true);
  });

  it("respects explicit cwd / homeDir options instead of process state", () => {
    setFlag("alpha", true, "global", { homeDir: tmpHome });
    expect(isFlagEnabled("alpha", { homeDir: tmpHome, cwd: tmpProject })).toBe(true);
  });
});

describe("readEffectiveFlags", () => {
  it("merges both scopes, with project shadowing global for the same key", () => {
    const options = tmpOptions();
    setFlag("global-only", true, "global", options);
    setFlag("shared", false, "global", options);
    setFlag("shared", true, "project", options);
    setFlag("project-only", true, "project", options);

    expect(readEffectiveFlags(options)).toEqual({
      "global-only": true,
      "shared": true,
      "project-only": true,
    });
    // The merged value is the one isFlagEnabled resolves, not the other scope's.
    expect(isFlagEnabled("shared", options)).toBe(true);
  });

  it("a project false shadows a global true", () => {
    const options = tmpOptions();
    setFlag("alpha", true, "global", options);
    setFlag("alpha", false, "project", options);
    expect(readEffectiveFlags(options)).toEqual({ alpha: false });
    expect(isFlagEnabled("alpha", options)).toBe(false);
  });

  it("returns {} when neither scope stores anything", () => {
    const options = tmpOptions();
    expect(readEffectiveFlags(options)).toEqual({});
    expect(Object.keys(readEffectiveFlags(options))).toEqual([]);
  });

  it("includes explicitly-false entries instead of dropping them", () => {
    const options = tmpOptions();
    setFlag("off-globally", false, "global", options);
    setFlag("off-in-project", false, "project", options);
    setFlag("on", true, "global", options);

    const effective = readEffectiveFlags(options);
    expect(effective).toEqual({ "off-globally": false, "off-in-project": false, "on": true });
    expect(Object.hasOwn(effective, "off-globally")).toBe(true);
    expect(effective["off-in-project"]).toBe(false);
  });
});

describe("withForwardedFlags", () => {
  it("resolves isFlagEnabled from the forwarded set, never from disk", () => {
    const options = tmpOptions();
    setFlag("alpha", true, "global", options);
    setFlag("beta", true, "project", options);
    // Baseline: without a scope, disk decides.
    expect(isFlagEnabled("alpha", options)).toBe(true);
    expect(isFlagEnabled("beta", options)).toBe(true);

    // An empty forwarded set means the caller has nothing enabled, so the
    // server's own flags.json must not fill the gap.
    const inside = withForwardedFlags({}, () => ({
      alpha: isFlagEnabled("alpha", options),
      beta: isFlagEnabled("beta", options),
    }));
    expect(inside).toEqual({ alpha: false, beta: false });
  });

  it("a forwarded true wins when the flag is absent from disk", () => {
    const options = tmpOptions();
    expect(isFlagEnabled("alpha", options)).toBe(false);
    expect(withForwardedFlags({ alpha: true }, () => isFlagEnabled("alpha", options))).toBe(true);
  });

  it("a forwarded true wins when disk stores false in both scopes", () => {
    const options = tmpOptions();
    setFlag("alpha", false, "global", options);
    setFlag("alpha", false, "project", options);
    expect(withForwardedFlags({ alpha: true }, () => isFlagEnabled("alpha", options))).toBe(true);
  });

  it("a forwarded false wins when disk stores true", () => {
    const options = tmpOptions();
    setFlag("alpha", true, "global", options);
    expect(withForwardedFlags({ alpha: false }, () => isFlagEnabled("alpha", options))).toBe(false);
  });

  it("returns the callback's value unchanged", () => {
    expect(withForwardedFlags({ alpha: true }, () => "payload")).toBe("payload");
  });

  for (const name of ["toString", "constructor"]) {
    it(`a forwarded set that omits "${name}" resolves it to false, not to the prototype member`, () => {
      const options = tmpOptions();
      const result = withForwardedFlags({ real: true }, () => isFlagEnabled(name, options));
      expect(result).toBe(false);
      expect(typeof result).toBe("boolean");
    });

    it(`a flag literally named "${name}" resolves from the forwarded set`, () => {
      const options = tmpOptions();
      expect(withForwardedFlags({ [name]: true }, () => isFlagEnabled(name, options))).toBe(true);
      expect(withForwardedFlags({ [name]: false }, () => isFlagEnabled(name, options))).toBe(false);
    });
  }

  it("accepts a null-prototype set (the shape decodeForwardedFlags produces)", () => {
    const options = tmpOptions();
    const forwarded = Object.assign(Object.create(null) as Record<string, boolean>, {
      alpha: true,
    });
    const inside = withForwardedFlags(forwarded, () => ({
      alpha: isFlagEnabled("alpha", options),
      toStringFlag: isFlagEnabled("toString", options),
    }));
    expect(inside).toEqual({ alpha: true, toStringFlag: false });
  });

  it("stays bound across an await, and disk applies again after the scope ends", async () => {
    const options = tmpOptions();
    setFlag("alpha", true, "global", options);

    const observed = await withForwardedFlags({ beta: true }, async () => {
      const beforeAwait = isFlagEnabled("alpha", options);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return {
        beforeAwait,
        alphaAfterAwait: isFlagEnabled("alpha", options),
        betaAfterAwait: isFlagEnabled("beta", options),
      };
    });

    expect(observed).toEqual({
      beforeAwait: false,
      alphaAfterAwait: false,
      betaAfterAwait: true,
    });
    // Outside the scope the disk is authoritative again.
    expect(isFlagEnabled("alpha", options)).toBe(true);
    expect(isFlagEnabled("beta", options)).toBe(false);
  });

  it("a nested scope replaces the outer set rather than merging with it", () => {
    const options = tmpOptions();
    const inner = withForwardedFlags({ outer: true }, () =>
      withForwardedFlags({ inner: true }, () => ({
        outer: isFlagEnabled("outer", options),
        inner: isFlagEnabled("inner", options),
      }))
    );
    expect(inner).toEqual({ outer: false, inner: true });

    // …and the outer set is restored once the nested scope exits.
    const afterNested = withForwardedFlags({ outer: true }, () => {
      withForwardedFlags({ inner: true }, () => undefined);
      return isFlagEnabled("outer", options);
    });
    expect(afterNested).toBe(true);
  });

  it("leaves the scope even when the callback throws", () => {
    const options = tmpOptions();
    setFlag("alpha", true, "global", options);
    expect(() =>
      withForwardedFlags({ alpha: false }, () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    // Disk applies again — a scope leaked past the throw would keep alpha off.
    expect(isFlagEnabled("alpha", options)).toBe(true);
  });
});

describe("prototype-named flags (Object.prototype keys)", () => {
  // Names like "toString"/"constructor"/"valueOf" also exist on
  // Object.prototype. A naive `name in obj` check would treat these as set
  // (returning a truthy prototype member) even when storage is empty — these
  // guard that hasOwn semantics are used throughout.
  const protoNames = ["toString", "constructor", "valueOf", "hasOwnProperty"];

  for (const name of protoNames) {
    it(`isFlagEnabled("${name}") is false (and a real boolean) when unset`, () => {
      const result = isFlagEnabled(name);
      expect(result).toBe(false);
      expect(typeof result).toBe("boolean");
    });

    it(`unsetFlag("${name}") on storage without it returns false and is a no-op`, () => {
      setFlag("real", true, "global");
      expect(unsetFlag(name, "global")).toBe(false);
      expect(readFlags("global")).toEqual({ real: true });
    });

    it(`set/unset round trip works for a flag literally named "${name}"`, () => {
      setFlag(name, true, "global");
      expect(readFlags("global")).toEqual({ [name]: true });
      expect(isFlagEnabled(name)).toBe(true);
      expect(unsetFlag(name, "global")).toBe(true);
      expect(isFlagEnabled(name)).toBe(false);
    });
  }
});

describe("FLAG_REGISTRY / getFlagDefinition", () => {
  it("getFlagDefinition returns the entry or undefined", () => {
    expect(getFlagDefinition("my-feature-flag", TEST_REGISTRY)?.description).toBe(
      "Primary test flag."
    );
    expect(getFlagDefinition("nope", TEST_REGISTRY)).toBeUndefined();
  });

  it("getFlagDefinition defaults to the shipped registry", () => {
    expect(getFlagDefinition("disable-auto-screenshot")?.description).toMatch(/auto/i);
    expect(getFlagDefinition("tool-server-event-log")?.description).toMatch(/event/i);
  });

  it("every shipped registry entry has a non-empty name and description", () => {
    // Guards against a half-filled entry being added to the production registry.
    for (const def of FLAG_REGISTRY) {
      expect(def.name).toMatch(/^[a-zA-Z][a-zA-Z0-9._-]*$/);
      expect(def.description.trim().length).toBeGreaterThan(0);
    }
  });
});
