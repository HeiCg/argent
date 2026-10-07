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
// Run 37571460849 (OFF arms 91/86 resets, 12 timeouts and 50/49 relaunches each; ON
// 109/108, 1/3, 5/12). Logcat over the four blocks: every Settings "remove task" kill
// (OFF 17/18 per block, ON 4/4) landed 1.000-1.502 s after the pm clear, never after a
// light reset (force-stop + am start, no pm clear). OFF hit it four times as often
// because its pm clear -> am start gap was longer (median 0.70 s vs 0.56 s on ON), which
// put the new process's startup on top of the kill. The kill left the task's top record
// resumed with no process, and the relaunch, a plain am start, was delivered to that
// record (result code 3, START_DELIVERED_TO_TOP) without starting a process: every one
// of the 50/49/5/12 relaunches was delivered-to-top, so the probe read resumed=Settings
// pid=- focused=false until the 5 s bound. Two changes, the same on both arms:
//  - CLEAR_KILL_GUARD_MS: the bench holds am start until 2 s after pm clear returned,
//    past the delayed kill, so it finds no process to kill.
//  - RELAUNCH_CMD force-stops Settings before am start, so a stale record is removed
//    and a new process starts.
// Each wait also returns a histogram of its decisions (`reasons`: why it waited, why it
// relaunched, what the relaunch's am start answered, the outcome); the bench sums them
// per block into the block JSON.
//
// Review 2026-10-07 run 37591260027 finding 6: the gate never passed. All 489 resets
// (every block, both arms) ended `outcome:timeout` at ~5 s with `wait:not-focused` on
// every poll (OFF-1: 1697 not-focused polls, 83 dead-record, 0 ready), while logcat shows
// the Settings windows taking focus normally. The focus read was
// `dumpsys window | grep -m1 mCurrentFocus`: the FIRST mCurrentFocus line of the full
// window dump. That dump starts with the "WINDOW MANAGER LAST ANR" section when an ANR
// was recorded since boot, which carries a copy of the window state at the ANR time, so
// grep -m1 can read a frozen focus. Not established from the artifact (it kept only the
// parsed summary, not the raw line). The probe now reads focus from two current sources
// and keeps what it read:
//  - `dumpsys window windows | grep -E 'mCurrentFocus|mFocusedApp'`: the WINDOWS section
//    only (no LAST ANR copy), every line, not the first;
//  - `dumpsys input | grep -A1 FocusedWindows`: InputDispatcher's focused window.
// Settings is focused when either source names a com.android.settings window. Each poll
// adds `focus:<what the window manager named>` and `focus-input:<what input named>` to the
// reasons histogram, so the next artifact shows the raw focus reads.
//
// The probe, relaunch, clock and sleep are injected so the logic is unit-tested
// without adb (settings-reset.test.js).
"use strict";

const SETTINGS_PKG = "com.android.settings";
const PID_MARK = "@@BENCH_PID";
const FOCUS_MARK = "@@BENCH_FOCUS";
const INPUT_MARK = "@@BENCH_INPUT";
// One adb shell call per poll: the activity stack, the Settings pid, the focused window
// (window manager, WINDOWS section) and the input dispatcher's focused window. Ends in
// `true` so a missing pid or focus line (exit 1) is data, not an adb error.
const PROBE_CMD =
  `dumpsys activity activities; echo '${PID_MARK}'; pidof ${SETTINGS_PKG}; ` +
  `echo '${FOCUS_MARK}'; dumpsys window windows | grep -E 'mCurrentFocus|mFocusedApp'; ` +
  `echo '${INPUT_MARK}'; dumpsys input | grep -A1 FocusedWindows; true`;

// am start the probe issues when Settings is gone: force-stop first, so a resumed record
// left by a killed process is removed instead of receiving the intent (run 37571460849).
const RELAUNCH_CMD = `am force-stop ${SETTINGS_PKG}; am start -n ${SETTINGS_PKG}/.Settings`;

const POLL_MS = 100;
const STABLE_GAP_MS = 100;
const KILL_GUARD_MS = 800;
const RELAUNCH_AFTER_MS = 1000;
const BUDGET_MS = 5000;
// Minimum time from pm clear returning to the am start that follows it. The delayed
// "remove task" kill lands 1.000-1.502 s after the clear (run 37571460849, all blocks).
const CLEAR_KILL_GUARD_MS = 2000;

