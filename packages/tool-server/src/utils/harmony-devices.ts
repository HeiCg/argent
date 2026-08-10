import {
  HARMONY_EMPTY_SENTINEL,
  emulatorFailure,
  resolveHarmonyEmulator,
  runHarmonyEmulator,
} from "./harmony-cli";
import { HDC_EMPTY_SENTINEL, hdcFailure, resolveHdc, runHdc } from "./harmony-hdc";

/**
 * Discovery for the HarmonyOS platform, from the two sources that know about a
 * HarmonyOS target:
 *
 * - DevEco Studio's `Emulator` manager knows about emulator *instances*,
 *   running or not. An instance is what `boot-device` starts.
 * - `hdc` knows about *connected* targets — a physical phone over USB, and a
 *   running emulator once it has registered. A connect key is what every
 *   interaction tool drives.
 *
 * This is the same split Android has between `avdmanager` and `adb devices`,
 * and it has the same consequence: a running emulator legitimately appears in
 * both, under an instance name in one and a connect key in the other.
 *
 * Readers here treat `[Empty]` as "none" and a recognised diagnostic as a
 * failure, because neither CLI's exit code says either (see `harmony-cli.ts`
 * and `harmony-hdc.ts`).
 */

/** A HarmonyOS emulator instance as reported by `Emulator -list -details`. */
interface HarmonyInstance {
  name: string;
  /** `Phone`, `Foldable`, `Tablet`, `TV`, … as configured at creation. */
  deviceType: string | null;
  /** e.g. `HarmonyOS 6.1.1(24)`. */
  osVersion: string | null;
  running: boolean;
}

/**
 * One `Emulator -list -details` record. Every value is a string, including the
 * booleans — `isRunning` is `"true"`/`"false"`, never a JSON boolean, the same
 * quirk `-imageList` has with `downloaded`.
 */
interface RawInstance {
  "name"?: unknown;
  "deviceName"?: unknown;
  "deviceType"?: unknown;
  "isRunning"?: unknown;
  "os.osVersion"?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Instances from `Emulator -list -details`.
 *
 * `-details` rather than the bare `-list` (one name per line) because it is the
 * strict superset and costs the same — both were measured at ~30ms, since each
 * only reads `~/.Huawei/Emulator/deployed`. It is also the only form that
 * reports `isRunning`, without which every instance would have to be listed
 * with an unknown state.
 *
 * The name is taken from the config's `name` key, not the directory: the manager
 * itself keys off the config, so two directories carrying the same configured
 * name are reported as one instance.
 */
export function parseHarmonyInstances(stdout: string): HarmonyInstance[] {
  const text = stdout.trim();
  if (text.length === 0 || text.startsWith(HARMONY_EMPTY_SENTINEL)) return [];
  // A malformed instance directory makes the manager print `Config file not
  // found: …` *before* the JSON body, so parse from the first bracket rather
  // than the first byte.
  const start = text.indexOf("[");
  if (start === -1) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: HarmonyInstance[] = [];
  for (const entry of raw as RawInstance[]) {
    const name = str(entry?.name) ?? str(entry?.deviceName);
    if (!name) continue;
    out.push({
      name,
      deviceType: str(entry?.deviceType),
      osVersion: str(entry?.["os.osVersion"]),
      running: entry?.isRunning === "true",
    });
  }
  return out;
}

/**
 * Bound for the `-list` call, well under `list-devices`' BRANCH_DEADLINE_MS —
 * that backstop must stay above every branch's worst case, or it truncates a
 * branch that would have completed and drops a real device from the list.
 * `runHarmonyEmulator`'s 30s default is above the deadline, so this call must
 * pass its own. `-list -details` only reads `~/.Huawei/Emulator/deployed`
 * (measured at under 0.1s), making 6s pure headroom for a loaded machine.
 */
export const HARMONY_LIST_TIMEOUT_MS = 6_000;

/** Emulator instances, or [] when DevEco Studio isn't installed. */
export async function listHarmonyInstances(): Promise<HarmonyInstance[]> {
  if (!(await resolveHarmonyEmulator())) return [];
  const result = await runHarmonyEmulator(["-list", "-details"], HARMONY_LIST_TIMEOUT_MS);
  if (emulatorFailure(result)) return [];
  return parseHarmonyInstances(result.stdout);
}

/** A target `hdc` is connected to — a physical device, or a running emulator. */
interface HarmonyHdcTarget {
  /** The key every `hdc -t <key>` call takes. A hardware serial, or `ip:port`. */
  connectKey: string;
  /** `USB`, `TCP`, … as reported in column 2. */
  connection: string | null;
  /** `Connected`, `Offline`, … — only a Connected target can be driven. */
  state: string;
}

/**
 * Bound for `hdc list targets`, chosen on the same basis as the instance list
 * above: it must stay under `BRANCH_DEADLINE_MS`. Unlike `-list` this one does
 * talk to a daemon (and starts it if absent), so it gets more room than a
 * directory read while staying far below the deadline.
 */
export const HDC_LIST_TIMEOUT_MS = 8_000;

/**
 * Parse `hdc list targets -v`, whose rows are tab-separated:
 *
 *   025DEK236V035771\t\tUSB\tConnected\tlocalhost
 *
 * Note the empty second column. Splitting on runs of whitespace rather than on
 * single tabs keeps that hole from shifting `connection` and `state` one column
 * left — which would report every attached phone's state as `USB`, a string no
 * readiness check matches, hiding a perfectly healthy device.
 */
export function parseHdcTargets(stdout: string): HarmonyHdcTarget[] {
  const out: HarmonyHdcTarget[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith(HDC_EMPTY_SENTINEL)) continue;
    if (trimmed.startsWith("[")) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length === 1) {
      // `hdc list targets` without `-v` prints the bare connect key.
      out.push({ connectKey: cols[0], connection: null, state: "Connected" });
      continue;
    }
    out.push({ connectKey: cols[0], connection: cols[1] ?? null, state: cols[2] ?? "Unknown" });
  }
  return out;
}

/** Connected HarmonyOS targets, or [] when `hdc` isn't installed. */
export async function listHarmonyHdcTargets(): Promise<HarmonyHdcTarget[]> {
  if (!(await resolveHdc())) return [];
  const result = await runHdc(["list", "targets", "-v"], HDC_LIST_TIMEOUT_MS);
  if (hdcFailure(result)) return [];
  return parseHdcTargets(result.stdout);
}
