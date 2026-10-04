// Emulator diagnostics for the Android bench workflows (bench-open-vs-proprietary,
// bench-androidworld). Three jobs, all driven from emulator-diagnostics.sh:
//
//   env       write ci-emulator-env.json: emulator version + build id, system-image
//             revision, adb version, runner image ($ImageOS/$ImageVersion), kernel,
//             CPU count, free -m. Recorded so a run can tell an emulator-version
//             change from a runner-image change (2026-10-04 incident: emulator lost
//             mid-run, the last good runs' emulator version was never logged).
//   sampler   every 30 s append one line to host-sampler.log (mem available, swap
//             used, load, RSS/%CPU of qemu-system-*, simulator-server count, top-3
//             RSS) and print a compact heartbeat to the step log every 2 min.
//             Never fails: every probe error degrades to "?".
//   watchdog  every 10 s check the qemu-system-* process and `adb -s <serial>
//             get-state`. A vanished qemu process (once seen) or 3 consecutive
//             get-state failures declares the emulator LOST: print
//             `::error::emulator lost at <UTC> (<context>)`, write the marker JSON
//             the bench steps/harnesses read, and terminate the bench process tree
//             (SIGTERM, then SIGKILL after a grace period). It never restarts the
//             emulator: a rebooted device's results are not comparable.
//
// The pure parts (parsers, formatters, the 3-strikes reducer, kill-target selection,
// the env builder) take an injected command runner `run(cmd, args, opts) ->
// { code, stdout, stderr }` so emulator-diagnostics.test.js exercises them with no
// adb, ps or emulator.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/* ----------------------------------------------------------------------------- */
/* parsers                                                                        */
/* ----------------------------------------------------------------------------- */

const num = (s) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** `free -m` -> totals, available memory and swap used (MB); nulls when unparseable. */
function parseFreeM(text) {
  const out = { memTotalMb: null, memAvailMb: null, swapTotalMb: null, swapUsedMb: null };
  for (const line of String(text || "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[0] === "Mem:") {
      out.memTotalMb = num(f[1]);
      out.memAvailMb = num(f[6]);
    } else if (f[0] === "Swap:") {
      out.swapTotalMb = num(f[1]);
      out.swapUsedMb = num(f[2]);
    }
  }
  return out;
}

/** `ps -eo pid=,ppid=,rss=,times=,pcpu=,args=` -> rows (rss KiB -> MB, times = cpu s). */
function parsePs(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!m) continue;
    const args = m[6].trim();
    const first = args.split(/\s+/)[0] || "";
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssMb: Math.round(Number(m[3]) / 1024),
      cpuSec: Number(m[4]),
      pcpu: Number(m[5]),
      name: path.basename(first),
      args,
    });
  }
  return rows;
}

/** `ps -eo pid=,ppid=,args=` -> rows; portable (no procps-only columns) for the kill path. */
function parsePsTree(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3].trim() });
  }
  return rows;
}

const isQemu = (r) => r.name.startsWith("qemu-system-");
const isoSec = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/* ----------------------------------------------------------------------------- */
/* host sampler                                                                   */
/* ----------------------------------------------------------------------------- */

const PS_ARGS = ["-eo", "pid=,ppid=,rss=,times=,pcpu=,args="];
const PS_TREE_ARGS = ["-eo", "pid=,ppid=,args="];

/** One host sample through the injected runner. Probe failures become nulls. */
function collectSample(run, now = new Date()) {
  const safe = (cmd, args) => {
    try {
      const r = run(cmd, args, { timeoutMs: 10000 });
      return r && r.code === 0 ? String(r.stdout || "") : "";
    } catch {
      return "";
    }
  };
  const mem = parseFreeM(safe("free", ["-m"]));
  const load = safe("cat", ["/proc/loadavg"]).trim().split(/\s+/).slice(0, 3);
  const rows = parsePs(safe("ps", PS_ARGS)).sort((a, b) => b.rssMb - a.rssMb);
  return {
    time: isoSec(now),
    epochMs: now.getTime(),
    memAvailMb: mem.memAvailMb,
    swapUsedMb: mem.swapUsedMb,
    load: load.length === 3 && load.every((x) => x !== "") ? load : ["?", "?", "?"],
    qemu: rows
      .filter(isQemu)
      .map((r) => ({ pid: r.pid, rssMb: r.rssMb, cpuSec: r.cpuSec, pcpu: r.pcpu })),
    simServerCount: rows.filter((r) => r.args.includes("simulator-server")).length,
    top3: rows.slice(0, 3).map((r) => ({ name: r.name, rssMb: r.rssMb })),
  };
}

