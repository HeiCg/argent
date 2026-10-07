// Per-phase CPU load of the emulator, the proprietary host process and the on-device
// agents (Review 2026-10-07 run 37591260027 finding 1).
//
// That run's host sampler (emulator-diagnostics.js, every 30 s, block level only) showed
// qemu CPU p50 250-262 % in the OFF blocks vs 202-210 % in the ON blocks, with
// simulator-server alive only in OFF. To say what the proprietary stack runs in the
// background, and where, this sampler records every INTERVAL (10 s):
//  - host: cumulative CPU ticks of the qemu-system-* process and of every simulator-server
//    process (/proc/<pid>/stat utime + stime);
//  - device: cumulative CPU ticks of every com.argent.* process (the open server
//    com.argent.devicecontrol, the proprietary helper com.argent.androiddevtools) read
//    with one `adb shell` per interval (ps -A + /proc/<pid>/stat);
//  - the bench context ($BENCH_CONTEXT_FILE: `block <name> phase <phase>`, written by the
//    harness at every phase change).
// Review run 37609765062 (Part A findings 3 and 6): the qemu total does not say WHERE the
// emulator spends its CPU, and at 290-345 % on 4 cores the host is saturated. Each sample
// also records:
//  - qemu per thread: /proc/<qemu pid>/task/<tid>/stat (comm + utime + stime). A thread
//    whose comm matches VCPU_COMM counts as vCPU, every other thread as "other" (GPU,
//    gRPC, audio, ...). Unnamed threads inherit the process comm (qemu-system-…), so the
//    main loop thread lands in vCPU: the split reads "named emulator threads" vs the rest.
//  - the host: the aggregate `cpu` line of /proc/stat (idle, iowait, steal jiffies).
// and each JSONL line carries the interval fields against the previous sample
// (sampleLine): qemuVcpuPct, qemuOtherPct (100 % = one core), hostIdlePct, hostStealPct,
// hostIowaitPct (% of all host CPU time). Where /proc is absent (macOS) they are null.
// CPU % per interval = Δticks / HZ / Δt × 100 (100 % = one core), an interval reading, the
// same arithmetic as top's %CPU. `aggregate` assigns each interval to the phase that was
// current at both of its ends ("mixed" otherwise) and summarises per (block, phase).
//
// Usage (background, inside the bench step):
//   node load-sampler.js --serial emulator-5554 --context <file> --out <jsonl> [--interval 10000]
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const { summarize } = require("./stats");

const HZ = 100; // USER_HZ on the x86_64 runner and on the Android guest
// The vCPU threads of qemu (review run 37609765062 "Follow-ups" 1).
const VCPU_COMM = /^(qemu|.*vCPU|CPU \d+)/;
const DEVICE_CMD =
  "ps -A -o PID,NAME | grep com.argent | while read p n; do " +
  'echo "@@P $p $n $(cat /proc/$p/stat 2>/dev/null)"; done; true';

/** utime + stime from a /proc/<pid>/stat line (fields after the comm's closing paren). */
function statTicks(line) {
  const s = String(line || "");
  const close = s.lastIndexOf(")");
  if (close < 0) return null;
  const f = s
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ut = Number(f[11]);
  const st = Number(f[12]);
  return Number.isFinite(ut) && Number.isFinite(st) ? ut + st : null;
}

/** The comm of a /proc/<pid>/stat line (between the first "(" and the last ")"). */
function commOf(line) {
  const s = String(line || "");
  const open = s.indexOf("(");
  const close = s.lastIndexOf(")");
  return open >= 0 && close > open ? s.slice(open + 1, close) : null;
}

/** The aggregate `cpu` line of /proc/stat → jiffies { idle, iowait, steal, total }. */
function parseHostStat(text) {
  const line = String(text || "")
    .split("\n")
    .find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  // user nice system idle iowait irq softirq steal [guest guest_nice]; guest time is
  // already inside user/nice, so the total is user..steal.
  const f = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (f.length < 8 || f.some((x) => !Number.isFinite(x))) return null;
  return { idle: f[3], iowait: f[4], steal: f[7], total: f.reduce((a, b) => a + b, 0) };
}

/** DEVICE_CMD output → [{ pid, name, ticks }]. */
function parseDeviceProcs(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^@@P (\d+) (\S+) (.*)$/);
    if (!m) continue;
    const ticks = statTicks(m[3]);
    if (ticks != null) out.push({ pid: Number(m[1]), name: m[2], ticks });
  }
  return out;
}

/** `block <b> phase <p>` → { block, phase }; a bare `block <b>` → phase "(block)". */
function parseContext(text) {
  const s = String(text || "").trim();
  const m = s.match(/^block (\S+)(?: phase (.+))?$/);
  if (!m) return { block: null, phase: null };
  return { block: m[1], phase: m[2] ? m[2].trim() : "(block)" };
}

