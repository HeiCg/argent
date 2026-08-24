// Reads fd 4, the extra pipe the executor opens when it forks this process.
// Nothing is ever written to it; the parent holds the other end, and that end
// closing is how a runner learns the tool server is gone. This thread then
// stops the whole process.
//
// None of the softer controls reach a runner whose parent died: a tool-server
// process-group stop does not reach a detached runner, and the runner's
// `disconnect` handler is a main-thread event-loop callback that a synchronous
// infinite loop never yields to. A worker thread has its own event loop on its
// own OS thread, so a spinning main thread cannot starve it.
//
// It reads through the event loop, not `fs.readSync`: a thread parked inside a
// synchronous syscall cannot be joined, and Node joins its worker threads
// before leaving — so with a blocking read every exit path hangs until the
// parent's time limit, including a passing script's own exit.

import fs from "node:fs";
import net from "node:net";

const LIFELINE_FD = 4;

const stop = () => {
  // The *group*, not just this process: the tool server is already gone, so its
  // cleanup will never run and every descendant the script started would be
  // left behind. Killing the group takes this process with it, which is the
  // point — the main thread it has to stop may be in the very synchronous loop
  // this control exists for.
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // No process group to name (Windows, or a runner that never led one).
  }
  process.kill(process.pid, "SIGKILL");
};

try {
  const lifeline = new net.Socket({ fd: LIFELINE_FD, readable: true, writable: false });
  // End of file reaches a socket as `end`, `close` or a broken-pipe `error`
  // depending on the platform; all three mean the parent is gone.
  lifeline.on("end", stop);
  lifeline.on("close", stop);
  lifeline.on("error", stop);
  // The parent never writes, but a paused stream would never reach its own end
  // event.
  lifeline.resume();
} catch (err) {
  fs.writeSync(2, `[argent] script lifeline unavailable: ${err && err.message}\n`);
}
