// Block name → arm, for the Android latency bench merge and scoreboard (Review 2026-10-07
// run 37591260027, "Next run": interleaved ABBA, three blocks per main arm).
//
// ABBA run order (default since review run 37609765062): OFF-1, ON-im-1, ON-im-bg, OFF-2,
// ON-im-2, ON-hostawait, OFF-3, ON-im-3.
//  - OFF-<n>: the current proprietary release (pooled arm; drift floor; P2-P5 comparator)
//  - ON-im-<n>: the open server with the input-manager injector (the candidate)
//  - ON-uia: the open server with the UiAutomation default (the P6 control, one block;
//    out of the default since run 37609765062, still runnable by name)
//  - OFF-legacy: an older proprietary release (its own arm, report only; out of the
//    default since run 37609765062)
//  - ON-im-bg: ON-im with the proprietary simulator-server spawned idle for the whole
//    block (review run 37609765062 Part A finding 6: does the stream cause the slower
//    guest?). Diagnostic arm, one block, report only.
//  - ON-hostawait: ON-im whose tap → await-idle → describe await (and the await-screen-idle
//    verb) runs the HOST await algorithm (hostAwaitIdle below: poll every 200 ms, 250 ms
//    stable window, the tool's timeout and tree-equality rule) over open-server state
//    reads, instead of the on-device AX-event await. Same ON stack, only the algorithm
//    changes (Part A finding 5: algorithm vs driver). Diagnostic arm, one block, report
//    only. It replaced OFF-devawait (review round 1: the open server next to the
//    proprietary helper is a second UiAutomation client on one emulator).
// The pre-ABBA names map to the same arms: ON-input-manager → candidate, ON-uiautomation →
// control (one block each).
"use strict";

const isCurrentOff = (n) => /^OFF-\d+$/.test(String(n));
const isOnIm = (n) => n === "ON-input-manager" || /^ON-im-\d+$/.test(String(n));
const isOnUia = (n) => n === "ON-uiautomation" || n === "ON-uia";
const isOnImBg = (n) => n === "ON-im-bg";
const isOnHostawait = (n) => n === "ON-hostawait";
/** A diagnostic arm: one block, report only, its validity graded on its own. */
const isDiagnosticArm = (n) => isOnImBg(n) || isOnHostawait(n);
/**
 * A name only the ABBA design uses (selects the ABBA order check and labels). A diagnostic
 * arm alone never makes a run ABBA (review round 1, note 7).
 */
const isAbbaName = (n) => /^ON-im-\d+$/.test(String(n)) || n === "ON-uia" || n === "OFF-3";

/** The arm a block belongs to (OFF, ON-im, ON-uia, ON-im-bg, ON-hostawait, OFF-legacy). */
function armOf(n) {
  if (isCurrentOff(n)) return "OFF";
  if (isOnIm(n)) return "ON-im";
  if (isOnUia(n)) return "ON-uia";
  if (isDiagnosticArm(n) || n === "OFF-legacy") return n;
  return null;
}

// ON-im-bg is only an "ON-im with the stream on" block when the idle simulator-server was
// alive for (nearly) the whole block, read from the load sampler (load-sampler.js).
const SIMSERVER_ALIVE_MIN = 0.9;

/** `block <name> phase <phase>` → { block, phase } (the sampler's context line). */
function contextOf(text) {
  const m = String(text || "")
    .trim()
    .match(/^block (\S+)(?: phase (.+))?$/);
  return m ? { block: m[1], phase: m[2] ? m[2].trim() : null } : { block: null, phase: null };
}

/**
 * simulator-server alive / samples over the block's harness phases, and its CPU ticks
 * over those intervals (pids present at both ends). null: no sample.
 */
function simServerAliveOf(name, loadSamples) {
  // Samples without a phase were taken before the harness started the block (the
  // workflow's ready-gate): the idle server is spawned by the harness, so they do not count.
  const mine = (loadSamples || []).filter((s) => {
    const c = contextOf(s && s.context);
    return c.block === name && c.phase != null;
  });
  if (!mine.length) return null;
  const sims = (s) => (Array.isArray(s.simServer) ? s.simServer : []);
  const alive = mine.filter((s) => sims(s).length > 0).length;
  let ticks = 0;
  for (let k = 1; k < mine.length; k++) {
    const before = new Map(sims(mine[k - 1]).map((x) => [x.pid, x.ticks]));
    for (const x of sims(mine[k]))
      if (before.has(x.pid)) ticks += Math.max(0, x.ticks - before.get(x.pid));
  }
  return { alive, n: mine.length, ticks };
}

const injectTotalOf = (b) =>
  Object.values((b && b.injectStrategyCounts) || {}).reduce((a, x) => a + (Number(x) || 0), 0);

/**
 * Why a diagnostic block is not a valid arm this run ([] = valid). Review run 37609765062
 * and review round 1:
 *  - both (ON blocks): on-device injectStrategyCounts total > 0 (the input ran through
 *    the open server; injectStrategyReported is only a note).
 *  - ON-im-bg: simulator-server alive in ≥ 90 % of the block's load samples and its CPU
 *    above 0 over them (the stream flows, not only the process exists).
 *  - ON-hostawait: the host-algorithm await ran (calls > 0) and never failed.
 * Other blocks: [].
 * @param {string} name @param {object} block the block JSON's `block` @param {object[]} loadSamples
 */
