/**
 * Finds the bash a `.sh` script step runs under, once per step.
 *
 * Not memoized, for the reason the executor's bounds are not: `scripts.bash` is
 * configuration, and editing it takes effect on the next request. The lookup
 * shells out once through `commandOnPath` and costs a few milliseconds against
 * a step that already starts a process.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { win32 as pathWin32 } from "node:path";
import {
  getConfigDefinition,
  getConfigValue,
  type ConfigDefinition,
} from "@argent/configuration-core";
import { commandOnPath } from "../../../utils/command-on-path";

const BASH_CONFIG_KEY = "scripts.bash";

/** POSIX hosts that answer with a short login PATH still have one of these. */
const POSIX_FIXED_LOCATIONS = ["/bin/bash", "/usr/bin/bash"];

/**
 * A configuration value read against the FLOW's project, not against the tool
 * server's own working directory — which is whatever the editor that spawned it
 * chose, so the bare call would read another project's `.argent/config.json`, or
 * none. `getConfigValue` resolves the project scope from `options.cwd`.
 *
 * Every project-scoped script key needs this same anchor, so a second one takes
 * this rather than making its own bare call.
 */
function projectAnchoredConfigValue<T>(key: string, anchor: string | undefined): T | undefined {
  const def = getConfigDefinition(key) as ConfigDefinition<T> | undefined;
  if (!def) return undefined;
  return getConfigValue(def, anchor ? { cwd: anchor } : {});
}

/**
 * Where bash comes from, first hit wins:
 *
 * 1. `scripts.bash`, read against the flow's own project. A value that is set
 *    but unusable REFUSES the step rather than falling through — a wrong path
 *    papered over by a fallback that happens to exist on this machine is a flow
 *    that breaks in CI with nothing in the configuration to show why.
 * 2. `bash` on the tool server's PATH — the same PATH the script receives, so
 *    "the bash your terminal would run", which on a Mac with Homebrew is 5.x
 *    and on a bare one is Apple's 3.2.
 * 3. Fixed locations, for an editor-spawned server with a short login PATH.
 *
 * On Windows every candidate under `%SystemRoot%` is dropped at each of the
 * three: `System32\bash.exe` is the WSL launcher, it runs the file inside a
 * Linux distribution where the project path, the environment and
 * `$ARGENT_OUTPUT` do not exist, and it is early on every PATH.
 */
export async function resolveBashInterpreter(
  anchor: string | undefined
): Promise<{ path: string } | { problem: string }> {
  const configured = projectAnchoredConfigValue<string>(BASH_CONFIG_KEY, anchor);
  if (configured !== undefined) {
    const problem = interpreterProblem(configured);
    return problem
      ? {
          problem:
            `The configured bash for this project (${BASH_CONFIG_KEY} = ${configured}) ` +
            `${problem}. Point ${BASH_CONFIG_KEY} at a bash executable, or unset it to use ` +
            `the one on this host's PATH.`,
        }
      : { path: configured };
  }

  for (const candidate of await bashSearchPath()) {
    if (!interpreterProblem(candidate)) return { path: candidate };
  }

  return { problem: notFoundMessage() };
}

/**
 * The ordered candidates the resolver tries when `scripts.bash` is unset, before
 * any of them is checked against the filesystem. Exported so the Windows rules —
 * the `%SystemRoot%` skip and the Git-derived path — can be pinned on a POSIX
 * host, where no `C:\…` file can exist to be found.
 */
export async function bashSearchPath(): Promise<string[]> {
  const onPath = await commandOnPath("bash", isUsableCandidate);
  return [...(onPath ? [onPath] : []), ...(await fixedLocations())];
}

/**
 * Every reason a candidate cannot be the interpreter, in the words the refusal
 * uses. Absolute because a relative PATH entry gives `command -v` a relative
 * answer that `spawn` would resolve against the runner's own cwd; executable
 * because a readable file is not a runnable one — except on Windows, where
 * `X_OK` succeeds for any file and existence is the whole check.
 */
function interpreterProblem(candidate: string): string | null {
  if (!platformPath().isAbsolute(candidate)) {
    return "is not an absolute path (a relative path would resolve against the tool server's own working directory)";
  }
  if (underSystemRoot(candidate)) {
    return (
      "is the WSL launcher under %SystemRoot%, which runs the script inside a Linux " +
      "distribution where the project path, the environment and $ARGENT_OUTPUT do not exist " +
      "(Git for Windows' bash.exe is the one to point at)"
    );
  }
  try {
    if (!fs.statSync(candidate).isFile()) return "is not a file";
  } catch {
    return "does not exist";
  }
  if (process.platform === "win32") return null;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
  } catch {
    return "is not executable";
  }
  return null;
}

function isUsableCandidate(candidate: string): boolean {
  return !underSystemRoot(candidate);
}

/**
 * Explicit win32 semantics under win32 rather than the running platform's, so
 * the Windows rules are correct on a real Windows host and unit-testable on
 * POSIX CI — the same shape `commandOnPath` uses for its CWD check.
 */
function platformPath(): typeof pathWin32 {
  return process.platform === "win32" ? pathWin32 : path.posix;
}

function underSystemRoot(candidate: string): boolean {
  if (process.platform !== "win32") return false;
  const root = pathWin32.resolve(process.env.SystemRoot ?? "C:\\Windows").toLowerCase();
  const resolved = pathWin32.resolve(candidate).toLowerCase();
  return resolved === root || resolved.startsWith(`${root}\\`);
}

/**
 * Git for Windows in the shapes its installers produce. `git.exe` on PATH is
 * the most reliable of them because it survives a per-user install into a
 * directory none of the environment names below point at: `<Git>\cmd\git.exe`
 * sits two levels above `<Git>\bin\bash.exe`.
 */
async function fixedLocations(): Promise<string[]> {
  if (process.platform !== "win32") return POSIX_FIXED_LOCATIONS;
  const candidates: string[] = [];
  const git = await commandOnPath("git");
  if (git && pathWin32.isAbsolute(git)) {
    // `<Git>\cmd\git.exe` sits two levels above `<Git>\bin\bash.exe`.
    candidates.push(pathWin32.join(pathWin32.dirname(pathWin32.dirname(git)), "bin", "bash.exe"));
  }
  for (const base of [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA && pathWin32.join(process.env.LOCALAPPDATA, "Programs"),
  ]) {
    if (base) candidates.push(pathWin32.join(base, "Git", "bin", "bash.exe"));
  }
  return candidates;
}

/**
 * The tool server's PATH is a snapshot taken when it started, so a bash a
 * terminal finds may still be absent here — the remedy an author needs first,
 * and the one nothing else in the report would say.
 */
function notFoundMessage(): string {
  const looked =
    process.platform === "win32"
      ? "PATH (skipping the WSL launcher under %SystemRoot%) and Git for Windows' usual install locations"
      : `PATH, ${POSIX_FIXED_LOCATIONS.join(" and ")}`;
  const install =
    process.platform === "win32" ? "Install Git for Windows, which ships bash.exe" : "Install bash";
  return (
    `No bash was found on this host to run the script with: the executor looked at ${looked}. ` +
    `${install}, or set ${BASH_CONFIG_KEY} to an absolute path. The tool server's PATH is a ` +
    `snapshot from when it started, so a bash your terminal finds may still be absent here — ` +
    `restart the tool server after changing PATH.`
  );
}
