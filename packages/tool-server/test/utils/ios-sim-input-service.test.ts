import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { IosSimInputService } from "../../src/utils/ios-sim-input-service";

/**
 * Unit tests for the ON-siminput host driver: the id-stamped JSONL framing and
 * the per-UDID FIFO ack queue. No native `sim-input` binary is spawned — a fake
 * spawn returns a controllable child whose stdin captures the written wire and
 * whose stdout we push ack lines into. Runs on any host (CI or the 24 GB box).
 */

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  spawnargs: string[];
}

function makeFakeChild(spawnargs: string[]): { child: FakeChild; written: string[] } {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.spawnargs = spawnargs;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  const written: string[] = [];
  child.stdin.on("data", (buf: Buffer) => written.push(buf.toString("utf-8")));
  return { child, written };
}

/** Build a service whose single spawned child we can drive. */
function serviceWithChild(): {
  svc: IosSimInputService;
  children: FakeChild[];
  written: string[][];
  spawnCalls: Array<{ binary: string; args: string[] }>;
} {
  const children: FakeChild[] = [];
  const written: string[][] = [];
  const spawnCalls: Array<{ binary: string; args: string[] }> = [];
  const spawn = vi.fn((binary: string, args: string[]) => {
    const { child, written: w } = makeFakeChild([binary, ...args]);
    children.push(child);
    written.push(w);
    spawnCalls.push({ binary, args });
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  });
  const svc = new IosSimInputService({ binary: "/fake/sim-input", spawn: spawn as never });
  return { svc, children, written, spawnCalls };
}

function pushAck(child: FakeChild, obj: Record<string, unknown>): void {
  child.stdout.write(JSON.stringify(obj) + "\n");
}

describe("IosSimInputService — framing", () => {
  it("stamps a monotonic id and writes one newline-terminated JSON line per command", async () => {
    const { svc, children, written } = serviceWithChild();
    const p1 = svc.tap("UDID-A", { x: 10, y: 20, width: 390, height: 844 });
    const p2 = svc.typeText("UDID-A", "hi");
    // Two lines written, each ending in exactly one \n, in call order.
    const lines = written[0]!.join("").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    const cmd1 = JSON.parse(lines[0]!);
    const cmd2 = JSON.parse(lines[1]!);
    expect(cmd1).toMatchObject({ id: 1, type: "tap", x: 10, y: 20, screenWidth: 390, screenHeight: 844 });
    expect(cmd2).toMatchObject({ id: 2, type: "text", text: "hi" });
    // id must be the FIRST key (stamped before the envelope spread).
    expect(Object.keys(cmd1)[0]).toBe("id");
    // The raw wire is one \n-terminated line per command.
    expect(written[0]!.every((chunk) => chunk.endsWith("\n"))).toBe(true);
    // Resolve both so no unhandled rejection.
    pushAck(children[0]!, { id: 1, ok: true });
    pushAck(children[0]!, { id: 2, ok: true });
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
  });

  it("swipe defaults durationMs to 250 and carries screen dims when given", async () => {
    const { svc, children, written } = serviceWithChild();
    const p = svc.swipe("UDID-A", { fromX: 1, fromY: 2, toX: 3, toY: 4, width: 390, height: 844 });
    const cmd = JSON.parse(written[0]!.join("").trim());
    expect(cmd).toMatchObject({ type: "swipe", fromX: 1, toY: 4, durationMs: 250, screenWidth: 390, screenHeight: 844 });
    pushAck(children[0]!, { id: cmd.id, ok: true });
    await expect(p).resolves.toBeUndefined();
  });

  it("reassembles acks split across stdout chunks", async () => {
    const { svc, children } = serviceWithChild();
    const p = svc.tap("UDID-A", { x: 1, y: 1, width: 10, height: 10 });
    // Ack arrives in two partial chunks with the newline in the second.
    children[0]!.stdout.write('{"id":1,"o');
    children[0]!.stdout.write('k":true}\n');
    await expect(p).resolves.toBeUndefined();
  });
});

describe("IosSimInputService — ack queue", () => {
  it("matches acks by id even when they arrive out of order", async () => {
    const { svc, children } = serviceWithChild();
    const order: number[] = [];
    const p1 = svc.tap("UDID-A", { x: 1, y: 1, width: 10, height: 10 }).then(() => order.push(1));
    const p2 = svc.tap("UDID-A", { x: 2, y: 2, width: 10, height: 10 }).then(() => order.push(2));
    // Ack the SECOND command first.
    pushAck(children[0]!, { id: 2, ok: true });
    pushAck(children[0]!, { id: 1, ok: true });
    await Promise.all([p1, p2]);
    expect(order).toEqual([2, 1]);
  });

  it("falls back to FIFO when the ack carries no id", async () => {
    const { svc, children } = serviceWithChild();
    const seen: string[] = [];
    const p1 = svc.tap("UDID-A", { x: 1, y: 1, width: 10, height: 10 }).then(() => seen.push("first"));
    const p2 = svc.tap("UDID-A", { x: 2, y: 2, width: 10, height: 10 }).then(() => seen.push("second"));
    // No id on either ack → pop the head of the pending queue each time.
    pushAck(children[0]!, { ok: true });
    await p1;
    pushAck(children[0]!, { ok: true });
    await p2;
    expect(seen).toEqual(["first", "second"]);
  });

  it("rejects the matching command when the ack reports ok:false with its error", async () => {
    const { svc, children } = serviceWithChild();
    const p = svc.tap("UDID-A", { x: 1, y: 1, width: 10, height: 10 });
    pushAck(children[0]!, { id: 1, ok: false, error: "tap failed" });
    await expect(p).rejects.toThrow("tap failed");
  });

  it("reuses one process per UDID and spawns a distinct one per UDID", async () => {
    const { svc, children, spawnCalls } = serviceWithChild();
    const a1 = svc.tap("UDID-A", { x: 1, y: 1, width: 10, height: 10 });
    const a2 = svc.tap("UDID-A", { x: 2, y: 2, width: 10, height: 10 });
    const b1 = svc.tap("UDID-B", { x: 3, y: 3, width: 10, height: 10 });
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]).toEqual({ binary: "/fake/sim-input", args: ["--udid", "UDID-A"] });
    expect(spawnCalls[1]).toEqual({ binary: "/fake/sim-input", args: ["--udid", "UDID-B"] });
    // UDID-A child answers both its ids; UDID-B its own id (restarts at 1? no —
    // the id counter is service-global, so UDID-B's tap is id 3).
    pushAck(children[0]!, { id: 1, ok: true });
    pushAck(children[0]!, { id: 2, ok: true });
    pushAck(children[1]!, { id: 3, ok: true });
    await Promise.all([a1, a2, b1]);
  });

  it("stop() rejects every pending command and kills the child", async () => {
    const { svc, children } = serviceWithChild();
    const p = svc.tap("UDID-A", { x: 1, y: 1, width: 10, height: 10 });
    await svc.stop("UDID-A");
    await expect(p).rejects.toThrow("sim-input stopped");
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects pending commands when the child exits unexpectedly", async () => {
    const { svc, children } = serviceWithChild();
    const p = svc.tap("UDID-A", { x: 1, y: 1, width: 10, height: 10 });
    children[0]!.emit("exit", 1, null);
    await expect(p).rejects.toThrow(/sim-input exited \(code=1\)/);
  });
});
