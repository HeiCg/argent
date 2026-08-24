/**
 * Wire-level building blocks for talking to usbmuxd, Apple's USB multiplexing
 * daemon. usbmuxd frames every message as a 16-byte little-endian header
 * (total length including the header, protocol version, message type, tag)
 * followed by an XML property list. The plist build/parse here is hand-rolled
 * because this module must stay dependency-free: it runs inside the device
 * transport hot path and pulling in an XML library for the handful of shapes
 * usbmuxd actually produces (Result dicts and DeviceList arrays) would be all
 * cost and no benefit.
 *
 * Kept separate from the socket logic in `usbmux.ts` so the pure encode/decode
 * pieces can be unit-tested without opening sockets.
 */

export const USBMUX_HEADER_BYTES = 16;
export const USBMUX_PROTOCOL_VERSION = 1;
/** The only message type this client speaks: XML plist payloads. */
export const USBMUX_MESSAGE_TYPE_PLIST = 8;
/**
 * usbmuxd responses are small (a Result dict or a device list); anything
 * claiming to be larger than 4 MiB is a corrupt or hostile stream, and
 * trusting the length prefix would let it drive an unbounded allocation.
 */
export const USBMUX_MAX_PACKET_BYTES = 4 * 1024 * 1024;

/**
 * Labels the transport failure mode. "device-unattached" (no device on the
 * cable) and "runner-not-listening" (device fine, only the runner port is
 * closed) are produced exclusively pre-send, while opening the usbmux
 * connection; the remaining kinds can also arrive after HTTP bytes were
 * written.
 */
export type IosDeviceTransportErrorKind =
  | "device-unattached"
  | "runner-not-listening"
  | "protocol"
  | "timeout"
  | "http";

/**
 * Typed transport failure shared by the whole ios-device stack. A plain Error
 * subclass on purpose: this module is imported by dependency-free transport
 * code, so it cannot reach for the richer error types in `@argent/registry`.
 *
 * `kind` labels the failure for messages, hints, and tests, and has two
 * structural consumers: runner-client.ts skips lost-response recovery for the
 * pre-send kinds ("device-unattached", "runner-not-listening" — nothing was
 * sent, so nothing can have run), and ios-device-runner.ts's runner-death
 * diagnosis excludes "device-unattached" (the connect-the-cable story wins
 * even when the runner also died). `retryable` is the retry-policy verdict,
 * consumed by runner-route.ts's read-only retry loop. `hint` carries the
 * human recovery step.
 */
export class IosDeviceTransportError extends Error {
  readonly kind: IosDeviceTransportErrorKind;
  readonly retryable: boolean;
  readonly hint?: string;

  constructor(
    kind: IosDeviceTransportErrorKind,
    message: string,
    options: { retryable: boolean; hint?: string; cause?: unknown } = { retryable: false }
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "IosDeviceTransportError";
    this.kind = kind;
    this.retryable = options.retryable;
    if (options.hint !== undefined) this.hint = options.hint;
  }
}

export function isIosDeviceTransportError(error: unknown): error is IosDeviceTransportError {
  return error instanceof IosDeviceTransportError;
}

export interface UsbmuxPacket {
  version: number;
  messageType: number;
  tag: number;
  payload: Buffer;
  /** Total bytes this packet occupied, so stream readers can slice leftovers. */
  bytesConsumed: number;
}

/** Frame an XML plist payload with the 16-byte little-endian usbmuxd header. */
export function encodeUsbmuxPacket(tag: number, payloadXml: string): Buffer {
  const payload = Buffer.from(payloadXml, "utf8");
  const packet = Buffer.alloc(USBMUX_HEADER_BYTES + payload.length);
  packet.writeUInt32LE(packet.length, 0);
  packet.writeUInt32LE(USBMUX_PROTOCOL_VERSION, 4);
  packet.writeUInt32LE(USBMUX_MESSAGE_TYPE_PLIST, 8);
  packet.writeUInt32LE(tag, 12);
  payload.copy(packet, USBMUX_HEADER_BYTES);
  return packet;
}