function diagnosticArmReasons(name, block, loadSamples) {
  const b = block || {};
  const why = [];
  if (isDiagnosticArm(name) && !(injectTotalOf(b) > 0))
    why.push("no on-device injectStrategyCounts (total 0): the input path is not shown");
  if (isOnImBg(name)) {
    const a = simServerAliveOf(name, loadSamples);
    if (!a) why.push(`no load samples for ${name}: simulator-server liveness not shown`);
    else {
      if (a.alive / a.n < SIMSERVER_ALIVE_MIN)
        why.push(
          `simulator-server alive in ${a.alive}/${a.n} load samples of ${name} ` +
            `(< ${SIMSERVER_ALIVE_MIN * 100} %)`
        );
      if (!(a.ticks > 0))
        why.push(`simulator-server CPU 0 over the load samples of ${name}: no sign of the stream`);
    }
  }
  if (isOnHostawait(name)) {
    const h = b.hostAwait;
    if (!h) why.push("no hostAwait record in the block: the await algorithm is not shown");
    else if (!(h.calls > 0)) why.push("no host-algorithm await ran");
    else if (h.failed > 0)
      why.push(`host-algorithm await failed ${h.failed}/${h.calls} (fell back to the tool)`);
  }
  return why;
}

// ON-hostawait: the await-screen-idle tool's host-side algorithm (tools/await-screen-idle:
// DEFAULT_POLL_INTERVAL_MS 200, DEFAULT_MIN_STABLE_MS 250, DEFAULT_TIMEOUT_MS 3000; the loop
// of utils/poll-describe-tree), reproduced here so the bench can run it over open-server
// reads and so it is unit-tested on fake signatures.
const HOST_AWAIT = { pollIntervalMs: 200, minStableMs: 250, timeoutMs: 3000 };

/**
 * The tool's tree-equality rule (treeSignature): role|label|value|frame rounded to 0.01 for
 * every node under the root, depth first. "" for a root with no children (an empty tree,
 * never settled).
 */
function hostAwaitSignature(root) {
  const round = (n) => Math.round(n * 100) / 100;
  const parts = [];
  const walk = (node) => {
    const f = node.frame || {};
    parts.push(
      `${node.role}|${node.label ?? ""}|${node.value ?? ""}|${round(f.x)},${round(f.y)},${round(f.width)},${round(f.height)}`
    );
    for (const c of node.children || []) walk(c);
  };
  for (const c of (root && root.children) || []) walk(c);
  return parts.join("\n");
}

/**
 * The host await loop: read a signature, settle when the same non-empty signature held for
 * minStableMs, poll every pollIntervalMs, give up at timeoutMs. A read that ends past the
 * deadline is not evaluated (pollDescribeTree's settleWithin); a read error is counted and
 * the loop goes on (the tool records it and keeps polling). Clock and sleep are injected.
 * @param {{ read: () => Promise<string>, timeoutMs?: number, pollIntervalMs?: number,
 *   minStableMs?: number, now?: () => number, sleep: (ms: number) => Promise<unknown> }} o
 * @returns {Promise<{ settled: boolean, waitedMs: number, polls: number, readErrors: number }>}
 */
async function hostAwaitIdle(o) {
  const timeoutMs = o.timeoutMs ?? HOST_AWAIT.timeoutMs;
  const pollIntervalMs = o.pollIntervalMs ?? HOST_AWAIT.pollIntervalMs;
  const minStableMs = o.minStableMs ?? HOST_AWAIT.minStableMs;
  const now = o.now || Date.now;
  const start = now();
  const deadline = start + timeoutMs;
  let polls = 0;
  let readErrors = 0;
  let stableSig;
  let stableSince = 0;
  const done = (settled) => ({ settled, waitedMs: now() - start, polls, readErrors });
  for (;;) {
    let sig = null;
    try {
      sig = await o.read();
    } catch {
      readErrors++;
    }
    polls++;
    const t = now();
    if (t > deadline) break;
    if (sig != null) {
      if (!sig) {
        stableSig = undefined;
        stableSince = 0;
      } else if (sig === stableSig) {
        if (t - stableSince >= minStableMs) return done(true);
      } else {
        stableSig = sig;
        stableSince = t;
        if (minStableMs === 0) return done(true);
      }
    }
    if (now() >= deadline) break;
    await o.sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
  return done(false);
}

module.exports = {
  isCurrentOff,
  isOnIm,
  isOnUia,
  isAbbaName,
  isOnImBg,
  isOnHostawait,
  isDiagnosticArm,
  armOf,
  diagnosticArmReasons,
  simServerAliveOf,
  SIMSERVER_ALIVE_MIN,
  HOST_AWAIT,
  hostAwaitSignature,
  hostAwaitIdle,
};
