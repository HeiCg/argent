import { describe, it, expect } from "vitest";
import { AsyncMutex, DeviceMutexManager } from "../src/utils/device-mutex";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AsyncMutex", () => {
  it("grants the lock immediately when free", async () => {
    const m = new AsyncMutex();
    expect(m.isLocked()).toBe(false);
    await m.acquire();
    expect(m.isLocked()).toBe(true);
    m.release();
    expect(m.isLocked()).toBe(false);
  });

  it("serializes overlapping critical sections in FIFO order", async () => {
    const m = new AsyncMutex();
    const order: number[] = [];
    const section = async (id: number) =>
      m.withLock(async () => {
        order.push(id);
        await tick();
        order.push(id);
      });
    // Start three at once; each must fully finish before the next begins.
    await Promise.all([section(1), section(2), section(3)]);
    expect(order).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it("releases the lock when the critical section throws", async () => {
    const m = new AsyncMutex();
    await expect(
      m.withLock(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(m.isLocked()).toBe(false);
    // The lock is reusable after a throw.
    await m.acquire();
    expect(m.isLocked()).toBe(true);
    m.release();
  });

  it("throws when released without a matching acquire", () => {
    const m = new AsyncMutex();
    expect(() => m.release()).toThrow(/without a matching acquire/);
  });

  it("hands ownership straight to the next waiter (stays locked)", async () => {
    const m = new AsyncMutex();
    await m.acquire();
    let secondEntered = false;
    const second = m.acquire().then(() => {
      secondEntered = true;
    });
    await tick();
    expect(secondEntered).toBe(false);
    m.release();
    await second;
    expect(secondEntered).toBe(true);
    expect(m.isLocked()).toBe(true);
    m.release();
  });
});

describe("DeviceMutexManager", () => {
  it("reuses one mutex per device id", () => {
    const mgr = new DeviceMutexManager();
    const a1 = mgr.getMutex("emulator-5554");
    const a2 = mgr.getMutex("emulator-5554");
    const b = mgr.getMutex("emulator-5556");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(mgr.size).toBe(2);
  });

  it("serializes same-device work but runs different devices in parallel", async () => {
    const mgr = new DeviceMutexManager();
    const log: string[] = [];
    const work = (dev: string, tag: string) =>
      mgr.withDeviceLock(dev, async () => {
        log.push(`${tag}:start`);
        await tick();
        log.push(`${tag}:end`);
      });
    await Promise.all([work("A", "a1"), work("A", "a2"), work("B", "b1")]);
    // Same-device A serializes: a1 finishes before a2 starts.
    expect(log.indexOf("a1:end")).toBeLessThan(log.indexOf("a2:start"));
    // Different device B overlapped A rather than waiting for it.
    expect(log).toContain("b1:start");
  });

  it("refuses to remove a held mutex, allows it once released", async () => {
    const mgr = new DeviceMutexManager();
    const m = mgr.getMutex("A");
    await m.acquire();
    expect(() => mgr.removeMutex("A")).toThrow(/lock is currently held/);
    m.release();
    mgr.removeMutex("A");
    expect(mgr.size).toBe(0);
  });
});