/**
 * Decode one packet from an accumulating stream buffer. Returns `null` while
 * the buffer does not yet hold a complete packet (the caller keeps reading),
 * and throws a typed protocol error the moment the length prefix is
 * implausible — a length below the header size or above the 4 MiB cap can
 * never become valid by reading more bytes.
 */
export function decodeUsbmuxPacket(buffer: Buffer): UsbmuxPacket | null {
  if (buffer.length < USBMUX_HEADER_BYTES) return null;
  const totalLength = buffer.readUInt32LE(0);
  if (totalLength < USBMUX_HEADER_BYTES || totalLength > USBMUX_MAX_PACKET_BYTES) {
    throw new IosDeviceTransportError(
      "protocol",
      `Invalid usbmuxd packet length ${totalLength} (must be between ${USBMUX_HEADER_BYTES} and ${USBMUX_MAX_PACKET_BYTES} bytes)`,
      { retryable: false }
    );
  }
  if (buffer.length < totalLength) return null;
  return {
    version: buffer.readUInt32LE(4),
    messageType: buffer.readUInt32LE(8),
    tag: buffer.readUInt32LE(12),
    payload: buffer.subarray(USBMUX_HEADER_BYTES, totalLength),
    bytesConsumed: totalLength,
  };
}

/**
 * usbmuxd's `Connect` message wants the device port in network byte order
 * inside a host-order plist integer (a quirk inherited from the original
 * libusbmuxd C API, which passed the value straight into htons()).
 */
export function hostToNetworkPort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 0xffff) {
    throw new IosDeviceTransportError("protocol", `Invalid TCP port ${port}`, {
      retryable: false,
    });
  }
  return ((port & 0xff) << 8) | ((port >>> 8) & 0xff);
}

/** Escape a value for use as XML text content or an attribute value. */
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the XML plist request body usbmuxd expects. The BundleID/ProgName
 * fields identify this client in usbmuxd's logs; kLibUSBMuxVersion 3 opts in
 * to the plist protocol (the daemon still supports an older binary one).
 */
