// Watchdog B — the deadline.
//
// The child's own copy of the step's time limit. It applies even when the
// parent is gone, which is what makes it the platform-neutral backstop:
// `Atomics.wait` behaves identically everywhere, while the lifeline's
// end-of-file reporting differs by platform. An orphan therefore has a bounded
// life even on a host where the lifeline does not fire.
//
// `Atomics.wait` blocks the thread outright — no event loop, no timer, no CPU —
// so this costs nothing while the script runs. The parent's own timer starts at
// spawn while this one starts when the request arrives, so the parent normally
// reaches the limit first and this is the second line, not the first.

import { workerData } from "node:worker_threads";

const deadlineMs = workerData && workerData.deadlineMs;
if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
  const slot = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(slot, 0, 0, deadlineMs);
  process.kill(process.pid, "SIGKILL");
}
