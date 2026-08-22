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
 *
 * One entry can also own a file: {@link ReapedSession.keptAt} names a log the
 * teardown left on disk for the breadcrumb to advertise, and this store unlinks
 * it when an event answering to exactly the same ids — the only shape that
 * proves one device — keeps a file of its own. Every other shape, wider or
 * narrower, leaves the file to the day-old sweep. That makes the module a
 * lifetime owner, not only a message board, so read that field's doc before
 * setting it — an artifact the user is meant to keep does not go there.
 */

import * as fs from "node:fs";
import { classifyDevice } from "./device-info";

/** Which session kind was reaped; scopes the key so two kinds can't collide. */
export type ReapedSessionKind = "screen-recording" | "native-profiler" | "js-runtime-debugger";

/**
 * What ended the session. `runtime-death` is a closed socket where no
 * `dispose()` accounts for it — the app went away, the debugger lost its route
 * to it, or Metro handed the one debugger slot this device has to someone else.
 * It is read from the socket, so a Chromium dispose landing inside a tab
 * switch, which leaves the client briefly between sockets, is filed here too.
 * `teardown` is a `dispose()` whose caller the disposer cannot see. All the disposer reads is a socket that stopped being open, which
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
  /**
   * How many earlier events this one replaced outright — each gone from the
   * store under every id it answered to, so nothing else will ever report what
   * they captured and the answer has to say it is not the whole story. Absent
   * where an earlier event kept a key of its own to go on answering under.
   */
  superseded?: number;
  /**
   * …and the replaced event's kept log file was reclaimed with it, so there is
   * not even a file left to find. Separate from {@link superseded} because the
   * reclaim needs both events to have kept one AND to have answered to the same
   * ids, which at most one replaced event can have done.
   */
  supersededFileTaken?: boolean;
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
 * own log file, so without the port a session ending on 8082 supersedes the
 * crash breadcrumb from 8081, and reclaims the file it named if it kept one of
 * its own. Omit it where a device
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
  const displaced = new Map<number, { keys: Set<string>; keptAt?: string; carried: number }>();
  for (const [k, entry] of reaped) {
    if (!collided.has(entry.event)) continue;
    const seen = displaced.get(entry.event);
    if (seen) seen.keys.add(k);
    else
      displaced.set(entry.event, {
        keys: new Set([k]),
        keptAt: entry.keptAt,
        // What it was already answering for. An unread crash loop replaces a
        // replacer every time round, and counting only this step would report
        // one loss however many sessions have gone unreported.
        carried: entry.superseded ?? 0,
      });
  }
  const filedNow: ReapedSession[] = [];
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
    filedNow.push(entry);
  }
  const orphanedFiles = new Set<string>();
  // Anything still in the store is unread — a read deletes every copy — so
  // replacing one is a second teardown arriving before the first was reported.
  let replacedUnread = 0;
  for (const previous of displaced.values()) {
    // An event holding a key this one did not take goes on answering under it,
    // so nothing of its has gone unreported. Count only the ones the write
    // above left nowhere: every id they answered to now names this event.
    if ([...previous.keys].some((k) => !keys.has(k))) continue;
    replacedUnread += 1 + previous.carried;
    // Its FILE goes with it only where this event answers to exactly the same
    // ids. Nothing weaker proves one device: `selectTarget`'s one-device
    // fallback mints a stranger's session on the crashed device's
    // logicalDeviceId and files it under both of its own ids, so a set this one
    // merely covers, or that covers this one, is equally that stranger and the
    // crashed device — and taking the file there takes the log being held for
    // the device that actually crashed. Every uncertain shape leaves its file
    // to the day-old sweep instead, the failure that loses nothing.
    //
    // It also needs this event to keep a file of its own — nothing else records
    // that path — which bounds an UNREAD crash loop that keeps reconnecting the
    // same way to one kept file per device, since every crash in such a loop
    // keeps one. A loop that alternates the connect id with the logicalDeviceId
    // a mismatch told it to use never files the same ids twice running, so no
    // step of one is comparable and every file waits for the sweep. A teardown
    // keeps none and reclaims
    // none: it would be spending an unread crash log to save a file the sweep
    // collects anyway. Nor is a loop whose notes ARE read bounded here — the
    // read spends the event, leaving nothing to supersede — and that is the
    // point: the agent was just handed that path to read. The one file this
    // cannot protect is one named by a `connected` read that landed before the
    // dispose filed anything; the next crash reclaims it.
    // Never this event's own path: the unlink runs after the write above, so a
    // file recorded twice would be taken from the answer advertising it. Both
    // events named one file there, so nothing of the earlier one is missing.
    if (
      previous.keys.size === keys.size &&
      previous.keptAt &&
      opts.keptAt &&
      previous.keptAt !== opts.keptAt
    ) {
      orphanedFiles.add(previous.keptAt);
    }
  }
  if (replacedUnread > 0) {
    for (const entry of filedNow) {
      entry.superseded = replacedUnread;
      if (orphanedFiles.size > 0) entry.supersededFileTaken = true;
    }
  }
  for (const file of orphanedFiles) {
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
 * The clause for the events this one replaced before anything read them.
 *
 * Says neither what ended them nor whose device they were: a teardown replaces
 * a crash as readily as the other way round, and the ids a replaced event
 * answered to are this event's own or a subset of them — which is also what
 * `selectTarget`'s one-device fallback files when it mints a stranger's session
 * on this id. Nor what they were holding — the clause is reached by all three
 * kinds. All that is certain is that they held output, that nothing read it,
 * and that no id reaches their record now.
 */
function describeReplacedRecords(entry: ReapedSession): string {
  const count = entry.superseded ?? 0;
  if (count === 0) return "";
  const subject = count === 1 ? "An earlier session" : `${count} earlier sessions`;
  const they = count === 1 ? "it" : "they";
  // Only a debugger entry leaves a file this store knows the home of. A
  // recording and a trace are written where the user asked for them, and the
  // replaced entry took the only record of that path with it.
  const file =
    entry.kind !== "js-runtime-debugger"
      ? ``
      : entry.supersededFileTaken
        ? ` The log file kept for it went with it.`
        : ` Any log file left behind is still in ~/.argent/tmp, named by nothing.`;
  return (
    ` ${subject} that answered here ended holding output nobody read, and this event ` +
    `replaced what ${they} filed, so what ${they} captured is reported nowhere.` +
    file
  );
}

/**
 * The sentence a tool shows in place of "no active session". Names what
 * happened, says it is not necessarily this agent's own doing (one tool-server
 * serves every agent), and points at whatever survived.
 *
 * On a `teardown` the disposer cannot see who triggered it — a blueprint's
 * `dispose()` is called by `Registry._teardown`, with no caller — so the message
 * names the family rather than asserting one member. `stop-all-simulator-servers`
 * is the common one and is named first; whether any FURTHER member can be named
 * depends on what was reaped. Only a debugger session has any: on Chromium
 * anything that reaps its `ChromiumCdp` cascades into it — `stop-simulator-server`
 * by its documented behaviour, and `flow-run` reclaiming an Electron app it
 * booted — and on Apple or Android `react-profiler-start` disposes the
 * debugger and the profiler session whenever it finds either in a state it
 * cannot reuse. That tool declares no chromium and no vega platform, and neither
 * a screen recording nor a native trace declares a dependency for any teardown
 * to cascade through, so a Vega debugger and those two kinds are where the
 * sentence stops after the first member. A `runtime-death` narrows that: on
 * every path but one the socket closed with nothing having called `dispose()`,
 * so pointing at the teardown family would send an agent hunting for a tool
 * call that never touched this session. The exception is a Chromium teardown
 * landing inside a tab switch, where the client is briefly socket-less with the
 * renderer alive and a real dispose reads the same. It does NOT name the
 * culprit either — the disposer sees a dropped socket, which a crash, a
 * force-quit, a `restart-app` and Metro evicting this debugger for a new one
 * all produce alike. Which of those an agent can act on is
 * platform-specific: a Chromium session has no Metro to have restarted, and
 * `restart-app` does not reach it at all — the tool's capability declares no
 * chromium platform, so the call is refused before dispatch. It gets the same
 * sentence in its own terms, the split the not-connected guidance makes for
 * the same reason.
 */
export function describeReapedSession(entry: ReapedSession, what: string): string {
  const secondsAgo = Math.max(0, Math.round((Date.now() - entry.atMs) / 1000));
  const isChromium = classifyDevice(entry.deviceId) === "chromium";
  const runtimeDeath = isChromium
    ? `its debugger connection dropped instead of being closed — the page went away (a crash, ` +
      `a tab or window closing, the browser quitting), its CDP endpoint stopped being ` +
      `reachable, or a teardown landed while a tab switch had the client between sockets — ` +
      `which ends the session the same way a teardown does. Nothing here separates the ` +
      `three: the close reason that would is not kept.`
    : `its debugger connection dropped instead of being closed — the app went away (a crash, ` +
      `a force-quit, a restart-app), the runtime stopped being reachable (Metro restarted, ` +
      `a device transport dropped), or another debugger attached and Metro closed this one, ` +
      `its inspector proxy allowing one per device and this one having lost the race — which ` +
      `ends the session the same way a teardown does. Nothing here separates the three: the ` +
      `close reason that would is not kept, and a later debugger-status answers for the ` +
      `runtime as it is by then, not for the one that died.`;
  // Only a debugger session has another tool that can have disposed it, and not
  // on every platform: a Chromium one goes with the ChromiumCdp it declares
  // a dependency on, which `stop-simulator-server` and a `flow-run` reclaiming
  // an Electron app it booted both reap, and an Apple or Android one is cleared
  // by `react-profiler-start` when it cannot reuse it. A Vega session has
  // neither, and a screen recording and a native trace declare no dependency for
  // a teardown to cascade through, so naming any of those tools to them would
  // send an agent after a call that could not have reached them.
  const otherReacher =
    entry.kind !== "js-runtime-debugger"
      ? undefined
      : isChromium
        ? `a stop-simulator-server, or a flow-run reclaiming an Electron app it booted, either ` +
          `of which cascades into the debugger through the Chromium CDP session it reaps`
        : classifyDevice(entry.deviceId) === "vega"
          ? undefined
          : `a react-profiler-start clearing a debugger session it could not reuse`;
  const why =
    entry.cause === "runtime-death"
      ? runtimeDeath
      : `by a stop-all-simulator-servers, which reaps every service a device owns` +
        (otherReacher ? `, or by ${otherReacher}` : ``) +
        `. One tool-server serves every agent using this argent install, so this may have been ` +
        `another agent rather than your own call.`;
  // The salvage clause was written when the file was there; a breadcrumb nobody
  // read can outlive it, so correct the promise rather than send the reader at a
  // path the log pruner has already reclaimed.
  const salvage =
    entry.keptAt && !fs.existsSync(entry.keptAt)
      ? `The log file it left at ${entry.keptAt} has since been reclaimed — a later crash ` +
        `filed under the same ids takes it, and a debugger session sweeps one a day old — so ` +
        `those entries are gone.`
      : entry.salvage;
  const earlier = describeReplacedRecords(entry);
  return (
    `The ${what} for device ${entry.deviceId} was torn down ${secondsAgo}s ago — ${why} ` +
    `It was not a session that never started.` +
    (salvage ? ` ${salvage}` : "") +
    earlier
  );
}

/**
 * The {@link ReapedSession.salvage} clause for a debugger session torn down
 * while it still held console history nobody had read.
 *
 * Pass `keptAt` — the log file's path — when the teardown left the file on
 * disk, which a runtime death does whenever the writer had one; omit it when
 * there is nothing to read, whether the teardown unlinked the file, the writer
 * never opened one, or something has removed it since. What
 * the clause settles is only whether the old entries are still readable
 * somewhere: why the session ended is the {@link ReapedSessionCause} clause's
 * job, and what an empty registry means belongs to the one consumer that has a
 * registry — `debugger-connect` and a `not_connected` answer have none.
 */
export function describeLostHistory(captured: number, keptAt?: string): string {
  const entries = `${captured} captured console ${captured === 1 ? "entry" : "entries"}`;
  if (keptAt) {
    return `The log file is kept at ${keptAt} — grep that file for the ${entries} it holds.`;
  }
  return `The ${entries} went with it — no log file was left behind.`;
}

/** Test-only: drop all breadcrumbs so cases don't leak across tests. */
export function __resetReapedSessionsForTesting(): void {
  reaped.clear();
}
