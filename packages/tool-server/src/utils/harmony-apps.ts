import { FAILURE_CODES, FailureError } from "@argent/registry";
import { runHdcShell, shellQuote } from "./harmony-hdc";

/**
 * App lifecycle on HarmonyOS, over the device's `aa` (ability assistant) and
 * `bm` (bundle manager).
 *
 * `aa` continues the platform's pattern of unreliable exit codes and takes it
 * one step further than `hdc` or `Emulator`: measured on HarmonyOS 6.0.1, a
 * failed `aa start` prints `error: failed to start ability.` with a numbered
 * error code and still exits **0**. Success prints `start ability successfully.`
 * So the verdict is read off stdout, and a missing success line is a failure
 * even when nothing recognisable was printed — the alternative is reporting a
 * launch that did not happen.
 */

/** Printed verbatim by `aa start` on success. */
const AA_SUCCESS = "start ability successfully.";

interface HarmonyBundleEntry {
  /** The ability to launch, as `bm` reports it — always fully qualified. */
  mainAbility: string;
  /** The HAP module the ability lives in; `aa start -m` needs it. */
  module: string;
}

/**
 * Resolve a bundle's launchable entry point.
 *
 * Necessary rather than convenient: `aa start -b <bundle>` alone does **not**
 * launch an app. It is an *implicit* start, and with no matching action it
 * fails with `10103101 Failed to find a matching application for implicit
 * launch` — and, worse, leaves a system "No options to open with" chooser on the
 * user's screen, which then has to be dismissed. So the ability and its module
 * are looked up first and passed explicitly, which is also how DevEco Studio
 * launches an app.
 *
 * The subtlety, and the reason this is not a one-line read of `mainAbility`:
 * **`aa start -a` does not accept `mainAbility`.** It accepts the `name` of the
 * matching entry in `abilityInfos`, and the two are spelled differently from
 * bundle to bundle. Measured on HarmonyOS 6.0.1:
 *
 *   bundle       mainAbility                                 abilityInfos name
 *   calculator   com.huawei.hmos.calculator.CalculatorAbility CalculatorAbility
 *   settings     com.huawei.hmos.settings.MainAbility         (identical)
 *   notepad      MainAbility                                  (identical)
 *
 * Passing `mainAbility` verbatim launches Settings and fails on Calculator with
 * `10104001 The specified ability does not exist`; passing the bare final
 * segment does the reverse. So `mainAbility` is used to *identify* the entry and
 * the entry's own `name` is what gets passed.
 *
 * `mainAbility` is what identifies it, rather than the first entry of
 * `abilityInfos`: a bundle can declare a dozen abilities (Settings declares
 * background, OOBE and external-intent ones) and only `mainAbility` picks the
 * one the launcher icon opens.
 */
