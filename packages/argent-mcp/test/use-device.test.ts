import { describe, it, expect, vi } from "vitest";
import type { ToolMeta } from "@argent/tools-client";
import {
  SessionDevice,
  NO_DEVICE_ERROR,
  USE_DEVICE_TOOL_NAME,
  deviceArgSpec,
  defaultDeviceLine,
} from "../src/session-device.js";
import { createCallToolHandler, type ToolCallOutcome } from "../src/mcp-server.js";
import { toMcpToolList } from "../src/tool-mapping.js";

// Schemas in the shape the tool-server advertises (zod → JSON Schema, io: "input").
const TAP: ToolMeta = {
  name: "gesture-tap",
  description: "Tap",
  inputSchema: {
    type: "object",
    properties: { udid: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
    required: ["udid", "x", "y"],
  },
};
const NETWORK: ToolMeta = {
  name: "view-network-logs",
  description: "Network",
  inputSchema: {
    type: "object",
    properties: { port: { type: "number" }, device_id: { type: "string" } },
    required: ["device_id"],
  },
};
const FLOW: ToolMeta = {
  name: "flow-execute",
  description: "Run a flow",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, device: { type: "string" } },
  },
};
const BOOT: ToolMeta = {
  name: "boot-device",
  description: "Boot",
  inputSchema: {
    type: "object",
    properties: { udid: { type: "string" }, avdName: { type: "string" } },
  },
};
// No tool-server tool declares a required `device` today; this fixture pins the key.
const REQ_DEVICE: ToolMeta = {
  name: "some-device-tool",
  description: "Hypothetical",
  inputSchema: {
    type: "object",
    properties: { device: { type: "string" } },
    required: ["device"],
  },
};
const STOP: ToolMeta = {
  name: "stop-simulator-server",
  description: "Stop",
  inputSchema: { type: "object", properties: { udid: { type: "string" } }, required: ["udid"] },
};
const STOP_ALL: ToolMeta = {
  name: "stop-all-simulator-servers",
  description: "Stop all",
  inputSchema: {
    type: "object",
    properties: { devices: { type: "array", items: { type: "string" } } },
    additionalProperties: false,
  },
};
const LIST: ToolMeta = {
  name: "list-devices",
  description: "List",
  inputSchema: { type: "object", properties: {} },
};
const TOOLS = [TAP, NETWORK, FLOW, BOOT, REQ_DEVICE, STOP, STOP_ALL, LIST];

function harness(results: Record<string, unknown> = {}) {
  const session = new SessionDevice();
  const callTool = vi.fn(
    async (name: string, _args: unknown, _tools?: ToolMeta[]): Promise<ToolCallOutcome> => ({
      result: results[name] ?? { ok: true },
    })
  );
  const handle = createCallToolHandler({
    session,
    fetchTools: async () => TOOLS,
    callTool,
    spyLog: async () => {},
    contentContext: () => ({ toolsUrl: "http://127.0.0.1:1", authToken: "" }),
    autoScreenshotOn: false,
    autoDescribeOn: false,
  });
  return { session, callTool, handle };
}

function textOf(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((b) => b.text ?? "").join("\n");
}

