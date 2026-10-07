// Unit tests for the per-phase load sampler (load-sampler.js). Review 2026-10-07 run
// 37591260027 finding 1: qemu, simulator-server and on-device com.argent.* CPU per
// (block, phase). Commands and files are injected: nothing here runs adb, ps or pgrep.
//
// Review run 37609765062 (Part A findings 3, 6): qemu CPU per thread (vCPU vs the rest) and
// the host's /proc/stat idle / steal / iowait per interval, null where /proc is absent.
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

// Review run 37609765062 Part A findings 3 and 6: qemu per thread (vCPU vs the emulator's
// other threads) and the host's idle / steal / iowait per interval. Synthetic /proc files.
const { VCPU_COMM, commOf, parseHostStat, intervalLoad, readSamples } = require("./load-sampler");

// /proc/stat "cpu" line: user nice system idle iowait irq softirq steal guest guest_nice.
const procStat = (user, idle, iowait, steal) =>
  `cpu  ${user} 0 0 ${idle} ${iowait} 0 0 ${steal} 0 0\ncpu0 1 2 3 4 5 6 7 8 0 0\nintr 1 2 3\n`;

test("load-sampler: /proc/stat → host jiffies (idle, iowait, steal, total over user..steal)", () => {
  assert.deepStrictEqual(parseHostStat(procStat(600, 300, 40, 60)), {
    idle: 300,
    iowait: 40,
    steal: 60,
    total: 1000,
  });
  assert.strictEqual(parseHostStat("intr 1 2\n"), null);
  assert.strictEqual(parseHostStat(""), null);
});

test("load-sampler: thread comm and the vCPU rule /^(qemu|.*vCPU|CPU \\d+)/", () => {
  assert.strictEqual(commOf(stat(9, "CPU 0/KVM", 1, 1)), "CPU 0/KVM");
  assert.strictEqual(commOf(stat(9, "weird (name) x", 1, 1)), "weird (name) x");
  assert.strictEqual(commOf("garbage"), null);
  for (const c of ["qemu-system-x86", "CPU 0/KVM", "CPU 3/KVM", "x86 vCPU", "qemu-vcpu"])
    assert.ok(VCPU_COMM.test(c), c);
  for (const c of ["gpu-render", "MainLoopThread", "grpc_global_tim", "emulator-audio"])
    assert.ok(!VCPU_COMM.test(c), c);
});

