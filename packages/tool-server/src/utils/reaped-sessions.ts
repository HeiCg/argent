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
 * What ended the session. `runtime-death` is the app going away underneath it —
 * it crashed, was force-quit, or a tool such as `restart-app` terminated it;
 * `teardown` is a `dispose()` whose caller the disposer cannot see. The disposer
 * reads a dropped socket, which tells it the app is gone but not what took it.
 */
export type ReapedSessionCause = "teardown" | "runtime-death";

export interface ReapedSession {
  kind: ReapedSessionKind;
  deviceId: string;
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
   * The file {@link salvage} points at, when it points at one. Kept apart from
   * the prose so the read can check the file is still there: a breadcrumb has no
   * expiry, while a kept debugger log is swept once it is a day old, so an
   * unread breadcrumb outlives what it advertises.
   */
  keptAt?: string;
}

const reaped = new Map<string, ReapedSession>();

function key(kind: ReapedSessionKind, deviceId: string): string {
  return `${kind}:${deviceId.toLowerCase()}`;
}

/**
 * Note that `kind`'s session for `deviceId` was disposed with data unretrieved.
 *
 * Call ONLY when there was something to lose: a dispose of an idle session is
 * routine cleanup, and recording it would make the next honest "no active
 * session" answer claim a teardown destroyed something.
 *
 * `cause` defaults to `"teardown"` — all a disposer can say when the only thing
 * it knows is that `dispose()` ran. Pass `"runtime-death"` only where the
 * disposer can tell the app went away, and `keptAt` when the teardown left a
 * file behind for the reader to open.
 */
export function recordReapedSession(
  kind: ReapedSessionKind,
  deviceId: string,
  salvage?: string,
  opts: { cause?: ReapedSessionCause; keptAt?: string } = {}
): void {
  const k = key(kind, deviceId);
  const previous = reaped.get(k);
  const entry: ReapedSession = {
    kind,
    deviceId,
    atMs: Date.now(),
    cause: opts.cause ?? "teardown",
  };
  if (salvage) entry.salvage = salvage;
  if (opts.keptAt) entry.keptAt = opts.keptAt;
  reaped.set(k, entry);
  // One breadcrumb per kind+device, so recording this one just made whatever the
  // previous one named unreachable — nothing else records that path. Reclaim it
  // here instead of leaving it for the log pruner a day later, which is what
  // bounds a crash loop to one kept file per device rather than one per crash.
  if (previous?.keptAt && previous.keptAt !== entry.keptAt) {
    try {
      fs.unlinkSync(previous.keptAt);
    } catch {
      // already gone, or never ours
    }
  }
}

/** Read and consume the breadcrumb for `kind`/`deviceId`, if there is one. */
export function takeReapedSession(
  kind: ReapedSessionKind,
  deviceId: string
): ReapedSession | undefined {
  const k = key(kind, deviceId);
  const entry = reaped.get(k);
  if (entry) reaped.delete(k);
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
 * `ChromiumCdp` (its documented behaviour), and `react-profiler-start
 * { force: true }` disposes the debugger and the profiler session to reclaim
 * them. A `runtime-death` narrows that: the app itself went away, so pointing at
 * the teardown family would send an agent hunting for a tool call, or another
 * agent, that never touched this session. It does NOT name the culprit either —
 * the disposer sees a dropped socket, which a crash, a force-quit and a
 * `restart-app` all produce alike.
 */
export function describeReapedSession(entry: ReapedSession, what: string): string {
  const secondsAgo = Math.max(0, Math.round((Date.now() - entry.atMs) / 1000));
  const why =
    entry.cause === "runtime-death"
      ? `the app it was attached to went away — it crashed, was force-quit, or a tool such as ` +
        `restart-app terminated it — which ends the session the same way a teardown does.`
      : `by a stop-all-simulator-servers, which reaps every service a device owns, or by ` +
        `another teardown that reaches the same services (a stop-simulator-server on Chromium, ` +
        `or a react-profiler-start reclaiming the session with force). One tool-server serves ` +
        `every agent using this argent install, so this may have been another agent rather ` +
        `than your own call.`;
  // The salvage clause was written when the file was there; a breadcrumb nobody
  // read can outlive it, so correct the promise rather than send the reader at a
  // path the log pruner has already reclaimed.
  const salvage =
    entry.keptAt && !fs.existsSync(entry.keptAt)
      ? `The log file it left at ${entry.keptAt} has since been reclaimed — a kept log is ` +
        `swept by the next debugger session once it is a day old — so those entries are gone. ` +
        `This registry ` +
        `starts empty because a new session was minted, not because the app logged nothing.`
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
 * disk, which a runtime death does; omit it when the teardown unlinked it. The
 * count restarts at 0 either way, since the next resolve builds a new writer
 * over a new path, so what the clause has to settle is whether the old entries
 * are still readable somewhere. Why the session ended is the {@link
 * ReapedSessionCause} clause's job, not this one's.
 */
export function describeLostHistory(captured: number, keptAt?: string): string {
  const entries = `${captured} captured console ${captured === 1 ? "entry" : "entries"}`;
  if (keptAt) {
    return (
      `The log file is kept at ${keptAt} — it holds the ${entries}, so read that file for them. ` +
      `This registry starts empty because a new session was minted, not because the app logged ` +
      `nothing.`
    );
  }
  return (
    `The ${entries} went with it — the log file is deleted on teardown, so this registry starts ` +
    `empty rather than the app having logged nothing.`
  );
}

/** Test-only: drop all breadcrumbs so cases don't leak across tests. */
export function __resetReapedSessionsForTesting(): void {
  reaped.clear();
}