/**
 * One sample through the injected runner `run(cmd, args) → { code, stdout }`, file reader
 * and directory lister (`listDir(path) → names`).
 */
function collect(run, readFile, opts, now = Date.now(), listDir = (p) => fs.readdirSync(p)) {
  const out = (cmd, args) => {
    try {
      const r = run(cmd, args);
      return r && r.code === 0 ? String(r.stdout || "") : "";
    } catch {
      return "";
    }
  };
  const pids = (pattern) =>
    out("pgrep", ["-f", pattern])
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((p) => p !== process.pid);
  const procTicks = (pid) => {
    try {
      return statTicks(readFile(`/proc/${pid}/stat`));
    } catch {
      return null;
    }
  };
  const qemu = pids("qemu-system-")
    .map((pid) => ({ pid, ticks: procTicks(pid) }))
    .filter((x) => x.ticks != null);
  const simServer = pids("simulator-server .*android")
    .map((pid) => ({ pid, ticks: procTicks(pid) }))
    .filter((x) => x.ticks != null);
  const qemuThreads = [];
  for (const { pid } of qemu) {
    let tids = [];
    try {
      tids = listDir(`/proc/${pid}/task`);
    } catch {
      tids = [];
    }
    for (const t of tids) {
      let line;
      try {
        line = readFile(`/proc/${pid}/task/${t}/stat`);
      } catch {
        continue;
      }
      const ticks = statTicks(line);
      if (ticks != null) qemuThreads.push({ pid, tid: Number(t), comm: commOf(line), ticks });
    }
  }
  let hostCpu = null;
  try {
    hostCpu = parseHostStat(readFile("/proc/stat"));
  } catch {
    hostCpu = null;
  }
  const device = parseDeviceProcs(out("adb", ["-s", opts.serial, "shell", DEVICE_CMD]));
  let context;
  try {
    context = opts.context ? readFile(opts.context) : "";
  } catch {
    context = "";
  }
  return {
    epochMs: now,
    context: String(context).trim(),
    qemu,
    qemuThreads,
    simServer,
    device,
    hostCpu,
  };
}

/** Sum of tick deltas over pids present in both samples (a new pid has no delta). */
function deltaTicks(prev, cur) {
  const before = new Map(prev.map((x) => [x.pid, x.ticks]));
  let sum = 0;
  let any = false;
  for (const x of cur) {
    if (!before.has(x.pid)) continue;
    sum += Math.max(0, x.ticks - before.get(x.pid));
    any = true;
  }
  return any ? sum : null;
}

/**
 * The interval readings between two samples: qemu vCPU / other threads (100 % = one core,
 * threads present at both ends) and host idle / steal / iowait (% of all host CPU time).
 * null where either end lacks the data (/proc absent, an old sample, no thread overlap).
 */
function intervalLoad(a, b) {
  const out = {
    qemuVcpuPct: null,
    qemuOtherPct: null,
    hostIdlePct: null,
    hostStealPct: null,
    hostIowaitPct: null,
  };
  if (!a || !b) return out;
  const dt = (b.epochMs - a.epochMs) / 1000;
  const r1 = (x) => Number(x.toFixed(1));
  const ta = Array.isArray(a.qemuThreads) ? a.qemuThreads : [];
  const tb = Array.isArray(b.qemuThreads) ? b.qemuThreads : [];
  if (dt > 0 && ta.length && tb.length) {
    const key = (x) => `${x.pid}/${x.tid}`;
    const before = new Map(ta.map((x) => [key(x), x.ticks]));
    let vcpu = 0;
    let other = 0;
    let any = false;
    for (const x of tb) {
      if (!before.has(key(x))) continue;
      const d = Math.max(0, x.ticks - before.get(key(x)));
      if (VCPU_COMM.test(String(x.comm || ""))) vcpu += d;
      else other += d;
      any = true;
    }
    if (any) {
      out.qemuVcpuPct = r1((vcpu / HZ / dt) * 100);
      out.qemuOtherPct = r1((other / HZ / dt) * 100);
    }
  }
  const ha = a.hostCpu;
  const hb = b.hostCpu;
  if (ha && hb && hb.total > ha.total) {
    const tot = hb.total - ha.total;
    const share = (k) => r1((Math.max(0, hb[k] - ha[k]) / tot) * 100);
    out.hostIdlePct = share("idle");
    out.hostStealPct = share("steal");
    out.hostIowaitPct = share("iowait");
  }
  return out;
}

/** One JSONL line: the sample plus its interval fields against the previous one. */
function sampleLine(prev, cur) {
  return JSON.stringify({ ...cur, ...intervalLoad(prev, cur) });
}

/**
 * Per (block, phase) summaries of the interval CPU %: qemu, simulator-server (0 when no
 * process was alive at either end: it was not running), com.argent.* on the device (sum,
 * and per process name). Intervals whose ends saw different contexts count as "mixed".
 * @param {Array<ReturnType<typeof collect>>} samples
 */