const COMPONENT = /([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/;
const RESUMED_LINE = /(?:mResumedActivity|topResumedActivity|ResumedActivity)\W+ActivityRecord\{/;
const RECORD_HEADER = /\bHist\b.*ActivityRecord\{|^\s*\* (?:ActivityRecord|Task)\{/;
const SETTINGS_RECORD = new RegExp(
  `ActivityRecord\\{[^}]*\\b${SETTINGS_PKG.replace(/\./g, "\\.")}/`
);
const FINISHING = /\bm?[Ff]inishing=true\b|\bstate=(?:FINISHING|DESTROYING|DESTROYED)\b/;

/**
 * Components named by focus lines: `mCurrentFocus=Window{… <comp>}` (window manager) or
 * `name='… <comp>'` (input dispatcher). `null` entries stand for `mCurrentFocus=null`.
 * @param {string} part
 * @param {RegExp} lineRx
 * @returns {(string | null)[]}
 */
function focusComponents(part, lineRx) {
  const out = [];
  for (const line of part.split("\n")) {
    const m = line.match(lineRx);
    if (!m) continue;
    const c = m[1].match(COMPONENT);
    out.push(c ? c[1] : null);
  }
  return out;
}
const WM_FOCUS_LINE = /mCurrentFocus=(Window\{[^}]*\}|null)/;
const INPUT_FOCUS_LINE = /name='([^']*)'/;

/** Short histogram value for a focus read: the component, `null`, or `absent`. */
function focusValue(comps) {
  if (!comps.length) return "absent";
  const c = comps.find((x) => x && x.startsWith(`${SETTINGS_PKG}/`)) || comps[0];
  return c === null ? "null" : c;
}

/**
 * Parse one PROBE_CMD output.
 * @param {string} text
 * @returns {{ resumed: string | null, settingsResumed: boolean, settingsFocused: boolean,
 *   focusWm: string, focusInput: string, finishing: boolean, pid: string | null,
 *   clean: boolean }}
 */
function parseResetProbe(text) {
  const s = String(text || "");
  const pidAt = s.indexOf(PID_MARK);
  const focusAt = s.indexOf(FOCUS_MARK);
  const inputAt = s.indexOf(INPUT_MARK);
  const activities = pidAt >= 0 ? s.slice(0, pidAt) : s;
  const pidPart =
    pidAt >= 0 ? s.slice(pidAt + PID_MARK.length, focusAt >= 0 ? focusAt : undefined) : "";
  const focusPart =
    focusAt >= 0 ? s.slice(focusAt + FOCUS_MARK.length, inputAt >= 0 ? inputAt : undefined) : "";
  const inputPart = inputAt >= 0 ? s.slice(inputAt + INPUT_MARK.length) : "";

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
  // Every current focus line, from both sources: Settings is focused when any names it.
  const wm = focusComponents(focusPart, WM_FOCUS_LINE);
  const input = focusComponents(inputPart, INPUT_FOCUS_LINE);
  const isSettings = (c) => !!c && c.startsWith(`${SETTINGS_PKG}/`);
  const settingsResumed = !!resumed && resumed.startsWith(`${SETTINGS_PKG}/`);
  const settingsFocused = wm.some(isSettings) || input.some(isSettings);
  return {
    resumed,
    settingsResumed,
    settingsFocused,
    focusWm: focusValue(wm),
    focusInput: focusValue(input),
    finishing,
    pid,
    clean: settingsResumed && settingsFocused && !finishing && pid !== null,
  };
}

/** One-line summary of a parsed probe, for logs and a timeout record. */
function probeSummary(p) {
  return (
    `resumed=${p.resumed || "-"} focused=${p.settingsFocused} ` +
    `(wm=${p.focusWm || "-"} input=${p.focusInput || "-"}) finishing=${p.finishing} ` +
    `pid=${p.pid || "-"}`
  );
}

/**
 * Classify am start's output (the relaunch's answer).
 * @param {string | undefined | null} out
 * @returns {"started" | "delivered-to-top" | "brought-to-front" | "error" | "unknown"}
 */
function classifyAmStart(out) {
  if (typeof out !== "string") return "unknown";
  if (/delivered to currently running top-most instance/i.test(out)) return "delivered-to-top";
  if (/brought to the front/i.test(out)) return "brought-to-front";
  if (/^\s*Error\b|Exception/m.test(out)) return "error";
  if (/^\s*Starting: Intent/m.test(out)) return "started";
  return "unknown";
}

/** Why one probe read is not (yet) ready; null when it is clean. */
function waitReason(p) {
  if (!p.settingsResumed) return "not-resumed";
  if (p.pid === null) return "dead-record";
  if (p.finishing) return "finishing";
  if (!p.settingsFocused) return "not-focused";
  return null;
}

/**
 * Wait until Settings is resumed, drawn and stable after an am start.
 * @param {{ probe: () => string, relaunch: () => (string | void), now: () => number,
 *   sleep: (ms: number) => Promise<void>, startedAt: number, budgetMs?: number,
 *   pollMs?: number }} o startedAt = the clock reading when am start was issued. relaunch
 *   runs RELAUNCH_CMD and may return its output (classified into `reasons`).
 * @returns {Promise<{ ok: boolean, waitMs: number, readyAtMs: number | null, polls: number,
 *   relaunches: number, pid: string | null, last: string,
 *   reasons: Record<string, number> }>} readyAtMs is measured from the LAST am start;
 *   waitMs from the call. `reasons` counts one decision per poll (`wait:<why>`), each
 *   relaunch (`relaunch:<why>`, `relaunch-start:<am start answer>`) and the outcome
 *   (`outcome:ready` or `outcome:timeout`).
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
  /** @type {Record<string, number>} */
  const reasons = {};
  const count = (k) => {
    reasons[k] = (reasons[k] || 0) + 1;
  };
  for (;;) {
    const p = parseResetProbe(o.probe());
    polls++;
    // Run 37591260027 finding 6: what each focus source named, every poll.
    count(`focus:${p.focusWm}`);
    count(`focus-input:${p.focusInput}`);
    const last = probeSummary(p);
    const now = o.now();
    if (p.clean) {
      if (consecutive > 0 && p.pid === stablePid) consecutive++;
      else {
        if (consecutive > 0) count("wait:pid-changed");
        consecutive = 1;
        firstCleanAt = now;
        stablePid = p.pid;
      }
      if (
        consecutive >= 2 &&
        now - firstCleanAt >= STABLE_GAP_MS &&
        now - startedAt >= KILL_GUARD_MS
      ) {
        count("outcome:ready");
        return {
          ok: true,
          waitMs: now - t0,
          readyAtMs: now - startedAt,
          polls,
          relaunches,
          pid: p.pid,
          last,
          reasons,
        };
      }
      count(
        consecutive < 2 || now - firstCleanAt < STABLE_GAP_MS
          ? "wait:stabilising"
          : "wait:kill-guard"
      );
    } else {
      count(`wait:${waitReason(p)}`);
      consecutive = 0;
      stablePid = null;
      firstCleanAt = null;
    }
    if (now - t0 >= budget) {
      count("outcome:timeout");
      return {
        ok: false,
        waitMs: now - t0,
        readyAtMs: null,
        polls,
        relaunches,
        pid: p.pid,
        last,
        reasons,
      };
    }
    // Settings is gone (killed after am start, or never came up), or its record is
    // resumed with no process (the run 37571460849 state): start it again, force-stop
    // first (RELAUNCH_CMD) so the stale record does not swallow the intent.
    if ((!p.settingsResumed || p.pid === null) && now - startedAt >= RELAUNCH_AFTER_MS) {
      count(`relaunch:${p.settingsResumed ? "dead-record" : "gone"}`);
      const out = o.relaunch();
      if (typeof out === "string") count(`relaunch-start:${classifyAmStart(out)}`);
      relaunches++;
      startedAt = o.now();
    }
    await o.sleep(pollMs);
  }
}

module.exports = {
  PROBE_CMD,
  RELAUNCH_CMD,
  CLEAR_KILL_GUARD_MS,
  classifyAmStart,
  PID_MARK,
  FOCUS_MARK,
  INPUT_MARK,
  KILL_GUARD_MS,
  RELAUNCH_AFTER_MS,
  parseResetProbe,
  waitSettingsReady,
};
