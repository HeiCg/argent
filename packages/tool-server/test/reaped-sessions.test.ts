/**
 * The breadcrumb store's key semantics. Three tools read it — screen-recording
 * stop, native-profiler stop, debugger-log-registry — and each was tested only
 * against its own kind and its own single spelling, so nothing pinned what the
 * key itself does: scope by kind, and fold case the way every device-id lookup
 * in the stop tools does.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  recordReapedSession,
  takeReapedSession,
  describeReapedSession,
  __resetReapedSessionsForTesting,
} from "../src/utils/reaped-sessions";

const UDID = "6DBF83B4-0000-0000-0000-000000000000";

beforeEach(() => {
  __resetReapedSessionsForTesting();
});

describe("the reaped-session key", () => {
  it("scopes by kind, so one device's three captures do not collide", () => {
    // A teardown reaps all three of a device's capture services at once, and
    // each owner reads back separately. An unscoped key would let the
    // screen-recording read consume the profiler's explanation.
    recordReapedSession("screen-recording", UDID, "the video");
    recordReapedSession("native-profiler", UDID, "the trace");
    recordReapedSession("js-runtime-debugger", UDID, "the console log");

    expect(takeReapedSession("screen-recording", UDID)?.salvage).toBe("the video");
    // …and taking one leaves the other two intact.
    expect(takeReapedSession("native-profiler", UDID)?.salvage).toBe("the trace");
    expect(takeReapedSession("js-runtime-debugger", UDID)?.salvage).toBe("the console log");
  });

  it("folds case, so a device read back in another spelling still finds it", () => {
    // Device ids reach the two sides from different places — an iOS UDID comes
    // back uppercase from simctl and lowercase from some tool args — and every
    // id lookup in the stop tools already compares case-insensitively. A
    // case-sensitive key here would silently strand the explanation.
    recordReapedSession("native-profiler", UDID.toUpperCase(), "the trace");

    expect(takeReapedSession("native-profiler", UDID.toLowerCase())).toBeDefined();
    // Consumed once, whichever spelling asked.
    expect(takeReapedSession("native-profiler", UDID.toUpperCase())).toBeUndefined();
  });

  it("reports the device id in the spelling the DISPOSER used, not the reader's", () => {
    // The message names the device; it must name the one the teardown actually
    // reaped rather than echoing back whatever the reader happened to type.
    recordReapedSession("screen-recording", UDID.toUpperCase());

    const entry = takeReapedSession("screen-recording", UDID.toLowerCase())!;
    expect(describeReapedSession(entry, "screen recording")).toContain(UDID.toUpperCase());
  });

  it("keeps the newest record when one kind+device is reaped twice", () => {
    recordReapedSession("screen-recording", UDID, "first");
    recordReapedSession("screen-recording", UDID, "second");

    expect(takeReapedSession("screen-recording", UDID)?.salvage).toBe("second");
    expect(takeReapedSession("screen-recording", UDID)).toBeUndefined();
  });

  it("does not pin the teardown on one caller the disposer cannot have seen", () => {
    // A blueprint's dispose() is called by Registry._teardown with no caller, so
    // nothing that writes a breadcrumb knows which tool triggered it.
    // stop-all-simulator-servers is the common one, but react-profiler-start
    // disposes the session too whenever it finds it in a state it cannot reuse —
    // so the message names the family rather than asserting one member. It names
    // only the members that reach an RN session: `stop-simulator-server` reaches
    // the debugger through ChromiumCdp, which this device has none of.
    recordReapedSession("js-runtime-debugger", UDID);

    const message = describeReapedSession(
      takeReapedSession("js-runtime-debugger", UDID)!,
      "JS-runtime debugger session"
    );
    expect(message).toContain("stop-all-simulator-servers");
    expect(message).toContain("react-profiler-start");
    expect(message).not.toContain("a stop-simulator-server");
    // The claim that made it wrong two ways out of three.
    expect(message).not.toMatch(/torn down \d+s ago by a stop-all-simulator-servers/);
  });

  it("names the crash instead of the teardown family when the runtime died", () => {
    // The one cause a disposer can actually identify. Offering the teardown
    // family here — "a stop-all-simulator-servers … this may have been another
    // agent" — sends an agent hunting for a tool call that never happened, and
    // then contradicts itself with a salvage clause about a dead runtime.
    recordReapedSession("js-runtime-debugger", UDID, "the log file is kept at /x", {
      cause: "runtime-death",
    });

    const message = describeReapedSession(
      takeReapedSession("js-runtime-debugger", UDID)!,
      "JS-runtime debugger session"
    );
    expect(message).toContain("its debugger connection dropped instead of being closed");
    expect(message).not.toContain("stop-all-simulator-servers");
    expect(message).not.toContain("another agent");
    // Nor does it name a culprit it cannot see: a crash, a force-quit, a
    // restart-app and Metro going away all reach the disposer as the same
    // dropped socket, so it offers the whole family and leaves the caller's own
    // `reason` to narrow it.
    expect(message).toContain("a restart-app");
    expect(message).toContain("Metro restarted");
    // A second debugger attaching is the member of that family where the app is
    // fine, and it is not rare: Metro's inspector proxy allows one debugger per
    // device and closes the incumbent, and `CDPClient` keeps neither the close
    // code nor the reason, so it arrives as that same dropped socket. Omitting
    // it left the note asserting a crash and the guidance prescribing a
    // relaunch for a live app.
    expect(message).toContain("another debugger attached");
    // And no answer here narrows the family: `debugger-status` resolves a new
    // session, so it reports the runtime as it is when asked — connected once a
    // relaunch has landed, and connected from the survivor when a shared Metro
    // is down to one device.
    expect(message).toContain("Nothing here separates the three");
    // Still says the thing the breadcrumb exists to say.
    expect(message).toContain("It was not a session that never started.");
    expect(message).toContain("the log file is kept at /x");
  });

  it("tells a Chromium session its death in its own terms", () => {
    // The Metro wording pinned above names two recoveries a Chromium session
    // does not have: there is no Metro behind it, and `restart-app` declares no
    // chromium platform, so that call is refused before it dispatches. Naming
    // them sends an agent after a restart that cannot happen.
    recordReapedSession("js-runtime-debugger", "chromium-cdp-9222", "the log file is kept at /x", {
      cause: "runtime-death",
    });

    const message = describeReapedSession(
      takeReapedSession("js-runtime-debugger", "chromium-cdp-9222")!,
      "JS-runtime debugger session"
    );
    expect(message).toContain("its debugger connection dropped instead of being closed");
    expect(message).not.toContain("restart-app");
    expect(message).not.toContain("Metro");
    // And still offers the family it CAN see, in the terms that platform has.
    expect(message).toContain("the page went away");
    expect(message).toContain("the browser quitting");
    // And the same disclaimer the Metro arm carries: this platform has one
    // cause fewer, but no more ability to say which of them it was.
    expect(message).toContain("Nothing here separates the two");
    expect(message).toContain("the log file is kept at /x");
  });

  it("names a Chromium teardown only tools that reach a Chromium session", () => {
    // `react-profiler-start` carries RN_ONLY_TOOL_CAPABILITY, which declares no
    // chromium platform, so it can never have been the disposer here. What can
    // is anything that reaps the ChromiumCdp this session declares a dependency
    // on: `stop-simulator-server`, and a `flow-run` ending a booted Electron app.
    recordReapedSession("js-runtime-debugger", "chromium-cdp-9222", "");

    const message = describeReapedSession(
      takeReapedSession("js-runtime-debugger", "chromium-cdp-9222")!,
      "JS-runtime debugger session"
    );
    expect(message).toContain("stop-all-simulator-servers");
    expect(message).toContain("a stop-simulator-server");
    // flow-run reclaims a booted Electron app by disposing its ChromiumCdp,
    // which is the same cascade, so a session lost at the end of a run must not
    // be blamed on a stop tool nobody called.
    expect(message).toContain("a flow-run reclaiming an Electron app it booted");
    expect(message).not.toContain("react-profiler-start");
  });

  it("names no second tool for a kind nothing else can have reached", () => {
    // `describeReapedSession` serves all three kinds. A teardown cascades to a
    // service that DECLARES a dependency on what it reaped, and neither a screen
    // recording nor a native trace declares one; nor are they among the URNs
    // `react-profiler-start` disposes. Naming that tool to their owner sends an
    // agent after a call that cannot have taken their capture.
    recordReapedSession("screen-recording", UDID, "");

    const message = describeReapedSession(
      takeReapedSession("screen-recording", UDID)!,
      "screen recording"
    );
    expect(message).toContain("reaps every service a device owns. One tool-server");
    expect(message).not.toContain("react-profiler-start");
    expect(message).not.toContain("a stop-simulator-server");
  });

  it("names no react-profiler-start to a Vega debugger session", () => {
    // The debugger runs on Vega — DEBUGGER_TOOL_CAPABILITY declares vega.vvd —
    // while RN_ONLY_TOOL_CAPABILITY, which gates react-profiler-start, does not.
    recordReapedSession("js-runtime-debugger", "amazon-4a27df03c9777152", "");

    const message = describeReapedSession(
      takeReapedSession("js-runtime-debugger", "amazon-4a27df03c9777152")!,
      "JS-runtime debugger session"
    );
    expect(message).toContain("reaps every service a device owns. One tool-server");
    expect(message).not.toContain("react-profiler-start");
  });

  it("spends every copy of one teardown, whichever id the reader knows", () => {
    // A reader asks with one id and gets the whole event: a copy left behind
    // under the other would explain some later, unrelated answer, and would
    // reclaim on the next teardown the very file this read was sent to.
    recordReapedSession("js-runtime-debugger", [UDID, "logical-abc"], "salvage", {
      cause: "runtime-death",
    });

    expect(takeReapedSession("js-runtime-debugger", UDID)).toBeDefined();
    expect(takeReapedSession("js-runtime-debugger", "logical-abc")).toBeUndefined();
  });

  it("still reports a teardown whose two ids differ only in case", () => {
    // `key()` lowercases, so both spellings land in one slot: the second write
    // must not read the first as a previous event and supersede itself, which
    // would drop the only record of a teardown that did happen.
    recordReapedSession("js-runtime-debugger", [UDID, UDID.toLowerCase()], "same device", {
      cause: "runtime-death",
    });

    expect(takeReapedSession("js-runtime-debugger", UDID)?.salvage).toBe("same device");
  });

  it("defaults to the teardown family, so only a proven crash claims one", () => {
    recordReapedSession("screen-recording", UDID);
    expect(takeReapedSession("screen-recording", UDID)!.cause).toBe("teardown");
  });

  describe("the file a salvage clause points at", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-keptat-"));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("keeps the file of an event this one answers to fewer ids than", () => {
      // Narrowing has two readings and no way to tell them apart. One device
      // reconnecting with the logicalDeviceId alone, after `selectTarget`
      // refused its udid, is the harmless one. The other is `selectTarget`'s
      // one-device fallback binding the crashed device's id to a legacy
      // inspector, which reports no logicalDeviceId — and there the earlier
      // file is another device's crash log. Reclaim on the second reading and
      // it is destroyed, and the note that survives names the wrong file with
      // the right device on it; leave it and the harmless reading costs one
      // file that waits for the day-old sweep.
      const older = path.join(dir, "argent-logs-3-1.log");
      const newer = path.join(dir, "argent-logs-3-2.log");
      fs.writeFileSync(older, "first");
      fs.writeFileSync(newer, "second");
      recordReapedSession("js-runtime-debugger", [UDID, "logical-abc"], "first", {
        cause: "runtime-death",
        keptAt: older,
      });
      recordReapedSession("js-runtime-debugger", ["logical-abc"], "second", {
        cause: "runtime-death",
        keptAt: newer,
      });

      expect(fs.existsSync(older)).toBe(true);
      expect(fs.existsSync(newer)).toBe(true);
      // And the id the second event never named still answers for the first.
      expect(takeReapedSession("js-runtime-debugger", UDID)?.keptAt).toBe(older);
    });

    it("says so when it replaced an event nobody had read", () => {
      // A second crash before the first is reported is the one case where
      // entries go missing with every individual answer still true: this note
      // describes the newer session correctly and the older one not at all.
      const older = path.join(dir, "argent-logs-3-3.log");
      const newer = path.join(dir, "argent-logs-3-4.log");
      fs.writeFileSync(older, "first");
      fs.writeFileSync(newer, "second");
      recordReapedSession("js-runtime-debugger", [UDID], "first", {
        cause: "runtime-death",
        keptAt: older,
      });
      recordReapedSession("js-runtime-debugger", [UDID], "second", {
        cause: "runtime-death",
        keptAt: newer,
      });

      const message = describeReapedSession(
        takeReapedSession("js-runtime-debugger", UDID)!,
        "JS-runtime debugger session"
      );
      expect(message).toContain("nothing read its record before this one replaced it");
      expect(fs.existsSync(older)).toBe(false);
    });

    it("says nothing about an earlier event when there was none", () => {
      const kept = path.join(dir, "argent-logs-3-5.log");
      fs.writeFileSync(kept, "only");
      recordReapedSession("js-runtime-debugger", [UDID], "only", {
        cause: "runtime-death",
        keptAt: kept,
      });

      const message = describeReapedSession(
        takeReapedSession("js-runtime-debugger", UDID)!,
        "JS-runtime debugger session"
      );
      expect(message).not.toContain("An earlier session");
    });

    it("leaves the file of an event that never answered to every id this one names", () => {
      // The id set can grow back: a session keyed by the logicalDeviceId alone,
      // then one that files both ids again. Nothing can reach the older record
      // afterwards, but that shape is the stranger's fallback shape as well —
      // one shared id, one this event owns alone — so its file waits for the
      // day-old sweep instead of being taken from a device that may still own it.
      const older = path.join(dir, "argent-logs-5-1.log");
      const newer = path.join(dir, "argent-logs-5-2.log");
      fs.writeFileSync(older, "first");
      fs.writeFileSync(newer, "second");
      recordReapedSession("js-runtime-debugger", ["logical-abc"], "first", {
        cause: "runtime-death",
        keptAt: older,
      });
      recordReapedSession("js-runtime-debugger", [UDID, "logical-abc"], "second", {
        cause: "runtime-death",
        keptAt: newer,
      });

      expect(fs.existsSync(older)).toBe(true);
      expect(fs.existsSync(newer)).toBe(true);
      expect(takeReapedSession("js-runtime-debugger", "logical-abc")?.salvage).toBe("second");
    });

    it("leaves another device's breadcrumb, and its file, to the device that owns it", () => {
      // `selectTarget` answers an unmatched device_id with its single remaining
      // target, so a second device's session is minted on THIS device's
      // logicalDeviceId and files its own teardown under it. Superseding on that
      // one shared id would take the crashed device's kept log with it — the
      // read-side hazard `takeReapedNote` guards against, arriving from the
      // write side.
      const owners = path.join(dir, "argent-logs-4-1.log");
      fs.writeFileSync(owners, "pre-crash");
      recordReapedSession("js-runtime-debugger", [UDID, "logical-abc"], "owner", {
        cause: "runtime-death",
        keptAt: owners,
      });
      // The stranger keeps a file of its own, so the reclaim path is live: drop
      // the guard and this call unlinks the log the crashed device is holding.
      const strangers = path.join(dir, "argent-logs-5-1.log");
      fs.writeFileSync(strangers, "stranger's own");
      recordReapedSession(
        "js-runtime-debugger",
        ["someone-elses-device", "logical-abc"],
        "stranger",
        { cause: "runtime-death", keptAt: strangers }
      );

      expect(fs.existsSync(owners)).toBe(true);
      const entry = takeReapedSession("js-runtime-debugger", UDID);
      expect(entry?.salvage).toBe("owner");
      expect(entry?.keptAt).toBe(owners);
    });

    it("leaves the file alone once a reader has been given its path", () => {
      // The reclaim exists to bound a crash loop nobody reads. A read consumes the
      // whole event, so the next teardown finds nothing to replace — which is what
      // keeps it from deleting the file the reader was just sent to.
      const held = path.join(dir, "argent-logs-2-1.log");
      const next = path.join(dir, "argent-logs-2-2.log");
      fs.writeFileSync(held, "pre-crash");
      fs.writeFileSync(next, "later");
      recordReapedSession("js-runtime-debugger", [UDID, "logical-abc"], "kept", {
        cause: "runtime-death",
        keptAt: held,
      });
      expect(takeReapedSession("js-runtime-debugger", UDID)!.keptAt).toBe(held);

      // The app relaunches and crashes again, under the same two ids: without
      // the read above, this teardown would supersede that one and take its
      // file.
      recordReapedSession("js-runtime-debugger", [UDID, "logical-abc"], "kept", {
        cause: "runtime-death",
        keptAt: next,
      });

      expect(fs.existsSync(held)).toBe(true);
    });

    it("stops advertising it once it is gone", () => {
      // A breadcrumb has no expiry; a kept debugger log is reclaimed a day after
      // its session ends, and the sweep that reclaims it runs in the very
      // connect whose read then surfaces this note. Sending the agent at a path
      // deleted seconds earlier is worse than admitting the entries are gone.
      const kept = path.join(dir, "argent-logs-1-2.log");
      fs.writeFileSync(kept, "x");
      recordReapedSession("js-runtime-debugger", UDID, `The log file is kept at ${kept}`, {
        cause: "runtime-death",
        keptAt: kept,
      });
      fs.rmSync(kept);

      const message = describeReapedSession(
        takeReapedSession("js-runtime-debugger", UDID)!,
        "JS-runtime debugger session"
      );
      expect(message).toContain("has since been reclaimed");
      expect(message).not.toContain("The log file is kept at");
    });

    it("reclaims the file the previous breadcrumb named, which nothing can reach any more", () => {
      // One breadcrumb per kind+device: the second record makes the first one's
      // path unreachable. Left alone, a crash loop keeps one file per crash and
      // only the last is nameable.
      const older = path.join(dir, "argent-logs-1-1.log");
      const newer = path.join(dir, "argent-logs-1-2.log");
      fs.writeFileSync(older, "x");
      fs.writeFileSync(newer, "y");
      recordReapedSession("js-runtime-debugger", UDID, "first", {
        cause: "runtime-death",
        keptAt: older,
      });
      recordReapedSession("js-runtime-debugger", UDID, "second", {
        cause: "runtime-death",
        keptAt: newer,
      });

      expect(fs.existsSync(older)).toBe(false);
      expect(fs.existsSync(newer)).toBe(true);
    });

    it("keeps two Metro ports apart, each with its own file", () => {
      // One device can hold a debugger session per Metro port — one app on 8081,
      // another on 8082 — each with its own log file. On a shared key the
      // second teardown supersedes the first and reclaims the file it kept,
      // which is the one a reader was about to be sent to.
      const on8081 = path.join(dir, "argent-logs-8081-1.log");
      const on8082 = path.join(dir, "argent-logs-8082-1.log");
      fs.writeFileSync(on8081, "first");
      fs.writeFileSync(on8082, "second");
      recordReapedSession("js-runtime-debugger", UDID, "on 8081", {
        cause: "runtime-death",
        keptAt: on8081,
        scope: "8081",
      });
      recordReapedSession("js-runtime-debugger", UDID, "on 8082", {
        cause: "runtime-death",
        keptAt: on8082,
        scope: "8082",
      });

      expect(fs.existsSync(on8081)).toBe(true);
      expect(fs.existsSync(on8082)).toBe(true);
      // And a reader gets its own port's session, not whichever died last.
      expect(takeReapedSession("js-runtime-debugger", UDID, "8081")?.salvage).toBe("on 8081");
      expect(takeReapedSession("js-runtime-debugger", UDID, "8082")?.salvage).toBe("on 8082");
    });

    it("keeps the file when the same path is recorded twice", () => {
      // The sweep runs after the new entries are written, so a breadcrumb that
      // supersedes one naming the same file would otherwise unlink the very path
      // it is advertising.
      const kept = path.join(dir, "argent-logs-1-3.log");
      fs.writeFileSync(kept, "x");
      recordReapedSession("js-runtime-debugger", UDID, "same", {
        cause: "runtime-death",
        keptAt: kept,
      });
      recordReapedSession("js-runtime-debugger", UDID, "same", {
        cause: "runtime-death",
        keptAt: kept,
      });

      expect(fs.existsSync(kept)).toBe(true);
    });

    it("leaves a crash's file to the sweep when the teardown replacing it keeps nothing", () => {
      // The bound this reclaim defends is an unread crash LOOP, where every
      // crash keeps a file of its own. An ordinary teardown keeps none, so
      // reclaiming there would delete the one artifact the crash left — and the
      // developer can still reach it by path, which is more than a deleted file
      // offers. It waits for the day-old sweep instead.
      const crashLog = path.join(dir, "argent-logs-1-5.log");
      fs.writeFileSync(crashLog, "x");
      recordReapedSession("js-runtime-debugger", UDID, "the crash", {
        cause: "runtime-death",
        keptAt: crashLog,
      });

      recordReapedSession("js-runtime-debugger", UDID, "a later teardown");

      expect(fs.existsSync(crashLog)).toBe(true);
      // Superseded all the same: the note a reader gets is the teardown's.
      expect(takeReapedSession("js-runtime-debugger", UDID)?.salvage).toBe("a later teardown");
    });

    it("records the new session even though the file it supersedes is already gone", () => {
      // That directory is shared with every other tool-server on the machine,
      // any of which prunes it on its own connects. The record itself is
      // already written by the time this runs, but a throw here still takes the
      // rest of the disposer with it — the console server's close, the writer's
      // own, the CDP disconnect — and lands in the registry's teardown cascade.
      const swept = path.join(dir, "argent-logs-1-4.log");
      const replacement = path.join(dir, "argent-logs-1-6.log");
      fs.writeFileSync(swept, "x");
      fs.writeFileSync(replacement, "y");
      recordReapedSession("js-runtime-debugger", UDID, "first", {
        cause: "runtime-death",
        keptAt: swept,
      });
      fs.rmSync(swept);

      recordReapedSession("js-runtime-debugger", UDID, "second", {
        cause: "runtime-death",
        keptAt: replacement,
      });

      expect(takeReapedSession("js-runtime-debugger", UDID)?.salvage).toBe("second");
    });
  });

  it("omits the salvage clause entirely when nothing survived", () => {
    recordReapedSession("native-profiler", UDID);

    const entry = takeReapedSession("native-profiler", UDID)!;
    expect(entry.salvage).toBeUndefined();
    const message = describeReapedSession(entry, "native profiling session");
    expect(message).toContain("It was not a session that never started.");
    expect(message).toMatch(/never started\.$/);
  });
});
