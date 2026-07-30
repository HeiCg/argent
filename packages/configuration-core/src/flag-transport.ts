// Wire format for forwarding a client's feature flags to a remote tool-server.
//
// `@argent/tools-client` encodes and `@argent/tool-server` decodes, so the
// format is defined once here rather than twice on either side of the HTTP
// boundary. The payload is base64 of a UTF-8 JSON `{ "<flag>": <boolean> }`
// object: header values are limited to ISO-8859-1, and nothing constrains a
// hand-edited flags.json to that range.

/** Request header carrying the caller's effective flags. */
export const FLAG_FORWARD_HEADER = "X-Argent-Flags";

/**
 * Response header the tool-server sets when it applied a forwarded set. Absent
 * from a server that predates flag forwarding, which lets `argent link` tell
 * the user their flags will be ignored instead of leaving them to discover it
 * through a tool that silently isn't there.
 */
export const FLAG_FORWARD_ACK_HEADER = "X-Argent-Flags-Applied";

/** Thrown when a {@link FLAG_FORWARD_HEADER} value is not a decodable flag set. */
export class ForwardedFlagsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForwardedFlagsError";
  }
}

export function encodeForwardedFlags(flags: Record<string, boolean>): string {
  return Buffer.from(JSON.stringify(flags), "utf8").toString("base64");
}

/**
 * Decode a {@link FLAG_FORWARD_HEADER} value.
 *
 * Non-boolean entries are dropped rather than rejected, mirroring how the
 * flags.json reader treats them — a stored `{"x": "yes"}` must resolve the same
 * way whether the server reads it locally or receives it over the wire. A
 * payload that is not a JSON object at all is a protocol violation, not a stray
 * key, and throws {@link ForwardedFlagsError}.
 */
export function decodeForwardedFlags(raw: string): Record<string, boolean> {
  // Buffer.from(…, "base64") never throws — it skips characters outside the
  // alphabet — so JSON.parse is what actually rejects a corrupt value.
  const json = Buffer.from(raw, "base64").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ForwardedFlagsError("value is not base64-encoded JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ForwardedFlagsError("decoded value is not a JSON object of flag booleans");
  }
  // Null prototype: a forwarded `__proto__` key is then an ordinary own entry
  // instead of a prototype write, and Object.hasOwn lookups stay exact.
  const flags = Object.create(null) as Record<string, boolean>;
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "boolean") flags[name] = value;
  }
  return flags;
}
