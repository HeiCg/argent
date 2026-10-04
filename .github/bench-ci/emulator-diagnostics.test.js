// Unit tests for the emulator diagnostics helpers (emulator-diagnostics.js): the
// ci-emulator-env.json builder, the host-sampler line + heartbeat formatters, the
// liveness watchdog's 3-strikes reducer and its kill-target selection. Every
// command runner is injected, so nothing here touches adb, ps or an emulator.
//
// Run: node --test .github/bench-ci/emulator-diagnostics.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  buildEmulatorEnv,
  collectSample,
  formatHeartbeat,
  formatSamplerLine,
  initialWatchdogState,
  nextWatchdogState,
  observe,
  parseFreeM,
  parsePs,
  parsePsTree,
  runWatchdog,
  selectKillTargets,
} = require("./emulator-diagnostics");

const FREE_M = `               total        used        free      shared  buff/cache   available
Mem:           15989        5122        2020          45        9218       10867
Swap:           3071         512        2559
`;

// `ps -eo pid=,ppid=,rss=,times=,pcpu=,args= --sort=-rss` (rss in KiB, times in s).
const PS = `   4122    4100 4044800    1200 187.4 /usr/local/lib/android/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64 -netdelay none @argent-test
   5000    4900  831488     300  20.1 java -Xmx2g -jar gradle.jar
   5100    5050  655360     120  10.0 node .github/bench-ci/run-bench.js
   5200    5100  102400      40   5.0 /tmp/argent-pkg/bin/linux/simulator-server android --id emulator-5554
   5300    5100   20480       2   0.1 adb -s emulator-5554 shell getprop
`;

// The kill path's minimal listing (`ps -eo pid=,ppid=,args=`), the same processes.
const PS_TREE = PS.split("\n")
  .map((l) => l.replace(/^(\s*\d+\s+\d+)\s+\d+\s+\d+\s+[\d.]+(\s+.*)$/, "$1$2"))
  .join("\n");

/** Fake runner: maps "cmd args..." to { code, stdout }. */
function fakeRun(table) {
  return (cmd, args) => {
    const key = [cmd, ...(args || [])].join(" ");
    for (const [k, v] of Object.entries(table)) {
      if (key === k || key.startsWith(k)) return typeof v === "function" ? v() : v;
    }
    return { code: 127, stdout: "" };
  };
}

test("parseFreeM: available memory, swap used, totals", () => {
  assert.deepStrictEqual(parseFreeM(FREE_M), {
    memTotalMb: 15989,
    memAvailMb: 10867,
    swapTotalMb: 3071,
    swapUsedMb: 512,
  });
  assert.deepStrictEqual(parseFreeM("garbage"), {
    memTotalMb: null,
    memAvailMb: null,
    swapTotalMb: null,
    swapUsedMb: null,
  });
});

test("parsePs: pid/ppid/rss MB/cpu seconds/pcpu/name/args", () => {
  const rows = parsePs(PS);
  assert.strictEqual(rows.length, 5);
  assert.deepStrictEqual(
    { ...rows[0], args: undefined },
    {
      pid: 4122,
      ppid: 4100,
      rssMb: 3950,
      cpuSec: 1200,
      pcpu: 187.4,
      name: "qemu-system-x86_64",
      args: undefined,
    }
  );
  assert.strictEqual(rows[3].name, "simulator-server");
});

test("collectSample + formatSamplerLine: one line with every required field", () => {
  const run = fakeRun({
    "free": { code: 0, stdout: FREE_M },
    "cat /proc/loadavg": { code: 0, stdout: "1.52 1.40 1.33 3/812 9999\n" },
    "ps": { code: 0, stdout: PS },
  });
  const s = collectSample(run, new Date("2026-10-04T16:38:00.123Z"));
  const line = formatSamplerLine(s, null);
  assert.strictEqual(
    line,
    "2026-10-04T16:38:00Z mem_avail_mb=10867 swap_used_mb=512 load=1.52/1.40/1.33 " +
      "qemu=[4122 rss_mb=3950 cpu_pct=187.4avg] sim_server=1 " +
      "top3=[qemu-system-x86_64:3950MB,java:812MB,node:640MB]"
  );
});

