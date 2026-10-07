// Unit tests for the logcat transition timeline (logcat-timeline.js). Review 2026-10-07
// run 37591260027 finding 1: tap → first frame / transition finished per timed tap, from
// the BENCH marker at each t0. The lines below are the run's own logcat shapes.
//
// Run: node --test .github/bench-ci/logcat-timeline.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  markerMessage,
  markerVerbKey,
  parseLine,
  createCollector,
  timelineOfFile,
  residualAfterFinish,
} = require("./logcat-timeline");

const BENCH_TS = path.join(
  __dirname,
  "..",
  "..",
  "packages",
  "tool-server",
  "scripts",
  "bench-open-vs-proprietary.ts"
);

const marker = (t, msg) => `10-07 08:14:${t}  4321  4321 I BENCH   : ${msg}`;
const LINES = [
  marker("45.300", markerMessage("OFF-1", "tap+await-idle+describe", 0)),
  "10-07 08:14:45.366   524   545 V WindowManager: Collecting in transition 136",
  "10-07 08:14:46.236   843   910 V WindowManagerShell: onTransitionReady android.os.BinderProxy@2d8fde0: {id=136 t=OPEN f=0x0 trk=0 r=[0@Point(0, 0)] c=[]}",
  "10-07 08:14:46.239   524   545 I ActivityTaskManager: Displayed com.android.settings/.SubSettings for user 0: +782ms",
  "10-07 08:14:46.730   524   545 V WindowManager: Finish Transition #136: created at 10-07 08:14:45.366 collect-started=0.032ms request-sent=9.161ms started=56.75ms ready=392.254ms sent=807.166ms finished=1363.872ms",
  // BACK: a CLOSE transition, never matched as the tap's transition.
  "10-07 08:14:49.108   843   910 V WindowManagerShell: onTransitionReady android.os.BinderProxy@667431a: {id=137 t=CLOSE f=0x0 trk=0}",
  "10-07 08:14:49.127   524   545 V WindowManager: Finish Transition #137: created at 10-07 08:14:48.758 collect-started=0.029ms ready=136.099ms finished=369.066ms",
  marker("50.000", markerMessage("OFF-1", "tap+await-idle+describe", 1)),
  // No first frame and no OPEN transition before the next marker: unmatched.
  marker("55.000", markerMessage("ON-im-1", "gesture-tap", 0)),
  "10-07 08:14:55.400   524   545 I ActivityTaskManager: Displayed com.android.settings/.SubSettings for user 0: +300ms",
  "10-07 08:14:55.380   843   910 V WindowManagerShell: onTransitionReady android.os.BinderProxy@1: {id=140 t=OPEN f=0x0}",
  "10-07 08:14:55.600   524   545 V WindowManager: Finish Transition #140: created at 10-07 08:14:55.010 ready=1ms finished=590ms",
];

test("logcat-timeline: the marker is one shell-safe token per field", () => {
  assert.strictEqual(markerVerbKey("tap+describe(settle:false)"), "tap+describe_settle:false_");
  assert.strictEqual(
    markerMessage("ON-im-1", "tap+describe(settle:true)", 7),
    "ON-im-1 tap+describe_settle:true_ 7 t0"
  );
  assert.doesNotMatch(markerMessage("OFF-1", "a b'c", 0), /['" ()]{1}c/);
  const l = parseLine(LINES[0]);
  assert.strictEqual(l.tag, "BENCH");
  assert.match(l.msg, /^OFF-1 tap\+await-idle\+describe 0 t0$/);
});

test("logcat-timeline: tap → first frame and tap → OPEN transition finished per marker", () => {
  const c = createCollector();
  for (const l of LINES) c.line(l);
  const t = c.result();
  const off = t["OFF-1"]["tap+await-idle+describe"];
  assert.strictEqual(off.markers, 2);
  assert.deepStrictEqual(
    off.firstFrame.map((x) => [x.i, x.ms]),
    [[0, 939]]
  );
  // #136 finished at 46.730, marker at 45.300; the CLOSE #137 is not matched.
  assert.deepStrictEqual(off.finished, [{ i: 0, ms: 1430 }]);
  assert.strictEqual(off.firstFrameMs.p50, 939);
  assert.strictEqual(off.finishedMs.n, 1);
  const on = t["ON-im-1"]["gesture-tap"];
  assert.deepStrictEqual(
    on.firstFrame.map((x) => x.ms),
    [400]
  );
  assert.deepStrictEqual(
    on.finished.map((x) => x.ms),
    [600]
  );
});

test("logcat-timeline: residual after the transition, matched by iteration", () => {
  const row = {
    finished: [
      { i: 0, ms: 1000 },
      { i: 2, ms: 1100 },
    ],
  };
  const r = residualAfterFinish({ samples: [1600, 900, 1500], iters: [0, 1, 2] }, row);
  assert.strictEqual(r.n, 2);
  assert.strictEqual(r.p50, 500);
  assert.strictEqual(residualAfterFinish({ samples: [1] }, row), null);
});

test("logcat-timeline: reads a file in chunks (lines split across chunk boundaries)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logcat-tl-"));
  const f = path.join(dir, "logcat-bench.txt");
  fs.writeFileSync(f, LINES.join("\n") + "\n");
  const t = timelineOfFile(f);
  assert.strictEqual(t["OFF-1"]["tap+await-idle+describe"].finished[0].ms, 1430);
  assert.strictEqual(timelineOfFile(path.join(dir, "absent.txt")), null);
});

test("bench: a BENCH logcat marker precedes every timed t0 (markerMessage, adb shell log -t BENCH)", () => {
  const src = fs.readFileSync(BENCH_TS, "utf8");
  assert.match(src, /markerMessage/);
  assert.match(src, /"log", "-t", MARKER_TAG/);
  for (const fn of ["timeTapEffectVariants", "timeGestureDrained", "timeCalls"]) {
    const body = src.slice(src.indexOf(`async function ${fn}(`));
    const fnBody = body.slice(0, body.indexOf("\n}\n"));
    const m = fnBody.indexOf("benchMarker(");
    const t0 = fnBody.indexOf("const t0 = performance.now()");
    assert.ok(m > 0 && t0 > m, `${fn}: marker before t0`);
  }
});
