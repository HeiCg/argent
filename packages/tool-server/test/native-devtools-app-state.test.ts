import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DeviceInfo } from "@argent/registry";

// `restart_required` used to be asserted rather than measured: every unconnected
// app got it, forever. These cover the measurement that replaced it — what the
// running process was actually launched with, and whether this service's
// listener even existed at the time — since that is the whole difference
// between "restart-app fixes this" and "restarting the app is a loop".

const probe = vi.hoisted(() => ({
  launchctlList: "",
  psOutput: "",
  psFails: false,
  /** `launchctl setenv/getenv` calls seen — i.e. the launchd env being re-applied. */
  envOps: 0,
}));

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/dylibs/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTcp: () => "/fake/dylibs/tcp/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTvos: () => "/fake/dylibs/tvos/libArgentInjectionBootstrap.dylib",
  tcpInjectionDylibs: () => [],
  axServiceBinaryPath: () => "/fake/ax-service",
  axServiceBinaryPathTcp: () => "/fake/ax-service-tcp",
}));

type ExecCb = (err: Error | null, out: { stdout: string; stderr: string }) => void;

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (cmd: string, args: readonly string[], opts: unknown, cb?: ExecCb) => {
      const callback = (typeof opts === "function" ? opts : cb!) as ExecCb;
      const argv = args.join(" ");
      if (/\bps$/.test(cmd)) {
        if (probe.psFails) {
          callback(new Error("ps: no such process"), { stdout: "", stderr: "" });
          return;
        }
        callback(null, { stdout: probe.psOutput, stderr: "" });
        return;
      }
      if (argv.includes("launchctl list")) {
        callback(null, { stdout: probe.launchctlList, stderr: "" });
        return;
      }
      if (argv.includes("launchctl setenv") || argv.includes("launchctl getenv")) {
        probe.envOps += 1;
        callback(null, { stdout: "", stderr: "" });
        return;
      }
      if (argv.includes("simctl list")) {
        callback(null, { stdout: JSON.stringify({ devices: {} }), stderr: "" });
        return;
      }
      callback(null, { stdout: "", stderr: "" });
    },
  };
});

import { nativeDevtoolsBlueprint, type NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { parsePsElapsedSeconds, processCarriesInjection } from "../src/utils/ios-host";

const UDID = "AAAAAAAA-1111-2222-3333-444444444444";
const SOCKET = "/tmp/argent-nd-AAAAAAAA.sock";
const BUNDLE = "com.example.app";
const PID = 4242;

const device: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };

/** One `launchctl list` row in the real `<pid>\t<status>\t<label>` shape. */
function runningRow(pid: number | "-" = PID, bundleId = BUNDLE): string {
  return `${pid}\t0\tUIKitApplication:${bundleId}[dffa][rb-legacy]\n`;
}

/** `ps eww -p <pid> -o etime=,command=` output: age, argv, then the launch env. */
function psLine(etime: string, env: string): string {
  return `${etime} /Devices/${UDID}/Bluesky.app/Bluesky ${env}\n`;
}

const INJECTED_ENV =
  `NATIVE_DEVTOOLS_IOS_CDP_SOCKET=${SOCKET} ` +
  "DYLD_INSERT_LIBRARIES=/fake/dylibs/libArgentInjectionBootstrap.dylib";

async function stateFor(options: {
  /** Wall-clock the listener has been up when the state is read. */
  listenerAgeMs?: number;
}): Promise<string> {
  const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
  try {
    if (options.listenerAgeMs !== undefined) {
      vi.setSystemTime(Date.now() + options.listenerAgeMs);
    }
    return await (instance.api as NativeDevtoolsApi).appConnectionState(BUNDLE);
  } finally {
    await instance.dispose();
  }
}

describe("parsePsElapsedSeconds", () => {
  // `ps -o etime` drops the leading units when they are zero, so a simulator
  // app that has been up for a day renders in a shape the common case never
  // exercises. Reading `01-02:03:04` as anything smaller would make an ancient
  // process look younger than the listener and flip it to `unregistered`.
  it.each([
    ["00:45", 45],
    ["12:30", 750],
    ["01:00:00", 3600],
    ["2-03:04:05", 183845],
  ])("reads %s as %i seconds", (etime, seconds) => {
    expect(parsePsElapsedSeconds(etime)).toBe(seconds);
  });

  it("returns null for output it cannot read rather than guessing an age", () => {
    for (const junk of ["", "-", "ps: no such process", "45"]) {
      expect(parsePsElapsedSeconds(junk)).toBeNull();
    }
  });
});

describe("processCarriesInjection", () => {
  const unix = { transport: "unix", socketPath: SOCKET } as const;

  it("requires both the bootstrap dylib and this exact endpoint", () => {
    expect(processCarriesInjection(INJECTED_ENV, unix)).toBe(true);
    expect(processCarriesInjection(`NATIVE_DEVTOOLS_IOS_CDP_SOCKET=${SOCKET}`, unix)).toBe(false);
    expect(
      processCarriesInjection("DYLD_INSERT_LIBRARIES=/x/libArgentInjectionBootstrap.dylib", unix)
    ).toBe(false);
  });

  it("accepts the legacy pre-rename bootstrap name", () => {
    expect(
      processCarriesInjection(
        `NATIVE_DEVTOOLS_IOS_CDP_SOCKET=${SOCKET} DYLD_INSERT_LIBRARIES=/x/libInjectionBootstrap.dylib`,
        unix
      )
    ).toBe(true);
  });

  it("does not accept an endpoint that merely starts the same way", () => {
    // A whole-token match, not a substring one: `…-AAAAAAAA.sock.old` shares a
    // prefix with our path but is another run's socket, and treating it as ours
    // would call a genuinely relaunchable process unregistered.
    const env =
      `NATIVE_DEVTOOLS_IOS_CDP_SOCKET=${SOCKET}.old ` +
      "DYLD_INSERT_LIBRARIES=/x/libArgentInjectionBootstrap.dylib";
    expect(processCarriesInjection(env, unix)).toBe(false);
  });

  it("matches the port for a TCP endpoint", () => {
    const env =
      "NATIVE_DEVTOOLS_IOS_CDP_PORT=51234 DYLD_INSERT_LIBRARIES=/x/libArgentInjectionBootstrap.dylib";
    expect(processCarriesInjection(env, { transport: "tcp", port: 51234 })).toBe(true);
    expect(processCarriesInjection(env, { transport: "tcp", port: 51235 })).toBe(false);
  });
});

