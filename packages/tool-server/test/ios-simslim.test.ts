import { describe, expect, it, vi } from "vitest";
import {
  applySimslimBeforeBoot,
  parseGoDurationMs,
  readSimslimSettings,
  simslimOnTimeoutMs,
  verifySimslimAfterBoot,
  type SimslimExec,
  type SimslimExecResult,
  type SimslimSettings,
  type SimslimTarget,
} from "../src/utils/ios-simslim";

const UDID = "11111111-1111-1111-1111-111111111111";
const PROFILE = "/repo/.github/simslim/ci.json";
const SETTINGS: SimslimSettings = { profile: PROFILE, binary: "simslim" };

function target(over: Partial<SimslimTarget> = {}): SimslimTarget {
  return {
    udid: UDID,
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
    runtimeKind: "mobile",
    state: "Shutdown",
    shutDownByForce: false,
    deviceSet: null,
    ...over,
  };
}

const ok = (stdout = ""): SimslimExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const STATUS = JSON.stringify({
  managedDisabled: 168,
  managedTotal: 171,
  booted: true,
  persistent: true,
  verdict: "slim",
});

/** A fake simslim: answers by subcommand, records every call in order. */
function fakeExec(answers: Partial<Record<string, SimslimExecResult>> = {}) {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const exec: SimslimExec = vi.fn(async (file, args, opts) => {
    calls.push({ file, args, timeoutMs: opts.timeoutMs });
    const sub = args[0] === "--version" ? "version" : args[0]!;
    const answer = answers[sub];
    if (answer) return answer;
    if (sub === "version") return ok("simslim v0.11.0\n");
    if (sub === "verify") return ok(JSON.stringify({ udid: UDID, ok: true }));
    if (sub === "status") return ok(STATUS);
    return ok();
  });
  return {
    exec,
    calls,
    subs: () => calls.map((c) => (c.args[0] === "--version" ? "version" : c.args[0])),
  };
}

describe("readSimslimSettings", () => {
  it("is null — and reads nothing else — when no profile is configured", () => {
    const binary = vi.fn(() => "simslim");
    expect(readSimslimSettings({ profile: () => null, binary })).toBeNull();
    expect(binary).not.toHaveBeenCalled();
  });

  it("defaults the binary to `simslim` on PATH", () => {
    expect(readSimslimSettings({ profile: () => PROFILE, binary: () => null })).toEqual({
      profile: PROFILE,
      binary: "simslim",
    });
  });

  it("reads an unreadable config as off rather than failing the boot", () => {
    expect(
      readSimslimSettings({
        profile: () => {
          throw new Error("bad json");
        },
        binary: () => null,
      })
    ).toBeNull();
  });
});

