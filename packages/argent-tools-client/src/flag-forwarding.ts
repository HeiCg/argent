import {
  FLAG_FORWARD_HEADER,
  encodeForwardedFlags,
  readEffectiveFlags,
} from "@argent/configuration-core";

/**
 * Header carrying this machine's effective feature flags to the tool-server.
 *
 * Send it only when requests are routed to an external server (`argent link`
 * or ARGENT_TOOLS_URL). That server resolves flags against its own
 * ~/.argent/flags.json and its own working directory — the operator's
 * preferences and the operator's project, neither of which is the caller's —
 * so its answers to `argent enable` are the wrong ones. An auto-spawned local
 * server already reads the very files this would forward, so it is left to
 * read them and its resolution is unchanged.
 *
 * Re-read per request, like the server's own flag lookup, so `argent enable` /
 * `argent disable` reaches a linked server without re-linking or a restart.
 */
export function flagForwardHeaders(): Record<string, string> {
  return { [FLAG_FORWARD_HEADER]: encodeForwardedFlags(readEffectiveFlags()) };
}
