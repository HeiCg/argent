// Settings reset readiness for the Android latency bench (run 37561512651, Review
// 2026-10-07).
//
// The bench resets Settings before many timed calls with force-stop + pm clear +
// am start. In run 37561512651 the system's delayed "remove task" kill fired ~0.35 s
// after am start and killed the NEW Settings process before its first frame. The next
// timed call then saw no active window: 9 to 11 of the 40 swipe drain reads per ON
// block returned an empty tree, and OFF answered in a few ms with an empty screen.
//
// waitSettingsReady polls one probe (PROBE_CMD) until Settings is resumed, its window
// has focus (it has drawn), no Settings activity record is finishing or being
// destroyed, and the process id is the same over two consecutive clean reads at least
// STABLE_GAP_MS apart, with the last one at least KILL_GUARD_MS after the last am
// start (past the delayed kill). If Settings stays gone for RELAUNCH_AFTER_MS it is
// started again (am start, no pm clear). The wait is bounded by budgetMs. The same
// wait runs in every block, OFF and ON alike.
//
// The probe, relaunch, clock and sleep are injected so the logic is unit-tested
// without adb (settings-reset.test.js).
"use strict";

const SETTINGS_PKG = "com.android.settings";
const PID_MARK = "@@BENCH_PID";
const FOCUS_MARK = "@@BENCH_FOCUS";
// One adb shell call per poll: the activity stack, the Settings pid, the focused window.
// Ends in `true` so a missing pid or focus line (exit 1) is data, not an adb error.
const PROBE_CMD =
  `dumpsys activity activities; echo '${PID_MARK}'; pidof ${SETTINGS_PKG}; ` +
  `echo '${FOCUS_MARK}'; dumpsys window | grep -m1 mCurrentFocus; true`;

const POLL_MS = 100;
const STABLE_GAP_MS = 100;
const KILL_GUARD_MS = 800;
const RELAUNCH_AFTER_MS = 1000;
const BUDGET_MS = 5000;

const COMPONENT = /([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/;
const RESUMED_LINE = /(?:mResumedActivity|topResumedActivity|ResumedActivity)\W+ActivityRecord\{/;
const RECORD_HEADER = /\bHist\b.*ActivityRecord\{|^\s*\* (?:ActivityRecord|Task)\{/;
const SETTINGS_RECORD = new RegExp(
  `ActivityRecord\\{[^}]*\\b${SETTINGS_PKG.replace(/\./g, "\\.")}/`
);
const FINISHING = /\bm?[Ff]inishing=true\b|\bstate=(?:FINISHING|DESTROYING|DESTROYED)\b/;

/**
 * Parse one PROBE_CMD output.
 * @param {string} text
 * @returns {{ resumed: string | null, settingsResumed: boolean, settingsFocused: boolean,
 *   finishing: boolean, pid: string | null, clean: boolean }}
 */
function parseResetProbe(text) {
  const s = String(text || "");
  const pidAt = s.indexOf(PID_MARK);
  const focusAt = s.indexOf(FOCUS_MARK);
  const activities = pidAt >= 0 ? s.slice(0, pidAt) : s;
  const pidPart =
    pidAt >= 0 ? s.slice(pidAt + PID_MARK.length, focusAt >= 0 ? focusAt : undefined) : "";
  const focusPart = focusAt >= 0 ? s.slice(focusAt + FOCUS_MARK.length) : "";

  let resumed = null;
  let finishing = false;
  let inSettings = false;
  for (const line of activities.split("\n")) {
    if (resumed === null && RESUMED_LINE.test(line)) {
      const m = line.slice(line.indexOf("ActivityRecord{")).match(COMPONENT);
      if (m) resumed = m[1];
      continue;
    }
    if (RECORD_HEADER.test(line)) inSettings = SETTINGS_RECORD.test(line);
    if (inSettings && FINISHING.test(line)) finishing = true;
  }
  // `pidof` may print several pids (a dying process next to the new one): keep them
  // all, so a change in the set restarts the stabilisation.
  const pids = pidPart
    .trim()
    .split(/\s+/)
    .filter((x) => /^\d+$/.test(x));
  const pid = pids.length ? pids.join(" ") : null;
  const focusM = focusPart.match(/mCurrentFocus=Window\{[^}]*\}/);
  const focusComp = focusM ? (focusM[0].match(COMPONENT) || [])[1] || null : null;
  const settingsResumed = !!resumed && resumed.startsWith(`${SETTINGS_PKG}/`);
  const settingsFocused = !!focusComp && focusComp.startsWith(`${SETTINGS_PKG}/`);
  return {
    resumed,
    settingsResumed,
    settingsFocused,
    finishing,
    pid,
    clean: settingsResumed && settingsFocused && !finishing && pid !== null,
  };
}

/** One-line summary of a parsed probe, for logs and a timeout record. */
function probeSummary(p) {
  return (
    `resumed=${p.resumed || "-"} focused=${p.settingsFocused} finishing=${p.finishing} ` +
    `pid=${p.pid || "-"}`
  );
}

/**
 * Wait until Settings is resumed, drawn and stable after an am start.
 * @param {{ probe: () => string, relaunch: () => void, now: () => number,
 *   sleep: (ms: number) => Promise<void>, startedAt: number, budgetMs?: number,
 *   pollMs?: number }} o startedAt = the clock reading when am start was issued.
 * @returns {Promise<{ ok: boolean, waitMs: number, readyAtMs: number | null, polls: number,
 *   relaunches: number, pid: string | null, last: string }>} readyAtMs is measured from
 *   the LAST am start; waitMs from the call.
 */
async function waitSettingsReady(o) {
  const budget = o.budgetMs == null ? BUDGET_MS : o.budgetMs;
  const pollMs = o.pollMs == null ? POLL_MS : o.pollMs;
  const t0 = o.now();
  let startedAt = o.startedAt == null ? t0 : o.startedAt;
  let polls = 0;
  let relaunches = 0;
  let stablePid = null;
  let firstCleanAt = null;
  let consecutive = 0;
  for (;;) {
    const p = parseResetProbe(o.probe());
    polls++;
    const last = probeSummary(p);
    const now = o.now();
    if (p.clean) {
      if (consecutive > 0 && p.pid === stablePid) consecutive++;
      else {
        consecutive = 1;
        firstCleanAt = now;
        stablePid = p.pid;
      }
      if (
        consecutive >= 2 &&
        now - firstCleanAt >= STABLE_GAP_MS &&
        now - startedAt >= KILL_GUARD_MS
      ) {
        return {
          ok: true,
          waitMs: now - t0,
          readyAtMs: now - startedAt,
          polls,
          relaunches,
          pid: p.pid,
          last,
        };
      }
    } else {
      consecutive = 0;
      stablePid = null;
      firstCleanAt = null;
    }
    if (now - t0 >= budget) {
      return { ok: false, waitMs: now - t0, readyAtMs: null, polls, relaunches, pid: p.pid, last };
    }
    // Settings is gone (killed after am start, or never came up): start it again.
    if ((!p.settingsResumed || p.pid === null) && now - startedAt >= RELAUNCH_AFTER_MS) {
      o.relaunch();
      relaunches++;
      startedAt = o.now();
    }
    await o.sleep(pollMs);
  }
}

module.exports = {
  PROBE_CMD,
  PID_MARK,
  FOCUS_MARK,
  KILL_GUARD_MS,
  RELAUNCH_AFTER_MS,
  parseResetProbe,
  waitSettingsReady,
};
