import {
  HARMONY_EMPTY_SENTINEL,
  emulatorFailure,
  resolveHarmonyEmulator,
  runHarmonyEmulator,
} from "./harmony-cli";

/**
 * Discovery for the HarmonyOS platform: the emulator instances DevEco Studio's
 * `Emulator` manager knows about.
 *
 * Readers here treat `[Empty]` as "none" and a recognised diagnostic as a
 * failure, because the exit code says neither (see `harmony-cli.ts`).
 */

/** A HarmonyOS emulator instance as reported by `Emulator -list`. */
type HarmonyInstance = { name: string };

/**
 * Lines the emulator manager prints alongside a listing that are not instance
 * names. `Config file not found: …` is emitted per malformed instance directory
 * *before* the `[Empty]`/listing body, so it would otherwise be read as a name.
 */
function isDiagnosticLine(line: string): boolean {
  return line.startsWith("Config file not found:") || line.startsWith("[");
}

/**
 * Instance names from `Emulator -list`.
 *
 * Only the empty case (`[Empty]`) could be verified on a host outside mainland
 * China, because Huawei restricts the image download that creating an instance
 * requires — so the populated case is parsed conservatively as one name per
 * line, with known diagnostics filtered out, and anything unrecognised simply
 * yields no instances rather than a bogus one.
 */
export function parseHarmonyInstances(stdout: string): HarmonyInstance[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== HARMONY_EMPTY_SENTINEL && !isDiagnosticLine(l))
    .map((name) => ({ name }));
}

/**
 * Bound for the `-list` call, well under `list-devices`' BRANCH_DEADLINE_MS —
 * that backstop must stay above every branch's worst case, or it truncates a
 * branch that would have completed and drops a real device from the list.
 * `runHarmonyEmulator`'s 30s default is above the deadline, so this call must
 * pass its own. `-list` only reads `~/.Huawei/Emulator/deployed` (measured at
 * under 0.1s), making 6s pure headroom for a loaded machine.
 */
export const HARMONY_LIST_TIMEOUT_MS = 6_000;

/** Emulator instances, or [] when DevEco Studio isn't installed. */
export async function listHarmonyInstances(): Promise<HarmonyInstance[]> {
  if (!(await resolveHarmonyEmulator())) return [];
  const result = await runHarmonyEmulator(["-list"], HARMONY_LIST_TIMEOUT_MS);
  if (emulatorFailure(result)) return [];
  return parseHarmonyInstances(result.stdout);
}
