/**
 * Process-global record of capture sessions a teardown reaped while they still
 * held data nobody had retrieved.
 *
 * `stop-all-simulator-servers` disposes every device-owned service, which since
 * the `devices` scope landed includes the three that hold captured output —
 * `ScreenRecordingSession` (a video), `NativeProfilerSession` (a trace) and
 * `JsRuntimeDebugger` (a console-log file). Disposing them is deliberate: each
 * owns a spawned process or an open fd that must not outlive the session.
 *
 * What is not deliberate is what the owner is then told. `Registry._teardown`
 * nulls the node's instance, so the next tool call resolves a FRESH service
 * whose api is indistinguishable from one that never ran — and the stop tools
 * answer "no active session, call start first" for a capture that did run and
 * whose output may still be on disk. That reads as "you never started one",
 * which is the one thing that is certainly false.
 *
 * So the disposer leaves a breadcrumb here and the tool that would otherwise
 * report absence reports the teardown instead. Module-global for the same
 * reason as `screen-recording-reminder`: it has to outlive the service instance
 * it describes, which is exactly what teardown destroys.
 *
 * Entries are CONSUMED by the read ({@link takeReapedSession}) — the breadcrumb
 * explains one confusing answer, once. Leaving it would make a genuine later
 * "you never started a recording" blame a teardown from an hour ago.
 */

import * as fs from "node:fs";

/** Which session kind was reaped; scopes the key so two kinds can't collide. */
export type ReapedSessionKind = "screen-recording" | "native-profiler" | "js-runtime-debugger";

/**
 * What ended the session. `runtime-death` is the CDP connection dropping under
 * it rather than a `dispose()` closing it — the app went away, or the debugger
 * lost its route to it; `teardown` is a `dispose()` whose caller the disposer
 * cannot see. All the disposer reads is a socket that stopped being open, which
 * says the far end is unreachable and nothing about what made it so.
 */
type ReapedSessionCause = "teardown" | "runtime-death";

export interface ReapedSession {
  kind: ReapedSessionKind;
  deviceId: string;
  /**
   * The teardown this describes. One teardown is filed under every id its
   * device answers to, and those copies are one event, not several — see
   * {@link takeReapedSession}.
   */
  event: number;
  /** When the teardown ran, for "…N seconds ago" phrasing. */
  atMs: number;
  /** Why the session ended, so the message does not blame a tool for a crash. */
  cause: ReapedSessionCause;
  /**
   * What survived, as a ready-to-read clause (e.g. naming a salvaged file), or
   * undefined when nothing did. Built by the disposer, which is the only place
   * that still knows.
   */
  salvage?: string;
  /**
   * A file this store may delete: the one {@link salvage} points at, kept apart
   * from the prose so the read can check it is still there — a breadcrumb has no
   * expiry, while a kept debugger log is swept once it is a day old, so an unread
   * breadcrumb outlives what it advertises — and so superseding this entry can
   * reclaim it (see {@link recordReapedSession}). Set it only for a file whose
   * lifetime the breadcrumb owns; an artifact the user is meant to keep, like the
   * recording and trace paths the other two kinds salvage, belongs in
   * {@link salvage} alone.
   */
  keptAt?: string;
}

const reaped = new Map<string, ReapedSession>();
let nextEvent = 1;

function key(kind: ReapedSessionKind, deviceId: string, scope?: string): string {
  return `${kind}:${scope ?? ""}:${deviceId.toLowerCase()}`;
}

/**
 * Note that `kind`'s session for `deviceId` was disposed with data unretrieved.
 *
 * Call ONLY when there was something to lose: a dispose of an idle session is
 * routine cleanup, and recording it would make the next honest "no active
 * session" answer claim a teardown destroyed something.
 *
 * Pass every id the device answers to — a debugger session is readable back
 * under the id the caller connected with OR the `logicalDeviceId` Metro echoed,
 * and only the disposer still knows both. They file one event, so consuming
 * either spends all of them.
 *
 * `cause` defaults to `"teardown"` — all a disposer can say when the only thing
 * it knows is that `dispose()` ran. Pass `"runtime-death"` only where the
 * disposer can tell the session's runtime went out from under it, and `keptAt`
 * when the teardown left a file behind for the reader to open.
 *
 * `scope` tells apart two sessions of one kind on one device, and readers must
 * pass the same one. A Metro-backed debugger is per port, each session with its
 * own log file, so without the port a teardown on 8082 supersedes the crash
 * breadcrumb from 8081 AND reclaims the file it named. Omit it where a device
 * holds at most one session of the kind (a recording, a profiler trace), and on
 * Chromium, whose port is already inside the device id.
 */