describe("applySimslimBeforeBoot → verifySimslimAfterBoot", () => {
  it("happy path: version → on (with profile) → verify → status, and a slim result", async () => {
    const { exec, calls, subs } = fakeExec();
    const plan = await applySimslimBeforeBoot(SETTINGS, target(), exec);
    expect(plan).toEqual({ attempted: true, applied: true, version: "v0.11.0" });
    expect(calls[1]).toMatchObject({
      file: "simslim",
      args: ["on", UDID, "--profile", PROFILE],
      timeoutMs: simslimOnTimeoutMs({}),
    });

    const outcome = await verifySimslimAfterBoot(SETTINGS, target(), plan, exec);
    expect(subs()).toEqual(["version", "on", "verify", "status"]);
    expect(calls[2]!.args).toEqual(["verify", UDID, "--profile", PROFILE, "--json"]);
    expect(calls[3]!.args).toEqual(["status", UDID, "--json"]);
    expect(outcome).toEqual({
      slim: {
        applied: true,
        verdict: "slim",
        managedDisabled: 168,
        managedTotal: 171,
        profile: PROFILE,
        version: "v0.11.0",
      },
    });
  });

  it("passes the device set to every simslim call that targets the simulator", async () => {
    const deviceSet = "/Users/me/DeviceSets/ci";
    const { exec, calls } = fakeExec();
    const plan = await applySimslimBeforeBoot(SETTINGS, target({ deviceSet }), exec);
    await verifySimslimAfterBoot(SETTINGS, target({ deviceSet }), plan, exec);
    expect(calls[1]!.args).toEqual(["on", UDID, "--profile", PROFILE, "--set", deviceSet]);
    expect(calls[2]!.args).toEqual([
      "verify",
      UDID,
      "--profile",
      PROFILE,
      "--json",
      "--set",
      deviceSet,
    ]);
    expect(calls[3]!.args).toEqual(["status", UDID, "--json", "--set", deviceSet]);
  });

  it("applies after force shut a Booted simulator down", async () => {
    const { exec, subs } = fakeExec();
    const plan = await applySimslimBeforeBoot(
      SETTINGS,
      target({ state: "Booted", shutDownByForce: true }),
      exec
    );
    expect(plan.applied).toBe(true);
    expect(subs()).toEqual(["version", "on"]);
  });

  it("binary missing: no `on`, stock boot with one warning", async () => {
    const { exec, subs } = fakeExec({
      version: { code: null, stdout: "", stderr: "", timedOut: false, errorCode: "ENOENT" },
    });
    const plan = await applySimslimBeforeBoot(SETTINGS, target(), exec);
    expect(subs()).toEqual(["version"]);
    expect(plan).toEqual({
      attempted: false,
      applied: false,
      version: null,
      warning: expect.stringMatching(/simslim was not found.*booted stock/),
    });
    expect(await verifySimslimAfterBoot(SETTINGS, target(), plan, exec)).toEqual({
      warning: plan.warning,
    });
    expect(subs()).toEqual(["version"]);
  });

  it("runtime 18.4: skipped without spawning simslim", async () => {
    const { exec, calls } = fakeExec();
    const plan = await applySimslimBeforeBoot(
      SETTINGS,
      target({ runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-4" }),
      exec
    );
    expect(calls).toEqual([]);
    expect(plan.applied).toBe(false);
    expect(plan.warning).toMatch(/iOS 18\.5 or later.*iOS 18\.4.*booted stock/);
  });

  it("runtime 18.5 is accepted", async () => {
    const { exec } = fakeExec();
    const plan = await applySimslimBeforeBoot(
      SETTINGS,
      target({ runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-5" }),
      exec
    );
    expect(plan.applied).toBe(true);
  });

  it("simulator already Booted (no force): skipped without spawning simslim", async () => {
    const { exec, calls } = fakeExec();
    const plan = await applySimslimBeforeBoot(SETTINGS, target({ state: "Booted" }), exec);
    expect(calls).toEqual([]);
    expect(plan.applied).toBe(false);
    expect(plan.warning).toMatch(/already booted.*force: true/);
  });

  it("`on` exits non-zero: no retry, the warning carries the exit code and stderr", async () => {
    const { exec, subs } = fakeExec({
      on: {
        code: 1,
        stdout: "",
        stderr: "disabling com.apple.foo\nsimslim: launchctl disable failed\n",
        timedOut: false,
      },
    });
    const plan = await applySimslimBeforeBoot(SETTINGS, target(), exec);
    expect(subs()).toEqual(["version", "on"]);
    expect(plan).toMatchObject({ attempted: true, applied: false });
    expect(plan.warning).toMatch(/simslim on failed \(exit 1: simslim: launchctl disable failed\)/);
    // Post-boot still reports what state the simulator actually reached.
    const outcome = await verifySimslimAfterBoot(SETTINGS, target(), plan, exec);
    expect(subs()).toEqual(["version", "on", "status"]);
    expect(outcome.slim).toMatchObject({ applied: false, verdict: "slim" });
    expect(outcome.warning).toBe(plan.warning);
  });

  it("`on` times out: the warning says so", async () => {
    const { exec } = fakeExec({ on: { code: null, stdout: "", stderr: "", timedOut: true } });
    const plan = await applySimslimBeforeBoot(SETTINGS, target(), exec);
    expect(plan).toMatchObject({ attempted: true, applied: false });
    expect(plan.warning).toMatch(/did not finish within 15 min/);
  });

  it("verify drift (exit 1 with JSON): applied=false, the warning names the drift", async () => {
    const { exec } = fakeExec({
      verify: {
        code: 1,
        stdout: JSON.stringify({ udid: UDID, ok: false, missing: ["com.apple.a"], extra: ["b"] }),
        stderr: "",
        timedOut: false,
      },
      status: ok(JSON.stringify({ managedDisabled: 160, managedTotal: 171, verdict: "slim" })),
    });
    const plan = await applySimslimBeforeBoot(SETTINGS, target(), exec);
    const outcome = await verifySimslimAfterBoot(SETTINGS, target(), plan, exec);
    expect(outcome.slim).toMatchObject({ applied: false, managedDisabled: 160 });
    expect(outcome.warning).toMatch(/drift.*missing: com\.apple\.a.*extra: b/);
  });

  it("verify error (exit 1 without JSON): applied=false, the warning says unverified", async () => {
    const { exec } = fakeExec({
      verify: { code: 1, stdout: "", stderr: "simslim: no such device\n", timedOut: false },
    });
    const plan = await applySimslimBeforeBoot(SETTINGS, target(), exec);
    const outcome = await verifySimslimAfterBoot(SETTINGS, target(), plan, exec);
    expect(outcome.slim).toMatchObject({ applied: false });
    expect(outcome.warning).toMatch(/simslim verify failed \(simslim: no such device\)/);
    expect(outcome.warning).not.toMatch(/drift/);
  });

  it("status failure keeps the result but leaves its fields null", async () => {
    const { exec } = fakeExec({ status: { code: 1, stdout: "", stderr: "x", timedOut: false } });
    const plan = await applySimslimBeforeBoot(SETTINGS, target(), exec);
    const outcome = await verifySimslimAfterBoot(SETTINGS, target(), plan, exec);
    expect(outcome).toEqual({
      slim: {
        applied: true,
        verdict: null,
        managedDisabled: null,
        managedTotal: null,
        profile: PROFILE,
        version: "v0.11.0",
      },
    });
  });

  it("tvOS and unknown simulators (physical, unlisted) never call simslim and stay silent", async () => {
    for (const t of [
      target({ runtimeKind: "tv", runtime: "com.apple.CoreSimulator.SimRuntime.tvOS-26-0" }),
      target({ runtime: undefined, runtimeKind: undefined, state: undefined }),
    ]) {
      const { exec, calls } = fakeExec();
      const plan = await applySimslimBeforeBoot(SETTINGS, t, exec);
      expect(calls).toEqual([]);
      expect(plan).toEqual({ attempted: false, applied: false, version: null });
      expect(await verifySimslimAfterBoot(SETTINGS, t, plan, exec)).toEqual({});
    }
  });
});

describe("simslim on timeout", () => {
  it("defaults to 15 min and follows SIMSLIM_BOOT_TIMEOUT plus a grace minute", () => {
    expect(simslimOnTimeoutMs({})).toBe(15 * 60_000 + 60_000);
    expect(simslimOnTimeoutMs({ SIMSLIM_BOOT_TIMEOUT: "20m" })).toBe(20 * 60_000 + 60_000);
    expect(simslimOnTimeoutMs({ SIMSLIM_BOOT_TIMEOUT: "nonsense" })).toBe(15 * 60_000 + 60_000);
  });

  it("parses Go durations", () => {
    expect(parseGoDurationMs("15m")).toBe(900_000);
    expect(parseGoDurationMs("1h30m")).toBe(5_400_000);
    expect(parseGoDurationMs("90s")).toBe(90_000);
    expect(parseGoDurationMs("1500ms")).toBe(1_500);
    expect(parseGoDurationMs("0s")).toBeNull();
    expect(parseGoDurationMs("15")).toBeNull();
  });
});