export function buildUsbmuxPlistMessage(
  messageType: string,
  fields: Record<string, string | number> = {}
): string {
  const entries: Array<[string, string | number]> = [
    ["BundleID", "com.argent.tool-server"],
    ["ClientVersionString", "argent"],
    ["MessageType", messageType],
    ["ProgName", "argent"],
    ["kLibUSBMuxVersion", 3],
    ...Object.entries(fields),
  ];
  const body = entries
    .map(([key, value]) =>
      typeof value === "number"
        ? `<key>${escapeXmlText(key)}</key><integer>${value}</integer>`
        : `<key>${escapeXmlText(key)}</key><string>${escapeXmlText(value)}</string>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${body}</dict></plist>`;
}

export type PlistValue = string | number | boolean | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

/**
 * Parse an XML plist document into plain JS values. Covers exactly the node
 * types usbmuxd emits (dict/array/string/integer/real/true/false, with
 * data/date kept as their raw text); anything unbalanced or unrecognized is a
 * protocol error rather than a silent partial parse, because a wrong read here
 * would misroute a device connection.
 */
export function parsePlist(xml: string): PlistValue {
  const elements = parseXmlElements(xml);
  const plist = elements.find((element) => element.name === "plist");
  const root = plist ? plist.children[0] : elements[0];
  if (!root) {
    throw new IosDeviceTransportError("protocol", "Empty plist document from usbmuxd", {
      retryable: false,
    });
  }
  return convertPlistElement(root);
}

/**
 * Read the `Number` result code out of a usbmuxd `Result` message. Returns
 * undefined when the payload is not the expected shape so callers can surface
 * a generic failure with the raw payload attached.
 */
export function readUsbmuxResultCode(xml: string): number | undefined {
  const root = parsePlistOrUndefined(xml);
  if (!isPlistDict(root)) return undefined;
  const value = root["Number"];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Resolve a mux DeviceID from a `ListDevices` response by EXACT serial-number
 * match. Exactness matters: hardware UDIDs share long prefixes across devices
 * of the same model generation, and a substring or prefix match could tap a
 * command into the wrong phone.
 */
export function readUsbmuxDeviceIdForSerial(xml: string, serial: string): number | undefined {
  const root = parsePlistOrUndefined(xml);
  if (!isPlistDict(root)) return undefined;
  const list = root["DeviceList"];
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    if (!isPlistDict(entry)) continue;
    const properties = entry["Properties"];
    if (!isPlistDict(properties)) continue;
    if (properties["SerialNumber"] !== serial) continue;
    const deviceId = entry["DeviceID"];
    if (typeof deviceId === "number" && Number.isSafeInteger(deviceId) && deviceId > 0) {
      return deviceId;
    }
  }
  return undefined;
}

function parsePlistOrUndefined(xml: string): PlistValue | undefined {
  try {
    return parsePlist(xml);
  } catch {
    return undefined;
  }
}

function isPlistDict(value: PlistValue | undefined): value is PlistDict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface XmlElement {
  name: string;
  text: string;
  children: XmlElement[];
}

/**
 * Minimal XML scanner: tags and text only, no comments/CDATA/processing
 * instructions beyond stripping the leading declaration and doctype — usbmuxd
 * never emits those, and rejecting surprises loudly beats guessing.
 */
function parseXmlElements(xml: string): XmlElement[] {
  const source = xml.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  const tokenPattern = /<(\/?)([A-Za-z][\w.-]*)((?:\s[^<>]*?)?)(\/?)>|([^<]+)/g;
  const root: XmlElement = { name: "#root", text: "", children: [] };
  const stack: XmlElement[] = [root];
  let consumed = 0;
  for (let match = tokenPattern.exec(source); match !== null; match = tokenPattern.exec(source)) {
    if (match.index !== consumed) break;
    consumed = tokenPattern.lastIndex;
    const [, closing, name, , selfClosing, textChunk] = match;
    const top = stack[stack.length - 1] as XmlElement;
    if (textChunk !== undefined) {
      top.text += decodeXmlEntities(textChunk);
      continue;
    }
    if (closing) {
      if (stack.length < 2 || top.name !== name) {
        throw invalidXmlError(`unexpected closing tag </${name}>`);
      }
      stack.pop();
      continue;
    }
    const element: XmlElement = { name: name as string, text: "", children: [] };
    top.children.push(element);
    if (!selfClosing) stack.push(element);
  }
  if (consumed !== source.length) throw invalidXmlError("malformed markup");
  if (stack.length !== 1) {
    throw invalidXmlError(`unclosed tag <${(stack[stack.length - 1] as XmlElement).name}>`);
  }
  return root.children;
}

function convertPlistElement(element: XmlElement): PlistValue {
  switch (element.name) {
    case "dict":
      return convertPlistDict(element);
    case "array":
      return element.children.map(convertPlistElement);
    case "string":
      return element.text;
    case "integer":
    case "real": {
      const parsed = Number(element.text.trim());
      if (!Number.isFinite(parsed)) {
        throw invalidXmlError(`non-numeric <${element.name}> value "${element.text}"`);
      }
      return parsed;
    }
    case "true":
      return true;
    case "false":
      return false;
    case "data":
    case "date":
      return element.text.trim();
    default:
      throw invalidXmlError(`unsupported plist node <${element.name}>`);
  }
}

function convertPlistDict(element: XmlElement): PlistDict {
  const dict: PlistDict = {};
  for (let index = 0; index < element.children.length - 1; index += 1) {
    const key = element.children[index] as XmlElement;
    if (key.name !== "key") continue;
    const value = element.children[index + 1] as XmlElement;
    if (value.name === "key") continue;
    dict[key.text] = convertPlistElement(value);
    index += 1;
  }
  return dict;
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };
    return named[body] ?? entity;
  });
}

function invalidXmlError(detail: string): IosDeviceTransportError {
  return new IosDeviceTransportError("protocol", `Invalid plist XML from usbmuxd: ${detail}`, {
    retryable: false,
  });
}