test("formatSamplerLine: qemu %CPU from the cpu-time delta when a previous sample exists", () => {
  const prev = {
    time: "2026-10-04T16:37:30Z",
    epochMs: Date.parse("2026-10-04T16:37:30Z"),
    memAvailMb: 1,
    swapUsedMb: 0,
    load: ["0.1", "0.1", "0.1"],
    qemu: [{ pid: 4122, rssMb: 3900, cpuSec: 1140, pcpu: 180 }],
    simServerCount: 0,
    top3: [],
  };
  const cur = { ...prev, time: "2026-10-04T16:38:00Z", epochMs: prev.epochMs + 30000 };
  cur.qemu = [{ pid: 4122, rssMb: 3950, cpuSec: 1200, pcpu: 181 }];
  // 60 cpu-seconds over 30 wall-seconds = 200%.
  assert.match(formatSamplerLine(cur, prev), /qemu=\[4122 rss_mb=3950 cpu_pct=200\.0\]/);
});

test("formatSamplerLine: no qemu process and failed probes still give one line", () => {
  const run = fakeRun({});
  const s = collectSample(run, new Date("2026-10-04T16:40:00Z"));
  assert.strictEqual(
    formatSamplerLine(s, null),
    "2026-10-04T16:40:00Z mem_avail_mb=? swap_used_mb=? load=?/?/? qemu=[none] sim_server=0 top3=[]"
  );
});

test("formatHeartbeat: compact one-liner", () => {
  const run = fakeRun({
    "free": { code: 0, stdout: FREE_M },
    "cat /proc/loadavg": { code: 0, stdout: "1.52 1.40 1.33 3/812 9999\n" },
    "ps": { code: 0, stdout: PS },
  });
  const s = collectSample(run, new Date("2026-10-04T16:38:00Z"));
  assert.strictEqual(
    formatHeartbeat(s, null),
    "[host 16:38:00Z] avail 10867MB swap 512MB load 1.52 qemu 3950MB/187.4%avg sim-server 1"
  );
});

test("watchdog: 3 consecutive adb failures declare the emulator lost; a good read resets", () => {
  let st = initialWatchdogState();
  st = nextWatchdogState(st, { processAlive: true, adbState: "device" });
  assert.strictEqual(st.lost, false);
  st = nextWatchdogState(st, { processAlive: true, adbState: "offline" });
  st = nextWatchdogState(st, { processAlive: true, adbState: "error: timeout" });
  assert.strictEqual(st.strikes, 2);
  assert.strictEqual(st.lost, false);
  st = nextWatchdogState(st, { processAlive: true, adbState: "device" });
  assert.strictEqual(st.strikes, 0);
  for (let i = 0; i < 2; i++) st = nextWatchdogState(st, { processAlive: true, adbState: "" });
  assert.strictEqual(st.lost, false);
  st = nextWatchdogState(st, {
    processAlive: true,
    adbState: "error: device 'emulator-5554' not found",
  });
  assert.strictEqual(st.lost, true);
  assert.match(st.reason, /adb get-state failed 3 consecutive checks/);
  assert.match(st.reason, /not found/);
  // Once lost, stays lost.
  st = nextWatchdogState(st, { processAlive: true, adbState: "device" });
  assert.strictEqual(st.lost, true);
});

test("watchdog: the qemu process vanishing is definitive (no strikes needed)", () => {
  let st = initialWatchdogState();
  st = nextWatchdogState(st, { processAlive: true, adbState: "device" });
  st = nextWatchdogState(st, { processAlive: false, adbState: "device" });
  assert.strictEqual(st.lost, true);
  assert.match(st.reason, /qemu-system-\* process gone/);
});

