/**
 * Finds the bash a `.sh` script step runs under, once per step.
 *
 * Not memoized, for the reason the executor's bounds are not: `scripts.bash` is
 * configuration, and editing it takes effect on the next request. The lookup
 * shells out twice — once through `commandOnPath` for the PATH answer, once to
 * ask the candidate for its own version — and costs a few milliseconds against
 * a step that already starts a process.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { win32 as pathWin32 } from "node:path";
import {
  configFilePath,
  getConfigDefinition,
  getConfigValue,
  getConfigValueAtScope,
  type ConfigDefinition,
} from "@argent/configuration-core";
import { commandOnPath } from "../../../utils/command-on-path";

const BASH_CONFIG_KEY = "scripts.bash";

/**
 * What the probe below asks a candidate to print. `BASH_VERSION` is set by bash
 * and by nothing else, so a shell that is not bash answers with the marker and
 * an empty version — which the pattern refuses. The leading newline keeps a
 * candidate that greets on stdout from running into the marker's own line.
 */
const BASH_PROBE_COMMAND = 'printf \'\\n%s%s\\n\' "argent-bash-version:" "${BASH_VERSION}"';

const BASH_PROBE_MARKER = /^argent-bash-version:\S/m;

const BASH_PROBE_TIMEOUT_MS = 5_000;

/** Enough for the marker line; a candidate that streams is cut off, not kept. */
const BASH_PROBE_MAX_CHARS = 4 * 1024;

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
    const problem = interpreterProblem(configured) ?? (await notBashProblem(configured));
    return problem
      ? {
          problem:
            `The configured bash (${BASH_CONFIG_KEY} = ${configured}, from ` +
            `${configuredIn(configured, anchor)}) ${problem}. Point ${BASH_CONFIG_KEY} at a bash ` +
            `executable, or unset it to use the one on this host's PATH.`,
        }
      : { path: configured };
  }

  for (const candidate of await bashSearchPath()) {
    if (interpreterProblem(candidate)) continue;
    if (await notBashProblem(candidate)) continue;
    return { path: candidate };
  }

  return { problem: notFoundMessage() };
}

/**
 * Whether the candidate is really a bash, asked by running it. The static
 * checks above pass any executable file, and the three properties that follow
 * make a wrong one invisible rather than red: `$ARGENT_OUTPUT` already holds
 * the document the parent seeded, so a program that never reads the script
 * leaves a file the parent accepts; the child's stdout and stderr are drained
 * and discarded, so the wrong program's own words go nowhere; and an exit code
 * of 0 is a pass. A wrapper that pins a bash version and forgets to forward its
 * arguments is the realistic shape — bash with no file to run reads stdin, gets
 * end of file, and exits 0 — and it would report every `.sh` step green while
 * running none of them.
 *
 * `BASH_VERSION` rather than the exit status, because that is what separates
 * bash from the shells that would run the file with different word-splitting
 * and array semantics: zsh, ksh and dash answer this with an empty version.
 */
async function notBashProblem(candidate: string): Promise<string | null> {
  const answer = await askForBashVersion(candidate);
  if (BASH_PROBE_MARKER.test(answer.stdout)) return null;
  if (answer.signal) {
    return (
      `answered nothing when it was asked for its version, and was stopped by ${answer.signal} ` +
      `(the check waits ${BASH_PROBE_TIMEOUT_MS / 1_000} seconds)`
    );
  }
  return (
    "is not a bash: running it printed no $BASH_VERSION, so a `.sh` step would report the " +
    "document it was seeded with rather than the one the script writes" +
    (answer.failure ? ` (${answer.failure})` : "")
  );
}

/**
 * One run of the candidate, bounded on both axes. Its standard input is the
 * null device, the same end of file the step gives the script — without it the
 * wrapper this check exists for reads an open pipe until the timeout, and
 * answers in five seconds what it can answer at once. Its standard output is
 * kept only up to the marker's own length, so a candidate that streams costs
 * the timeout rather than the heap.
 */
function askForBashVersion(
  candidate: string
): Promise<{ stdout: string; signal: NodeJS.Signals | null; failure?: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(candidate, ["-c", BASH_PROBE_COMMAND], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: BASH_PROBE_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ stdout: "", signal: null, failure: firstLine(err) });
      return;
    }
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < BASH_PROBE_MAX_CHARS) stdout += chunk;
    });
    child.on("error", (err) => resolve({ stdout, signal: null, failure: firstLine(err) }));
    child.on("close", (_code, signal) => resolve({ stdout, signal }));
  });
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
}

/**
 * Which file to edit. `getConfigValue` merges the two scopes, so a stale GLOBAL
 * value makes every `.sh` step in every project on the machine refuse with a
 * message about a file the project does not contain.
 */
function configuredIn(configured: string, anchor: string | undefined): string {
  const options = anchor ? { cwd: anchor } : {};
  const project = getConfigValueAtScope(BASH_CONFIG_KEY, "project", options);
  return project === configured
    ? configFilePath("project", options)
    : configFilePath("global", options);
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
 * uses. Empty because the schema keeps every value that is PRESENT, so that a
 * blank one is refused here rather than read as an absent key; absolute because
 * a relative PATH entry gives `command -v` a relative answer that `spawn` would
 * resolve against the runner's own cwd; executable because a readable file is
 * not a runnable one — except on Windows, where `X_OK` succeeds for any file
 * and existence is the whole check.
 */
function interpreterProblem(candidate: string): string | null {
  if (candidate === "") return "is empty";
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
 *
 * That derivation is the official installer's layout, and a package manager
 * puts a SHIM on PATH instead — `~\scoop\shims\git.exe`,
 * `C:\ProgramData\chocolatey\bin\git.exe` — two levels above which there is
 * no `bin\bash.exe`. Chocolatey installs Git for Windows itself, so
 * `ProgramFiles` below covers it; Scoop keeps its own tree, so its two roots
 * are named here.
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
  for (const root of [
    process.env.SCOOP,
    process.env.USERPROFILE && pathWin32.join(process.env.USERPROFILE, "scoop"),
    process.env.SCOOP_GLOBAL,
    process.env.ProgramData && pathWin32.join(process.env.ProgramData, "scoop"),
  ]) {
    if (root) candidates.push(pathWin32.join(root, "apps", "git", "current", "bin", "bash.exe"));
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
      ? "PATH (skipping the WSL launcher under %SystemRoot%) and Git for Windows' usual install locations, Scoop's included"
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
