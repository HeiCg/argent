import { describe, it, expect } from "vitest";
import { toMcpTool } from "../src/tool-mapping.js";

describe("toMcpTool — MCP _meta forwarding", () => {
  const base = {
    name: "example",
    description: "desc",
    inputSchema: { properties: { foo: { type: "string" } } },
  };

  it("forwards alwaysLoad as _meta['anthropic/alwaysLoad']", () => {
    const result = toMcpTool({ ...base, alwaysLoad: true });
    expect(result._meta).toEqual({ "anthropic/alwaysLoad": true });
  });

  it("forwards searchHint as _meta['anthropic/searchHint']", () => {
    const result = toMcpTool({ ...base, searchHint: "tap press touch" });
    expect(result._meta).toEqual({ "anthropic/searchHint": "tap press touch" });
  });

  it("forwards both when set", () => {
    const result = toMcpTool({
      ...base,
      alwaysLoad: true,
      searchHint: "discovery",
    });
    expect(result._meta).toEqual({
      "anthropic/alwaysLoad": true,
      "anthropic/searchHint": "discovery",
    });
  });

  it("omits _meta entirely when neither field is set", () => {
    const result = toMcpTool(base);
    expect(result).not.toHaveProperty("_meta");
  });

  it("omits _meta when alwaysLoad is false and searchHint is undefined", () => {
    const result = toMcpTool({ ...base, alwaysLoad: false });
    expect(result).not.toHaveProperty("_meta");
  });

  it("drops empty-string searchHint rather than forwarding it", () => {
    const result = toMcpTool({ ...base, searchHint: "" });
    expect(result).not.toHaveProperty("_meta");
  });

  it("always forces inputSchema.type to 'object' and preserves other keys", () => {
    const result = toMcpTool(base);
    expect(result.inputSchema).toEqual({
      type: "object",
      properties: { foo: { type: "string" } },
    });
  });
});

// Breaks if: toMcpTool stops relaxing the device key of the exposed schema.
describe("toMcpTool — device keys optional in the exposed schema", () => {
  const tap = {
    name: "gesture-tap",
    description: "Tap",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Target device id from `list-devices`." },
        x: { type: "number" },
      },
      required: ["udid", "x"],
    },
  };

  it.each([
    ["udid", "gesture-tap"],
    ["device_id", "view-network-logs"],
  ])("removes %s from required and adds the session-device hint", (key, name) => {
    const result = toMcpTool({
      name,
      description: "d",
      inputSchema: {
        properties: { [key]: { type: "string", description: "Device id." }, x: { type: "number" } },
        required: [key, "x"],
      },
    });
    expect(result.inputSchema.required).toEqual(["x"]);
    const prop = (result.inputSchema.properties as Record<string, { description: string }>)[key]!;
    expect(prop.description).toContain("Device id.");
    expect(prop.description).toContain("defaults to the session device set by use-device");
  });

  // Breaks if: the hint is put on an optional key that the MCP layer never fills.
  it("leaves an optional flow `device` untouched: it is never filled", () => {
    const flow = {
      name: "flow-execute",
      description: "d",
      inputSchema: { properties: { device: { type: "string", description: "Device id." } } },
    };
    expect(toMcpTool(flow).inputSchema).toEqual({ type: "object", ...flow.inputSchema });
  });

  it("does not mutate the tool-server schema it maps", () => {
    const before = JSON.parse(JSON.stringify(tap));
    toMcpTool(tap);
    expect(tap).toEqual(before);
  });

  it("leaves boot-device untouched: its udid selects what to boot", () => {
    const boot = {
      name: "boot-device",
      description: "Boot",
      inputSchema: { properties: { udid: { type: "string", description: "UDID." } } },
    };
    expect(toMcpTool(boot).inputSchema).toEqual({ type: "object", ...boot.inputSchema });
  });
});