/** qemu %CPU over the last interval when `prev` saw the same pid; else ps' lifetime avg. */
function qemuCpu(q, sample, prev) {
  const p = prev && (prev.qemu || []).find((x) => x.pid === q.pid);
  const dt = prev ? (sample.epochMs - prev.epochMs) / 1000 : 0;
  if (p && dt > 0) return `${(((q.cpuSec - p.cpuSec) / dt) * 100).toFixed(1)}`;
  return `${q.pcpu.toFixed(1)}avg`;
}

const orQ = (v) => (v === null || v === undefined ? "?" : String(v));

/** The host-sampler.log line (UTC, mem, swap, load, qemu RSS/%CPU, sim-server, top-3). */
function formatSamplerLine(sample, prev) {
  const qemu = sample.qemu.length
    ? sample.qemu
        .map((q) => `${q.pid} rss_mb=${q.rssMb} cpu_pct=${qemuCpu(q, sample, prev)}`)
        .join("; ")
    : "none";
  const top = sample.top3.map((t) => `${t.name}:${t.rssMb}MB`).join(",");
  return (
    `${sample.time} mem_avail_mb=${orQ(sample.memAvailMb)} swap_used_mb=${orQ(sample.swapUsedMb)} ` +
    `load=${sample.load.join("/")} qemu=[${qemu}] sim_server=${sample.simServerCount} top3=[${top}]`
  );
}

/** The compact step-log heartbeat. */
function formatHeartbeat(sample, prev) {
  const q = sample.qemu[0];
  const qemu = q ? `${q.rssMb}MB/${qemuCpu(q, sample, prev)}%` : "none";
  return (
    `[host ${sample.time.slice(11)}] avail ${orQ(sample.memAvailMb)}MB swap ${orQ(sample.swapUsedMb)}MB ` +
    `load ${sample.load[0]} qemu ${qemu.replace(/avg%$/, "%avg")} sim-server ${sample.simServerCount}`
  );
}

/** Sampler loop. Append one line per interval; heartbeat every `heartbeatEvery` samples. */
function runSampler({
  run,
  logPath,
  intervalMs = 30000,
  heartbeatEvery = 4,
  maxSamples = Infinity,
  sleep,
  now = () => new Date(),
  log = (l) => process.stdout.write(l + "\n"),
}) {
  let prev = null;
  for (let i = 0; i < maxSamples; i++) {
    let line;
    let sample = null;
    try {
      sample = collectSample(run, now());
      line = formatSamplerLine(sample, prev);
    } catch (e) {
      line = `${isoSec(now())} sample-error ${e && e.message ? e.message : String(e)}`;
    }
    try {
      fs.appendFileSync(logPath, line + "\n");
    } catch {
      /* never fail the job over a log write */
    }
    if (sample && i % heartbeatEvery === 0) log(formatHeartbeat(sample, prev));
    if (sample) prev = sample;
    sleep(intervalMs);
  }
}

/* ----------------------------------------------------------------------------- */
/* liveness watchdog                                                              */
/* ----------------------------------------------------------------------------- */

function initialWatchdogState() {
  return { strikes: 0, lost: false, processArmed: null, reason: null };
}

/**
 * The 3-strikes reducer. `obs = { processAlive, adbState }`. The process check arms
 * only once a qemu-system-* process has been seen (a name mismatch must never kill a
 * healthy bench); a vanished process after that is definitive. `adb get-state` must
 * read `device`; `maxStrikes` consecutive other reads declare the emulator lost.
 */
function nextWatchdogState(state, obs, maxStrikes = 3) {
  if (state.lost) return state;
  const processArmed = state.processArmed === null ? obs.processAlive === true : state.processArmed;
  if (processArmed && obs.processAlive === false) {
    return {
      strikes: state.strikes,
      lost: true,
      processArmed,
      reason: "emulator qemu-system-* process gone",
    };
  }
  if (obs.adbState === "device") return { strikes: 0, lost: false, processArmed, reason: null };
  const strikes = state.strikes + 1;
  const last = obs.adbState ? obs.adbState : "(no output)";
  const reason = `adb get-state failed ${strikes} consecutive checks (last: ${last})`;
  return { strikes, lost: strikes >= maxStrikes, processArmed, reason };
}

