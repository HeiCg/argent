// Feature-flag storage for argent: booleans in `~/.argent/flags.json` (global) and
// `<project-root>/.argent/flags.json` (project), where a project entry shadows the
// global one. The `enable`/`disable`/`flags` commands live in `@argent/cli` and
// wrap the primitives below.
//
// FLAG_REGISTRY gates only which names `argent enable` accepts; reads load whatever
// booleans are stored, so dropping a registry entry never errors on a flags.json
// that still contains it.

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export type FlagScope = "global" | "project";

interface FlagsFile {
  flags?: Record<string, boolean>;
}

// `description` is shown by `argent flags` and in `enable`/`disable` --help.
export interface FlagDefinition {
  readonly name: string;
  readonly description: string;
  // Opt-OUT flag: on until explicitly disabled, so `argent disable <name>` persists
  // an explicit `false` instead of unsetting. Only `isFeatureEnabled` applies it.
  readonly defaultEnabled?: boolean;
}

// Adding an entry here is the only change needed for `argent enable <name>` to
// accept it and `argent flags` to document it.
export const FLAG_REGISTRY: readonly FlagDefinition[] = [
  {
    name: "disable-auto-screenshot",
    description: "Disable the automatic screenshot captured after interaction tools.",
  },
  {
    name: "disable-auto-describe",
    description: "Disable the accessibility element tree appended after interaction tools.",
  },
  {
    name: "argent-lens",
    description:
      "Argent Lens — the propose_variant / await_user_selection tools and the Electron preview window for staging UI design variants and letting a human pick among them. Off by default while the feature is in development.",
  },
  {
    name: "artifacts-list-endpoint",
    description: "Expose GET /artifacts for remote artifact inventory consumers.",
  },
  {
    name: "tool-server-event-log",
    description: "Write structured tool-server lifecycle events to a JSONL file.",
  },
  {
    name: "boot-sound",
    description:
      "Default boot-device's `sound` argument to true so Android emulators boot with audio " +
      "output instead of muted. Only the argument's default changes — an explicit " +
      "`sound: false` on a call still boots muted.",
  },
  {
    name: "microinteractions",
    description:
      "Amplify device actions with matching animations of the host window, so what happens on the guest is also visible on the desktop. Purely cosmetic, macOS only, and never affects whether the underlying action succeeds. Off by default.",
  },
  {
    name: "video-watermark",
    description:
      "Overlay the argent corner watermark on recorded screen videos. On by default; turn it off with `argent disable video-watermark`.",
    defaultEnabled: true,
  },
  {
    name: "open-device-server",
    description:
      "Route Android describe, screen capture and touch/type input through the open-source on-device control server (`@argent/android-device-server`) instead of the uiautomator dump and the proprietary simulator-server. When on and the server is reachable it serves describe (source: open-device-server), screenshot, screenshot-diff live capture, gesture-tap / gesture-swipe / gesture-pinch / gesture-rotate / gesture-custom, paste, keyboard, the flow tree, and the await-* poll loops; every path falls back to the current one if the server is unavailable. Off by default; requires the built server APK.",
  },
  {
    name: "open-device-server-fast-inject",
    description:
      "Under `open-device-server`, inject tap/swipe/gesture touch events over the scrcpy control channel (Apache-2.0, server 3.3.1 via `@yume-chan/adb-scrcpy`) instead of the UiAutomation instrumentation hop, cutting per-event inject latency. Only the tap/swipe/gesture verbs move to scrcpy; describe/state/screenshot/typeText/key/await-* stay on the Kotlin on-device server. Ordering with a following read is preserved by a synchronous `flushInput` RPC. No effect unless `open-device-server` is also on. Off by default.",
  },
];

export function getFlagDefinition(
  name: string,
  registry: readonly FlagDefinition[] = FLAG_REGISTRY
): FlagDefinition | undefined {
  return registry.find((def) => def.name === name);
}

// `.argent` is a marker itself so later runs from a subdir find the dir the first
// run created.
const PROJECT_MARKERS = [".argent", ".git", "package.json"];

export interface FlagsPathOptions {
  cwd?: string;
  homeDir?: string;
}

/**
 * Nearest ancestor of `startDir` (inclusive) carrying a {@link PROJECT_MARKERS} entry,
 * or `null` if the walk reaches the filesystem root. Unlike {@link resolveProjectRoot},
 * the "no project" case stays distinct, so callers can warn or fall back to a global
 * location instead of silently anchoring at `startDir`.
 */
export function findProjectRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    for (const marker of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(current, marker))) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveProjectRoot(startDir: string): string {
  return findProjectRoot(startDir) ?? path.resolve(startDir);
}

// --- process-local read cache (phase 3i) -----------------------------------
// `isFlagEnabled` ran on EVERY Android describe, and each call did a project-root
// fs walk (an `existsSync` per marker up the tree) plus up to two `readFileSync` +
// `JSON.parse`. On the describe hot path that disk work dominated the host-side
// flag check.
//
// The cache validates the parsed flag map against a per-call `fs.statSync`
// (mtime + size): a stat is ~0.01 ms and needs no `readFileSync` and no
// project-root walk, so the hot path pays one stat instead of a walk + read +
// parse — while STILL observing cross-process writes. `argent flags set …` runs
// in a separate CLI process (`@argent/cli`), so the tool-server MUST see that
// write without a restart; an epoch bumped only on in-process writes would make
// the flag need a restart (a regression). The resolved project root is cached per
// cwd (form-factor of the tree is stable for a process).
const parsedFlagsByPath = new Map<
  string,
  { mtimeMs: number; size: number; flags: Record<string, boolean> }