// ---------------------------------------------------------------------------
// SessionDevice state
// Breaks if: set/clear stop writing the per-process state.
// ---------------------------------------------------------------------------
describe("SessionDevice set/get/clear", () => {
  it("starts empty, holds the id after set, and is empty after clear", () => {
    const s = new SessionDevice();
    expect(s.get().defaultDeviceId).toBeUndefined();
    s.set("SIM-A");
    expect(s.get()).toEqual({ defaultDeviceId: "SIM-A", source: "use-device" });
    s.clear();
    expect(s.get().defaultDeviceId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deviceArgSpec — the device key comes from the tool's schema.
// Breaks if: the key is read from a fixed tool list instead of the schema.
// ---------------------------------------------------------------------------
describe("deviceArgSpec", () => {
  it("reads udid, device_id and device from the schema properties", () => {
    expect(deviceArgSpec(TAP.name, TAP.inputSchema)).toEqual({ key: "udid", required: true });
    expect(deviceArgSpec(NETWORK.name, NETWORK.inputSchema)).toEqual({
      key: "device_id",
      required: true,
    });
    expect(deviceArgSpec(FLOW.name, FLOW.inputSchema)).toEqual({ key: "device", required: false });
  });

  it("prefers the required key when a tool declares two (debugger-component-tree)", () => {
    const schema = {
      properties: { device_id: { type: "string" }, udid: { type: "string" } },
      required: ["device_id"],
    };
    expect(deviceArgSpec("debugger-component-tree", schema)).toEqual({
      key: "device_id",
      required: true,
    });
  });

  it("returns undefined for a tool without a device arg", () => {
    expect(deviceArgSpec(LIST.name, LIST.inputSchema)).toBeUndefined();
  });

  it("reports boot-device's udid as optional, read from the schema", () => {
    expect(deviceArgSpec(BOOT.name, BOOT.inputSchema)).toEqual({ key: "udid", required: false });
  });
});

// ---------------------------------------------------------------------------
// injectIfMissing
// Breaks if: injectIfMissing stops filling the schema's device key, or fills it
// over an explicit id.
// ---------------------------------------------------------------------------
describe("SessionDevice.injectIfMissing", () => {
  it("fills udid, device_id and device when absent", () => {
    const s = new SessionDevice();
    s.set("DEV-1");
    expect(s.injectIfMissing(TAP.name, { x: 0.5, y: 0.5 }, TAP.inputSchema)).toEqual({
      ok: true,
      args: { x: 0.5, y: 0.5, udid: "DEV-1" },
    });
    expect(s.injectIfMissing(NETWORK.name, { port: 8081 }, NETWORK.inputSchema)).toEqual({
      ok: true,
      args: { port: 8081, device_id: "DEV-1" },
    });
    expect(s.injectIfMissing(REQ_DEVICE.name, {}, REQ_DEVICE.inputSchema)).toEqual({
      ok: true,
      args: { device: "DEV-1" },
    });
  });

  // Breaks if: an optional device key is filled. flow-execute's optional `device`
  // switches the runner's no-device branches (Chromium self-boot, auto-detect,
  // `platform` filter); a filled default would turn them off.
  it("never fills an optional device key, even with a default (flow-execute)", () => {
    const s = new SessionDevice();
    s.set("DEV-1");
    expect(s.injectIfMissing(FLOW.name, { name: "login" }, FLOW.inputSchema)).toEqual({
      ok: true,
      args: { name: "login" },
    });
  });

  it("fills an undefined args object", () => {
    const s = new SessionDevice();
    s.set("DEV-1");
    expect(s.injectIfMissing(TAP.name, undefined, TAP.inputSchema)).toEqual({
      ok: true,
      args: { udid: "DEV-1" },
    });
  });

  it("does not overwrite an explicit id", () => {
    const s = new SessionDevice();
    s.set("DEV-1");
    expect(s.injectIfMissing(TAP.name, { udid: "OTHER", x: 0, y: 0 }, TAP.inputSchema)).toEqual({
      ok: true,
      args: { udid: "OTHER", x: 0, y: 0 },
    });
  });

  it("returns the one-line error when no default exists and the device arg is required", () => {
    const s = new SessionDevice();
    expect(s.injectIfMissing(TAP.name, { x: 0, y: 0 }, TAP.inputSchema)).toEqual({
      ok: false,
      error: NO_DEVICE_ERROR,
    });
  });

  it("passes the args through when no default exists and the device arg is optional", () => {
    const s = new SessionDevice();
    expect(s.injectIfMissing(FLOW.name, { name: "login" }, FLOW.inputSchema)).toEqual({
      ok: true,
      args: { name: "login" },
    });
  });

  it("never fills boot-device: its optional udid selects what to boot", () => {
    const s = new SessionDevice();
    s.set("DEV-1");
    expect(s.injectIfMissing(BOOT.name, { avdName: "Pixel" }, BOOT.inputSchema)).toEqual({
      ok: true,
      args: { avdName: "Pixel" },
    });
  });
});

// ---------------------------------------------------------------------------
// Learning
// Breaks if: learnFromResult stops reading the boot-device id field, or the
// source precedence (use-device > boot-device > last-call) changes.
// ---------------------------------------------------------------------------
describe("SessionDevice learning", () => {
  it("learns the id from a successful boot-device result on each platform", () => {
    const cases: [unknown, string][] = [
      [{ platform: "ios", udid: "SIM-1", booted: true }, "SIM-1"],
      [{ platform: "ios-remote", udid: "remote:SIM-2", booted: true }, "remote:SIM-2"],
      [
        { platform: "android", serial: "emulator-5554", avdName: "Pixel", booted: true },
        "emulator-5554",
      ],
      [
        { platform: "vega", serial: "emulator-5556", vvdImage: "vvd", booted: true },
        "emulator-5556",
      ],
      [
        {
          platform: "chromium",
          id: "chromium:9222",
          port: 9222,
          pid: 1,
          appPath: "/a",
          booted: true,
        },
        "chromium:9222",
      ],
    ];
    for (const [result, id] of cases) {
      const s = new SessionDevice();
      s.learnFromResult("boot-device", result);
      expect(s.get()).toEqual({ defaultDeviceId: id, source: "boot-device" });
    }
  });

  it("does not learn from a failed boot-device result", () => {
    const s = new SessionDevice();
    s.learnFromResult("boot-device", { status: "init_failed", message: "x", attempts: 3 });
    expect(s.get().defaultDeviceId).toBeUndefined();
  });

  // Breaks if: a source hierarchy comes back; the plan says the last event wins.
  it("lets the last event win, whatever set the previous default", () => {
    const s = new SessionDevice();
    s.set("PICKED");
    s.learnFromResult("boot-device", { platform: "ios", udid: "SIM-1", booted: true });
    expect(s.get()).toEqual({ defaultDeviceId: "SIM-1", source: "boot-device" });
    s.learnFromArgs(TAP.name, { udid: "SIM-A", x: 0, y: 0 });
    expect(s.get()).toEqual({ defaultDeviceId: "SIM-A", source: "last-call" });
    s.set("PICKED");
    expect(s.get()).toEqual({ defaultDeviceId: "PICKED", source: "use-device" });
    s.learnFromArgs(TAP.name, { udid: "SIM-C", x: 0, y: 0 });
    expect(s.get()).toEqual({ defaultDeviceId: "SIM-C", source: "last-call" });
  });

  // Breaks if: learnFromArgs reads device_id or device. Debugger, profiler and
  // network tools accept a Metro logicalDeviceId there, which no device tool takes.
  it("learns from udid and serial only, never from device_id or device", () => {
    const s = new SessionDevice();
    s.learnFromArgs(NETWORK.name, { device_id: "logical-1", port: 8081 });
    s.learnFromArgs(FLOW.name, { name: "login", device: "SIM-F" });
    expect(s.get().defaultDeviceId).toBeUndefined();
    s.learnFromArgs("some-tool", { serial: "emulator-5554" });
    expect(s.get()).toEqual({ defaultDeviceId: "emulator-5554", source: "last-call" });
  });
});

// ---------------------------------------------------------------------------
// Stop tools forget the default
// Breaks if: a successful stop of the default device leaves it as the default.
// ---------------------------------------------------------------------------
describe("SessionDevice.forgetIfStopped", () => {
  function withDefault() {
    const s = new SessionDevice();
    s.set("SIM-A");
    return s;
  }

  it("clears the default when a stop- tool names it", () => {
    const s = withDefault();
    s.forgetIfStopped("stop-simulator-server", { udid: "SIM-A" });
    expect(s.get().defaultDeviceId).toBeUndefined();
  });

  it("keeps the default when a stop- tool names another device", () => {
    const s = withDefault();
    s.forgetIfStopped("stop-simulator-server", { udid: "SIM-B" });
    s.forgetIfStopped("stop-metro", { port: 8081 });
    expect(s.get().defaultDeviceId).toBe("SIM-A");
  });

  it("clears the default on an unscoped stop-all, or one scoped to the default", () => {
    const unscoped = withDefault();
    unscoped.forgetIfStopped("stop-all-simulator-servers", {});
    expect(unscoped.get().defaultDeviceId).toBeUndefined();
    const scoped = withDefault();
    scoped.forgetIfStopped("stop-all-simulator-servers", { devices: ["SIM-B", "SIM-A"] });
    expect(scoped.get().defaultDeviceId).toBeUndefined();
  });

  it("keeps the default on a stop-all scoped to other devices", () => {
    const s = withDefault();
    s.forgetIfStopped("stop-all-simulator-servers", { devices: ["SIM-B"] });
    expect(s.get().defaultDeviceId).toBe("SIM-A");
  });
});

// ---------------------------------------------------------------------------
// defaultDeviceLine — the line appended to list-devices
// Breaks if: the default is written into the JSON, or the line loses the
// source or the "not in this list" note.
// ---------------------------------------------------------------------------
describe("defaultDeviceLine", () => {
  const listed = {
    devices: [
      { platform: "ios", udid: "SIM-A" },
      { platform: "android", serial: "emulator-5554" },
      { platform: "chromium", id: "chromium:9222" },
    ],
    avds: [],
  };

  it("names the default and its source", () => {
    expect(
      defaultDeviceLine(listed, { defaultDeviceId: "emulator-5554", source: "boot-device" })
    ).toBe("Default device: emulator-5554 (boot-device)");
    expect(
      defaultDeviceLine(listed, { defaultDeviceId: "chromium:9222", source: "use-device" })
    ).toBe("Default device: chromium:9222 (use-device)");
  });

  it("says when the default is not in the list", () => {
    expect(defaultDeviceLine(listed, { defaultDeviceId: "SIM-GONE", source: "last-call" })).toBe(
      "Default device: SIM-GONE (last-call) — not in this list"
    );
  });

  it("returns undefined without a default", () => {
    expect(defaultDeviceLine(listed, {})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MCP handler wiring
// ---------------------------------------------------------------------------
describe("use-device through the MCP handler", () => {
  // Breaks if: use-device is forwarded to the tool-server instead of answered here.
  it("sets and clears the default without a tool-server call", async () => {
    const { session, callTool, handle } = harness();
    const set = await handle({ name: USE_DEVICE_TOOL_NAME, arguments: { udid: "SIM-A" } });
    expect(set.isError).toBeFalsy();
    expect(textOf(set)).toBe("Default device set to SIM-A");
    expect(session.get()).toEqual({ defaultDeviceId: "SIM-A", source: "use-device" });

    const cleared = await handle({ name: USE_DEVICE_TOOL_NAME, arguments: { clear: true } });
    expect(textOf(cleared)).toBe("Default device cleared");
    expect(session.get().defaultDeviceId).toBeUndefined();
    expect(callTool).not.toHaveBeenCalled();
  });

  // Breaks if: use-device accepts an empty or contradictory argument set.
  it("rejects a call with neither udid nor clear, and a call with both", async () => {
    const { handle } = harness();
    expect((await handle({ name: USE_DEVICE_TOOL_NAME, arguments: {} })).isError).toBe(true);
    expect(
      (await handle({ name: USE_DEVICE_TOOL_NAME, arguments: { udid: "A", clear: true } })).isError
    ).toBe(true);
  });

  // Breaks if: the handler forwards the original args instead of the injected ones.
  it("injects the default into the forwarded args", async () => {
    const { callTool, handle } = harness();
    await handle({ name: USE_DEVICE_TOOL_NAME, arguments: { udid: "SIM-A" } });
    await handle({ name: "gesture-tap", arguments: { x: 0.5, y: 0.5 } });
    expect(callTool).toHaveBeenCalledWith(
      "gesture-tap",
      { x: 0.5, y: 0.5, udid: "SIM-A" },
      expect.anything()
    );
  });

  // Breaks if: the handler calls the tool-server when no device can be chosen.
  it("returns the one-line error and calls nothing when no device is selected", async () => {
    const { callTool, handle } = harness();
    const res = await handle({ name: "gesture-tap", arguments: { x: 0.5, y: 0.5 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(NO_DEVICE_ERROR);
    expect(callTool).not.toHaveBeenCalled();
  });

  // Breaks if: the handler stops feeding boot-device results to learnFromResult.
  it("uses the device that boot-device booted for the next call", async () => {
    const { callTool, handle } = harness({
      "boot-device": {
        platform: "android",
        serial: "emulator-5554",
        avdName: "Pixel",
        booted: true,
      },
    });
    await handle({ name: "boot-device", arguments: { avdName: "Pixel" } });
    await handle({ name: "gesture-tap", arguments: { x: 0.1, y: 0.2 } });
    expect(callTool).toHaveBeenLastCalledWith(
      "gesture-tap",
      { x: 0.1, y: 0.2, udid: "emulator-5554" },
      expect.anything()
    );
  });

  // Breaks if: the list-devices text loses its trailing default line, or the
  // JSON before it stops parsing.
  it("appends the default line after the list-devices JSON", async () => {
    const listed = {
      devices: [
        { platform: "ios", udid: "SIM-A" },
        { platform: "ios", udid: "SIM-B" },
      ],
      avds: [],
    };
    const { handle } = harness({ "list-devices": listed });
    const plain = textOf(await handle({ name: "list-devices", arguments: {} }));
    expect(JSON.parse(plain)).toEqual(listed);

    await handle({ name: USE_DEVICE_TOOL_NAME, arguments: { udid: "SIM-B" } });
    const text = textOf(await handle({ name: "list-devices", arguments: {} }));
    const lines = text.split("\n");
    expect(lines.at(-1)).toBe("Default device: SIM-B (use-device)");
    expect(JSON.parse(lines.slice(0, -1).join("\n"))).toEqual(listed);
  });

  // Breaks if: the handler learns the explicit udid of a stop- call before
  // forgetIfStopped runs; the stopped device would become the default and be
  // cleared, and the live default would be lost.
  it("keeps the default after a successful stop of another device", async () => {
    const { session, handle } = harness();
    await handle({ name: USE_DEVICE_TOOL_NAME, arguments: { udid: "SIM-A" } });
    await handle({ name: "stop-simulator-server", arguments: { udid: "SIM-B" } });
    expect(session.get()).toEqual({ defaultDeviceId: "SIM-A", source: "use-device" });
    await handle({ name: "stop-simulator-server", arguments: { udid: "SIM-A" } });
    expect(session.get().defaultDeviceId).toBeUndefined();
  });

  // Breaks if: the handler stops clearing the default after a successful stop,
  // or checks only the explicit args (the stop below names the device by injection).
  it("forgets the default after a stop on it, and not after a failed one", async () => {
    const { session, callTool, handle } = harness();
    await handle({ name: USE_DEVICE_TOOL_NAME, arguments: { udid: "SIM-A" } });
    callTool.mockRejectedValueOnce(new Error("boom"));
    expect((await handle({ name: "stop-simulator-server", arguments: {} })).isError).toBe(true);
    expect(session.get().defaultDeviceId).toBe("SIM-A");
    await handle({ name: "stop-simulator-server", arguments: {} });
    expect(callTool).toHaveBeenLastCalledWith(
      "stop-simulator-server",
      { udid: "SIM-A" },
      expect.anything()
    );
    expect(session.get().defaultDeviceId).toBeUndefined();
  });

  // Breaks if: the handler forwards a default into flow-execute's optional device.
  it("forwards flow-execute without a device when a default is set", async () => {
    const { callTool, handle } = harness();
    await handle({ name: USE_DEVICE_TOOL_NAME, arguments: { udid: "SIM-A" } });
    await handle({ name: "flow-execute", arguments: { name: "login" } });
    expect(callTool).toHaveBeenLastCalledWith("flow-execute", { name: "login" }, expect.anything());
  });

  // Breaks if: use-device is missing from tools/list.
  it("lists use-device next to the tool-server tools", () => {
    const listed = toMcpToolList(TOOLS);
    const tool = listed.find((t) => t.name === USE_DEVICE_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/default device/i);
    expect(tool!.inputSchema.properties).toHaveProperty("udid");
    expect(tool!.inputSchema.properties).toHaveProperty("clear");
    expect(listed).toHaveLength(TOOLS.length + 1);
  });
});
