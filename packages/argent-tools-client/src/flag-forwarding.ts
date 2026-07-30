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
 * server reads the very files this would forward, so it is left to read them.
 *
 * Re-read per request, like the server's own flag lookup, so `argent enable` /
 * `argent disable` reaches a linked server's tool gating without re-linking or
 * a restart. (`disable-auto-screenshot` is resolved once at MCP startup and is
 * the exception — see auto-screenshot.ts.)
 */
export function flagForwardHeaders(): Record<string, string> {
  return { [FLAG_FORWARD_HEADER]: encodeForwardedFlags(readEffectiveFlags()) };
}
