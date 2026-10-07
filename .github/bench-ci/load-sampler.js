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

/** One sample through the injected runner `run(cmd, args) → { code, stdout }`. */
function collect(run, readFile, opts, now = Date.now()) {
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
  const device = parseDeviceProcs(out("adb", ["-s", opts.serial, "shell", DEVICE_CMD]));
  let context;
  try {
    context = opts.context ? readFile(opts.context) : "";
  } catch {
    context = "";
  }
  return { epochMs: now, context: String(context).trim(), qemu, simServer, device };
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
  }
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
  for (;;) {
    const t0 = Date.now();
    try {
      fs.appendFileSync(opts.out, JSON.stringify(collect(run, readFile, opts)) + "\n");
    } catch {
      /* never fail the bench over a sample */
    }
    Atomics.wait(sab, 0, 0, Math.max(0, opts.interval - (Date.now() - t0)));
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  DEVICE_CMD,
  statTicks,
  parseDeviceProcs,
  parseContext,
  collect,
  aggregate,
  readSamples,
};
