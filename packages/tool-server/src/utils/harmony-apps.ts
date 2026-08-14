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
 * bundle to bundle. Measured on HarmonyOS 6.0.1 and a 6.1.1 emulator:
 *
 *   bundle       mainAbility                                 abilityInfos name
 *   calculator   com.huawei.hmos.calculator.CalculatorAbility CalculatorAbility
 *   settings     com.huawei.hmos.settings.MainAbility         (identical)
 *   notepad      MainAbility                                  (identical)
 *   photos       MainAbility                                  com.huawei.hmos.photos.MainAbility
 *
 * Passing `mainAbility` verbatim launches Settings and fails on Calculator with
 * `10104001 The specified ability does not exist`; passing the bare final
 * segment does the reverse. Photos spells them the other way around — a short
 * `mainAbility` against a fully-qualified entry — so the match has to run in
 * BOTH directions, not just the Calculator one. `mainAbility` is used to
 * *identify* the entry and the entry's own `name` is what gets passed.
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
  // `bm` serialises the `mainAbility` key on EVERY bundle, so an empty string —
  // not an absent key — is how a bundle with no launcher entry reports itself
  // (14 of the 73 bundles installed on a 6.1.1 emulator, every service bundle
  // among them). Treat "" as missing on BOTH selection arms: accepting it sends
  // `aa start -a ''`, which `aa` reads as an implicit start, answers with
  // `10103101 Failed to find a matching application for implicit launch`, and
  // leaves a modal "No options to open with" dialog on the device — the exact
  // failure this module's lookup exists to prevent, with a worse message.
  const hasMain = (m: (typeof modules)[number]): boolean =>
    typeof m.mainAbility === "string" && m.mainAbility.length > 0;
  // `mainEntry` names the module that owns the launcher entry; fall back to the
  // first module that declares a mainAbility for bundles that omit it.
  const chosen = modules.find((m) => m.name === mainEntry && hasMain(m)) ?? modules.find(hasMain);
  if (!chosen || typeof chosen.name !== "string" || typeof chosen.mainAbility !== "string") {
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
 * `aa force-stop` says this when the package does not exist, which is
 * `resolveHarmonyEntry`'s unknown-bundle case reached through the other verb.
 * Both are the caller naming an app that is not installed, so both report
 * `not_found` — telling an agent to fix the bundle id rather than to retry a
 * subprocess that will fail identically forever.
 *
 * Carries `aa`'s own `Error Code:` prefix rather than the bare digits, for the
 * reason `emulatorFailure` matches verified markers: the bundle id is caller
 * input, and a bare number could be forged by one that contains it.
 */
const AA_NO_SUCH_PACKAGE = "Error Code:10104002";

/**
 * Stop every process of an app.
 *
 * `aa force-stop` takes the bundle name and, unlike `aa start`, needs no ability
 * — there is nothing to resolve. Stopping an app that is not running is not a
 * failure to it: measured on 6.0.1 against three never-launched bundles, it
 * answers `force stop process successfully.` So every `error:` it does print is
 * a real refusal and propagates — `restart-app` exists to guarantee a fresh
 * process, and reporting `restarted: true` for an app still running with its old
 * state is the one outcome it must not produce.
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
        error_kind: stdout.includes(AA_NO_SUCH_PACKAGE) ? "not_found" : "subprocess",
      }
    );
  }
}

/**
 * The spelling of the main ability that `aa start -a` accepts — see the note on
 * `resolveHarmonyEntry`.
 *
 * The match runs in BOTH directions on a dot boundary, because the two
 * spellings occur both ways on real bundles: Calculator's `mainAbility` is
 * fully qualified where its `abilityInfos` entry is short, and Photos' is the
 * reverse (short `mainAbility`, fully-qualified entry). Exact match first, then
 * either side being the other's final dot-segment. The boundary stops `Ability`
 * matching `MainAbility`.
 *
 * Falls back to `mainAbility` itself when no declared ability matches: the
 * common case spells them identically, so it is the right guess, and `aa`'s own
 * `10104001` names the problem precisely if it turns out wrong.
 */
function startableAbilityName(
  abilityInfos: Array<{ name?: unknown }> | undefined,
  mainAbility: string
): string {
  const names = (Array.isArray(abilityInfos) ? abilityInfos : [])
    .map((a) => a?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  if (names.includes(mainAbility)) return mainAbility;
  return (
    names.find((n) => mainAbility.endsWith(`.${n}`) || n.endsWith(`.${mainAbility}`)) ?? mainAbility
  );
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
