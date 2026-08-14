import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFailureSignal, type DeviceInfo } from "@argent/registry";
import { runHdcShell as realRunHdcShell } from "../src/utils/harmony-hdc";
import {
  resolveHarmonyEntry,
  launchHarmonyApp,
  openHarmonyUrl,
  terminateHarmonyApp,
} from "../src/utils/harmony-apps";
import { harmonyImpl as harmonyRestartImpl } from "../src/tools/restart-app/platforms/harmony";

// Only the transport is faked: these tests are about what the module makes of
// `bm`/`aa` output, and both CLIs report failure on stdout while exiting 0.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/harmony-hdc")>();
  return { ...actual, runHdcShell: vi.fn() };
});

const runHdcShell = vi.mocked(realRunHdcShell);

/**
 * `bm dump -n` output, trimmed to the keys the resolver reads. The three
 * fixtures are the three real bundles measured on a HarmonyOS 6.0.1 handset,
 * because the spelling of the launchable ability differs between them and that
 * difference is the whole reason the resolver is not a one-line read.
 */
const CALCULATOR = JSON.stringify({
  // mainAbility is fully qualified, the ability declares itself by short name.
  mainEntry: "phone",
  hapModuleInfos: [
    {
      name: "phone",
      mainAbility: "com.huawei.hmos.calculator.CalculatorAbility",
      abilityInfos: [{ name: "CalculatorAbility" }],
    },
  ],
});

const SETTINGS = JSON.stringify({
  // mainAbility is fully qualified and the ability declares the same string.
  mainEntry: "phone_settings",
  hapModuleInfos: [
    {
      name: "phone_settings",
      mainAbility: "com.huawei.hmos.settings.MainAbility",
      abilityInfos: [
        { name: "DefaultIntentBackgroundUiAbility" },
        { name: "com.huawei.hmos.settings.MainAbility" },
      ],
    },
  ],
});

const NOTEPAD = JSON.stringify({
  // mainAbility is already a short name.
  mainEntry: "phone",
  hapModuleInfos: [
    { name: "phone", mainAbility: "MainAbility", abilityInfos: [{ name: "MainAbility" }] },
  ],
});

const ok = (stdout: string) => ({ stdout, exitCode: 0 });

beforeEach(() => runHdcShell.mockReset());