/** One liveness observation through the injected runner. */
function observe(run, serial) {
  const p = run("pgrep", ["-f", "qemu-system-"], { timeoutMs: 5000 });
  const a = run("adb", ["-s", serial, "get-state"], { timeoutMs: 8000 });
  return {
    processAlive: Boolean(p && p.code === 0 && String(p.stdout || "").trim()),
    adbState: String((a && (a.stdout || a.stderr)) || "")
      .trim()
      .split("\n")
      .pop(),
  };
}

/**
 * The processes to terminate: every row whose args match `pattern` (minus this
 * watchdog and the diagnostics scripts themselves) as roots, plus all descendants,
 * captured BEFORE any kill (orphans get re-parented to init afterwards).
 */
function selectKillTargets(rows, pattern, selfPid) {
  const rx = new RegExp(pattern);
  const roots = rows
    .filter((r) => r.pid !== selfPid && !r.args.includes("emulator-diagnostics") && rx.test(r.args))
    .map((r) => r.pid);
  const rootSet = new Set(roots);
  // Only the top-most matches are roots (a matching child is already in the tree).
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const topRoots = roots.filter((pid) => {
    let p = byPid.get(pid);
    while (p && byPid.has(p.ppid)) {
      if (rootSet.has(p.ppid)) return false;
      p = byPid.get(p.ppid);
    }
    return true;
  });
  const tree = new Set(topRoots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (!tree.has(r.pid) && tree.has(r.ppid) && r.pid !== selfPid) {
        tree.add(r.pid);
        grew = true;
      }
    }
  }
  return { roots: topRoots, tree: [...tree] };
}

const readContext = (p) => {
  try {
    return fs.readFileSync(p, "utf8").trim() || null;
  } catch {
    return null;
  }
};

/** Watchdog loop. Returns `{ lost, lostAt, reason }` (lost false when maxChecks ran out). */
function runWatchdog({
  serial,
  intervalMs = 10000,
  strikes = 3,
  graceMs = 30000,
  markerPath,
  contextPath,
  killPattern,
  run,
  sleep,
  now = () => new Date(),
  log = (l) => process.stdout.write(l + "\n"),
  kill = (pid, sig) => {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  },
  isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  selfPid = process.pid,
  maxChecks = Infinity,
}) {
  let st = initialWatchdogState();
  for (let i = 0; i < maxChecks; i++) {
    if (i > 0) sleep(intervalMs);
    const obs = observe(run, serial);
    const prevStrikes = st.strikes;
    st = nextWatchdogState(st, obs, strikes);
    if (!st.lost && st.strikes > prevStrikes) {
      log(`[watchdog ${isoSec(now()).slice(11)}] strike ${st.strikes}/${strikes}: ${st.reason}`);
    }
    if (!st.lost) continue;
    const lostAt = isoSec(now());
    const context = contextPath ? readContext(contextPath) : null;
    log(`::error::emulator lost at ${lostAt}${context ? ` (${context})` : ""}`);
    log(`[watchdog] ${st.reason} — terminating the bench (no emulator restart)`);
    const marker = { lostAt, reason: st.reason, context, serial };
    try {
      if (markerPath) fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n");
    } catch {
      /* the ::error:: line above is the primary signal */
    }
    if (killPattern) {
      const ps = run("ps", PS_TREE_ARGS, { timeoutMs: 10000 });
      const rows = parsePsTree(ps && ps.stdout);
      const { roots, tree } = selectKillTargets(rows, killPattern, selfPid);
      log(`[watchdog] SIGTERM ${roots.join(",") || "(no matching process)"}`);
      for (const pid of roots) kill(pid, "SIGTERM");
      // Give a harness its SIGTERM handler time to write a partial report, then
      // SIGKILL whatever is left of the captured tree (a child holding the step's
      // `| tee` pipe open would otherwise hang the step).
      const deadline = now().getTime() + graceMs;
      while (roots.some(isAlive) && now().getTime() < deadline) sleep(1000);
      for (const pid of tree) if (isAlive(pid)) kill(pid, "SIGKILL");
    }
    return { lost: true, lostAt, reason: st.reason };
  }
  return { lost: false, lostAt: null, reason: null };
}

/* ----------------------------------------------------------------------------- */
/* ci-emulator-env.json                                                           */
/* ----------------------------------------------------------------------------- */

