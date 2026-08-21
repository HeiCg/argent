import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LogFileWriter, type RichLogEntry } from "../../src/utils/debugger/log-file-writer";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-log-writer-home-");

let writer: LogFileWriter;

function makeEntry(id: number, overrides: Partial<Omit<RichLogEntry, "marker">> = {}) {
  return {
    id,
    timestamp: new Date(1710000000000 + id * 1000).toISOString(),
    level: overrides.level ?? "log",
    message: overrides.message ?? `Log message ${id}`,
    stackTrace: overrides.stackTrace,
  };
}

describe("LogFileWriter", () => {
  beforeEach(() => {
    writer = new LogFileWriter(9999);
  });

  afterEach(() => {
    writer.close();
  });

  it("reports no file once the path is gone from under it", () => {
    // What the disposer asks before naming a path in a breadcrumb, and what
    // `debugger-log-registry` asks before sending a reader to grep it. The fd
    // survives an unlink, so answering from it would advertise a file that is
    // no longer there.
    expect(writer.hasFile()).toBe(true);
    fs.rmSync(writer.getFilePath());
    expect(writer.hasFile()).toBe(false);
  });

  describe("stale-log pruning", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    let logDir: string;

    const age = (file: string, ms: number) => {
      const when = new Date(Date.now() - ms);
      fs.utimesSync(file, when, when);
    };

    beforeEach(() => {
      // `scopeTempHome` above already pinned HOME and USERPROFILE at a fresh
      // directory for this test; a second one here would send the writer and
      // these fixtures to different places on Windows.
      logDir = path.join(os.homedir(), ".argent", "tmp");
      fs.mkdirSync(logDir, { recursive: true });
    });

    it("removes log files older than a day and leaves everything else", () => {
      const stale = path.join(logDir, "argent-logs-1111-1700000000000.log");
      const recent = path.join(logDir, "argent-logs-2222-1700000000000.log");
      const foreign = path.join(logDir, "not-a-log.txt");
      for (const f of [stale, recent, foreign]) fs.writeFileSync(f, "x");
      age(stale, DAY_MS + 60_000);
      age(foreign, DAY_MS + 60_000);
      age(recent, DAY_MS - 60 * 60 * 1000);

      const pruner = new LogFileWriter(3333);

      expect(fs.existsSync(stale)).toBe(false);
      // A concurrent tool-server's live writer touches its file hourly, so the
      // cutoff has to clear that by a long way: this one is an hour short of it
      // and still in use.
      expect(fs.existsSync(recent)).toBe(true);
      // The directory is not exclusively ours to empty.
      expect(fs.existsSync(foreign)).toBe(true);
      pruner.close();
    });

    it("lets a kept file age out once the session that kept it has closed", () => {
      // Both halves of the keep path's close, which the pruner then depends on:
      // the timer is disarmed, and the fd released. An fd left open is what
      // would let `touch` go on refreshing the kept file's mtime — the only
      // thing that ever makes it reclaimable — so a crash would leave a file no
      // sweep in any tool-server collects.
      vi.useFakeTimers();
      try {
        const idle = vi.getTimerCount();
        const crashed = new LogFileWriter(7777);
        expect(vi.getTimerCount()).toBe(idle + 1);
        crashed.write({ id: 1, timestamp: "t", level: "error", message: "CRITICAL pre-crash" });
        const kept = crashed.getFilePath();
        crashed.close({ keepFile: true });
        expect(vi.getTimerCount()).toBe(idle);
        expect(fs.existsSync(kept)).toBe(true);

        vi.advanceTimersByTime(DAY_MS + 60 * 60 * 1000);
        const later = new LogFileWriter(8888);

        expect(fs.existsSync(kept)).toBe(false);
        later.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("opens anyway when the log directory cannot be listed", () => {
      // The sweep is a courtesy; the session it runs for is not. A throw here
      // comes out of debugger-connect as a failed connect, on a machine where
      // the only thing wrong is that this directory belongs to someone else.
      let opened: LogFileWriter | undefined;
      fs.chmodSync(logDir, 0o000);
      try {
        // The mode has to actually bite, or the case below passes without ever
        // reaching the guard it is here for.
        expect(() => fs.readdirSync(logDir)).toThrow();
        expect(() => (opened = new LogFileWriter(4444))).not.toThrow();
      } finally {
        fs.chmodSync(logDir, 0o755);
        opened?.close();
      }
      // And it opened empty-handed rather than half-built: the file could no
      // more be created than the directory could be read.
      expect(opened?.hasFile()).toBe(false);
    });

    it("spares a session still open after a day of capturing nothing", () => {
      // The pruner reads mtime, which only moves when an entry is written — so
      // without the writer's keepalive an open session that has logged nothing
      // for a day is indistinguishable from an orphan, and the next connect
      // from any tool-server unlinks the file whose path the tool already
      // handed out. Reached the same way by a session past MAX_ENTRIES, where
      // `write` stops touching the file at all.
      //
      // Fake timers advance both the clock the pruner compares against and the
      // interval the writer scheduled, so the keepalive's own `new Date()` lands
      // ahead of the cutoff — which is the whole of what saves the file.
      vi.useFakeTimers();
      try {
        const live = new LogFileWriter(5555);
        live.write({ id: 1, timestamp: "t", level: "error", message: "CRITICAL pre-crash" });
        const livePath = live.getFilePath();

        vi.advanceTimersByTime(DAY_MS + 60 * 60 * 1000);
        const other = new LogFileWriter(6666);

        expect(fs.existsSync(livePath)).toBe(true);
        expect(fs.readFileSync(livePath, "utf-8")).toContain("CRITICAL pre-crash");
        other.close();
        live.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports no file when the log could not be opened, though entries still count", () => {
      // `open()` swallows its failure and buffers instead, so `totalEntries`
      // rises for a file that never existed. A breadcrumb built from the count
      // alone would tell an agent to read a path that has never been there.
      fs.chmodSync(logDir, 0o555);
      try {
        const w = new LogFileWriter(8888);
        w.write({ id: 1, timestamp: "t", level: "error", message: "buffered" });

        expect(w.getStats().totalEntries).toBe(1);
        expect(w.hasFile()).toBe(false);
        w.close();
      } finally {
        fs.chmodSync(logDir, 0o755);
      }
    });

    it("does not let the keepalive hold the process open", () => {
      // The tool-server exits when its work is done; an hourly ref'd interval
      // would keep the event loop alive for as long as any writer stayed open.
      // Real timers, because a faked one is not what Node would be holding.
      const w = new LogFileWriter(4444);
      try {
        const { keepalive } = w as unknown as { keepalive: NodeJS.Timeout };
        expect(keepalive.hasRef()).toBe(false);
      } finally {
        w.close();
      }
    });

    it("stops the keepalive when the writer closes", () => {
      // One debugger session per connect on a daemon that runs for weeks: an
      // interval that outlives its writer accumulates one timer per session.
      vi.useFakeTimers();
      try {
        const before = vi.getTimerCount();
        const w = new LogFileWriter(7777);
        expect(vi.getTimerCount()).toBe(before + 1);
        w.close();
        expect(vi.getTimerCount()).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("creates a flat log file in ~/.argent/tmp", () => {
    const filePath = writer.getFilePath();
    expect(filePath).toMatch(/\.argent\/tmp\/argent-logs-9999-\d+\.log$/);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("writes entries as flat text lines", () => {
    writer.write(makeEntry(0));
    writer.write(makeEntry(1));

    const content = fs.readFileSync(writer.getFilePath(), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    expect(lines[0]).toMatch(/^\[L:0\] .+ LOG\s+- \| Log message 0$/);
    expect(lines[1]).toMatch(/^\[L:1\] .+ LOG\s+- \| Log message 1$/);
  });

  it("returns RichLogEntry with marker from write()", () => {
    const result = writer.write(makeEntry(0));
    expect(result.marker).toBe("[L:0]");

    const result2 = writer.write(makeEntry(1));
    expect(result2.marker).toBe("[L:1]");
  });

  it("tracks stats correctly", () => {
    writer.write(makeEntry(0, { level: "log" }));
    writer.write(makeEntry(1, { level: "warn" }));
    writer.write(makeEntry(2, { level: "error" }));
    writer.write(makeEntry(3, { level: "log" }));

    const stats = writer.getStats();
    expect(stats.totalEntries).toBe(4);
    expect(stats.byLevel).toEqual({ log: 2, warn: 1, error: 1 });
    expect(stats.fileSizeBytes).toBeGreaterThan(0);
    expect(stats.file).toBe(writer.getFilePath());
  });

  it("clusters messages by first 80 chars", () => {
    for (let i = 0; i < 10; i++) {
      writer.write(makeEntry(i, { message: "Repeated message" }));
    }
    writer.write(makeEntry(10, { message: "Unique message" }));

    const clusters = writer.getClusters();
    expect(clusters).toHaveLength(2);
    expect(clusters[0].message).toBe("Repeated message");
    expect(clusters[0].count).toBe(10);
    expect(clusters[0].firstId).toBe(0);
    expect(clusters[0].lastId).toBe(9);
    expect(clusters[1].message).toBe("Unique message");
    expect(clusters[1].count).toBe(1);
  });

  it("limits clusters to requested count", () => {
    for (let i = 0; i < 30; i++) {
      writer.write(makeEntry(i, { message: `msg-${i}` }));
    }
    const clusters = writer.getClusters(5);
    expect(clusters).toHaveLength(5);
  });

  it("includes source info in clusters from stack trace", () => {
    writer.write(
      makeEntry(0, {
        message: "From source",
        stackTrace: {
          callFrames: [
            {
              functionName: "fetchUser",
              scriptId: "1",
              url: "http://localhost:8081/src/api/user.ts?platform=ios",
              lineNumber: 42,
              columnNumber: 10,
            },
          ],
        },
      })
    );

    const clusters = writer.getClusters();
    expect(clusters[0].sourceFile).toBe("src/api/user.ts");
    expect(clusters[0].sourceLine).toBe(42);
  });

  it("readAll() returns all written entries", () => {
    writer.write(makeEntry(0));
    writer.write(makeEntry(1));
    writer.write(makeEntry(2));

    const entries = writer.readAll();
    expect(entries).toHaveLength(3);
    expect(entries[0].id).toBe(0);
    expect(entries[2].id).toBe(2);
  });

  it("readFiltered() filters by level", () => {
    writer.write(makeEntry(0, { level: "log" }));
    writer.write(makeEntry(1, { level: "error" }));
    writer.write(makeEntry(2, { level: "log" }));
    writer.write(makeEntry(3, { level: "error" }));

    const { entries, total } = writer.readFiltered({ level: "error" });
    expect(total).toBe(2);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.level === "error")).toBe(true);
  });

  it("readFiltered() limits results to last N", () => {
    for (let i = 0; i < 10; i++) {
      writer.write(makeEntry(i));
    }

    const { entries, total } = writer.readFiltered({ limit: 3 });
    expect(total).toBe(10);
    expect(entries).toHaveLength(3);
    expect(entries[0].id).toBe(7);
    expect(entries[2].id).toBe(9);
  });

  it("readFiltered() combines level and limit", () => {
    for (let i = 0; i < 10; i++) {
      writer.write(makeEntry(i, { level: i % 2 === 0 ? "error" : "log" }));
    }

    const { entries, total } = writer.readFiltered({ level: "error", limit: 2 });
    expect(total).toBe(5);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.level === "error")).toBe(true);
  });

  it("close() deletes the file", () => {
    const filePath = writer.getFilePath();
    expect(fs.existsSync(filePath)).toBe(true);

    writer.close();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("close() is idempotent", () => {
    writer.close();
    expect(() => writer.close()).not.toThrow();
  });

  it("write() throws after close", () => {
    writer.close();
    expect(() => writer.write(makeEntry(0))).toThrow("LogFileWriter is closed");
  });

  it("readAll() returns empty after close", () => {
    writer.write(makeEntry(0));
    writer.close();
    expect(writer.readAll()).toEqual([]);
  });

  it("stackTrace is NOT persisted to flat file but sourceFile IS in cluster", () => {
    const stackTrace = {
      callFrames: [
        {
          functionName: "render",
          scriptId: "5",
          url: "http://localhost:8081/src/App.tsx",
          lineNumber: 10,
          columnNumber: 5,
        },
      ],
    };
    writer.write(makeEntry(0, { stackTrace }));

    // readAll() reconstructs from flat file — no stackTrace
    const entries = writer.readAll();
    expect(entries[0].stackTrace).toBeUndefined();

    // But source attribution is still available via in-memory clusters
    const clusters = writer.getClusters();
    expect(clusters[0].sourceFile).toBe("src/App.tsx");
    expect(clusters[0].sourceLine).toBe(10);
  });

  it("collapses newlines in message to spaces in flat file", () => {
    writer.write(makeEntry(0, { message: "Error:\nstacktrace here" }));

    const content = fs.readFileSync(writer.getFilePath(), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Error: stacktrace here");
  });

  it("bundle URL as sourceFile → cluster.sourceFile is undefined", () => {
    writer.write(
      makeEntry(0, {
        message: "Bundle source",
        stackTrace: {
          callFrames: [
            {
              functionName: "",
              scriptId: "1",
              url: "http://localhost:8081/index.bundle?platform=ios&dev=true",
              lineNumber: 1,
              columnNumber: 0,
            },
          ],
        },
      })
    );

    const clusters = writer.getClusters();
    expect(clusters[0].sourceFile).toBeUndefined();
  });

  it("valid source URL → cluster.sourceFile is clean relative path (no port, no query)", () => {
    writer.write(
      makeEntry(0, {
        message: "API call",
        stackTrace: {
          callFrames: [
            {
              functionName: "fetchUser",
              scriptId: "1",
              url: "http://localhost:8081/src/api/user.ts?platform=ios",
              lineNumber: 42,
              columnNumber: 10,
            },
          ],
        },
      })
    );

    const clusters = writer.getClusters();
    expect(clusters[0].sourceFile).toBe("src/api/user.ts");
  });
});
