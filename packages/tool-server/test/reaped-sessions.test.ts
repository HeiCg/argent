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
    // stop-all-simulator-servers is the common one, but stop-simulator-server on
    // Chromium cascades into the debugger through ChromiumCdp, and
    // react-profiler-start { force: true } disposes it to reclaim the session —
    // so the message names the family rather than asserting one member.
    recordReapedSession("js-runtime-debugger", UDID);

    const message = describeReapedSession(
      takeReapedSession("js-runtime-debugger", UDID)!,
      "JS-runtime debugger session"
    );
    expect(message).toContain("stop-all-simulator-servers");
    expect(message).toContain("stop-simulator-server on Chromium");
    expect(message).toContain("react-profiler-start");
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
    expect(message).toContain("the app it was attached to went away");
    expect(message).not.toContain("stop-all-simulator-servers");
    expect(message).not.toContain("another agent");
    // Nor does it name a culprit it cannot see — a crash, a force-quit and a
    // restart-app all reach the disposer as the same dropped socket.
    expect(message).toContain("restart-app terminated it");
    // Still says the thing the breadcrumb exists to say.
    expect(message).toContain("It was not a session that never started.");
    expect(message).toContain("the log file is kept at /x");
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

    it("keeps the file when the same path is recorded twice", () => {
      // The Hermes disposer writes ONE event under both ids the device answers
      // to; the second write must not delete the file the first just kept.
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