test("watchdog: a qemu process never seen does not arm the process check (adb only)", () => {
  let st = initialWatchdogState();
  st = nextWatchdogState(st, { processAlive: false, adbState: "device" });
  st = nextWatchdogState(st, { processAlive: false, adbState: "device" });
  assert.strictEqual(st.lost, false);
  assert.strictEqual(st.processArmed, false);
});

test("observe: uses the injected runner for pgrep + adb get-state", () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "pgrep") return { code: 0, stdout: "4122\n" };
    return { code: 0, stdout: "device\n" };
  };
  assert.deepStrictEqual(observe(run, "emulator-5554"), {
    processAlive: true,
    adbState: "device",
  });
  assert.deepStrictEqual(calls, ["pgrep -f qemu-system-", "adb -s emulator-5554 get-state"]);
  const dead = (cmd) =>
    cmd === "pgrep"
      ? { code: 1, stdout: "" }
      : { code: 1, stdout: "error: device 'emulator-5554' not found" };
  assert.deepStrictEqual(observe(dead, "emulator-5554"), {
    processAlive: false,
    adbState: "error: device 'emulator-5554' not found",
  });
});

test("runWatchdog: 3 strikes 10 s apart -> ::error:: line, marker, kill of the bench tree", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emu-wd-"));
  const marker = path.join(dir, "emulator-lost.json");
  const ctx = path.join(dir, "context");
  fs.writeFileSync(ctx, "block ON-uiautomation\n");
  const out = [];
  const killed = [];
  let t = Date.parse("2026-10-04T16:38:00Z");
  let n = 0;
  const run = (cmd, args) => {
    if (cmd === "pgrep") return { code: 0, stdout: "4122\n" };
    // Only the minimal pid/ppid/args listing is served: the kill path must not
    // depend on procps-only columns (macOS ps has no `times`).
    if (cmd === "ps") {
      return args.join(" ") === "-eo pid=,ppid=,args="
        ? { code: 0, stdout: PS_TREE }
        : { code: 1, stdout: "" };
    }
    n++;
    return n <= 2 ? { code: 0, stdout: "device" } : { code: 1, stdout: "error: closed" };
  };
  const res = runWatchdog({
    serial: "emulator-5554",
    intervalMs: 10000,
    strikes: 3,
    markerPath: marker,
    contextPath: ctx,
    killPattern: "run-bench\\.js",
    run,
    sleep: (ms) => {
      t += ms;
    },
    now: () => new Date(t),
    log: (l) => out.push(l),
    kill: (pid, sig) => killed.push([pid, sig]),
    isAlive: () => false,
    selfPid: 99999,
    maxChecks: 50,
  });
  assert.strictEqual(res.lost, true);
  // Checks 1-2 ok, 3-5 fail -> lost at the 5th check, 40 s after the first.
  assert.strictEqual(res.lostAt, "2026-10-04T16:38:40Z");
  assert.ok(
    out.includes("::error::emulator lost at 2026-10-04T16:38:40Z (block ON-uiautomation)"),
    out.join("\n")
  );
  const m = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.strictEqual(m.context, "block ON-uiautomation");
  assert.strictEqual(m.serial, "emulator-5554");
  assert.match(m.reason, /3 consecutive/);
  // run-bench.js (5100) and its descendants (5200 simulator-server, 5300 adb) are
  // TERMed; qemu / java untouched.
  assert.deepStrictEqual(
    killed.filter(([, s]) => s === "SIGTERM").map(([p]) => p),
    [5100]
  );
  assert.ok(!killed.some(([p]) => p === 4122 || p === 5000));
});

test("selectKillTargets: matching roots + descendants, never self or the diagnostics script", () => {
  const rows = parsePsTree(
    PS_TREE +
      "\n   7000       1 node .github/bench-ci/emulator-diagnostics.js watchdog --kill-pattern run-bench.js\n"
  );
  const t = selectKillTargets(rows, "run-bench\\.js", 7000);
  assert.deepStrictEqual(t.roots, [5100]);
  assert.deepStrictEqual(t.tree.sort(), [5100, 5200, 5300]);
});

