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
 * it when an event that answers ONLY where that entry did — the shape that proves
 * one device — keeps a file of its own. Anything wider leaves the file to the
 * day-old sweep. That makes the
 * module a lifetime owner, not only a message board, so read that field's doc
 * before setting it — an artifact the user is meant to keep does not go there.
 */

import * as fs from "node:fs";
import { classifyDevice } from "./device-info";

/** Which session kind was reaped; scopes the key so two kinds can't collide. */
export type ReapedSessionKind = "screen-recording" | "native-profiler" | "js-runtime-debugger";

/**
 * What ended the session. `runtime-death` is the CDP connection dropping under
 * it rather than a `dispose()` closing it — the app went away, the debugger
 * lost its route to it, or Metro handed the one debugger slot this device has
 * to someone else; `teardown` is a `dispose()` whose caller the disposer
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
  /**
   * This event replaced an earlier one nobody had read, and that one is gone
   * from the store — so nothing else will ever report what it captured, and the
   * answer has to say it is not the whole story.
   */
  superseded?: boolean;
  /**
   * …and the replaced event's kept log file was reclaimed with it, so there is
   * not even a file left to find. Separate from {@link superseded} because the
   * reclaim needs both events to have kept one.
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
  // Anything still in the store is unread — a read deletes every copy — so
  // replacing one is a second teardown arriving before the first was reported.
  // Set only where the entry is really gone: one whose id set differed keeps
  // its leftover keys below, and answers for itself under them.
  let replacedUnread = false;
  for (const previous of displaced.values()) {
    const leftovers = [...previous.keys].filter((k) => !keys.has(k));
    // A previous event keeps its copies, and its file, unless this one answers
    // to exactly the same ids. Nothing weaker proves one device: an id set that
    // differs either way is equally the shape `selectTarget`'s one-device
    // fallback produces, minting a stranger's session on the crashed device's
    // id — grown when that stranger reports a logicalDeviceId, narrowed when it
    // is a legacy inspector and reports none — and taking the entry there takes
    // the log file being held for the device that actually crashed. Every
    // uncertain shape leaves its file to the day-old sweep instead, which is
    // the failure that loses nothing.
    const standsIn =
      keys.size === previous.keys.size && [...keys].every((k) => previous.keys.has(k));
    if (!standsIn) continue;
    // Half an event explains nothing: a copy left behind would answer some
    // later, unrelated read.
    //
    // Its file goes with it only when this event keeps one of its own — nothing
    // else records that path — which bounds an UNREAD crash loop that keeps
    // reconnecting the same way to one kept file per device, since every crash
    // in such a loop keeps one. A loop that alternates the connect id with the
    // logicalDeviceId a mismatch told it to use is incomparable at every second
    // step, and those files wait for the sweep instead. A teardown
    // keeps none and reclaims none: it would be spending an unread crash log to
    // save a file the sweep collects anyway. Nor is a loop whose notes ARE read
    // bounded here — the read spends the event, leaving nothing to supersede —
    // and that is the point: the agent was just handed that path to read. The
    // one file this cannot protect is one named by a `connected` read that
    // landed before the dispose filed anything; the next crash reclaims it.
    for (const k of leftovers) reaped.delete(k);
    replacedUnread = true;
    if (previous.keptAt && opts.keptAt) orphanedFiles.add(previous.keptAt);
  }
  if (replacedUnread) {
    for (const deviceId of ids) {
      const filed = reaped.get(key(kind, deviceId, opts.scope));
      if (filed) {
        filed.superseded = true;
        if (orphanedFiles.size > 0) filed.supersededFileTaken = true;
      }
    }
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
 * is the common one and is named first; whether any FURTHER member can be named
 * depends on what was reaped. Only a debugger session has any: on Chromium
 * anything that reaps its `ChromiumCdp` cascades into it — `stop-simulator-server`
 * by its documented behaviour, and `flow-run` reclaiming an Electron app it
 * booted — and on Apple or Android `react-profiler-start` disposes the
 * debugger and the profiler session whenever it finds either in a state it
 * cannot reuse. That tool declares no chromium and no vega platform, and neither
 * a screen recording nor a native trace declares a dependency for any teardown
 * to cascade through, so a Vega debugger and those two kinds are where the
 * sentence stops after the first member. A `runtime-death` narrows that: no
 * `dispose()` ran, so pointing at the teardown family would send an agent
 * hunting for a tool call that never touched this session. It does NOT name the
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
      `a tab or window closing, the browser quitting) or its CDP endpoint stopped being ` +
      `reachable — which ends the session the same way a teardown does. Nothing here ` +
      `separates the two: the close reason that would is not kept.`
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
      ? `The log file it left at ${entry.keptAt} has since been reclaimed — a later crash on ` +
        `this device takes it, and a debugger session sweeps one a day old — so those entries ` +
        `are gone.`
      : entry.salvage;
  const earlier = entry.superseded
    ? ` An earlier session for this device ended the same way and nothing read its record ` +
      `before this one replaced it, so what that one captured is reported nowhere.` +
      (entry.supersededFileTaken
        ? ` Its log file went with it.`
        : ` Any log file it left is still in ~/.argent/tmp, named by nothing.`)
    : "";
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
