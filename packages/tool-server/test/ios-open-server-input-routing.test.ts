import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import type { SimInputAck } from "../src/utils/ios-sim-input-service";

/**
 * iOS-4 ticket 6: under the `open-ios-device-server` flag, on a simulator,
 * gesture-tap / gesture-swipe / keyboard text (printable ASCII) go to sim-input
 * first. A sim-input failure falls back to the XCUITest runner, and a runner
 * failure to the simulator-server; each fallback is visible on the result
 * (`fallbackReason`), and `inputBackend` names the backend that served the call.
 * Physical iPhones and the flag-off path are unchanged.
 *
 * Every backend is a fake behind a stub registry: no simulator, no binary.
 */

const h = vi.hoisted(() => ({
  flagOn: true,
  simInputUnavailable: null as Error | null,
  simInputError: null as Error | null,
  runnerError: null as Error | null,
  calls: [] as Array<{ backend: string; op: string; args: unknown }>,
  urns: [] as string[],
}));

vi.mock("@argent/configuration-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/configuration-core")>();
  return {
    ...actual,
    isFlagEnabled: (name: string) => name === "open-ios-device-server" && h.flagOn,
  };
});

vi.mock("../src/utils/simulator-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/simulator-client")>();
  return {
    ...actual,
    sendCommand: vi.fn(async (_api: unknown, cmd: Record<string, unknown>) => {
      h.calls.push({ backend: "simulator-server", op: String(cmd.type ?? cmd.cmd), args: cmd });
      return {};
    }),
  };
});

vi.mock("../src/utils/ios-devices", () => ({
  isTvOsSimulator: vi.fn(async () => false),
}));

vi.mock("../src/tools/keyboard/simulator-server-keys", () => ({
  typeSimulatorServer: vi.fn(async (_r: unknown, _d: unknown, params: { text?: string }) => {
    h.calls.push({ backend: "simulator-server", op: "type", args: params.text });
    return { typed: params.text ?? "", keys: 0 };
  }),
}));

vi.mock("../src/utils/ios-device/app-session", () => ({
  requireCurrentIosDeviceApp: () => "com.example.app",
}));

vi.mock("../src/utils/ios-device/runner-commands", () => ({
  getViewport: vi.fn(async () => ({ width: 400, height: 800 })),
  toPoints: (_v: unknown, x: number, y: number) => ({ x: x * 400, y: y * 800 }),
  tapAt: vi.fn(async (_r: unknown, _b: string, point: unknown) => {
    h.calls.push({ backend: "device-runner", op: "tap", args: point });
    return {};
  }),
  dragBetween: vi.fn(async () => {
    h.calls.push({ backend: "device-runner", op: "swipe", args: null });
    return {};
  }),
}));

import { createGestureTapTool } from "../src/tools/gesture-tap";
import { createGestureSwipeTool } from "../src/tools/gesture-swipe";
import { makeIosImpl as makeKeyboardIosImpl } from "../src/tools/keyboard/platforms/ios";
import { createKeyboardTool } from "../src/tools/keyboard";
import { resolveDevice } from "../src/utils/device-info";

const SIM = "DE624B9E-8175-406B-93D4-FC65B7FC39F3";
const PHYSICAL = "00008110-000978540290401E";

const TIMING = { recvAt: 10, sends: [{ sendStart: 10.1, sendEnd: 10.2 }], ackAt: 61 };

function simAck(id: number, extra: Partial<SimInputAck> = {}): SimInputAck {
  return { id, hostWriteAt: 100, hostAckAt: 152, timing: TIMING, ...extra };
}

async function defaultSendTap(args: unknown): Promise<SimInputAck> {
  if (h.simInputError) throw h.simInputError;
  h.calls.push({ backend: "sim-input", op: "tap", args });
  return simAck(1, { scheduledMs: 50, actualMs: 50.4, overshootMs: 0.4, maxFrameLateMs: 0.1 });
}

