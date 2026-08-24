import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeRunnerCacheKey,
  prepareXctestrunWithPort,
  resolveSigningHint,
  runnerBuildStaticArgs,
  XctestrunFormatError,
  type RunnerSigningConfig,
} from "../src/utils/ios-device/runner-build";

const execFileAsync = promisify(execFile);

let tmpRoot: string;
beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "argent-runner-build-"));
});
afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Write a plist-XML .xctestrun from a JSON object via the same plutil the
 * production code shells out to (available on macOS dev machines and CI).
 */
async function writeXctestrun(name: string, contents: unknown): Promise<string> {
  const jsonPath = path.join(tmpRoot, `${name}.json`);
  const xctestrunPath = path.join(tmpRoot, `${name}.xctestrun`);
  await fsp.writeFile(jsonPath, JSON.stringify(contents));
  await execFileAsync("plutil", ["-convert", "xml1", jsonPath, "-o", xctestrunPath]);
  return xctestrunPath;
}

async function readPlistAsJson(filePath: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", filePath]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

const ENV_KEYS = [
  "EnvironmentVariables",
  "TestingEnvironmentVariables",
  "UITestEnvironmentVariables",
  "UITargetAppEnvironmentVariables",
];

type Target = Record<string, Record<string, string>>;

const expectPortInAllEnvMaps = (target: Target, port: number): void => {
  for (const key of ENV_KEYS) {
    expect(target[key]?.["ARGENT_RUNNER_PORT"], key).toBe(String(port));
  }
};

describe("prepareXctestrunWithPort", () => {
  it("injects the port into every env map of a v1 (top-level targets) xctestrun", async () => {
    const src = await writeXctestrun("v1", {
      __xctestrun_metadata__: { FormatVersion: 1 },
      ArgentRunnerUITests: {
        TestBundlePath: "__TESTHOST__/PlugIns/ArgentRunnerUITests.xctest",
        TestHostPath: "__TESTROOT__/ArgentRunnerUITests-Runner.app",
        EnvironmentVariables: { OS_ACTIVITY_DT_MODE: "YES" },
        TestingEnvironmentVariables: {},
      },
    });

    const clonePath = await prepareXctestrunWithPort(src, 50505);

    expect(clonePath).toBe(src.replace(/\.xctestrun$/, ".env.port-50505.xctestrun"));
    const clone = await readPlistAsJson(clonePath);
    const target = clone["ArgentRunnerUITests"] as Target;
    expectPortInAllEnvMaps(target, 50505);
    // Pre-existing entries survive the injection.
    expect(target["EnvironmentVariables"]?.["OS_ACTIVITY_DT_MODE"]).toBe("YES");
  });

  it("injects into targets nested under TestConfigurations (v2)", async () => {
    const src = await writeXctestrun("v2", {
      __xctestrun_metadata__: { FormatVersion: 2 },
      TestConfigurations: [
        {
          Name: "Test Scheme Action",
          TestTargets: [
            {
              BlueprintName: "ArgentRunnerUITests",
              TestBundlePath: "__TESTHOST__/PlugIns/ArgentRunnerUITests.xctest",
              TestHostPath: "__TESTROOT__/ArgentRunnerUITests-Runner.app",
              EnvironmentVariables: { DYLD_FRAMEWORK_PATH: "__TESTROOT__" },
            },
          ],
        },
      ],
    });

    const clonePath = await prepareXctestrunWithPort(src, 60606);

    const clone = await readPlistAsJson(clonePath);
    const configurations = clone["TestConfigurations"] as Array<{ TestTargets: Target[] }>;
    expectPortInAllEnvMaps(configurations[0]!.TestTargets[0]!, 60606);
  });

  it("throws the typed format error on a drifted xctestrun instead of writing a portless clone", async () => {
    const src = await writeXctestrun("drifted", {
      __xctestrun_metadata__: { FormatVersion: 3 },
      TestConfigurations: [
        {
          Name: "Test Scheme Action",
          // Neither TestBundlePath nor TestHostPath: the injection walk finds
          // nothing, which used to succeed silently and cost a 120s
          // ready-timeout misdiagnosed as signing/locked-screen.
          TestTargets: [
            { BlueprintName: "ArgentRunnerUITests", TestModulePath: "__TESTROOT__/Runner.app" },
          ],
        },
      ],
    });

    const error = await prepareXctestrunWithPort(src, 50505).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(XctestrunFormatError);
    expect((error as Error).name).toBe("XctestrunFormatError");
    expect((error as Error).message).toContain("xctestrun format not recognized");
    expect((error as Error).message).toContain(src);
    // Neither the clone nor the json intermediate may be left for the launch.
    const leftovers = (await fsp.readdir(tmpRoot)).filter((n) => n.startsWith("drifted.env."));
    expect(leftovers).toEqual([]);
  });
});

const PROJECT = "/opt/argent/ios-device-runner/ArgentRunner/ArgentRunner.xcodeproj";
const CONFIG: RunnerSigningConfig = {
  teamId: "ABCDE12345",
  signingIdentity: null,
  provisioningProfile: null,
  appBundleId: "com.swmansion.argent.runner",
  testBundleId: "com.swmansion.argent.runner.uitests",
};

describe("computeRunnerCacheKey", () => {
  it("is stable for identical inputs", () => {
    const a = computeRunnerCacheKey("srcs", "Xcode 16.4", runnerBuildStaticArgs(PROJECT, CONFIG));
    const b = computeRunnerCacheKey("srcs", "Xcode 16.4", runnerBuildStaticArgs(PROJECT, CONFIG));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when a static xcodebuild arg is edited", () => {
    const args = runnerBuildStaticArgs(PROJECT, CONFIG);
    const edited = args.map((a) => (a === "ENABLE_DEBUG_DYLIB=NO" ? "ENABLE_DEBUG_DYLIB=YES" : a));
    expect(edited).not.toEqual(args); // guards the fixture against arg drift
    expect(computeRunnerCacheKey("srcs", "x", edited)).not.toBe(
      computeRunnerCacheKey("srcs", "x", args)
    );
  });

  it("changes with the signing config, which rides in via the args", () => {
    const base = computeRunnerCacheKey("srcs", "x", runnerBuildStaticArgs(PROJECT, CONFIG));
    for (const config of [
      { ...CONFIG, appBundleId: "com.other.argent.runner" },
      { ...CONFIG, teamId: null },
      { ...CONFIG, signingIdentity: "Apple Development: Someone" },
      { ...CONFIG, provisioningProfile: "argent-runner-profile" },
    ]) {
      expect(computeRunnerCacheKey("srcs", "x", runnerBuildStaticArgs(PROJECT, config))).not.toBe(
        base
      );
    }
  });

  it("changes with the sources and toolchain fingerprints", () => {
    const args = runnerBuildStaticArgs(PROJECT, CONFIG);
    const base = computeRunnerCacheKey("srcs", "Xcode 16.4", args);
    expect(computeRunnerCacheKey("other-srcs", "Xcode 16.4", args)).not.toBe(base);
    expect(computeRunnerCacheKey("srcs", "Xcode 26.0", args)).not.toBe(base);
  });

  it("keeps the per-run destination/derived-data pair out of the static args", () => {
    const args = runnerBuildStaticArgs(PROJECT, CONFIG);
    expect(args).not.toContain("-destination");
    expect(args).not.toContain("-derivedDataPath");
  });
});

describe("resolveSigningHint", () => {
  it("maps a missing team to the ARGENT_IOS_TEAM_ID hint", () => {
    expect(resolveSigningHint('Signing for "ArgentRunner" requires a development team.')).toContain(
      "ARGENT_IOS_TEAM_ID"
    );
  });

  it("keeps the bundle-id hint for the explicit registration failure", () => {
    expect(
      resolveSigningHint("error: Failed Registering Bundle Identifier (in target 'ArgentRunner')")
    ).toContain("ARGENT_IOS_RUNNER_BUNDLE_ID");
  });

  it("gives the bundle-id hint when 'is not available' carries registration context", () => {
    const output =
      'The app identifier "com.swmansion.argent.runner" cannot be registered to your ' +
      "development team because it is not available.";
    expect(resolveSigningHint(output)).toContain("ARGENT_IOS_RUNNER_BUNDLE_ID");
  });

  it("does not blame the bundle id for unrelated 'is not available' failures", () => {
    const output =
      "xcodebuild: error: iPhone 15 with iOS 18.0 is not available for this run destination.";
    expect(resolveSigningHint(output)).toBeNull();
  });

  it("maps provisioning failures to the profile hint", () => {
    expect(
      resolveSigningHint('No profiles for "com.swmansion.argent.runner" were found')
    ).toContain("ARGENT_IOS_PROVISIONING_PROFILE");
  });

  it("returns null for output with no signing signature", () => {
    expect(resolveSigningHint("ld: symbol(s) not found for architecture arm64")).toBeNull();
  });
});
