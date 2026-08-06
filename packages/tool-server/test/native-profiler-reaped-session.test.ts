/**
 * `stop-all-simulator-servers` reaps every device-owned service, and since the
 * `devices` scope landed that set includes `NativeProfilerSession`. Its dispose
 * SIGKILLs the capture with no finalize grace — on Android it also removes the
 * on-device trace — so the trace really is destroyed.
 *
 * What must not also happen is the tool-server denying it ever ran.
 * `Registry._teardown` nulls the node's instance, so the next
 * `native-profiler-stop` resolves a fresh session and used to answer
 * "No active native profiling session found. Call native-profiler-start first."
 * for a capture that had been running seconds earlier.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import type { DeviceInfo } from "@argent/registry";

vi.mock("../src/utils/adb", () => ({ adbShell: vi.fn(async () => "") }));
vi.mock("@argent/native-devtools-android", () => ({
  disposeWarmEngine: vi.fn(async () => {}),
  TraceProcessorUnavailableError: class extends Error {},
}));

import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../src/blueprints/native-profiler-session";
import { stopNativeProfilerIos } from "../src/tools/profiler/native-profiler/platforms/ios";
import { stopNativeProfilerAndroid } from "../src/tools/profiler/native-profiler/platforms/android";
import { __resetReapedSessionsForTesting } from "../src/utils/reaped-sessions";

const iosDevice = { id: "6DBF83B4-0000-0000-0000-000000000000", platform: "ios" } as DeviceInfo;
const androidDevice = { id: "emulator-5554", platform: "android" } as DeviceInfo;

class FakeChild extends EventEmitter {
  kill = vi.fn((_signal?: NodeJS.Signals) => {
    queueMicrotask(() => this.emit("exit", null, "SIGKILL"));
    return true;
  });
}

async function session(device: DeviceInfo) {
  return nativeProfilerSessionBlueprint.factory({}, device, { device } as never);
}

beforeEach(() => {
  __resetReapedSessionsForTesting();
});

describe("a native profiling session reaped by stop-all-simulator-servers", () => {
  it("iOS: names the teardown, and says the partial bundle is not worth salvaging", async () => {
    const instance = await session(iosDevice);
    const api = instance.api as NativeProfilerSessionApi;
    api.profilingActive = true;
    api.captureProcess = new FakeChild() as unknown as ChildProcess;
    api.traceFile = "/tmp/argent-fake.trace";

    await instance.dispose();

    // The registry nulls the instance, so the stop below resolves a new one.
    const fresh = (await session(iosDevice)).api as NativeProfilerSessionApi;
    const err = await stopNativeProfilerIos(fresh).catch((e: unknown) => e);

    const message = (err as Error).message;
    expect(message).not.toMatch(/Call native-profiler-start first/);
    expect(message).toContain("torn down");
    expect(message).toContain("stop-all-simulator-servers");
    expect(message).toContain("/tmp/argent-fake.trace");
  });

  it("Android: says outright that no trace survived", async () => {
    const instance = await session(androidDevice);
    const api = instance.api as NativeProfilerSessionApi;
    api.profilingActive = true;
    api.capturePid = 4242;
    api.androidOnDeviceTracePath = "/data/misc/perfetto-traces/fake.pftrace";

    await instance.dispose();

    const fresh = (await session(androidDevice)).api as NativeProfilerSessionApi;
    const err = await stopNativeProfilerAndroid(fresh).catch((e: unknown) => e);

    const message = (err as Error).message;
    expect(message).not.toMatch(/Call native-profiler-start first/);
    expect(message).toContain("torn down");
    expect(message).toContain("no trace survived");
  });

  it("leaves a plain absence alone when the disposed session was idle", async () => {
    // Disposing a session nobody was profiling with is routine cleanup. If that
    // left a breadcrumb, the next honest "you never started one" would accuse a
    // teardown of destroying a capture that never existed.
    const instance = await session(iosDevice);
    await instance.dispose();

    const fresh = (await session(iosDevice)).api as NativeProfilerSessionApi;
    const err = await stopNativeProfilerIos(fresh).catch((e: unknown) => e);

    expect((err as Error).message).toBe(
      "No active native profiling session found. Call native-profiler-start first."
    );
  });

  it("is consumed by the report, so it cannot blame a later unrelated absence", async () => {
    const instance = await session(iosDevice);
    const api = instance.api as NativeProfilerSessionApi;
    api.profilingActive = true;
    api.captureProcess = new FakeChild() as unknown as ChildProcess;
    api.traceFile = "/tmp/argent-fake.trace";
    await instance.dispose();

    const fresh = (await session(iosDevice)).api as NativeProfilerSessionApi;
    await stopNativeProfilerIos(fresh).catch(() => {});
    const again = (await session(iosDevice)).api as NativeProfilerSessionApi;
    const err = await stopNativeProfilerIos(again).catch((e: unknown) => e);

    expect((err as Error).message).toBe(
      "No active native profiling session found. Call native-profiler-start first."
    );
  });
});