describe("appConnectionState measures the running process", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    probe.launchctlList = runningRow();
    probe.psOutput = psLine("10:00", INJECTED_ENV);
    probe.psFails = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports not_running when no UIKit job backs the bundle", async () => {
    probe.launchctlList = runningRow(PID, "com.other.app");

    await expect(stateFor({ listenerAgeMs: 60_000 })).resolves.toBe("not_running");
  });

  it("reports stale_process when the process carries no bootstrap dylib", async () => {
    probe.psOutput = psLine("00:30", `NATIVE_DEVTOOLS_IOS_CDP_SOCKET=${SOCKET}`);

    await expect(stateFor({ listenerAgeMs: 600_000 })).resolves.toBe("stale_process");
  });

  it("reports stale_process when the process points at another run's endpoint", async () => {
    probe.psOutput = psLine(
      "00:30",
      "NATIVE_DEVTOOLS_IOS_CDP_SOCKET=/tmp/argent-nd-BBBBBBBB.sock " +
        "DYLD_INSERT_LIBRARIES=/fake/dylibs/libArgentInjectionBootstrap.dylib"
    );

    await expect(stateFor({ listenerAgeMs: 600_000 })).resolves.toBe("stale_process");
  });

  it("reports stale_process for an injected process older than this listener", async () => {
    // A tool-server restart rebinds the same per-udid path to a new inode, so an
    // app that predates it dialed a socket nobody holds — relaunching re-dials.
    probe.psOutput = psLine("01:00:00", INJECTED_ENV);

    await expect(stateFor({ listenerAgeMs: 30_000 })).resolves.toBe("stale_process");
  });

  it("reports unregistered for an injected process launched into this listener", async () => {
    probe.psOutput = psLine("00:30", INJECTED_ENV);

    await expect(stateFor({ listenerAgeMs: 600_000 })).resolves.toBe("unregistered");
  });

  it("reports indeterminate while a just-launched process is still dialing", async () => {
    probe.psOutput = psLine("00:01", INJECTED_ENV);

    await expect(stateFor({ listenerAgeMs: 600_000 })).resolves.toBe("indeterminate");
  });

  it("reports indeterminate when the process table cannot be read", async () => {
    probe.psFails = true;

    await expect(stateFor({ listenerAgeMs: 600_000 })).resolves.toBe("indeterminate");
  });

  it("reports indeterminate when ps answers but its age column does not parse", async () => {
    // `ps` exiting 0 with an unreadable etime is not the same as `ps` failing,
    // and it must not become a *measurement*: substituting any age here (0
    // being the tempting one) would let an uninspectable process be judged
    // against the listener and reported as a definite `stale_process`. The env
    // below carries no bootstrap dylib precisely so a fabricated age would show
    // up as that stronger claim.
    probe.psOutput = psLine("not-an-etime", `NATIVE_DEVTOOLS_IOS_CDP_SOCKET=${SOCKET}`);

    await expect(stateFor({ listenerAgeMs: 600_000 })).resolves.toBe("indeterminate");
  });

  // The 3 s grace is the difference between "one wasted restart-app" and
  // "restart a tool-server that was never broken". The other cases sit 200x
  // away from it on either side, so they pass whatever the term does — these
  // two sit ON it. Without them, both dropping the grace and weakening `>=` to
  // `>` leave the suite green while flipping a relaunchable process to
  // `unregistered`, the one verdict this file exists to withhold.
  it("still calls a process that started exactly at the grace boundary stale", async () => {
    // Launched 597 s after the listener, read at 600 s: 597 + 3 == 600.
    probe.psOutput = psLine("09:57", INJECTED_ENV);

    await expect(stateFor({ listenerAgeMs: 600_000 })).resolves.toBe("stale_process");
  });

  it("still calls a process launched a second before the listener stale", async () => {
    probe.psOutput = psLine("09:59", INJECTED_ENV);

    await expect(stateFor({ listenerAgeMs: 600_000 })).resolves.toBe("stale_process");
  });

  it("re-applies the launchd env on every read, not just the first", async () => {
    // The factory already latched `envSetup`, so a latching `ensureEnvReady()`
    // here would be a silent no-op. `reverifyEnv` exists to bypass that latch:
    // a simulator rebooted out of band has had DYLD_INSERT_LIBRARIES wiped
    // while the latch still reads `true`, and this is the call that puts it
    // back — so a process judged without it would be compared against an env no
    // relaunch would actually get.
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    try {
      const api = instance.api as NativeDevtoolsApi;
      probe.envOps = 0;

      await api.appConnectionState(BUNDLE);

      expect(probe.envOps).toBeGreaterThan(0);
    } finally {
      await instance.dispose();
    }
  });

  it("reports indeterminate for a registered job with no live process", async () => {
    probe.launchctlList = runningRow("-");

    await expect(stateFor({ listenerAgeMs: 600_000 })).resolves.toBe("indeterminate");
  });
});
