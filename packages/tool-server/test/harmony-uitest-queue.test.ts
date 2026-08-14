import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  hdcFileRecv as realHdcFileRecv,
  runHdcShell as realRunHdcShell,
} from "../src/utils/harmony-hdc";
import { harmonyScreenCap } from "../src/utils/harmony-uitest";

// Only the transport is faked, so the queue under test is the real one and the
// commands it serializes are the ones a device would receive.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/harmony-hdc")>();
  return { ...actual, runHdcShell: vi.fn(), hdcFileRecv: vi.fn() };
});

const runHdcShell = vi.mocked(realRunHdcShell);
const hdcFileRecv = vi.mocked(realHdcFileRecv);

/** `start`/`end` per `uitest` call, in the order the device would see them. */
let events: string[] = [];
/** Resolvers for the `uitest` calls currently blocked, in start order. */
let blocked: (() => void)[] = [];

/** Let every microtask that can run, run — without releasing any device call. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  events = [];
  blocked = [];
  hdcFileRecv.mockResolvedValue(undefined);
  runHdcShell.mockImplementation(async (key, command) => {
    // The cleanup `rm -f` runs outside the queue by design; counting it here
    // would report an overlap the queue never promised to prevent.
    if (!command.startsWith("uitest ")) return { stdout: "", exitCode: 0 };
    events.push(`start:${key}`);
    await new Promise<void>((resolve) => blocked.push(resolve));
    events.push(`end:${key}`);
    return { stdout: "", exitCode: 0 };
  });
});

/** Release the longest-blocked `uitest` call and let the queue advance. */
async function releaseOne(): Promise<void> {
  blocked.shift()?.();
  await settle();
}

describe("the per-device uitest queue", () => {
  it("holds a second call on one device until the first has finished", async () => {
    // `uitest` is single-instance on the device: a second one launched while the
    // first is running fails with `Another uitest is running`, so two argent
    // calls landing together would fail whichever lost the race — a failure the
    // caller cannot do anything about and did not cause.
    const first = harmonyScreenCap("dev-a", "/tmp/a.png");
    const second = harmonyScreenCap("dev-a", "/tmp/b.png");
    await settle();

    expect(events).toEqual(["start:dev-a"]);

    await releaseOne();
    expect(events).toEqual(["start:dev-a", "end:dev-a", "start:dev-a"]);

    await releaseOne();
    await Promise.all([first, second]);
  });

  it("does not hold one device's call behind another device's", async () => {
    // The queue is keyed per device precisely so a phone and an emulator, or two
    // emulators, still run at once. One global lock would serialize an agent's
    // whole fleet behind its slowest device.
    const a = harmonyScreenCap("dev-a", "/tmp/a.png");
    const b = harmonyScreenCap("dev-b", "/tmp/b.png");
    await settle();

    expect(events).toEqual(["start:dev-a", "start:dev-b"]);

    await releaseOne();
    await releaseOne();
    await Promise.all([a, b]);
  });

  it("lets the next call through after one that failed", async () => {
    // The queue tracks settlement, not the value. Chaining the successor onto
    // the rejection itself would strand every later call on that device behind
    // one `uitest` failure — with nothing to release it, since the failure has
    // already been reported to its own caller.
    // Two things this has to get right to exercise the chain at all. The failing
    // call must still be IN the queue when the next one joins it — one that
    // fails before the successor enqueues finds an empty queue. And the failure
    // must be the transport REJECTING: a `uitest` that merely exits non-zero
    // resolves the queued work and is thrown on afterwards, outside the queue,
    // so it never reaches the chain this test is about.
    runHdcShell.mockImplementationOnce(async (key, command) => {
      events.push(`start:${key}`);
      expect(command).toContain("uitest");
      await new Promise<void>((resolve) => blocked.push(resolve));
      throw new Error("hdc could not reach HarmonyOS device 'dev-a'");
    });

    const failed = harmonyScreenCap("dev-a", "/tmp/a.png");
    await settle();
    const next = harmonyScreenCap("dev-a", "/tmp/b.png");
    await settle();
    expect(events).toEqual(["start:dev-a"]);

    blocked.shift()?.();
    await expect(failed).rejects.toThrow(/could not reach/);
    await settle();
    expect(events).toEqual(["start:dev-a", "start:dev-a"]);

    await releaseOne();
    await expect(next).resolves.toBeUndefined();
  });
});