test("load-sampler: collect reads /proc/<qemu>/task/*/stat and /proc/stat through injected IO", () => {
  const files = {
    "/proc/11/stat": stat(11, "qemu-system-x86", 1000, 0),
    "/proc/11/task/11/stat": stat(11, "qemu-system-x86", 100, 0),
    "/proc/11/task/12/stat": stat(12, "CPU 0/KVM", 500, 100),
    "/proc/11/task/13/stat": stat(13, "gpu-render", 250, 50),
    "/proc/stat": procStat(600, 300, 40, 60),
  };
  const dirs = { "/proc/11/task": ["11", "12", "13"] };
  const run = (cmd, args) =>
    cmd === "pgrep" && args[1] === "qemu-system-" ? { code: 0, stdout: "11\n" } : { code: 1 };
  const s = collect(
    run,
    (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    { serial: "emulator-5554", context: "" },
    1000,
    (p) => {
      if (!(p in dirs)) throw new Error("ENOENT");
      return dirs[p];
    }
  );
  assert.deepStrictEqual(s.qemuThreads, [
    { pid: 11, tid: 11, comm: "qemu-system-x86", ticks: 100 },
    { pid: 11, tid: 12, comm: "CPU 0/KVM", ticks: 600 },
    { pid: 11, tid: 13, comm: "gpu-render", ticks: 300 },
  ]);
  assert.deepStrictEqual(s.hostCpu, { idle: 300, iowait: 40, steal: 60, total: 1000 });
});

test("load-sampler: no /proc (macOS) → qemuThreads [] and hostCpu null; interval fields null", () => {
  const nofile = () => {
    throw new Error("ENOENT");
  };
  const s = collect(() => ({ code: 1 }), nofile, { serial: "x", context: "" }, 1000, nofile);
  assert.deepStrictEqual(s.qemuThreads, []);
  assert.strictEqual(s.hostCpu, null);
  assert.deepStrictEqual(intervalLoad(s, { ...s, epochMs: 11000 }), {
    qemuVcpuPct: null,
    qemuOtherPct: null,
    hostIdlePct: null,
    hostStealPct: null,
    hostIowaitPct: null,
  });
});

test("load-sampler: interval → qemuVcpuPct / qemuOtherPct (100 % = one core) and host idle / steal / iowait %", () => {
  const S = (t, main, vcpu, other, host) => ({
    epochMs: t * 1000,
    context: "block ON-im-bg phase tap+describe",
    qemu: [{ pid: 1, ticks: main + vcpu + other }],
    qemuThreads: [
      { pid: 1, tid: 1, comm: "qemu-system-x86", ticks: main },
      { pid: 1, tid: 2, comm: "CPU 0/KVM", ticks: vcpu },
      { pid: 1, tid: 3, comm: "gpu-render", ticks: other },
    ],
    simServer: [{ pid: 9, ticks: 0 }],
    device: [],
    hostCpu: host,
  });
  const a = S(0, 0, 0, 0, { idle: 0, iowait: 0, steal: 0, total: 0 });
  // 10 s: main thread 100 ticks + vCPU 2000 = 21 s of CPU = 210 %; gpu 400 = 40 %.
  // Host: 4000 jiffies, idle 1000 = 25 %, steal 200 = 5 %, iowait 40 = 1 %.
  const b = S(10, 100, 2000, 400, { idle: 1000, iowait: 40, steal: 200, total: 4000 });
  assert.deepStrictEqual(intervalLoad(a, b), {
    qemuVcpuPct: 210,
    qemuOtherPct: 40,
    hostIdlePct: 25,
    hostStealPct: 5,
    hostIowaitPct: 1,
  });
  // A thread born mid-interval has no delta; a sample without the new fields reads null.
  assert.strictEqual(intervalLoad({ epochMs: 0, qemu: [] }, b).qemuVcpuPct, null);
  const agg = aggregate([
    a,
    b,
    S(20, 200, 4200, 700, { idle: 1600, iowait: 80, steal: 400, total: 8000 }),
  ]);
  const r = agg["ON-im-bg"]["tap+describe"];
  assert.strictEqual(r.qemuVcpuCpuPct.p50, 220);
  assert.strictEqual(r.qemuOtherCpuPct.p50, 35);
  assert.strictEqual(r.hostIdlePct.p50, 20);
  assert.strictEqual(r.hostStealPct.p50, 5);
  assert.strictEqual(r.hostIowaitPct.p50, 1);
  // Old samples (no per-thread / host fields) aggregate with those summaries null.
  const old = aggregate([
    { epochMs: 0, context: "block OFF-1 phase x", qemu: [{ pid: 1, ticks: 0 }] },
    { epochMs: 10000, context: "block OFF-1 phase x", qemu: [{ pid: 1, ticks: 100 }] },
  ])["OFF-1"].x;
  assert.strictEqual(old.qemuCpuPct.p50, 10);
  assert.strictEqual(old.qemuVcpuCpuPct, null);
  assert.strictEqual(old.hostIdlePct, null);
});

test("load-sampler: main writes the interval fields on each JSONL line (null on the first)", () => {
  const { sampleLine } = require("./load-sampler");
  const a = {
    epochMs: 0,
    qemu: [],
    qemuThreads: [],
    hostCpu: { idle: 0, iowait: 0, steal: 0, total: 0 },
  };
  const b = { ...a, epochMs: 10000, hostCpu: { idle: 50, iowait: 0, steal: 10, total: 100 } };
  const first = JSON.parse(sampleLine(null, a));
  assert.strictEqual(first.hostIdlePct, null);
  assert.ok("qemuVcpuPct" in first && "qemuOtherPct" in first && "hostStealPct" in first);
  const second = JSON.parse(sampleLine(a, b));
  assert.strictEqual(second.hostIdlePct, 50);
  assert.strictEqual(second.hostStealPct, 10);
  assert.strictEqual(typeof readSamples, "function");
});
