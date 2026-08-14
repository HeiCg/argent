import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunnerClient,
  RUNNER_COMMAND_TIMEOUT_MS,
  RunnerCommandError,
  waitForRunnerReady,
  type RunnerCommand,
  type RunnerResponseEnvelope,
  type RunnerResponseError,
} from "../src/utils/ios-device/runner-client";
import type { SendRunnerCommandOptions } from "../src/utils/ios-device/runner-route";
import { IosDeviceTransportError } from "../src/utils/ios-device/usbmux-protocol";

const UDID = "00008110-000978540290401E";
const PORT = 8_100;

type SentCommand = { body: RunnerCommand; options: SendRunnerCommandOptions };

/** Records every send and replays scripted responses (a value) or failures (an Error). */
const createFakeSend = (script: Array<unknown | Error>) => {
  const sent: SentCommand[] = [];
  const send = vi.fn(
    async (_udid: string, _port: number, body: unknown, options: SendRunnerCommandOptions) => {
      sent.push({ body: body as RunnerCommand, options });
      const next = script.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  );
  return { send, sent };
};

const transportError = (): IosDeviceTransportError =>
  new IosDeviceTransportError("http", "socket hang up mid-response", { retryable: true });

afterEach(() => {
  vi.useRealTimers();
});

describe("createRunnerClient", () => {
  it("stamps a fresh argent-prefixed commandId on non-status commands", async () => {
    const { send, sent } = createFakeSend([{ ok: true, data: { done: true } } satisfies RunnerResponseEnvelope]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const result = await client.run({ command: "tap", x: 10, y: 20 });

    expect(result).toEqual({ done: true });
    expect(sent[0]?.body.commandId).toMatch(
      /^argent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(send).toHaveBeenCalledWith(UDID, PORT, expect.anything(), expect.anything());
  });

  it("preserves a caller-provided commandId and never stamps status commands", async () => {
    const { send, sent } = createFakeSend([
      { ok: true, data: {} },
      { ok: true, data: {} },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    await client.run({ command: "tap", commandId: "argent-known" });
    await client.run({ command: "status", statusCommandId: "argent-known" }, { readOnly: true });

    expect(sent[0]?.body.commandId).toBe("argent-known");
    expect(sent[1]?.body.commandId).toBeUndefined();
  });

  it("uses the 45s default timeout and forwards readOnly to the send layer", async () => {
    const { send, sent } = createFakeSend([
      { ok: true, data: {} },
      { ok: true, data: {} },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    await client.run({ command: "snapshot" }, { readOnly: true });
    await client.run({ command: "tap" }, { timeoutMs: 1_234 });

    expect(sent[0]?.options).toEqual({ timeoutMs: RUNNER_COMMAND_TIMEOUT_MS, readOnly: true });
    expect(sent[1]?.options).toEqual({ timeoutMs: 1_234, readOnly: false });
  });

  it("throws a typed RunnerCommandError for ok:false envelopes", async () => {
    const { send } = createFakeSend([
      {
        ok: false,
        error: { code: "ELEMENT_NOT_FOUND", message: "no such element", hint: "run snapshot" },
      },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const error = await client
      .run({ command: "tap" })
      .catch((caught: unknown) => caught as RunnerCommandError);

    expect(error).toBeInstanceOf(RunnerCommandError);
    expect((error as RunnerCommandError).code).toBe("ELEMENT_NOT_FOUND");
    expect((error as RunnerCommandError).message).toBe("no such element");
    expect((error as RunnerCommandError).hint).toBe("run snapshot");
    expect((error as RunnerCommandError).retryable).toBe(false);
  });

  it("classifies RUNNER_BUSY as retryable — the runner's explicit try-again verdict", async () => {
    const { send } = createFakeSend([
      { ok: false, error: { code: "RUNNER_BUSY", message: "busy" } satisfies RunnerResponseError },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const error = await client
      .run({ command: "tap" })
      .catch((caught: unknown) => caught as RunnerCommandError);

    expect((error as RunnerCommandError).retryable).toBe(true);
  });

  describe("status recovery after a lost mutating-command response", () => {
    it("returns the retained response when the runner reports the command completed", async () => {
      const { send, sent } = createFakeSend([
        transportError(),
        {
          ok: true,
          data: {
            state: "completed",
            responseJson: JSON.stringify({ ok: true, data: { tapped: true } }),
          },
        },
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const result = await client.run({ command: "tap", x: 1, y: 2 });

      // The tap happened; replaying it would tap twice. Recovery returns the
      // response the transport lost instead.
      expect(result).toEqual({ tapped: true });
      expect(sent).toHaveLength(2);
      expect(sent[1]?.body).toEqual({
        command: "status",
        statusCommandId: sent[0]?.body.commandId,
      });
      expect(sent[1]?.options).toEqual({ timeoutMs: 3_000, readOnly: true });
    });

    it("surfaces the runner's own error when the runner reports the command failed", async () => {
      const { send } = createFakeSend([
        transportError(),
        {
          ok: true,
          data: {
            state: "failed",
            errorCode: "ELEMENT_NOT_FOUND",
            errorMessage: "target vanished",
            errorHint: "run snapshot",
          },
        },
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client
        .run({ command: "tap" })
        .catch((caught: unknown) => caught as RunnerCommandError);

      expect(error).toBeInstanceOf(RunnerCommandError);
      expect((error as RunnerCommandError).code).toBe("ELEMENT_NOT_FOUND");
      expect((error as RunnerCommandError).message).toBe("target vanished");
      expect((error as RunnerCommandError).hint).toBe("run snapshot");
    });

    it("rethrows the transport error when the journal state is unknown", async () => {
      const original = transportError();
      const { send } = createFakeSend([
        original,
        { ok: true, data: { state: "started" } },
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client.run({ command: "tap" }).catch((caught: unknown) => caught);

      expect(error).toBe(original);
    });

    it("rethrows the transport error when the status probe itself fails", async () => {
      const original = transportError();
      const { send, sent } = createFakeSend([original, transportError()]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client.run({ command: "tap" }).catch((caught: unknown) => caught);

      expect(error).toBe(original);
      expect(sent).toHaveLength(2);
    });

    it("rethrows the transport error when completed but no response was retained", async () => {
      const original = transportError();
      const { send } = createFakeSend([
        original,
        { ok: true, data: { state: "completed" } },
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client.run({ command: "tap" }).catch((caught: unknown) => caught);

      expect(error).toBe(original);
    });

    it("does not attempt recovery for read-only commands", async () => {
      const original = transportError();
      const { send, sent } = createFakeSend([original]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client
        .run({ command: "snapshot" }, { readOnly: true })
        .catch((caught: unknown) => caught);

      // The route layer already retried idempotent sends; a status probe
      // could tell us nothing a retry did not.
      expect(error).toBe(original);
      expect(sent).toHaveLength(1);
    });

    it("surfaces the retained ok:false envelope as the command's real outcome", async () => {
      const { send } = createFakeSend([
        transportError(),
        {
          ok: true,
          data: {
            state: "completed",
            responseJson: JSON.stringify({
              ok: false,
              error: { code: "RUNNER_BUSY", message: "was busy" },
            }),
          },
        },
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client
        .run({ command: "tap" })
        .catch((caught: unknown) => caught as RunnerCommandError);

      expect(error).toBeInstanceOf(RunnerCommandError);
      expect((error as RunnerCommandError).code).toBe("RUNNER_BUSY");
      expect((error as RunnerCommandError).retryable).toBe(true);
    });
  });
});

describe("waitForRunnerReady", () => {
  it("polls status every 250ms until the first parsed response", async () => {
    vi.useFakeTimers();
    const { send, sent } = createFakeSend([
      transportError(),
      transportError(),
      { ok: true, data: { uptimeMs: 12, state: "idle" } },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const pending = waitForRunnerReady(client, { timeoutMs: 10_000 });
    await vi.runAllTimersAsync();
    await pending;

    expect(sent).toHaveLength(3);
    expect(sent.every((entry) => entry.body.command === "status")).toBe(true);
    expect(sent.every((entry) => entry.options.readOnly === true)).toBe(true);
  });

  it("treats a parsed ok:false answer as ready — the transport provably works", async () => {
    const { send, sent } = createFakeSend([
      { ok: false, error: { code: "RUNNER_BUSY", message: "busy" } },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    await waitForRunnerReady(client, { timeoutMs: 10_000 });

    expect(sent).toHaveLength(1);
  });

  it("times out with a typed error when the runner never answers", async () => {
    vi.useFakeTimers();
    const { send } = createFakeSend(
      Array.from({ length: 50 }, () => transportError())
    );
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const pending = waitForRunnerReady(client, { timeoutMs: 1_000 }).catch(
      (caught: unknown) => caught
    );
    await vi.runAllTimersAsync();
    const error = await pending;

    expect(error).toBeInstanceOf(IosDeviceTransportError);
    expect((error as IosDeviceTransportError).kind).toBe("timeout");
    expect(send.mock.calls.length).toBeGreaterThan(1);
  });
});