describe("resolveHarmonyEntry", () => {
  it("passes the short ability name when that is how the bundle declares it", async () => {
    // Regression: sending `mainAbility` verbatim here fails on a real device
    // with `10104001 The specified ability does not exist`, and launch-app
    // reported a launch that never happened.
    runHdcShell.mockResolvedValueOnce(ok(CALCULATOR));
    expect(await resolveHarmonyEntry("dev", "com.huawei.hmos.calculator")).toEqual({
      mainAbility: "CalculatorAbility",
      module: "phone",
    });
  });

  it("passes the qualified ability name when that is how the bundle declares it", async () => {
    // The mirror case: shortening this one to `MainAbility` fails the same way.
    runHdcShell.mockResolvedValueOnce(ok(SETTINGS));
    expect(await resolveHarmonyEntry("dev", "com.huawei.hmos.settings")).toEqual({
      mainAbility: "com.huawei.hmos.settings.MainAbility",
      module: "phone_settings",
    });
  });

  it("passes an already-short mainAbility through unchanged", async () => {
    runHdcShell.mockResolvedValueOnce(ok(NOTEPAD));
    expect((await resolveHarmonyEntry("dev", "com.huawei.hmos.notepad")).mainAbility).toBe(
      "MainAbility"
    );
  });

  it("resolves a short mainAbility to a fully-qualified abilityInfos entry (Photos direction)", async () => {
    // Photos spells the pair the other way around from Calculator: `mainAbility`
    // is the short name and the ability declares itself fully qualified. The
    // match must run in BOTH directions — drop the `n.endsWith` arm and this
    // bundle falls back to the bare `MainAbility`, which `aa start -a` rejects
    // with `10104001 The specified ability does not exist`.
    runHdcShell.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          mainEntry: "phone",
          hapModuleInfos: [
            {
              name: "phone",
              mainAbility: "MainAbility",
              abilityInfos: [{ name: "com.huawei.hmos.photos.MainAbility" }],
            },
          ],
        })
      )
    );
    expect(await resolveHarmonyEntry("dev", "com.huawei.hmos.photos")).toEqual({
      mainAbility: "com.huawei.hmos.photos.MainAbility",
      module: "phone",
    });
  });

  it("prefers an exact abilityInfos match over a suffix that would also match", async () => {
    // Both entries match `MainAbility` under the suffix rule, but the bundle
    // declares one of them verbatim — and the verbatim declaration is the
    // spelling `aa start -a` accepts. Checking the suffix rule first would pick
    // the qualified entry (listed first here so the wrong precedence bites).
    runHdcShell.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          mainEntry: "phone",
          hapModuleInfos: [
            {
              name: "phone",
              mainAbility: "MainAbility",
              abilityInfos: [{ name: "com.example.fake.MainAbility" }, { name: "MainAbility" }],
            },
          ],
        })
      )
    );
    expect((await resolveHarmonyEntry("dev", "x")).mainAbility).toBe("MainAbility");
  });

  it("matches only on a dot boundary — `Ability` does not match `MainAbility`", async () => {
    // Without the boundary, `MainAbility`.endsWith(`Ability`) would rewrite the
    // ability to a name the bundle never declared. No entry matches, so the
    // fallback passes `mainAbility` through unchanged.
    runHdcShell.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          mainEntry: "phone",
          hapModuleInfos: [
            { name: "phone", mainAbility: "Ability", abilityInfos: [{ name: "MainAbility" }] },
          ],
        })
      )
    );
    expect((await resolveHarmonyEntry("dev", "x")).mainAbility).toBe("Ability");
  });

  it("picks the module named by mainEntry, not the first one listed", async () => {
    runHdcShell.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          mainEntry: "phone",
          hapModuleInfos: [
            {
              name: "feature",
              mainAbility: "FeatureAbility",
              abilityInfos: [{ name: "FeatureAbility" }],
            },
            { name: "phone", mainAbility: "MainAbility", abilityInfos: [{ name: "MainAbility" }] },
          ],
        })
      )
    );
    expect(await resolveHarmonyEntry("dev", "x")).toEqual({
      mainAbility: "MainAbility",
      module: "phone",
    });
  });

  it("reports an unknown bundle rather than parsing prose as JSON", async () => {
    runHdcShell.mockResolvedValueOnce(ok("error: bundle is not existed."));
    await expect(resolveHarmonyEntry("dev", "com.nope")).rejects.toThrow(/no app with bundle name/);
  });

  it("reports a bundle that declares no launchable ability", async () => {
    runHdcShell.mockResolvedValueOnce(
      ok(JSON.stringify({ mainEntry: "svc", hapModuleInfos: [{ name: "svc" }] }))
    );
    await expect(resolveHarmonyEntry("dev", "com.svc")).rejects.toThrow(
      /no launchable main ability/
    );
  });
});

describe("launchHarmonyApp", () => {
  it("fails when `aa` prints an error, even though it exits 0", async () => {
    // `aa start` exits 0 on failure. Trusting the status would report a launch
    // that did not happen — the failure mode this whole module is shaped around.
    runHdcShell
      .mockResolvedValueOnce(ok(CALCULATOR))
      .mockResolvedValueOnce(
        ok(
          "error: failed to start ability.\nError Code:10104001  Error Message:The specified ability does not exist"
        )
      );
    await expect(launchHarmonyApp("dev", "com.huawei.hmos.calculator")).rejects.toThrow(/10104001/);
  });

  it("keeps the coded line, not just `aa`'s useless headline", async () => {
    runHdcShell
      .mockResolvedValueOnce(ok(CALCULATOR))
      .mockResolvedValueOnce(
        ok(
          "error: failed to start ability.\nError Code:10104001  Error Message:The specified ability does not exist\nError cause: not installed"
        )
      );
    await expect(launchHarmonyApp("dev", "c")).rejects.toThrow(
      /error: failed to start ability\. Error Code:10104001/
    );
  });

  it("succeeds only on the success line", async () => {
    runHdcShell
      .mockResolvedValueOnce(ok(CALCULATOR))
      .mockResolvedValueOnce(ok("start ability successfully."));
    await expect(launchHarmonyApp("dev", "c")).resolves.toBeUndefined();
  });

  it("passes the resolved ability and module to `aa start`", async () => {
    runHdcShell
      .mockResolvedValueOnce(ok(CALCULATOR))
      .mockResolvedValueOnce(ok("start ability successfully."));
    await launchHarmonyApp("dev", "com.huawei.hmos.calculator");
    // Explicit, never a bare `-b`: implicit start fails and leaves a chooser on
    // the user's screen.
    expect(runHdcShell.mock.calls[1][1]).toBe(
      "aa start -b 'com.huawei.hmos.calculator' -a 'CalculatorAbility' -m 'phone'"
    );
  });
});