export async function resolveHarmonyEntry(
  connectKey: string,
  bundleId: string
): Promise<HarmonyBundleEntry> {
  const { stdout } = await runHdcShell(connectKey, `bm dump -n ${shellQuote(bundleId)}`);
  const start = stdout.indexOf("{");
  if (start === -1) {
    // `bm dump` prints a prose line for an unknown bundle rather than JSON.
    throw new FailureError(
      `HarmonyOS device '${connectKey}' has no app with bundle name '${bundleId}'. ` +
        `List what is installed with \`bm dump -a\`.`,
      {
        error_code: FAILURE_CODES.HARMONY_ABILITY_START_FAILED,
        failure_stage: "harmony_resolve_bundle",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
  let parsed: {
    mainEntry?: unknown;
    hapModuleInfos?: Array<{
      name?: unknown;
      mainAbility?: unknown;
      abilityInfos?: Array<{ name?: unknown }>;
    }>;
  };
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch (err) {
    throw new FailureError(
      `Could not read the bundle description of '${bundleId}' from HarmonyOS device '${connectKey}'.`,
      {
        error_code: FAILURE_CODES.HARMONY_ABILITY_START_FAILED,
        failure_stage: "harmony_resolve_bundle",
        failure_area: "tool_server",
        error_kind: "subprocess",
      },
      { cause: err as Error }
    );
  }
  const modules = Array.isArray(parsed.hapModuleInfos) ? parsed.hapModuleInfos : [];
  const mainEntry = typeof parsed.mainEntry === "string" ? parsed.mainEntry : null;
  // `mainEntry` names the module that owns the launcher entry; fall back to the
  // first module that declares a mainAbility for bundles that omit it.
  const chosen =
    modules.find((m) => m.name === mainEntry && typeof m.mainAbility === "string") ??
    modules.find((m) => typeof m.mainAbility === "string");
  if (!chosen || typeof chosen.mainAbility !== "string" || typeof chosen.name !== "string") {
    throw new FailureError(
      `App '${bundleId}' on HarmonyOS device '${connectKey}' declares no launchable main ability, ` +
        `so there is nothing to start. It may be a service or extension rather than an app.`,
      {
        error_code: FAILURE_CODES.HARMONY_ABILITY_START_FAILED,
        failure_stage: "harmony_resolve_bundle",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
  return {
    mainAbility: startableAbilityName(chosen.abilityInfos, chosen.mainAbility),
    module: chosen.name,
  };
}

/**
 * The spelling of the main ability that `aa start -a` accepts — see the note on
 * `resolveHarmonyEntry`.
 *
 * Falls back to `mainAbility` itself when no declared ability matches: two of
 * the three bundles measured spell them identically, so it is the right guess,
 * and `aa`'s own `10104001` names the problem precisely if it turns out wrong.
 */
function startableAbilityName(
  abilityInfos: Array<{ name?: unknown }> | undefined,
  mainAbility: string
): string {
  const names = (Array.isArray(abilityInfos) ? abilityInfos : [])
    .map((a) => a?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  if (names.includes(mainAbility)) return mainAbility;
  return names.find((n) => mainAbility.endsWith(`.${n}`)) ?? mainAbility;
}

/** Bring an app to the foreground, resolving its entry ability first. */
export async function launchHarmonyApp(connectKey: string, bundleId: string): Promise<void> {
  const entry = await resolveHarmonyEntry(connectKey, bundleId);
  const { stdout } = await runHdcShell(
    connectKey,
    `aa start -b ${shellQuote(bundleId)} -a ${shellQuote(entry.mainAbility)} -m ${shellQuote(entry.module)}`
  );
  assertAbilityStarted(stdout, connectKey, bundleId);
}

/**
 * Stop every process of an app.
 *
 * `aa force-stop` takes the bundle name and, unlike `aa start`, needs no ability
 * — there is nothing to resolve.
 */
export async function terminateHarmonyApp(connectKey: string, bundleId: string): Promise<void> {
  const { stdout } = await runHdcShell(connectKey, `aa force-stop ${shellQuote(bundleId)}`);
  if (stdout.includes("error:")) {
    throw new FailureError(
      `Failed to stop '${bundleId}' on HarmonyOS device '${connectKey}': ${firstLine(stdout)}`,
      {
        error_code: FAILURE_CODES.HARMONY_ABILITY_START_FAILED,
        failure_stage: "harmony_force_stop",
        failure_area: "tool_server",
        error_kind: "subprocess",
      }
    );
  }
}

/**
 * Open a URI through whichever app claims it.
 *
 * This *is* an implicit start — the one case where it is the right verb, since
 * the point is to let the system choose the handler. It carries the failure mode
 * documented on `resolveHarmonyEntry`: with no handler installed, HarmonyOS
 * shows a chooser on the device. The caller is told so rather than left to
 * discover a dialog sitting on the screen.
 */
export async function openHarmonyUrl(connectKey: string, url: string): Promise<void> {
  const { stdout } = await runHdcShell(connectKey, `aa start -U ${shellQuote(url)}`);
  if (!stdout.includes(AA_SUCCESS)) {
    throw new FailureError(
      `HarmonyOS device '${connectKey}' could not open '${url}': ${firstLine(stdout)}. ` +
        `No installed app claims this URI scheme; the device may now be showing a chooser dialog.`,
      {
        error_code: FAILURE_CODES.HARMONY_ABILITY_START_FAILED,
        failure_stage: "harmony_open_url",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
}

function assertAbilityStarted(stdout: string, connectKey: string, bundleId: string): void {
  if (stdout.includes(AA_SUCCESS)) return;
  throw new FailureError(
    `Failed to launch '${bundleId}' on HarmonyOS device '${connectKey}': ${firstLine(stdout)}`,
    {
      error_code: FAILURE_CODES.HARMONY_ABILITY_START_FAILED,
      failure_stage: "harmony_ability_start",
      failure_area: "tool_server",
      error_kind: "subprocess",
    }
  );
}

/**
 * The part of an `aa` failure worth surfacing.
 *
 * `aa` prints a useless headline (`error: failed to start ability.`) and puts
 * the actual cause on the next line (`Error Code:10104001  Error Message:The
 * specified ability does not exist`), then several lines of generic advice. So
 * the coded line is kept alongside the headline — reporting only the first line
 * tells the agent that something failed and nothing about what.
 */
function firstLine(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "the ability assistant printed nothing";
  const coded = lines.find((l) => l.startsWith("Error Code:"));
  return coded ? `${lines[0]} ${coded}` : lines[0];
}
