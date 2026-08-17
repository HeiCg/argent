import { FAILURE_CODES } from "@argent/registry";
import { InvalidToolInputError } from "./capability";
import {
  describeSecretSources,
  lookupSecret,
  secretNames,
  secretPlacementAdvice,
  secretSources,
  SECRET_ENV_PREFIX,
  type SecretSource,
  type SecretSourceOptions,
} from "@argent/configuration-core";

/**
 * Server-side secret placeholders for text-entry tools.
 *
 * An agent-composed tool call cannot carry a plaintext credential without the
 * credential entering the model's context, the MCP call log, the event log,
 * and any recorded flow YAML. `{{secret:NAME}}` lets the agent reference a
 * secret by name instead: the placeholder travels through every logging
 * boundary verbatim and is substituted with the secret's value only here,
 * inside the typing tool's `execute` — the last hop before the keystrokes leave
 * for the device.
 *
 * Where a name's value comes from — the `ARGENT_SECRET_<NAME>` environment
 * variable, or a dotenv file in the project or under the user's `~/.argent` —
 * is owned by {@link secretSources}, which documents why each source exposes
 * what it does. What matters here is the property they share: only values the
 * user deliberately exposed to argent are resolvable, so a prompt-injected
 * agent cannot exfiltrate arbitrary host secrets through the mechanism.
 */

export { SECRET_ENV_PREFIX };
export type { SecretSourceOptions };

/**
 * Cheap containment probe — shared with the MCP layer's auto-screenshot skip,
 * which must not render a just-typed secret back into model context as pixels.
 */
export const SECRET_PLACEHOLDER_MARKER = "{{secret:";

const PLACEHOLDER_RE = /\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** Names (never values) of all secrets currently exposed to argent. */
export function availableSecretNames(options: SecretSourceOptions = {}): string[] {
  return secretNames(secretSources(options));
}

export interface ResolvedSecretText {
  /** The input with every placeholder replaced by its secret value. */
  text: string;
  /** The placeholders that were substituted; empty when the input had none. */
  secrets: Array<{ name: string; value: string }>;
}

/**
 * A placeholder name that (redundantly) repeats the env prefix in any casing —
 * `{{secret:ARGENT_SECRET_APP_PASSWORD}}` instead of the canonical
 * `{{secret:APP_PASSWORD}}`. Agents naturally paste the full variable name, so
 * this spelling is accepted as a fallback: the exact name is tried first, and
 * only when no source defines it is the prefix stripped and the lookup retried.
 * Exact-first keeps a literal `ARGENT_SECRET_ARGENT_SECRET_X` var reachable.
 */
const REDUNDANT_PREFIX_RE = /^argent_secret_/i;

/**
 * Replace every `{{secret:NAME}}` in `text` with its value, resolved through
 * the source chain. Unknown names reject with a message that lists the *names*
 * of available secrets and the sources consulted — never a value — so an agent
 * can self-correct without anything sensitive entering its context.
 *
 * The chain is built once per call and only when the text actually references a
 * secret: a typing call with no placeholder — the overwhelming majority — never
 * touches the filesystem, and one that types several placeholders reads each
 * file once and resolves them all against the same snapshot.
 */
export function resolveSecretPlaceholders(
  text: string,
  options: SecretSourceOptions = {}
): ResolvedSecretText {
  const secrets: Array<{ name: string; value: string }> = [];
  let sources: SecretSource[] | undefined;
  const resolved = text.replace(PLACEHOLDER_RE, (_placeholder, rawName: string) => {
    sources ??= secretSources(options);
    let name = rawName;
    let value = lookupSecret(name, sources);
    if (value === undefined && REDUNDANT_PREFIX_RE.test(name)) {
      name = name.replace(REDUNDANT_PREFIX_RE, "");
      value = lookupSecret(name, sources);
    }
    if (value === undefined) {
      const names = secretNames(sources);
      throw new InvalidToolInputError(
        `Unknown secret "${rawName}" — no source on the machine running the tool-server defines ` +
          `${name}. Available secrets: ${names.length ? names.join(", ") : "(none)"}.\n` +
          `Sources consulted, first match wins:\n${describeSecretSources(sources)}\n` +
          secretPlacementAdvice(name, options),
        {
          error_code: FAILURE_CODES.SECRET_PLACEHOLDER_UNKNOWN,
          failure_stage: "secret_placeholder_resolution",
          error_kind: "validation",
        }
      );
    }
    if (!secrets.some((s) => s.name === name)) secrets.push({ name, value });
    return value;
  });
  return { text: resolved, secrets };
}

