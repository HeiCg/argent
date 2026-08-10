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
export interface HarmonyInstance {
  name: string;
}

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

/** Emulator instances, or [] when DevEco Studio isn't installed. */
export async function listHarmonyInstances(): Promise<HarmonyInstance[]> {
  if (!(await resolveHarmonyEmulator())) return [];
  const result = await runHarmonyEmulator(["-list"]);
  if (emulatorFailure(result)) return [];
  return parseHarmonyInstances(result.stdout);
}