test("buildEmulatorEnv: version, build id, sysimg revision, adb, runner image, host facts", () => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), "emu-sdk-"));
  const sys = path.join(sdk, "system-images", "android-34", "google_apis", "x86_64");
  fs.mkdirSync(sys, { recursive: true });
  fs.writeFileSync(path.join(sys, "source.properties"), "Pkg.Desc=x\nPkg.Revision=14\n");
  fs.mkdirSync(path.join(sdk, "emulator"));
  fs.writeFileSync(path.join(sdk, "emulator", "source.properties"), "Pkg.Revision=37.2.12\n");
  const run = fakeRun({
    [`${path.join(sdk, "emulator", "emulator")} -version`]: {
      code: 0,
      stdout:
        "INFO | Android emulator version 37.2.12.0 (build_id 16428233) (CL:N/A)\nCopyright...\n",
    },
    "adb version": {
      code: 0,
      stdout: "Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524\nInstalled as /x/adb\n",
    },
    "uname -r": { code: 0, stdout: "6.11.0-1018-azure\n" },
    "nproc": { code: 0, stdout: "4\n" },
    "free": { code: 0, stdout: FREE_M },
  });
  const e = buildEmulatorEnv({
    run,
    sdkRoot: sdk,
    sysimgPackage: "system-images;android-34;google_apis;x86_64",
    env: {
      ImageOS: "ubuntu24",
      ImageVersion: "20260927.320.1",
      EMULATOR_BUILD: "",
      EMULATOR_GPU: "swiftshader_indirect",
      EMULATOR_MEMORY_MB: "4096",
    },
    now: new Date("2026-10-04T16:00:00Z"),
  });
  assert.deepStrictEqual(e.emulator, {
    version: "37.2.12.0",
    buildId: "16428233",
    packageRevision: "37.2.12",
    pinnedBuild: null,
    gpu: "swiftshader_indirect",
    memoryMb: 4096,
    versionLine: "INFO | Android emulator version 37.2.12.0 (build_id 16428233) (CL:N/A)",
  });
  assert.deepStrictEqual(e.systemImage, {
    package: "system-images;android-34;google_apis;x86_64",
    revision: "14",
  });
  assert.deepStrictEqual(e.adb, { version: "1.0.41", platformTools: "36.0.0-13206524" });
  assert.deepStrictEqual(e.runnerImage, { os: "ubuntu24", version: "20260927.320.1" });
  assert.strictEqual(e.kernel, "6.11.0-1018-azure");
  assert.strictEqual(e.nproc, 4);
  assert.strictEqual(e.memory.memAvailMb, 10867);
  assert.strictEqual(e.recordedAt, "2026-10-04T16:00:00.000Z");
});

test("buildEmulatorEnv: missing tools degrade to nulls, never throw", () => {
  const e = buildEmulatorEnv({
    run: () => ({ code: 127, stdout: "" }),
    sdkRoot: "/nonexistent",
    sysimgPackage: "system-images;android-33;google_apis;x86_64",
    env: { EMULATOR_BUILD: "13610412" },
    now: new Date("2026-10-04T16:00:00Z"),
  });
  assert.strictEqual(e.emulator.version, null);
  assert.strictEqual(e.emulator.pinnedBuild, "13610412");
  assert.strictEqual(e.systemImage.revision, null);
  assert.strictEqual(e.adb.version, null);
  assert.strictEqual(e.nproc, null);
});

test("CLI env subcommand writes the JSON file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emu-env-"));
  const out = path.join(dir, "ci-emulator-env.json");
  execFileSync(
    "node",
    [
      path.join(__dirname, "emulator-diagnostics.js"),
      "env",
      "--sysimg",
      "system-images;android-34;google_apis;x86_64",
      "--out",
      out,
    ],
    { env: { ...process.env, ANDROID_SDK_ROOT: dir }, stdio: ["ignore", "pipe", "pipe"] }
  );
  const j = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.strictEqual(j.systemImage.package, "system-images;android-34;google_apis;x86_64");
  assert.ok("emulator" in j && "adb" in j && "kernel" in j);
});