function readProp(file, key) {
  try {
    const m = fs.readFileSync(file, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** The emulator/host environment record embedded in the bench provenance. */
function buildEmulatorEnv({ run, sdkRoot, sysimgPackage, env = process.env, now = new Date() }) {
  const out = (cmd, args) => {
    try {
      const r = run(cmd, args, { timeoutMs: 30000 });
      return r && r.code === 0 ? `${r.stdout || ""}${r.stderr || ""}` : "";
    } catch {
      return "";
    }
  };
  const emuText = out(path.join(sdkRoot, "emulator", "emulator"), ["-version"]);
  const vm = emuText.match(/^.*Android emulator version (\S+) \(build_id (\d+)\).*$/m);
  const adbText = out("adb", ["version"]);
  const sysDir = path.join(sdkRoot, ...String(sysimgPackage || "").split(";"));
  const memoryMb = num(env.EMULATOR_MEMORY_MB);
  return {
    emulator: {
      version: vm ? vm[1] : null,
      buildId: vm ? vm[2] : null,
      packageRevision: readProp(
        path.join(sdkRoot, "emulator", "source.properties"),
        "Pkg.Revision"
      ),
      pinnedBuild: env.EMULATOR_BUILD ? String(env.EMULATOR_BUILD) : null,
      gpu: env.EMULATOR_GPU || null,
      memoryMb: env.EMULATOR_MEMORY_MB ? memoryMb : null,
      versionLine: vm ? vm[0].trim() : null,
    },
    systemImage: {
      package: sysimgPackage || null,
      revision: readProp(path.join(sysDir, "source.properties"), "Pkg.Revision"),
    },
    adb: {
      version: (adbText.match(/Android Debug Bridge version (\S+)/) || [])[1] || null,
      platformTools: (adbText.match(/^Version (\S+)/m) || [])[1] || null,
    },
    runnerImage: { os: env.ImageOS || null, version: env.ImageVersion || null },
    kernel: out("uname", ["-r"]).trim() || null,
    nproc: num(out("nproc", []).trim() || "x"),
    memory: parseFreeM(out("free", ["-m"])),
    recordedAt: now.toISOString(),
  };
}

/* ----------------------------------------------------------------------------- */
/* CLI                                                                            */
/* ----------------------------------------------------------------------------- */

function realRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args || [], {
    encoding: "utf8",
    timeout: opts.timeoutMs || 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status === null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

const realSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function flags(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[i + 1] ?? "";
  }
  return o;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  if (cmd === "env") {
    const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || "";
    const e = buildEmulatorEnv({ run: realRun, sdkRoot, sysimgPackage: f.sysimg });
    const json = JSON.stringify(e, null, 2) + "\n";
    if (f.out) {
      fs.mkdirSync(path.dirname(f.out), { recursive: true });
      fs.writeFileSync(f.out, json);
    }
    process.stdout.write(json);
    return 0;
  }
  if (cmd === "sampler") {
    process.on("SIGTERM", () => process.exit(0));
    const hours = Number(f["max-hours"] || 6);
    const intervalMs = Number(f.interval || 30) * 1000;
    runSampler({
      run: realRun,
      logPath: f.log,
      intervalMs,
      heartbeatEvery: Number(f["heartbeat-every"] || 4),
      maxSamples: Math.ceil((hours * 3600 * 1000) / intervalMs),
      sleep: realSleep,
    });
    return 0;
  }
  if (cmd === "watchdog") {
    process.on("SIGTERM", () => process.exit(0));
    runWatchdog({
      serial: f.serial || "emulator-5554",
      intervalMs: Number(f.interval || 10) * 1000,
      strikes: Number(f.strikes || 3),
      graceMs: Number(f.grace || 30) * 1000,
      markerPath: f.marker,
      contextPath: f.context,
      killPattern: f["kill-pattern"],
      run: realRun,
      sleep: realSleep,
    });
    return 0;
  }
  process.stderr.write("usage: emulator-diagnostics.js env|sampler|watchdog [--flags]\n");
  return 2;
}

module.exports = {
  parseFreeM,
  parsePs,
  parsePsTree,
  collectSample,
  formatSamplerLine,
  formatHeartbeat,
  initialWatchdogState,
  nextWatchdogState,
  observe,
  selectKillTargets,
  runWatchdog,
  buildEmulatorEnv,
};

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    // Diagnostics must never fail the job.
    process.stderr.write(`[emulator-diagnostics] ${e && e.stack ? e.stack : String(e)}\n`);
    process.exitCode = 0;
  }
}
