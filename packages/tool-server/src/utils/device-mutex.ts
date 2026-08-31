/**
 * Per-device serialization for the open-device-server backend.
 *
 * The on-device server processes one request at a time per connection, and its
 * client already queues requests on a single socket. This adds the missing layer
 * above that: cross-tool serialization keyed by device serial, so a describe, a
 * tap and a swipe issued concurrently against the SAME device take turns instead
 * of interleaving, while operations on DIFFERENT devices still run in parallel.
 *
 * Ported from device-stream's `@device-stream/core` mutex — which shipped without
 * tests; this port carries them (see `test/device-mutex.test.ts`).
 */

/** A fair FIFO async lock: waiters are served in acquire() order. */
export class AsyncMutex {
  private locked = false;
  private readonly waitQueue: Array<() => void> = [];

  /** Acquire the lock, waiting if another holder has it. */
  acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.waitQueue.push(resolve);
      }
    });
  }

  /** Release the lock, handing it to the next waiter if any. */
  release(): void {
    if (!this.locked) {
      throw new Error("AsyncMutex: release() called without a matching acquire()");
    }
    const next = this.waitQueue.shift();
    if (next) {
      // Stay locked; ownership passes straight to the next waiter.
      next();
    } else {
      this.locked = false;
    }
  }

  /** Run `fn` with the lock held, releasing it even if `fn` throws. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  isLocked(): boolean {
    return this.locked;
  }
}

/** One [AsyncMutex] per device serial, created on demand. */
export class DeviceMutexManager {
  private readonly mutexes = new Map<string, AsyncMutex>();

  getMutex(deviceId: string): AsyncMutex {
    let mutex = this.mutexes.get(deviceId);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.mutexes.set(deviceId, mutex);
    }
    return mutex;
  }

  /** Serialize `fn` against other work on the same `deviceId`. */
  withDeviceLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    return this.getMutex(deviceId).withLock(fn);
  }

  /** Forget a device's mutex; throws if the lock is still held. */
  removeMutex(deviceId: string): void {
    const mutex = this.mutexes.get(deviceId);
    if (mutex?.isLocked()) {
      throw new Error(`Cannot remove mutex for device ${deviceId}: lock is currently held`);
    }
    this.mutexes.delete(deviceId);
  }

  get size(): number {
    return this.mutexes.size;
  }
}

/** Process-wide manager shared by the open-device-server backend paths. */
export const openDeviceServerMutex = new DeviceMutexManager();