const simInput = {
  udid: SIM,
  sendTap: vi.fn(defaultSendTap),
  sendSwipe: vi.fn(async (args: unknown) => {
    if (h.simInputError) throw h.simInputError;
    h.calls.push({ backend: "sim-input", op: "swipe", args });
    return simAck(2, { scheduledMs: 220, actualMs: 221, overshootMs: 1, maxFrameLateMs: 0.5 });
  }),
  sendText: vi.fn(async (text: string) => {
    if (h.simInputError) throw h.simInputError;
    h.calls.push({ backend: "sim-input", op: "type", args: text });
    return simAck(3);
  }),
};

const runner = {
  getScreenSize: async () => ({ screenWidth: 400, screenHeight: 800, scale: 3 }),
  tap: vi.fn(async (x: number, y: number) => {
    if (h.runnerError) throw h.runnerError;
    h.calls.push({ backend: "runner", op: "tap", args: { x, y } });
    return { success: true, dropped: false, dropReporting: "none" };
  }),
  swipe: vi.fn(async (...args: unknown[]) => {
    if (h.runnerError) throw h.runnerError;
    h.calls.push({ backend: "runner", op: "swipe", args });
    return { success: true };
  }),
  typeText: vi.fn(async (text: string) => {
    if (h.runnerError) throw h.runnerError;
    h.calls.push({ backend: "runner", op: "type", args: text });
    return { success: true, charsTyped: text.length };
  }),
  key: vi.fn(async (key: string) => {
    if (h.runnerError) throw h.runnerError;
    h.calls.push({ backend: "runner", op: "key", args: key });
    return { success: true };
  }),
};

const registry = {
  resolveService: vi.fn(async (urn: string) => {
    h.urns.push(urn);
    if (urn.startsWith("IosSimInput:")) {
      if (h.simInputUnavailable) throw h.simInputUnavailable;
      return simInput;
    }
    if (urn.startsWith("IosOpenDeviceServer:")) return runner;
    if (urn.startsWith("SimulatorServer:")) return {};
    throw new Error(`unexpected urn ${urn}`);
  }),
} as unknown as Registry;

const tap = createGestureTapTool(registry);
const swipe = createGestureSwipeTool(registry);
const keyboard = makeKeyboardIosImpl(registry);

const backends = () => [...new Set(h.calls.map((c) => c.backend))];

