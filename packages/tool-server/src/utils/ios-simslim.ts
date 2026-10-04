// Opt-in simslim (https://github.com/MobAI-App/simslim) for local iOS
// simulators: `boot-device` runs the external `simslim` binary with the profile
// from `ios.simslim.profile` to disable launchd daemons the simulator does not
// need. This module owns every simslim process call; the exec is injectable so
// tests never spawn anything.
//
// `simslim on` boots and reboots the simulator itself, so it runs BEFORE
// `simctl boot`: a reboot after our boot would drop the launchd
// DYLD_INSERT_LIBRARIES env set post-boot. The pre-boot accessibility plist is
// on disk and survives simslim's reboot.
//
// simslim never fails a boot. Any problem — binary missing, runtime too old, a
// simulator already booted, a non-zero exit, a timeout, verify drift — leaves the
// boot to continue and yields one sentence for the tool result's `warning`.
// No retries.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getIosSimslimBinary, getIosSimslimProfile } from "@argent/configuration-core";

const execFileAsync = promisify(execFile);

/** Outcome of one simslim process. `code` is null when it did not exit normally. */
export interface SimslimExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn failure code, e.g. `ENOENT` for a missing binary. */
  errorCode?: string;
}

export type SimslimExec = (
  file: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }
) => Promise<SimslimExecResult>;

export interface SimslimSettings {
  /** Absolute profile path. */
  profile: string;
  /** Executable: a bare name (PATH lookup) or a path. */
  binary: string;
}

export interface SimslimTarget {
  udid: string;
  /** simctl runtime identifier, e.g. `com.apple.CoreSimulator.SimRuntime.iOS-18-5`. */
  runtime?: string;
  runtimeKind?: "mobile" | "tv";
  /** State before boot-device touched the simulator. */
  state?: string;
  /** `force` shut a Booted simulator down for this boot. */
  shutDownByForce: boolean;
  /** Owning device-set directory; null for the default set. */
  deviceSet: string | null;
}

/** The pre-boot half: whether `simslim on` ran and whether it succeeded. */
interface SimslimPlan {
  attempted: boolean;
  applied: boolean;
  version: string | null;
  warning?: string;
}

/** What boot-device adds to its result. */
export interface SimslimSlim {
  applied: boolean;
  verdict: string | null;
  managedDisabled: number | null;
  managedTotal: number | null;
  profile: string;
  version: string | null;
}

interface SimslimOutcome {
  slim?: SimslimSlim;
  warning?: string;
}

const MIN_RUNTIME: readonly [number, number] = [18, 5];
const DEFAULT_BOOT_TIMEOUT = "15m";
const DEFAULT_BOOT_TIMEOUT_MS = 15 * 60_000;
// Our kill is a backstop behind simslim's own boot deadline, so it lands after it.
const ON_GRACE_MS = 60_000;
const QUICK_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 60_000;

const asText = (v: unknown): string =>
  typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : "";

const defaultExec: SimslimExec = async (file, args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: opts.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      ...(opts.env ? { env: opts.env } : {}),
    });
    return { code: 0, stdout: asText(stdout), stderr: asText(stderr), timedOut: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      killed?: boolean;
      stdout?: unknown;
      stderr?: unknown;
    };
    return {
      code: typeof e.code === "number" ? e.code : null,
      stdout: asText(e.stdout),
      stderr: asText(e.stderr),
      timedOut: e.killed === true,
      ...(typeof e.code === "string" ? { errorCode: e.code } : {}),
    };
  }
};

/**
 * The configured simslim settings, or null when `ios.simslim.profile` is unset
 * (the feature is off). Reads config only — never spawns. An unreadable config
 * reads as off: simslim must not be the reason a boot fails.
 */
export function readSimslimSettings(
  read: { profile: () => string | null; binary: () => string | null } = {
    profile: getIosSimslimProfile,
    binary: getIosSimslimBinary,
  }
): SimslimSettings | null {
  try {
    const profile = read.profile();
    if (!profile) return null;
    return { profile, binary: read.binary() ?? "simslim" };
  } catch {
    return null;
  }
}

/** A Go `time.Duration` string (`15m`, `1h30m`, `90s`, `1500ms`) in ms, or null. */
export function parseGoDurationMs(value: string): number | null {
  const s = value.trim();
  if (!/^(\d+(\.\d+)?(h|ms|m|s))+$/.test(s)) return null;
  const unit: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };
  let total = 0;
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) total += Number(n) * unit[u!]!;
  return total > 0 ? total : null;
}

/** simslim's own boot deadline: SIMSLIM_BOOT_TIMEOUT when valid, else 15 min. */
function bootTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.SIMSLIM_BOOT_TIMEOUT;
  return (raw && parseGoDurationMs(raw)) || DEFAULT_BOOT_TIMEOUT_MS;
}

/** The kill deadline for `simslim on`: simslim's boot deadline plus a grace minute. */
export function simslimOnTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return bootTimeoutMs(env) + ON_GRACE_MS;
}