/**
 * How a secret is spelled by the time it can reach an error message.
 *
 * The value itself, plus its POSIX single-quote escaping. The backends that
 * echo their input echo a SHELL LINE (`adb shell input text 'x'`,
 * `hdc shell uitest uiInput text 'x'`), and `shellQuote` rewrites each `'` as
 * `'\''` — so a secret holding an apostrophe is no longer a contiguous
 * substring of the message and a literal search walks straight past it.
 */
function secretSpellings(value: string): string[] {
  const shellEscaped = value.replaceAll("'", `'\\''`);
  return shellEscaped === value ? [value] : [shellEscaped, value];
}

/**
 * The shortest run of a secret worth blanking a word out of a diagnostic for.
 *
 * Runs this short collide with ordinary message vocabulary (`adb`, `text`,
 * `device`), and three characters of a credential is not a disclosure worth
 * garbling the error the agent has to act on.
 */
const MIN_LEAKED_RUN = 4;

/**
 * Replace every PARTIAL run of `spelling` left in `message`, longest first.
 *
 * A whole-value search is not enough, because a backend need not send the
 * secret in one piece: `injectAndroidText` starts a new `adb shell input text`
 * at every `%` so the device never sees a format specifier, and the Android TV
 * remote types a word at a time between space keyevents. Each of those calls
 * carries a FRAGMENT of the secret, and the one that fails is the one quoted
 * back in `formatSubprocessFailure`'s argv — matching neither spelling of the
 * whole. Working down from the longest run keeps a short run inside a longer
 * one from being replaced on its own, which would leave the rest of the longer
 * run sitting beside the marker.
 */
function scrubRuns(message: string, spelling: string, marker: string): string {
  let out = message;
  for (let length = spelling.length - 1; length >= MIN_LEAKED_RUN; length--) {
    for (let start = 0; start + length <= spelling.length; start++) {
      const run = spelling.slice(start, start + length);
      if (out.includes(run)) out = out.split(run).join(marker);
    }
  }
  return out;
}

/**
 * Scrub resolved secret values from an error before it propagates — a backend
 * failure can echo its input (e.g. Android typing surfaces the device-side
 * `input text` command line). Mutates message/stack in place so the error's
 * class, and with it the HTTP status and telemetry mapping, is preserved.
 * Zero-length values are skipped: replacing an empty string would corrupt the
 * message rather than redact anything.
 */
export function redactSecretsFromError(
  err: unknown,
  secrets: Array<{ name: string; value: string }>
): unknown {
  const live = secrets.filter(({ value }) => value);
  const marker = (name: string) => `${SECRET_PLACEHOLDER_MARKER}${name}}}`;
  const eachSpelling = (
    message: string,
    replace: (msg: string, spelling: string, marker: string) => string
  ) =>
    live.reduce(
      (acc, { name, value }) =>
        secretSpellings(value).reduce((msg, spelling) => replace(msg, spelling, marker(name)), acc),
      message
    );
  // Whole spellings before partial runs, across every secret: a run of one
  // spelling can sit inside another that arrived intact — `'t-tell` inside
  // `don't-tell` — and taking the run first would leave the rest of that intact
  // secret standing beside the marker.
  const scrub = (s: string) =>
    eachSpelling(
      eachSpelling(s, (msg, spelling, m) => msg.split(spelling).join(m)),
      scrubRuns
    );
  if (err instanceof Error) {
    err.message = scrub(err.message);
    if (err.stack) err.stack = scrub(err.stack);
    return err;
  }
  if (typeof err === "string") return scrub(err);
  return err;
}
