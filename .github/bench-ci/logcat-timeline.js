// Transition timeline per timed tap, from logcat (Review 2026-10-07 run 37591260027
// finding 1 and "Next run").
//
// In run 37591260027 the guest ran slower under the proprietary stack: tap → SubSettings
// transition finished p50 OFF 1064-1361 ms vs ON 515-620 ms, first frame OFF 515-670 vs
// ON 326-370, and no correct read on any arm ended before the transition finished. That
// was matched post hoc. The bench now writes a logcat marker at each timed t0
// (`adb shell log -t BENCH "<block> <verb> <i> t0"`, markerMessage below), and the merge
// step parses logcat-bench.txt into, per (block, verb):
//  - tap → first frame: the first `ActivityTaskManager: Displayed <component>` line after
//    the marker (the destination's first frame was drawn);
//  - tap → transition finished: the first `WindowManager: Finish Transition #N` of an
//    OPEN transition (type from `WindowManagerShell: onTransitionReady … {id=N t=OPEN`)
//    created after the marker;
// each within MAX_MATCH_MS of the marker and before the next marker. Times are the device
// clock on both ends (marker and event), so host/device clock offset does not enter.
// The marker is written just before the host takes t0, so every interval includes the
// adb return of the marker call (the same on every arm).
"use strict";

const fs = require("fs");
const { summarize } = require("./stats");

const MARKER_TAG = "BENCH";
const MAX_MATCH_MS = 5000;

/** Marker-safe verb token (no spaces, no shell metacharacters). */
function markerVerbKey(verb) {
  return String(verb).replace(/[^A-Za-z0-9+:._-]/g, "_");
}

/** The marker text the bench logs at a timed t0. */
function markerMessage(block, verb, i) {
  return `${markerVerbKey(block)} ${markerVerbKey(verb)} ${i} t0`;
}

// `logcat -v threadtime`: "MM-DD HH:MM:SS.mmm  PID  TID L TAG: message"
const LINE =
  /^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})\s+\d+\s+\d+\s+([VDIWEF])\s+(.*?)\s*: (.*)$/;
const toMs = (mo, d, h, mi, s, ms) => Date.UTC(2000, Number(mo) - 1, Number(d), h, mi, s, ms);

/** Parse one threadtime line → { ms, level, tag, msg } or null. */
function parseLine(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  return {
    ms: toMs(m[1], m[2], Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])),
    level: m[7],
    tag: m[8].trim(),
    msg: m[9],
  };
}

const MARKER_MSG = /^(\S+) (\S+) (\d+) t0\s*$/;
const DISPLAYED = /^Displayed (\S+)(?: for user \d+)?: \+/;
const READY = /onTransitionReady .*\{id=(\d+) t=([A-Z_]+)/;
const FINISH = /^Finish Transition #(\d+): created at (\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})/;

/** Collector fed one logcat line at a time; `result()` builds the timeline. */
function createCollector() {
  const markers = [];
  const displayed = [];
  const finishes = [];
  const types = new Map();
  return {
    line(raw) {
      if (!raw) return;
      const l = parseLine(raw);
      if (!l) return;
      if (l.tag === MARKER_TAG) {
        const m = MARKER_MSG.exec(l.msg);
        if (m) markers.push({ ms: l.ms, block: m[1], verb: m[2], i: Number(m[3]) });
        return;
      }
      if (l.tag === "ActivityTaskManager") {
        const m = DISPLAYED.exec(l.msg);
        if (m) displayed.push({ ms: l.ms, component: m[1] });
        return;
      }
      if (l.tag === "WindowManagerShell") {
        const m = READY.exec(l.msg);
        if (m) types.set(m[1], m[2]);
        return;
      }
      if (l.tag === "WindowManager") {
        const m = FINISH.exec(l.msg);
        if (m)
          finishes.push({
            ms: l.ms,
            id: m[1],
            createdMs: toMs(m[2], m[3], Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])),
          });
      }
    },
    result() {
      return buildTimeline(markers, displayed, finishes, types);
    },
  };
}

function buildTimeline(markers, displayed, finishes, types) {
  markers.sort((a, b) => a.ms - b.ms);
  const out = {};
  markers.forEach((mk, k) => {
    const next = k + 1 < markers.length ? markers[k + 1].ms : Infinity;
    const until = Math.min(next, mk.ms + MAX_MATCH_MS);
    const ff = displayed.find((d) => d.ms >= mk.ms && d.ms < until);
    const fin = finishes.find(
      (f) => f.createdMs >= mk.ms && f.ms < until && types.get(f.id) === "OPEN"
    );
    const row = ((out[mk.block] = out[mk.block] || {})[mk.verb] = out[mk.block][mk.verb] || {
      markers: 0,
      firstFrame: [],
      finished: [],
    });
    row.markers++;
    if (ff) row.firstFrame.push({ i: mk.i, ms: ff.ms - mk.ms, component: ff.component });
    if (fin) row.finished.push({ i: mk.i, ms: fin.ms - mk.ms });
  });
  // Summaries per (block, verb).
  for (const verbs of Object.values(out)) {
    for (const row of Object.values(verbs)) {
      const ff = row.firstFrame.map((x) => x.ms);
      const fin = row.finished.map((x) => x.ms);
      row.firstFrameMs = ff.length ? summarize(ff) : null;
      row.finishedMs = fin.length ? summarize(fin) : null;
    }
  }
  return out;
}

/** Feed a file through `onLine` in fixed-size chunks (logcat-bench.txt is ~150 MB). */
function forEachLineSync(file, onLine, chunkBytes = 4 * 1024 * 1024) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(chunkBytes);
  let rest = "";
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkBytes, null);
      if (n <= 0) break;
      const text = rest + buf.toString("utf8", 0, n);
      const lines = text.split("\n");
      rest = lines.pop();
      for (const l of lines) onLine(l.replace(/\r$/, ""));
    }
    if (rest) onLine(rest);
  } finally {
    fs.closeSync(fd);
  }
}

/** Timeline of a logcat file; null when it is absent. */
function timelineOfFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  const c = createCollector();
  forEachLineSync(file, (l) => c.line(l));
  return c.result();
}

/**
 * Per-sample time after the transition finished: time-to-correct minus tap → finished,
 * matched by the loop iteration (`timeToCorrect.iters` ↔ the marker index).
 * @param {{ samples?: (number|null)[], iters?: (number|null)[] } | null} ttc
 * @param {{ finished: { i: number, ms: number }[] } | null} row
 */
function residualAfterFinish(ttc, row) {
  if (!ttc || !row || !Array.isArray(ttc.iters) || !Array.isArray(ttc.samples)) return null;
  const fin = new Map(row.finished.map((f) => [f.i, f.ms]));
  const xs = [];
  ttc.iters.forEach((i, k) => {
    const t = ttc.samples[k];
    if (i == null || t == null || !fin.has(i)) return;
    xs.push(t - fin.get(i));
  });
  return xs.length ? summarize(xs) : null;
}

module.exports = {
  MARKER_TAG,
  markerVerbKey,
  markerMessage,
  parseLine,
  createCollector,
  timelineOfFile,
  residualAfterFinish,
};
