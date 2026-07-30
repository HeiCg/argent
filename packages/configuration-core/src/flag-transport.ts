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

// Canonical base64: the standard alphabet, padded to a multiple of 4.
//
// Buffer.from(…, "base64") is far laxer — it stops at the padding and ignores
// anything after it, so `<valid>GARBAGE` and the comma-joined string Node
// produces for a duplicated header both decode to the FIRST value and sail
// through as if they were clean. Shape-check first so those reach the caller as
// a rejection rather than as a silently truncated flag set.
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

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
  if (raw.length % 4 !== 0 || !CANONICAL_BASE64.test(raw)) {
    throw new ForwardedFlagsError("value is not canonical base64");
  }
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
  // Null prototype so Object.hasOwn lookups stay exact for prototype-named
  // flags ("toString", "constructor", …).
  const flags = Object.create(null) as Record<string, boolean>;
  for (const [name, value] of Object.entries(parsed)) {
    // `__proto__` is dropped to hold the disk/wire parity above: on a plain
    // object the flags.json reader's `out[k] = v` hits the prototype setter and
    // stores nothing, so a flag by that name resolves false when read locally.
    // A null-prototype object has no such setter and would store it, making the
    // same flags.json mean two different things either side of the wire.
    if (name === "__proto__") continue;
    if (typeof value === "boolean") flags[name] = value;
  }
  return flags;
}