beforeEach(() => {
  h.flagOn = true;
  h.simInputUnavailable = null;
  h.simInputError = null;
  h.runnerError = null;
  h.calls.length = 0;
  h.urns.length = 0;
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("flag on, simulator: sim-input serves the call", () => {
  it("gesture-tap goes to sim-input with normalized coords and returns the ack timing", async () => {
    const result = await tap.execute({} as never, { udid: SIM, x: 0.25, y: 0.5 });
    expect(backends()).toEqual(["sim-input"]);
    expect(simInput.sendTap).toHaveBeenCalledWith({ x: 0.25, y: 0.5 });
    expect(result).toMatchObject({
      tapped: true,
      inputBackend: "sim-input",
      simInput: {
        scheduledMs: 50,
        actualMs: 50.4,
        overshootMs: 0.4,
        maxFrameLateMs: 0.1,
        timing: TIMING,
        hostRoundTripMs: 52,
      },
    });
    expect(result).not.toHaveProperty("fallbackReason");
    expect(result).not.toHaveProperty("backend");
  });

  it("a double tap is two sim-input taps", async () => {
    const result = await tap.execute({} as never, { udid: SIM, x: 0.5, y: 0.5, clickCount: 2 });
    expect(h.calls.filter((c) => c.backend === "sim-input")).toHaveLength(2);
    expect(result).toMatchObject({ tapped: true, inputBackend: "sim-input" });
  });

  it("gesture-swipe goes to sim-input with the duration", async () => {
    const result = await swipe.execute({} as never, {
      udid: SIM,
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.2,
      durationMs: 250,
    });
    expect(backends()).toEqual(["sim-input"]);
    expect(simInput.sendSwipe).toHaveBeenCalledWith({
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.2,
      durationMs: 250,
    });
    expect(result).toMatchObject({
      swiped: true,
      inputBackend: "sim-input",
      simInput: { scheduledMs: 220, timing: TIMING },
    });
  });

  it("keyboard ASCII text goes to sim-input", async () => {
    const result = await keyboard.handler(
      {},
      { udid: SIM, text: "Hello, world!" },
      resolveDevice(SIM)
    );
    expect(backends()).toEqual(["sim-input"]);
    expect(result).toMatchObject({
      typed: "Hello, world!",
      inputBackend: "sim-input",
      simInput: { timing: TIMING },
    });
  });
});

describe("flag on, simulator: visible fallback", () => {
  it("tap: sim-input fails -> runner, with fallbackReason", async () => {
    h.simInputError = new Error("sim-input exited (code=1)");
    const result = await tap.execute({} as never, { udid: SIM, x: 0.5, y: 0.5 });
    expect(backends()).toEqual(["runner"]);
    expect(result).toMatchObject({
      tapped: true,
      inputBackend: "runner",
      fallbackReason: expect.stringContaining("sim-input exited (code=1)"),
    });
    expect(result).not.toHaveProperty("backend");
  });

  it("tap: sim-input service unavailable -> runner, with fallbackReason", async () => {
    h.simInputUnavailable = new Error("sim-input binary not found");
    const result = await tap.execute({} as never, { udid: SIM, x: 0.5, y: 0.5 });
    expect(backends()).toEqual(["runner"]);
    expect(result).toMatchObject({
      inputBackend: "runner",
      fallbackReason: expect.stringContaining("sim-input binary not found"),
    });
  });

  it("keyboard: sim-input unavailable -> runner; nothing was sent, so no partial text", async () => {
    h.simInputUnavailable = new Error("sim-input binary not found");
    const result = await keyboard.handler({}, { udid: SIM, text: "abc" }, resolveDevice(SIM));
    expect(backends()).toEqual(["runner"]);
    expect(result).toMatchObject({ inputBackend: "runner" });
    expect(result).not.toHaveProperty("partialTextPossible");
  });

  it("swipe: sim-input fails -> runner, with fallbackReason", async () => {
    h.simInputError = new Error("sim-input swipe timed out after 5000 ms");
    const result = await swipe.execute({} as never, {
      udid: SIM,
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.2,
    });
    expect(backends()).toEqual(["runner"]);
    expect(result).toMatchObject({
      swiped: true,
      inputBackend: "runner",
      fallbackReason: expect.stringContaining("timed out"),
    });
  });

  it("keyboard: sim-input fails -> runner, with fallbackReason", async () => {
    h.simInputError = new Error("text: one or more characters failed");
    const result = await keyboard.handler({}, { udid: SIM, text: "abc" }, resolveDevice(SIM));
    expect(backends()).toEqual(["runner"]);
    expect(result).toMatchObject({
      typed: "abc",
      inputBackend: "runner",
      fallbackReason: expect.stringContaining("one or more characters failed"),
      // The command reached sim-input: some characters may have landed before
      // the failure, and the runner typed the whole text again.
      partialTextPossible: true,
    });
  });

  it("tap: sim-input and runner both fail -> simulator-server, both reasons visible", async () => {
    h.simInputError = new Error("sim-input exited (code=1)");
    h.runnerError = new Error("runner unreachable");
    const result = await tap.execute({} as never, { udid: SIM, x: 0.5, y: 0.5 });
    expect(backends()).toEqual(["simulator-server"]);
    expect(result).toMatchObject({
      tapped: true,
      inputBackend: "simulator-server",
      backend: "proprietary-fallback",
    });
    const reason = (result as { fallbackReason?: string }).fallbackReason ?? "";
    expect(reason).toContain("sim-input exited (code=1)");
    expect(reason).toContain("runner unreachable");
  });

  it("swipe: sim-input and runner both fail -> simulator-server", async () => {
    h.simInputError = new Error("sim-input exited (code=1)");
    h.runnerError = new Error("runner unreachable");
    const result = await swipe.execute({} as never, {
      udid: SIM,
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.2,
      durationMs: 32,
    });
    expect(backends()).toEqual(["simulator-server"]);
    expect(result).toMatchObject({
      swiped: true,
      inputBackend: "simulator-server",
      backend: "proprietary-fallback",
      fallbackReason: expect.stringContaining("runner unreachable"),
    });
  });
});

describe("flag on, simulator: calls sim-input does not take stay on the runner", () => {
  it("non-ASCII text goes to the runner without touching sim-input", async () => {
    const result = await keyboard.handler({}, { udid: SIM, text: "héllo ✓" }, resolveDevice(SIM));
    expect(backends()).toEqual(["runner"]);
    expect(simInput.sendText).not.toHaveBeenCalledWith("héllo ✓");
    expect(result).toMatchObject({ typed: "héllo ✓", inputBackend: "runner" });
    expect(result).not.toHaveProperty("fallbackReason");
  });

  it("a newline is not sim-input text either", async () => {
    await keyboard.handler({}, { udid: SIM, text: "a\nb" }, resolveDevice(SIM));
    expect(backends()).toEqual(["runner"]);
  });

  it("a named key stays on the runner", async () => {
    const result = await keyboard.handler({}, { udid: SIM, key: "enter" }, resolveDevice(SIM));
    expect(backends()).toEqual(["runner"]);
    expect(result).toMatchObject({ keys: 1, inputBackend: "runner" });
  });

  it("ARGENT_SIM_INPUT=off keeps tap, swipe and text on the runner", async () => {
    process.env.ARGENT_SIM_INPUT = "off";
    try {
      const t = await tap.execute({} as never, { udid: SIM, x: 0.5, y: 0.5 });
      const s = await swipe.execute({} as never, {
        udid: SIM,
        fromX: 0.5,
        fromY: 0.8,
        toX: 0.5,
        toY: 0.2,
      });
      const k = await keyboard.handler({}, { udid: SIM, text: "abc" }, resolveDevice(SIM));
      expect(backends()).toEqual(["runner"]);
      expect(h.urns.some((u) => u.startsWith("IosSimInput:"))).toBe(false);
      for (const r of [t, s, k]) {
        expect(r).toMatchObject({ inputBackend: "runner" });
        expect(r).not.toHaveProperty("fallbackReason");
      }
    } finally {
      delete process.env.ARGENT_SIM_INPUT;
    }
  });
});

describe("flag on, simulator: momentum-free swipe", () => {
  const momentumFree = {
    udid: SIM,
    fromX: 0.5,
    fromY: 0.8,
    toX: 0.5,
    toY: 0.2,
    durationMs: 300,
    momentum: false,
  };

  it("stays on the runner by default (the sim-input end hold is not measured yet)", async () => {
    const result = await swipe.execute({} as never, momentumFree);
    expect(backends()).toEqual(["runner"]);
    expect(simInput.sendSwipe).not.toHaveBeenCalled();
    expect(result).toMatchObject({ swiped: true, inputBackend: "runner" });
    expect(result).not.toHaveProperty("fallbackReason");
  });

  it("goes to sim-input with a 120 ms end hold when ARGENT_SIM_INPUT_MOMENTUM_FREE=1", async () => {
    process.env.ARGENT_SIM_INPUT_MOMENTUM_FREE = "1";
    try {
      const result = await swipe.execute({} as never, momentumFree);
      expect(backends()).toEqual(["sim-input"]);
      expect(simInput.sendSwipe).toHaveBeenLastCalledWith({
        fromX: 0.5,
        fromY: 0.8,
        toX: 0.5,
        toY: 0.2,
        durationMs: 300,
        holdEndMs: 120,
      });
      expect(result).toMatchObject({ swiped: true, inputBackend: "sim-input" });
    } finally {
      delete process.env.ARGENT_SIM_INPUT_MOMENTUM_FREE;
    }
  });
});

describe("flag on, simulator: partial multi-tap", () => {
  it("the 2nd tap fails after the 1st landed -> runner, partialTapsPossible: true", async () => {
    let n = 0;
    simInput.sendTap.mockImplementation(async (args: unknown) => {
      n++;
      if (n === 2) throw new Error("sim-input tap timed out after 5000 ms");
      h.calls.push({ backend: "sim-input", op: "tap", args });
      return simAck(n);
    });
    try {
      const result = await tap.execute({} as never, { udid: SIM, x: 0.5, y: 0.5, clickCount: 2 });
      expect(h.calls.map((c) => c.backend)).toEqual(["sim-input", "runner"]);
      expect(result).toMatchObject({
        tapped: true,
        inputBackend: "runner",
        partialTapsPossible: true,
        fallbackReason: expect.stringContaining("timed out"),
      });
    } finally {
      simInput.sendTap.mockReset();
      simInput.sendTap.mockImplementation(defaultSendTap);
    }
  });

  it("the 1st tap fails -> runner, no partialTapsPossible", async () => {
    h.simInputError = new Error("sim-input exited (code=1)");
    const result = await tap.execute({} as never, { udid: SIM, x: 0.5, y: 0.5, clickCount: 2 });
    expect(backends()).toEqual(["runner"]);
    expect(result).not.toHaveProperty("partialTapsPossible");
  });
});

describe("flag on, simulator: secrets never reach sim-input", () => {
  it("text resolved from a {{secret:...}} placeholder goes to the runner, with no fallbackReason", async () => {
    process.env.ARGENT_SECRET_SIMROUTE = "s3cret";
    try {
      const tool = createKeyboardTool(registry);
      const result = await tool.execute(
        {},
        { udid: SIM, text: "{{secret:SIMROUTE}}" },
        undefined as never
      );
      expect(simInput.sendText).not.toHaveBeenCalled();
      expect(h.calls).toEqual([{ backend: "runner", op: "type", args: "s3cret" }]);
      expect(result).toMatchObject({ typed: "{{secret:SIMROUTE}}", inputBackend: "runner" });
      expect(result).not.toHaveProperty("fallbackReason");
      expect(JSON.stringify(result)).not.toContain("s3cret");
    } finally {
      delete process.env.ARGENT_SECRET_SIMROUTE;
    }
  });

  it("text with no placeholder still goes to sim-input through the keyboard tool", async () => {
    const tool = createKeyboardTool(registry);
    const result = await tool.execute({}, { udid: SIM, text: "plain" }, undefined as never);
    expect(simInput.sendText).toHaveBeenCalledWith("plain");
    expect(result).toMatchObject({ inputBackend: "sim-input" });
  });
});

describe("unchanged paths", () => {
  it("physical iPhone: the device runner taps, sim-input is never resolved", async () => {
    const result = await tap.execute({ iosDeviceRunner: {} } as never, {
      udid: PHYSICAL,
      x: 0.5,
      y: 0.5,
    });
    expect(backends()).toEqual(["device-runner"]);
    expect(h.urns.some((u) => u.startsWith("IosSimInput:"))).toBe(false);
    expect(result).not.toHaveProperty("inputBackend");
  });

  it("flag off: tap uses the simulator-server, no sim-input, no inputBackend", async () => {
    h.flagOn = false;
    const result = await tap.execute({ simulatorServer: {} } as never, {
      udid: SIM,
      x: 0.5,
      y: 0.5,
    });
    expect(backends()).toEqual(["simulator-server"]);
    expect(h.urns.some((u) => u.startsWith("IosSimInput:"))).toBe(false);
    expect(result).not.toHaveProperty("inputBackend");
  });

  it("flag off: swipe and keyboard skip sim-input", async () => {
    h.flagOn = false;
    await swipe.execute({ simulatorServer: {} } as never, {
      udid: SIM,
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.2,
      durationMs: 32,
    });
    const typed = await keyboard.handler({}, { udid: SIM, text: "abc" }, resolveDevice(SIM));
    expect(backends()).toEqual(["simulator-server"]);
    expect(h.urns.some((u) => u.startsWith("IosSimInput:"))).toBe(false);
    expect(typed).not.toHaveProperty("inputBackend");
  });
});
