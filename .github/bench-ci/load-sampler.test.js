// Unit tests for the per-phase load sampler (load-sampler.js). Review 2026-10-07 run
// 37591260027 finding 1: qemu, simulator-server and on-device com.argent.* CPU per
// (block, phase). Commands and files are injected: nothing here runs adb, ps or pgrep.
//
// Run: node --test .github/bench-ci/load-sampler.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const {
  DEVICE_CMD,
  statTicks,
  parseDeviceProcs,
  parseContext,
  collect,
  aggregate,
} = require("./load-sampler");

// /proc/<pid>/stat with utime/stime at fields 14/15.
const stat = (pid, comm, ut, st) =>
  `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 ${ut} ${st} 0 0 20 0 30 0 100 0 0`;

test("load-sampler: utime + stime from /proc/<pid>/stat, comm with spaces and parens", () => {
  assert.strictEqual(statTicks(stat(7, "qemu-system-x86", 1200, 300)), 1500);
  assert.strictEqual(statTicks(stat(8, "weird (name) x", 10, 5)), 15);
  assert.strictEqual(statTicks("garbage"), null);
});

test("load-sampler: device processes from the one adb shell call; context parse", () => {
  assert.match(DEVICE_CMD, /ps -A -o PID,NAME \| grep com\.argent/);
  const procs = parseDeviceProcs(
    [
      `@@P 4242 com.argent.devicecontrol ${stat(4242, "com.argent.devi", 50, 10)}`,
      `@@P 5151 com.argent.androiddevtools ${stat(5151, "com.argent.andr", 7, 3)}`,
      "noise",
    ].join("\n")
  );
  assert.deepStrictEqual(procs, [
    { pid: 4242, name: "com.argent.devicecontrol", ticks: 60 },
    { pid: 5151, name: "com.argent.androiddevtools", ticks: 10 },
  ]);
  assert.deepStrictEqual(parseContext("block OFF-1 phase tap+describe"), {
    block: "OFF-1",
    phase: "tap+describe",
  });
  assert.deepStrictEqual(parseContext("block ON-im-1\n"), { block: "ON-im-1", phase: "(block)" });
  assert.deepStrictEqual(parseContext(""), { block: null, phase: null });
});

test("load-sampler: collect reads qemu, simulator-server and com.argent.* through the injected runner", () => {
  const files = {
    "/proc/11/stat": stat(11, "qemu-system-x86", 1000, 0),
    "/proc/22/stat": stat(22, "simulator-serve", 40, 0),
    "/ctx": "block OFF-2 phase gesture-tap\n",
  };
  const run = (cmd, args) => {
    if (cmd === "pgrep" && args[1] === "qemu-system-") return { code: 0, stdout: "11\n" };
    if (cmd === "pgrep") return { code: 0, stdout: "22\n" };
    if (cmd === "adb")
      return {
        code: 0,
        stdout: `@@P 5151 com.argent.androiddevtools ${stat(5151, "x", 3, 1)}\n`,
      };
    return { code: 1, stdout: "" };
  };
  const s = collect(run, (p) => files[p], { serial: "emulator-5554", context: "/ctx" }, 1000);
  assert.deepStrictEqual(s.qemu, [{ pid: 11, ticks: 1000 }]);
  assert.deepStrictEqual(s.simServer, [{ pid: 22, ticks: 40 }]);
  assert.strictEqual(s.device[0].ticks, 4);
  assert.strictEqual(s.context, "block OFF-2 phase gesture-tap");
});

test("load-sampler: aggregate → CPU % per (block, phase); a context change mid-interval is mixed", () => {
  const S = (t, ctx, qemu, sim, dev) => ({
    epochMs: t * 1000,
    context: ctx,
    qemu: [{ pid: 1, ticks: qemu }],
    simServer: sim == null ? [] : [{ pid: 2, ticks: sim }],
    device: dev == null ? [] : [{ pid: 3, name: "com.argent.androiddevtools", ticks: dev }],
  });
  const agg = aggregate([
    S(0, "block OFF-1 phase tap+describe", 0, 0, 0),
    // 10 s: qemu 2500 ticks = 25 s of CPU = 250 %; sim-server 100 ticks = 10 %; device 50 = 5 %
    S(10, "block OFF-1 phase tap+describe", 2500, 100, 50),
    S(20, "block OFF-1 phase tap+describe", 5100, 200, 100),
    S(30, "block OFF-1 phase gesture-swipe", 7100, 300, 150),
    // ON block: no simulator-server alive → 0 %, not missing.
    S(40, "block ON-im-1 phase tap+describe", 9100, null, null),
    S(50, "block ON-im-1 phase tap+describe", 11100, null, null),
  ]);
  const td = agg["OFF-1"]["tap+describe"];
  assert.strictEqual(td.intervals, 2);
  assert.strictEqual(td.qemuCpuPct.p50, 255);
  assert.strictEqual(td.simServerCpuPct.p50, 10);
  assert.strictEqual(td.simServerAliveIntervals, 2);
  assert.strictEqual(td.argentCpuPct.p50, 5);
  assert.strictEqual(td.argentByName["com.argent.androiddevtools"].p50, 5);
  assert.strictEqual(agg["OFF-1"].mixed.intervals, 1);
  const on = agg["ON-im-1"]["tap+describe"];
  assert.strictEqual(on.qemuCpuPct.p50, 200);
  assert.strictEqual(on.simServerCpuPct.p50, 0);
  assert.strictEqual(on.simServerAliveIntervals, 0);
});