function runtimeVersion(runtime: string | undefined): [number, number] | null {
  const m = runtime?.match(/iOS-(\d+)(?:-(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

function setArgs(deviceSet: string | null): string[] {
  return deviceSet ? ["--set", deviceSet] : [];
}

/** The last non-blank stderr line, for a one-sentence warning. */
function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1]! : "";
}

function failureDetail(r: SimslimExecResult): string {
  const line = lastLine(r.stderr);
  const exit = r.code === null ? "no exit code" : `exit ${r.code}`;
  return line ? `${exit}: ${line}` : exit;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const NOT_ATTEMPTED: SimslimPlan = { attempted: false, applied: false, version: null };

/**
 * Pre-boot half: run `simslim on` when the target qualifies. Call after the
 * pre-boot accessibility write and before `simctl boot`. Silent (no warning,
 * no spawn) for targets simslim does not apply to: tvOS, and a udid that is not
 * a listed local simulator (physical device, failed listing).
 */
export async function applySimslimBeforeBoot(
  settings: SimslimSettings,
  target: SimslimTarget,
  exec: SimslimExec = defaultExec
): Promise<SimslimPlan> {
  if (target.runtimeKind !== "mobile" || !target.runtime) return NOT_ATTEMPTED;

  const shutDown = target.state === "Shutdown" || target.shutDownByForce;
  if (!shutDown) {
    return {
      ...NOT_ATTEMPTED,
      warning:
        `The simulator was already booted, so simslim was not applied ` +
        `(pass force: true to reboot it with the profile).`,
    };
  }

  const version = runtimeVersion(target.runtime);
  if (
    !version ||
    version[0] < MIN_RUNTIME[0] ||
    (version[0] === MIN_RUNTIME[0] && version[1] < MIN_RUNTIME[1])
  ) {
    const found = version ? `iOS ${version[0]}.${version[1]}` : target.runtime;
    return {
      ...NOT_ATTEMPTED,
      warning: `simslim needs iOS 18.5 or later and this simulator runs ${found}, so it booted stock.`,
    };
  }

  const v = await exec(settings.binary, ["--version"], { timeoutMs: QUICK_TIMEOUT_MS });
  if (v.code !== 0) {
    const why = v.errorCode === "ENOENT" ? "was not found" : `did not run (${failureDetail(v)})`;
    return {
      ...NOT_ATTEMPTED,
      warning: `simslim ${why} at "${settings.binary}" (ios.simslim.binary or PATH), so the simulator booted stock.`,
    };
  }
  const simslimVersion = v.stdout.trim().replace(/^simslim\s+/, "") || null;

  // simslim reads SIMSLIM_BOOT_TIMEOUT itself; default it to 15 min (simslim's
  // own default is 10) so a slow host does not hit simslim's deadline first.
  const env = {
    ...process.env,
    SIMSLIM_BOOT_TIMEOUT: process.env.SIMSLIM_BOOT_TIMEOUT || DEFAULT_BOOT_TIMEOUT,
  };
  const on = await exec(
    settings.binary,
    ["on", target.udid, "--profile", settings.profile, ...setArgs(target.deviceSet)],
    { timeoutMs: simslimOnTimeoutMs(env), env }
  );
  if (on.timedOut) {
    const minutes = Math.round(bootTimeoutMs(env) / 60_000);
    return {
      attempted: true,
      applied: false,
      version: simslimVersion,
      warning: `simslim on did not finish within ${minutes} min, so the simulator booted without the slim profile.`,
    };
  }
  if (on.code !== 0) {
    return {
      attempted: true,
      applied: false,
      version: simslimVersion,
      warning: `simslim on failed (${failureDetail(on)}), so the simulator booted without the slim profile.`,
    };
  }
  return { attempted: true, applied: true, version: simslimVersion };
}

/**
 * Post-boot half: after the stock boot sequence, `simslim verify` (only when
 * `on` succeeded) and `simslim status` (whenever `on` ran) give the `slim`
 * object. A plan that never ran `on` spawns nothing here.
 */
export async function verifySimslimAfterBoot(
  settings: SimslimSettings,
  target: SimslimTarget,
  plan: SimslimPlan,
  exec: SimslimExec = defaultExec
): Promise<SimslimOutcome> {
  if (!plan.attempted) return plan.warning ? { warning: plan.warning } : {};

  let applied = plan.applied;
  let warning = plan.warning;
  const set = setArgs(target.deviceSet);

  if (plan.applied) {
    const r = await exec(
      settings.binary,
      ["verify", target.udid, "--profile", settings.profile, "--json", ...set],
      { timeoutMs: QUERY_TIMEOUT_MS }
    );
    // Exit 1 means drift AND error; only drift prints the JSON verdict.
    const json = parseJson(r.stdout);
    if (r.code !== 0 || !json || json.ok !== true) {
      applied = false;
      if (json && json.ok === false) {
        const list = (k: string) =>
          Array.isArray(json[k]) && (json[k] as unknown[]).length
            ? `${k}: ${(json[k] as unknown[]).join(", ")}`
            : null;
        const detail = [list("missing"), list("extra")].filter(Boolean).join("; ");
        warning = `simslim verify found drift from the profile (${detail || "no detail"}), so the simulator is not slimmed as configured.`;
      } else {
        warning = `simslim verify failed (${r.timedOut ? "timed out" : lastLine(r.stderr) || failureDetail(r)}), so the slim state is unverified.`;
      }
    }
  }

  const s = await exec(settings.binary, ["status", target.udid, "--json", ...set], {
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  const status = s.code === 0 ? parseJson(s.stdout) : null;
  const num = (k: string) => (status && typeof status[k] === "number" ? status[k] : null);

  return {
    slim: {
      applied,
      verdict: status && typeof status.verdict === "string" ? status.verdict : null,
      managedDisabled: num("managedDisabled"),
      managedTotal: num("managedTotal"),
      profile: settings.profile,
      version: plan.version,
    },
    ...(warning ? { warning } : {}),
  };
}