>();
// Sentinel stat for "file does not exist", so a missing flags file is not
// re-opened every call yet a later create (mtime becomes real) is observed.
const MISSING_MTIME = -1;
const projectRootByCwd = new Map<string, string>();

function resolveProjectRootCached(cwd: string): string {
  const hit = projectRootByCwd.get(cwd);
  if (hit !== undefined) return hit;
  const root = resolveProjectRoot(cwd);
  projectRootByCwd.set(cwd, root);
  return root;
}

/** Drop a path's cached flags so the next read re-stats + re-parses. */
function invalidateFlagsPath(filePath: string): void {
  parsedFlagsByPath.delete(filePath);
}

export function getFlagsPath(scope: FlagScope, options: FlagsPathOptions = {}): string {
  const home = options.homeDir ?? homedir();
  if (scope === "global") {
    return path.join(home, ".argent", "flags.json");
  }
  const cwd = options.cwd ?? process.cwd();
  return path.join(resolveProjectRootCached(cwd), ".argent", "flags.json");
}

function readFlagsFile(filePath: string): Record<string, boolean> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const flags = (parsed as FlagsFile).flags;
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

// Cached variant of {@link readFlagsFile}, validated against the file's mtime +
// size so a cross-process write is observed without a re-parse of an unchanged
// file (see the phase 3i cache note above). `setFlag`/`unsetFlag` read fresh
// through `readFlagsFile` for their read-modify-write.
function readFlagsFileCached(filePath: string): Record<string, boolean> {
  let mtimeMs = MISSING_MTIME;
  let size = -1;
  try {
    const st = fs.statSync(filePath);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    // File absent: mtime stays the MISSING sentinel.
  }
  const hit = parsedFlagsByPath.get(filePath);
  if (hit !== undefined && hit.mtimeMs === mtimeMs && hit.size === size) return hit.flags;
  const flags = mtimeMs === MISSING_MTIME ? {} : readFlagsFile(filePath);
  parsedFlagsByPath.set(filePath, { mtimeMs, size, flags });
  return flags;
}

function writeFlagsFile(filePath: string, flags: Record<string, boolean>): void {
  // Drop the file (and `.argent` once empty) so disable-after-enable leaves a clean
  // tree; sibling files like tool-server.json keep the dir alive when present.
  if (Object.keys(flags).length === 0) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    const parent = path.dirname(filePath);
    try {
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
        fs.rmdirSync(parent);
      }
    } catch {
      // non-fatal
    }
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // tmp+rename so a reader never observes a torn payload; concurrent
  // read-modify-write is still last-writer-wins.
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ flags } satisfies FlagsFile, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

export function readFlags(
  scope: FlagScope,
  options: FlagsPathOptions = {}
): Record<string, boolean> {
  return readFlagsFileCached(getFlagsPath(scope, options));
}

export function setFlag(
  name: string,
  value: boolean,
  scope: FlagScope,
  options: FlagsPathOptions = {}
): void {
  const filePath = getFlagsPath(scope, options);
  const current = readFlagsFile(filePath);
  current[name] = value;
  writeFlagsFile(filePath, current);
  invalidateFlagsPath(filePath);
}

// Returns true when an entry existed; the next scope (or the default) then applies.
export function unsetFlag(name: string, scope: FlagScope, options: FlagsPathOptions = {}): boolean {
  const filePath = getFlagsPath(scope, options);
  const current = readFlagsFile(filePath);
  // hasOwn, not `in`: `in` reports never-stored names like "toString" as present.
  if (!Object.hasOwn(current, name)) return false;
  delete current[name];
  writeFlagsFile(filePath, current);
  invalidateFlagsPath(filePath);
  return true;
}

// Effective value: project overrides global, then the caller's `default` (false).
// Storage-only — for a flag's declared default use `isFeatureEnabled`.
export function isFlagEnabled(
  name: string,
  options: FlagsPathOptions & { default?: boolean } = {}
): boolean {
  // hasOwn, not `in`: prototype keys ("toString", …) would resolve to a truthy
  // Object.prototype member for a flag that was never set.
  const projectFlags = readFlags("project", options);
  if (Object.hasOwn(projectFlags, name)) return projectFlags[name]!;
  const globalFlags = readFlags("global", options);
  if (Object.hasOwn(globalFlags, name)) return globalFlags[name]!;
  return options.default ?? false;
}

// Registry-aware read: an unset flag resolves to its declared `defaultEnabled`.
// Runtime features should use this; `isFlagEnabled` is the storage primitive.
export function isFeatureEnabled(
  name: string,
  options: FlagsPathOptions = {},
  registry: readonly FlagDefinition[] = FLAG_REGISTRY
): boolean {
  return isFlagEnabled(name, {
    ...options,
    default: getFlagDefinition(name, registry)?.defaultEnabled ?? false,
  });
}
