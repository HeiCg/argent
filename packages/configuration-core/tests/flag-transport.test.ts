import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ForwardedFlagsError,
  decodeForwardedFlags,
  encodeForwardedFlags,
} from "../src/flag-transport.js";
import { readFlags } from "../src/flags.js";

// Builds a header value straight from JSON text, bypassing encodeForwardedFlags,
// so the decoder can be fed payloads a hostile or older client could send but
// the encoder would never produce.
function headerValue(json: string): string {
  return Buffer.from(json, "utf8").toString("base64");
}

describe("encodeForwardedFlags / decodeForwardedFlags round trip", () => {
  it("preserves both true and false entries", () => {
    const flags = { "argent-lens": true, "disable-auto-screenshot": false };
    const decoded = decodeForwardedFlags(encodeForwardedFlags(flags));
    expect(decoded).toEqual({ "argent-lens": true, "disable-auto-screenshot": false });
    expect(decoded["disable-auto-screenshot"]).toBe(false);
  });

  it("round-trips an empty set to an empty set", () => {
    const decoded = decodeForwardedFlags(encodeForwardedFlags({}));
    expect(decoded).toEqual({});
    expect(Object.keys(decoded)).toEqual([]);
  });

  it("encodes non-ASCII flag names as header-safe ASCII and restores them exactly", () => {
    // Header values are ISO-8859-1; nothing stops a hand-edited flags.json from
    // holding a name outside that range, which is why the payload is base64.
    const flags = { "功能开关": true, "zażółć-gęślą": false, "flag-🚩": true };
    const encoded = encodeForwardedFlags(flags);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(decodeForwardedFlags(encoded)).toEqual({
      "功能开关": true,
      "zażółć-gęślą": false,
      "flag-🚩": true,
    });
  });
});

describe("decodeForwardedFlags non-boolean entries", () => {
  it("drops a non-boolean entry instead of rejecting the payload", () => {
    const decoded = decodeForwardedFlags(headerValue('{"x":"yes","y":true}'));
    expect(decoded).toEqual({ y: true });
    expect(Object.hasOwn(decoded, "x")).toBe(false);
  });

  it("drops every non-boolean shape, matching the flags.json reader", () => {
    const decoded = decodeForwardedFlags(
      headerValue('{"real":true,"bogus":"yes","numeric":1,"nested":{},"list":[],"nulled":null}')
    );
    expect(decoded).toEqual({ real: true });
    expect(Object.keys(decoded)).toEqual(["real"]);
  });
});

describe("decodeForwardedFlags rejections", () => {
  const nonObjectPayloads: ReadonlyArray<readonly [string, string]> = [
    ["array", "[]"],
    ["string", '"argent-lens"'],
    ["number", "42"],
    ["null", "null"],
  ];

  for (const [label, json] of nonObjectPayloads) {
    it(`throws ForwardedFlagsError for a JSON ${label} payload`, () => {
      expect(() => decodeForwardedFlags(headerValue(json))).toThrow(ForwardedFlagsError);
      expect(() => decodeForwardedFlags(headerValue(json))).toThrow(
        /decoded value is not a JSON object of flag booleans/
      );
    });
  }

  // Two rejection stages, each with its own message: the shape check fires
  // before any decoding, JSON.parse after it. Both must reject — a value that
  // slipped past either would be applied as a flag set.
  const garbagePayloads: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["an empty value", "", /value is not base64-encoded JSON/],
    ["punctuation outside the base64 alphabet", "!!! not base64 !!!", /not canonical base64/],
    [
      "base64 of a non-JSON string",
      Buffer.from("hello", "utf8").toString("base64"),
      /value is not base64-encoded JSON/,
    ],
    // Buffer.from stops at the padding, so without a shape check these decode
    // to their valid prefix and are silently applied.
    ["trailing junk after the padding", `${encodeForwardedFlags({})}GARBAGE!!!`, /canonical/],
    [
      "the comma-joined value a duplicated header produces",
      `${encodeForwardedFlags({ a: true })}, ${encodeForwardedFlags({ b: true })}`,
      /canonical/,
    ],
    ["a length that is not a multiple of four", "eyJhIjp0cnVlfQ", /canonical/],
  ];

  for (const [label, raw, message] of garbagePayloads) {
    it(`throws ForwardedFlagsError for ${label}`, () => {
      expect(() => decodeForwardedFlags(raw)).toThrow(ForwardedFlagsError);
      expect(() => decodeForwardedFlags(raw)).toThrow(message);
    });
  }

  it("the thrown error carries the ForwardedFlagsError name", () => {
    try {
      decodeForwardedFlags(headerValue("[]"));
      expect.unreachable("decodeForwardedFlags should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ForwardedFlagsError);
      expect((error as Error).name).toBe("ForwardedFlagsError");
    }
  });
});

describe("decodeForwardedFlags prototype safety", () => {
  it("drops a forwarded __proto__ boolean, matching what the flags.json reader stores", () => {
    // Parity with disk is the point: the reader assigns onto a plain object, so
    // a flags.json `"__proto__": true` hits the prototype setter and stores
    // nothing. Keeping it here would make the same flags.json mean one thing
    // read locally and another read over the wire.
    const decoded = decodeForwardedFlags(headerValue('{"__proto__":true,"real":true}'));
    expect(Object.getPrototypeOf(decoded)).toBeNull();
    expect(Object.hasOwn(decoded, "__proto__")).toBe(false);
    expect(decoded).toEqual({ real: true });
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("agrees with readFlags on a __proto__ entry", () => {
    // The parity claim, asserted against the real disk reader rather than
    // restated: both sides resolve the flag to absent.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-proto-parity-"));
    try {
      fs.mkdirSync(path.join(home, ".argent"));
      fs.writeFileSync(
        path.join(home, ".argent", "flags.json"),
        '{"flags":{"__proto__":true,"real":true}}'
      );
      const fromDisk = readFlags("global", { homeDir: home, cwd: home });
      const fromWire = decodeForwardedFlags(headerValue('{"__proto__":true,"real":true}'));
      expect(Object.hasOwn(fromDisk, "__proto__")).toBe(Object.hasOwn(fromWire, "__proto__"));
      expect({ ...fromDisk }).toEqual({ ...fromWire });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("drops a non-boolean __proto__ payload and leaves Object.prototype clean", () => {
    const decoded = decodeForwardedFlags(
      headerValue('{"__proto__":{"polluted":true},"real":true}')
    );
    expect(decoded).toEqual({ real: true });
    expect(Object.hasOwn(decoded, "__proto__")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(Object.hasOwn({}, "polluted")).toBe(false);
  });

  it("Object.hasOwn on the result is exact for prototype-named keys", () => {
    const decoded = decodeForwardedFlags(headerValue('{"real":true}'));
    for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      expect(Object.hasOwn(decoded, name)).toBe(false);
    }
    const withProtoName = decodeForwardedFlags(headerValue('{"toString":true}'));
    expect(Object.hasOwn(withProtoName, "toString")).toBe(true);
    expect(withProtoName["toString"]).toBe(true);
  });
});