export function recordReapedSession(
  kind: ReapedSessionKind,
  deviceIds: string | string[],
  salvage?: string,
  opts: { cause?: ReapedSessionCause; keptAt?: string; scope?: string } = {}
): void {
  const event = nextEvent++;
  const ids = new Set(typeof deviceIds === "string" ? [deviceIds] : deviceIds);
  const keys = new Set([...ids].map((id) => key(kind, id, opts.scope)));
  // Read before the write below overwrites any of it: every event this one
  // lands on top of, with every key it holds — the ones this call is about to
  // take, and the ones it leaves.
  const collided = new Set<number>();
  for (const k of keys) {
    const previous = reaped.get(k);
    if (previous) collided.add(previous.event);
  }
  const displaced = new Map<number, { keys: Set<string>; keptAt?: string }>();
  for (const [k, entry] of reaped) {
    if (!collided.has(entry.event)) continue;
    const seen = displaced.get(entry.event);
    if (seen) seen.keys.add(k);
    else displaced.set(entry.event, { keys: new Set([k]), keptAt: entry.keptAt });
  }
  for (const deviceId of ids) {
    const entry: ReapedSession = {
      kind,
      deviceId,
      event,
      atMs: Date.now(),
      cause: opts.cause ?? "teardown",
    };
    if (salvage) entry.salvage = salvage;
    if (opts.keptAt) entry.keptAt = opts.keptAt;
    reaped.set(key(kind, deviceId, opts.scope), entry);
  }
  const orphanedFiles = new Set<string>();
  for (const previous of displaced.values()) {
    // Which of that event's copies this one did not take.
    const leftovers = [...previous.keys].filter((k) => !keys.has(k));
    // It keeps them, and its file, when this event is a DIFFERENT device: it
    // still answers under an id this one does not name, while this one names an
    // id it never answered to. That is the shape `selectTarget`'s one-device
    // fallback makes — a stranger's session minted on this device's
    // logicalDeviceId — and taking the crashed device's entry there would take
    // the log file it is holding for it.
    //
    // Two teardowns of one device mostly fail that test: their ids match, or
    // shrink (a caller pushed onto the logicalDeviceId by that same refusal
    // files one id where the crash filed two), or grow back — and the ones that
    // grow leave nothing behind to keep. A second app on this port is the
    // exception, since the app derives that id from its own bundle: the sets go
    // incomparable and the older session's file waits for the sweep.
    const standsIn = [...keys].every((k) => previous.keys.has(k));
    if (!standsIn && leftovers.length > 0) continue;
    // Half an event explains nothing: a copy left behind would answer some
    // later, unrelated read — and would still
    // name the file the reclaim below is about to take.
    //
    // Its kept file goes with it when this event keeps one of its own: nothing
    // records that path any more, and reclaiming it here rather than waiting for
    // the day-old sweep keeps an UNREAD crash loop to one kept file per device —
    // every crash in such a loop keeps a file, so the bound holds. A teardown
    // that keeps nothing reclaims nothing: it would be spending the log a crash
    // left, which the reader it was kept for may still reach by path, to save a
    // file the sweep collects anyway.
    //
    // A loop whose notes are read is not bounded here, and deliberately so.
    // restart-app then `debugger-connect` is both the prescribed recovery and
    // ordinary iteration, and it consumes the breadcrumb and hands the agent the
    // path, leaving no previous entry for the next teardown to supersede — so
    // one file per cycle waits for the day-old sweep rather than being deleted
    // out from under the agent that was just told to read it.
    for (const k of leftovers) reaped.delete(k);
    if (previous.keptAt && opts.keptAt) orphanedFiles.add(previous.keptAt);
  }
  for (const file of orphanedFiles) {
    if (file === opts.keptAt) continue;
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone, or never ours
    }
  }
}