function aggregate(samples) {
  const out = {};
  const pct = (ticks, dtSec) => Number(((ticks / HZ / dtSec) * 100).toFixed(1));
  for (let k = 1; k < samples.length; k++) {
    const a = samples[k - 1];
    const b = samples[k];
    const dt = (b.epochMs - a.epochMs) / 1000;
    if (!(dt > 0)) continue;
    const ca = parseContext(a.context);
    const cb = parseContext(b.context);
    if (!cb.block) continue;
    const phase = ca.block === cb.block && ca.phase === cb.phase ? cb.phase : "mixed";
    const row = ((out[cb.block] = out[cb.block] || {})[phase] = out[cb.block][phase] || {
      qemu: [],
      simServer: [],
      simServerAlive: 0,
      argent: [],
      argentByName: {},
      qemuVcpu: [],
      qemuOther: [],
      hostIdle: [],
      hostSteal: [],
      hostIowait: [],
    });
    const q = deltaTicks(a.qemu || [], b.qemu || []);
    if (q != null) row.qemu.push(pct(q, dt));
    const alive = (a.simServer || []).length > 0 || (b.simServer || []).length > 0;
    if (alive) row.simServerAlive++;
    const s = deltaTicks(a.simServer || [], b.simServer || []);
    row.simServer.push(s == null ? 0 : pct(s, dt));
    const d = deltaTicks(a.device || [], b.device || []);
    row.argent.push(d == null ? 0 : pct(d, dt));
    for (const name of new Set((b.device || []).map((x) => x.name))) {
      const t = deltaTicks(
        (a.device || []).filter((x) => x.name === name),
        (b.device || []).filter((x) => x.name === name)
      );
      if (t != null) (row.argentByName[name] = row.argentByName[name] || []).push(pct(t, dt));
    }
    // Review run 37609765062: recomputed from the raw ticks / jiffies of both ends.
    const il = intervalLoad(a, b);
    if (il.qemuVcpuPct != null) row.qemuVcpu.push(il.qemuVcpuPct);
    if (il.qemuOtherPct != null) row.qemuOther.push(il.qemuOtherPct);
    if (il.hostIdlePct != null) row.hostIdle.push(il.hostIdlePct);
    if (il.hostStealPct != null) row.hostSteal.push(il.hostStealPct);
    if (il.hostIowaitPct != null) row.hostIowait.push(il.hostIowaitPct);
  }
  const sum = (xs) => (xs.length ? summarize(xs) : null);
  for (const phases of Object.values(out)) {
    for (const [ph, r] of Object.entries(phases)) {
      phases[ph] = {
        intervals: r.qemu.length || r.simServer.length,
        qemuCpuPct: r.qemu.length ? summarize(r.qemu) : null,
        simServerCpuPct: r.simServer.length ? summarize(r.simServer) : null,
        simServerAliveIntervals: r.simServerAlive,
        argentCpuPct: r.argent.length ? summarize(r.argent) : null,
        argentByName: Object.fromEntries(
          Object.entries(r.argentByName).map(([n, xs]) => [n, summarize(xs)])
        ),
        qemuVcpuCpuPct: sum(r.qemuVcpu),
        qemuOtherCpuPct: sum(r.qemuOther),
        hostIdlePct: sum(r.hostIdle),
        hostStealPct: sum(r.hostSteal),
        hostIowaitPct: sum(r.hostIowait),
      };
    }
  }
  return out;
}

/** Read a JSONL file written by the sampler; [] when absent. */
function readSamples(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function main(argv) {
  const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const opts = {
    serial: opt("serial", "emulator-5554"),
    context: opt("context", process.env.BENCH_CONTEXT_FILE || ""),
    out: opt("out", ""),
    interval: Number(opt("interval", "10000")),
  };
  if (!opts.out) throw new Error("load-sampler: --out <jsonl> is required");
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
    return { code: r.status, stdout: r.stdout };
  };
  const readFile = (p) => fs.readFileSync(p, "utf8");
  const sab = new Int32Array(new SharedArrayBuffer(4));
  let prev = null;
  for (;;) {
    const t0 = Date.now();
    try {
      const cur = collect(run, readFile, opts);
      fs.appendFileSync(opts.out, sampleLine(prev, cur) + "\n");
      prev = cur;
    } catch {
      /* never fail the bench over a sample */
    }
    Atomics.wait(sab, 0, 0, Math.max(0, opts.interval - (Date.now() - t0)));
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  VCPU_COMM,
  commOf,
  parseHostStat,
  intervalLoad,
  sampleLine,
  DEVICE_CMD,
  statTicks,
  parseDeviceProcs,
  parseContext,
  collect,
  aggregate,
  readSamples,
};
