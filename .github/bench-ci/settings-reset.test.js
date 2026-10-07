// Unit tests for the Settings reset readiness wait (settings-reset.js). Run 37561512651
// (Review 2026-10-07): after force-stop + pm clear + am start, the system's delayed
// "remove task" kill fired ~0.35 s later and killed the NEW Settings process before its
// first frame, so the next timed call saw no active window. The wait polls until
// Settings is resumed, focused, not finishing and on a stable pid. The probe, the
// relaunch, the clock and the sleep are injected: nothing here touches adb.
//
// Run: node --test .github/bench-ci/settings-reset.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const {
  PID_MARK,
  FOCUS_MARK,
  KILL_GUARD_MS,
  RELAUNCH_AFTER_MS,
  parseResetProbe,
  waitSettingsReady,
} = require("./settings-reset");

const BENCH_TS = path.join(
  __dirname,
  "..",
  "..",
  "packages",
  "tool-server",
  "scripts",
  "bench-open-vs-proprietary.ts"
);

// One probe output in the shape PROBE_CMD prints (Android 14 emulator).
function probeText({
  resumed = "com.android.settings/.Settings",
  pid = "4242",
  focus = "com.android.settings/com.android.settings.Settings",
  settingsRecord = "state=RESUMED delayedResume=false finishing=false",
} = {}) {
  return [
    "ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)",
    "Display #0 (activities from top to bottom):",
    "  * Task{8f2 #12 type=standard A=1000:com.android.settings U=0 visible=true}",
    "    * Hist  #0: ActivityRecord{a1b2c3 u0 com.android.settings/.Settings t12}",
    settingsRecord ? `        ${settingsRecord}` : "",
    "  * Task{11 #1 type=home}",
    "    * Hist  #0: ActivityRecord{d4e5 u0 com.android.launcher3/.uioverrides.QuickstepLauncher t1}",
    "        state=STOPPED delayedResume=false finishing=false",
    resumed ? `  ResumedActivity: ActivityRecord{a1b2c3 u0 ${resumed} t12}` : "",
    resumed ? `  topResumedActivity=ActivityRecord{a1b2c3 u0 ${resumed} t12}` : "",
    PID_MARK,
    pid,
    FOCUS_MARK,
    focus ? `  mCurrentFocus=Window{77 u0 ${focus}}` : "  mCurrentFocus=null",
  ].join("\n");
}

test("settings-reset: parseResetProbe reads resumed, focus, pid and a finishing Settings record", () => {
  const ok = parseResetProbe(probeText());
  assert.strictEqual(ok.resumed, "com.android.settings/.Settings");
  assert.strictEqual(ok.settingsResumed, true);
  assert.strictEqual(ok.settingsFocused, true);
  assert.strictEqual(ok.pid, "4242");
  assert.strictEqual(ok.finishing, false);
  assert.strictEqual(ok.clean, true);

  // The launcher's own records never count as a finishing Settings task.
  const fin = parseResetProbe(
    probeText({ settingsRecord: "state=DESTROYING delayedResume=false finishing=true" })
  );
  assert.strictEqual(fin.finishing, true);
  assert.strictEqual(fin.clean, false);

  // Process gone (killed after am start): no pid, no resumed Settings, focus elsewhere.
  const dead = parseResetProbe(
    probeText({ resumed: "", pid: "", focus: "com.android.launcher3/.Launcher" })
  );
  assert.strictEqual(dead.pid, null);
  assert.strictEqual(dead.settingsResumed, false);
  assert.strictEqual(dead.settingsFocused, false);
  assert.strictEqual(dead.clean, false);

  // Resumed but the window is not focused yet (no first frame): not clean.
  const noFrame = parseResetProbe(probeText({ focus: "" }));
  assert.strictEqual(noFrame.settingsResumed, true);
  assert.strictEqual(noFrame.settingsFocused, false);
  assert.strictEqual(noFrame.clean, false);
});

// A fake clock: each probe costs 30 ms, sleep advances the clock.
function harness(script) {
  let t = 0;
  let i = 0;
  const relaunchedAt = [];
  return {
    relaunchedAt,
    opts: {
      startedAt: 0,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      probe: () => {
        t += 30;
        const p = script(t, i++, relaunchedAt);
        return probeText(p);
      },
      relaunch: () => {
        relaunchedAt.push(t);
      },
    },
  };
}

test("settings-reset: ready after two clean reads on the same pid past the kill guard", async () => {
  const h = harness(() => ({}));
  const r = await waitSettingsReady(h.opts);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.relaunches, 0);
  assert.ok(r.polls >= 2, `polls ${r.polls}`);
  // Never declared ready before the delayed kill could have fired.
  assert.ok(r.readyAtMs >= KILL_GUARD_MS, `ready at ${r.readyAtMs}`);
  assert.ok(r.waitMs <= KILL_GUARD_MS + 300, `wait ${r.waitMs}`);
});

test("settings-reset: the delayed kill at ~0.35 s is detected and Settings is relaunched once", async () => {
  // Clean until 350 ms, then the process is gone until a relaunch, then a new pid.
  const h = harness((t, _i, relaunchedAt) => {
    if (relaunchedAt.length) return { pid: "5151" };
    if (t < 350) return {};
    return { resumed: "", pid: "", focus: "com.android.launcher3/.Launcher" };
  });
  const r = await waitSettingsReady(h.opts);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.relaunches, 1);
  assert.strictEqual(r.pid, "5151");
  // The relaunch comes only after Settings stayed gone for RELAUNCH_AFTER_MS.
  assert.ok(h.relaunchedAt[0] >= RELAUNCH_AFTER_MS, `relaunched at ${h.relaunchedAt[0]}`);
});

test("settings-reset: a pid change between clean reads restarts the stabilisation", async () => {
  const h = harness((_t, i) => ({ pid: i < 3 ? String(100 + i) : "999" }));
  const r = await waitSettingsReady(h.opts);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.pid, "999");
  assert.ok(r.polls >= 5, `polls ${r.polls}`);
});

test("settings-reset: bounded — never clean within the budget returns ok:false with the last probe", async () => {
  const h = harness(() => ({ settingsRecord: "state=DESTROYING finishing=true" }));
  const r = await waitSettingsReady({ ...h.opts, budgetMs: 2000 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.waitMs >= 2000 && r.waitMs < 2300, `wait ${r.waitMs}`);
  assert.match(r.last, /finishing/);
});

test("settings-reset: the bench waits for Settings after every am start, logs resetWaitMs", () => {
  const src = fs.readFileSync(BENCH_TS, "utf8");
  for (const fn of ["ensureSettings", "relaunchSettings"]) {
    const body = src.slice(src.indexOf(`async function ${fn}(`));
    const end = body.indexOf("\n}\n");
    const fnBody = body.slice(0, end);
    const start = fnBody.indexOf("am start -n ${SETTINGS}/.Settings");
    assert.ok(start > 0, `${fn} has no am start`);
    assert.ok(
      fnBody.indexOf("awaitSettingsReady(", start) > start,
      `${fn} does not wait for Settings after am start`
    );
  }
  assert.match(src, /resetWaitMs/);
});