describe("terminateHarmonyApp", () => {
  it("succeeds on the success line, which is also what a not-running app gets", async () => {
    // Measured on 6.0.1 against three never-launched bundles: `aa force-stop`
    // reports success rather than a not-running error, which is why restart-app
    // tolerates nothing here.
    runHdcShell.mockResolvedValueOnce(ok("force stop process successfully."));
    await expect(terminateHarmonyApp("dev", "com.huawei.hmos.calculator")).resolves.toBeUndefined();
    expect(runHdcShell.mock.calls[0][1]).toBe("aa force-stop 'com.huawei.hmos.calculator'");
  });

  it("throws on an `error:` line, even though `aa` exits 0", async () => {
    runHdcShell.mockResolvedValueOnce(
      ok("error: failed to force stop process.\nError Code:16000050  Error Message:Internal error.")
    );
    await expect(terminateHarmonyApp("dev", "c")).rejects.toThrow(/Failed to stop 'c'.*16000050/s);
  });

  it("reports a missing bundle as not_found, like the launch path's lookup", async () => {
    // The same condition through the other verb: `resolveHarmonyEntry` answers
    // not_found for a bundle that is not installed, so a stop must not tell the
    // agent to retry a subprocess that can never succeed.
    runHdcShell.mockResolvedValueOnce(
      ok(
        "error: failed to force stop process.\nError Code:10104002  Error Message:Failed to retrieve specified package information."
      )
    );
    const err = await terminateHarmonyApp("dev", "com.example.nope").catch((e: unknown) => e);
    expect(getFailureSignal(err as Error)?.error_kind).toBe("not_found");
  });

  it("keeps a non-package stop failure classified as a subprocess failure", async () => {
    runHdcShell.mockResolvedValueOnce(
      ok("error: failed to force stop process.\nError Code:16000050  Error Message:Internal error.")
    );
    const err = await terminateHarmonyApp("dev", "c").catch((e: unknown) => e);
    expect(getFailureSignal(err as Error)?.error_kind).toBe("subprocess");
  });
});

describe("restart-app on harmony", () => {
  const device: DeviceInfo = { id: "harmony-KEY", platform: "harmony", kind: "device" };

  it("does not launch — and does not report a restart — when the stop was refused", async () => {
    // The whole point of the tool: a refused stop leaves the old process up, so
    // the launch that follows would no-op on it and `restarted: true` would name
    // a process that never went away.
    runHdcShell.mockResolvedValueOnce(
      ok("error: failed to force stop process.\nError Code:16000050  Error Message:Internal error.")
    );
    await expect(
      harmonyRestartImpl.handler({}, { udid: device.id, bundleId: "c" }, device)
    ).rejects.toThrow(/Failed to stop 'c'/);
    expect(runHdcShell).toHaveBeenCalledTimes(1);
  });

  it("stops and then launches, reporting the bundle it restarted", async () => {
    runHdcShell
      .mockResolvedValueOnce(ok("force stop process successfully."))
      .mockResolvedValueOnce(ok(CALCULATOR))
      .mockResolvedValueOnce(ok("start ability successfully."));
    await expect(
      harmonyRestartImpl.handler(
        {},
        { udid: device.id, bundleId: "com.huawei.hmos.calculator" },
        device
      )
    ).resolves.toEqual({ restarted: true, bundleId: "com.huawei.hmos.calculator" });
    expect(runHdcShell.mock.calls.map((c) => c[1])).toEqual([
      "aa force-stop 'com.huawei.hmos.calculator'",
      "bm dump -n 'com.huawei.hmos.calculator'",
      "aa start -b 'com.huawei.hmos.calculator' -a 'CalculatorAbility' -m 'phone'",
    ]);
  });
});

describe("openHarmonyUrl", () => {
  it("rejects a URI no app claims", async () => {
    runHdcShell.mockResolvedValueOnce(
      ok(
        "error: failed to start ability.\nError Code:10103101  Error Message:Failed to find a matching application for implicit launch."
      )
    );
    await expect(openHarmonyUrl("dev", "nope://x")).rejects.toThrow(/10103101/);
  });

  it("shell-quotes the URI so its query string cannot reach the device shell", async () => {
    runHdcShell.mockResolvedValueOnce(ok("start ability successfully."));
    await openHarmonyUrl("dev", "app://x?a=1&b=2;id");
    expect(runHdcShell.mock.calls[0][1]).toBe("aa start -U 'app://x?a=1&b=2;id'");
  });
});