/**
 * Read and consume the breadcrumb for `kind`/`deviceId`, if there is one.
 *
 * Consumes every copy of the same teardown, not just the one that matched. A
 * reader knows only the id it was called with, so a per-key delete would leave
 * a twin behind to explain a later, unrelated read — and to reclaim, on the
 * next teardown, the very file this answer just named.
 */
export function takeReapedSession(
  kind: ReapedSessionKind,
  deviceId: string,
  scope?: string
): ReapedSession | undefined {
  const entry = reaped.get(key(kind, deviceId, scope));
  if (!entry) return undefined;
  for (const [k, sibling] of reaped) {
    if (sibling.event === entry.event) reaped.delete(k);
  }
  return entry;
}

/**
 * The sentence a tool shows in place of "no active session". Names what
 * happened, says it is not necessarily this agent's own doing (one tool-server
 * serves every agent), and points at whatever survived.
 *
 * On a `teardown` the disposer cannot see who triggered it — a blueprint's
 * `dispose()` is called by `Registry._teardown`, with no caller — so the message
 * names the family rather than asserting one member. `stop-all-simulator-servers`
 * is the common one and is named first, but it is not the only one:
 * `stop-simulator-server` on Chromium cascades into the debugger through
 * `ChromiumCdp` (its documented behaviour), and `react-profiler-start` disposes
 * the debugger and the profiler session whenever it finds either in a state it
 * cannot reuse. A `runtime-death` narrows that: the app itself went away, so
 * pointing at the teardown family would send an agent hunting for a tool call,
 * or another agent, that never touched this session. It does NOT name the culprit either —
 * the disposer sees a dropped socket, which a crash, a force-quit and a
 * `restart-app` all produce alike.
 */
export function describeReapedSession(entry: ReapedSession, what: string): string {
  const secondsAgo = Math.max(0, Math.round((Date.now() - entry.atMs) / 1000));
  const why =
    entry.cause === "runtime-death"
      ? `its debugger connection dropped instead of being closed — the app went away (a crash, ` +
        `a force-quit, a restart-app) or the runtime stopped being reachable (Metro restarted, ` +
        `a device transport dropped) — which ends the session the same way a teardown does.`
      : `by a stop-all-simulator-servers, which reaps every service a device owns, or by ` +
        `another teardown that reaches the same services (a stop-simulator-server on Chromium, ` +
        `or a react-profiler-start clearing a session it could not reuse). One tool-server serves ` +
        `every agent using this argent install, so this may have been another agent rather ` +
        `than your own call.`;
  // The salvage clause was written when the file was there; a breadcrumb nobody
  // read can outlive it, so correct the promise rather than send the reader at a
  // path the log pruner has already reclaimed.
  const salvage =
    entry.keptAt && !fs.existsSync(entry.keptAt)
      ? `The log file it left at ${entry.keptAt} has since been reclaimed — a kept log is ` +
        `swept by the next debugger session once it is a day old — so those entries are gone.`
      : entry.salvage;
  return (
    `The ${what} for device ${entry.deviceId} was torn down ${secondsAgo}s ago — ${why} ` +
    `It was not a session that never started.` +
    (salvage ? ` ${salvage}` : "")
  );
}

/**
 * The {@link ReapedSession.salvage} clause for a debugger session torn down
 * while it still held console history nobody had read.
 *
 * Pass `keptAt` — the log file's path — when the teardown left the file on
 * disk, which a runtime death does; omit it when there is nothing to read,
 * whether the teardown unlinked the file or it was never created. What
 * the clause settles is only whether the old entries are still readable
 * somewhere: why the session ended is the {@link ReapedSessionCause} clause's
 * job, and what an empty registry means belongs to the one consumer that has a
 * registry — `debugger-connect` and a `not_connected` answer have none.
 */
export function describeLostHistory(captured: number, keptAt?: string): string {
  const entries = `${captured} captured console ${captured === 1 ? "entry" : "entries"}`;
  if (keptAt) {
    return `The log file is kept at ${keptAt} — read that file for the ${entries} it holds.`;
  }
  return `The ${entries} went with it — no log file was left behind.`;
}

/** Test-only: drop all breadcrumbs so cases don't leak across tests. */
export function __resetReapedSessionsForTesting(): void {
  reaped.clear();
}
