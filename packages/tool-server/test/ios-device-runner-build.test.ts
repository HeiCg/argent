import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import {
  computeRunnerCacheKey,
  ensureRunnerArtifact,
  isProfileMissingDeviceFailure,
  killStaleRunnersForDevice,
  launchRunner,
  MAX_RUNNER_LOG_FILES,
  MAX_RUNNER_RESULT_BUNDLES,
  planRunnerStorageSweep,
  prepareXctestrunWithPort,
  PROCESS_TABLE_ARGV,
  resolveRunnerProjectPath,
  resolveRunnerSigningConfig,
  resolveSigningHint,
  runnerBuildStaticArgs,
  sweepRunnerStorage,
  waitForPidsToExit,
  xcodebuildFailureSummary,
  XctestrunFormatError,
  type RunnerArtifact,
  type RunnerSigningConfig,
} from "../src/utils/ios-device/runner-build";
import { PS_BIN } from "../src/utils/vega-process";

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
 * production code shells out to. plutil ships only with macOS, so every case
 * built on this helper is gated on darwin.
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

// The function under test reads and rewrites the plist with plutil, so both it
// and its fixtures are macOS-only. The unit-test job runs on Linux, where a
// missing plutil would fail the injection cases and pass the drift cases for
// the wrong reason.
describe.skipIf(process.platform !== "darwin")("prepareXctestrunWithPort", () => {
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

  it("wraps an unparseable (truncated) xctestrun in the same typed format error", async () => {
    const truncatedPath = path.join(tmpRoot, "truncated.xctestrun");
    // The head of a real plist, torn mid-write: plutil cannot parse it. Before
    // the wrap this surfaced as a raw execFileAsync error the blueprint's
    // self-heal could not key on.
    await fsp.writeFile(
      truncatedPath,
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n<key>TestConfig'
    );

    const error = await prepareXctestrunWithPort(truncatedPath, 50505).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(XctestrunFormatError);
    expect((error as Error).message).toContain("could not be parsed as a plist");
    expect((error as Error).message).toContain(truncatedPath);
    expect((error as Error).cause).toBeDefined();
  });
});

const PROJECT = "/opt/argent/ios-device-runner/ArgentRunner/ArgentRunner.xcodeproj";
const CONFIG: RunnerSigningConfig = {
  teamId: "ABCDE12345",
  appBundleId: "com.argent.runner.tabcde12345",
  testBundleId: "com.argent.runner.tabcde12345.uitests",
};

describe("runnerBuildStaticArgs", () => {
  it("always signs automatically under the configured team", () => {
    const args = runnerBuildStaticArgs(PROJECT, CONFIG);

    expect(args).toContain("CODE_SIGN_STYLE=Automatic");
    expect(args).toContain("DEVELOPMENT_TEAM=ABCDE12345");
    // The manual-signing surface is gone: no argv may carry an identity or a
    // profile, the pair xcodebuild refuses next to automatic signing.
    expect(
      args.filter((a) => /^(CODE_SIGN_IDENTITY|PROVISIONING_PROFILE_SPECIFIER)=/.test(a))
    ).toEqual([]);
  });
});

describe("resolveRunnerSigningConfig", () => {
  afterEach(() => {
    delete process.env.ARGENT_IOS_TEAM_ID;
  });

  it("derives the whole config from ARGENT_IOS_TEAM_ID", () => {
    process.env.ARGENT_IOS_TEAM_ID = " FGHIJ67890 ";

    expect(resolveRunnerSigningConfig()).toEqual({
      teamId: "FGHIJ67890",
      appBundleId: "com.argent.runner.tfghij67890",
      testBundleId: "com.argent.runner.tfghij67890.uitests",
    });
  });

  it("refuses a missing team id with the where-to-find-it guide", () => {
    delete process.env.ARGENT_IOS_TEAM_ID;
    let caught: unknown;
    try {
      resolveRunnerSigningConfig();
    } catch (error) {
      caught = error;
    }

    const message = (caught as Error).message;
    expect(message).toContain("ARGENT_IOS_TEAM_ID is not set");
    expect(message).toContain("Xcode > Settings > Accounts");
    expect(message).toContain("developer.apple.com/account");
    expect(getFailureSignal(caught)?.error_kind).toBe("validation");
  });
});

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
      { ...CONFIG, teamId: "FGHIJ67890" },
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !cond(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(cond()).toBe(true);
}

describe("ensureRunnerArtifact", () => {
  let fakeProject: string;
  let emptyBin: string;

  beforeAll(async () => {
    // resolveRunnerProjectPath returns the override verbatim; only its parent
    // dir is walked by the source fingerprint, so an empty one suffices.
    fakeProject = path.join(tmpRoot, "fake-runner-proj", "ArgentRunner.xcodeproj");
    await fsp.mkdir(path.dirname(fakeProject), { recursive: true });
    // An empty PATH dir makes the toolchain fingerprint deterministically
    // fall back to "unknown-xcode" instead of shelling out to real Xcode.
    emptyBin = path.join(tmpRoot, "ensure-empty-bin");
    await fsp.mkdir(emptyBin, { recursive: true });
  });

  /**
   * Run `fn` with HOME moved under a per-test dir (so cacheRoot() and the
   * fire-and-forget sweep stay inside the fixture tree), PATH narrowed to
   * `binDir` (empty by default, so nothing reaches the real Xcode), and the
   * project override pointed at the fake, the env-swap fixture pattern
   * launchRunner's tests established.
   */
  async function withEnsureEnv<T>(
    name: string,
    fn: () => Promise<T>,
    binDir: string = emptyBin
  ): Promise<T> {
    const saved = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      PROJECT: process.env.ARGENT_IOS_RUNNER_PROJECT,
    };
    process.env.HOME = path.join(tmpRoot, `ensure-home-${name}`);
    process.env.PATH = binDir;
    process.env.ARGENT_IOS_RUNNER_PROJECT = fakeProject;
    try {
      return await fn();
    } finally {
      process.env.HOME = saved.HOME;
      process.env.PATH = saved.PATH;
      if (saved.PROJECT === undefined) delete process.env.ARGENT_IOS_RUNNER_PROJECT;
      else process.env.ARGENT_IOS_RUNNER_PROJECT = saved.PROJECT;
    }
  }

  /**
   * A build seam that mints the base xctestrun exactly where the real build
   * arm would, counting invocations; `gate` holds the build mid-flight (after
   * the count, before any file exists) so a test can pin what happens while a
   * build is provably in progress.
   */
  function fakeBuild(counter: { builds: number }, gate?: Promise<void>) {
    return async (derivedDataPath: string): Promise<RunnerArtifact> => {
      counter.builds += 1;
      if (gate) await gate;
      const productsDir = path.join(derivedDataPath, "Build", "Products");
      await fsp.mkdir(productsDir, { recursive: true });
      const xctestrunPath = path.join(productsDir, "ArgentRunner_iphoneos18.0-arm64.xctestrun");
      await fsp.writeFile(xctestrunPath, "plist");
      return { xctestrunPath, derivedDataPath, fromCache: false };
    };
  }

  it("reports fromCache honestly and rebuilds the same key only when forced", async () => {
    await withEnsureEnv("hit-and-force", async () => {
      const counter = { builds: 0 };
      const build = fakeBuild(counter);

      const first = await ensureRunnerArtifact(CONFIG, { build });
      expect(first.fromCache).toBe(false);

      const hit = await ensureRunnerArtifact(CONFIG, { build });
      expect(hit.fromCache).toBe(true);
      expect(hit.xctestrunPath).toBe(first.xctestrunPath);
      expect(counter.builds).toBe(1);

      const forced = await ensureRunnerArtifact(CONFIG, { build, force: true });
      expect(forced.fromCache).toBe(false);
      expect(counter.builds).toBe(2);
    });
  });

  it("serializes concurrent same-key ensures into exactly one build", async () => {
    await withEnsureEnv("same-key", async () => {
      const counter = { builds: 0 };
      const gate = deferred();
      const build = fakeBuild(counter, gate.promise);

      const first = ensureRunnerArtifact(CONFIG, { build });
      // The first call provably holds the key's lock mid-build before the
      // second even starts, so the second MUST queue, not race.
      await until(() => counter.builds === 1);
      const second = ensureRunnerArtifact(CONFIG, { build });
      gate.resolve();

      const [a, b] = await Promise.all([first, second]);
      expect(counter.builds).toBe(1);
      expect(a.fromCache).toBe(false);
      expect(b.fromCache).toBe(true);
      expect(b.xctestrunPath).toBe(a.xctestrunPath);
    });
  });

  it("does not queue a different key's ensure behind an in-flight build", async () => {
    await withEnsureEnv("cross-key", async () => {
      const slowCounter = { builds: 0 };
      const slowGate = deferred();
      const slow = ensureRunnerArtifact(CONFIG, {
        build: fakeBuild(slowCounter, slowGate.promise),
      });
      let slowSettled = false;
      void slow.then(
        () => (slowSettled = true),
        () => (slowSettled = true)
      );
      await until(() => slowCounter.builds === 1);

      // A different bundle id changes the static args and thus the cache key;
      // its ensure must complete while the first key's build still runs.
      const otherConfig: RunnerSigningConfig = {
        ...CONFIG,
        appBundleId: "com.other.argent.runner",
        testBundleId: "com.other.argent.runner.uitests",
      };
      const fastCounter = { builds: 0 };
      const fast = await ensureRunnerArtifact(otherConfig, { build: fakeBuild(fastCounter) });
      expect(fast.fromCache).toBe(false);
      expect(fastCounter.builds).toBe(1);
      expect(slowSettled).toBe(false);

      slowGate.resolve();
      expect((await slow).fromCache).toBe(false);
    });
  });

  it("marks the derived dir as owned while xcodebuild runs and clears it after", async () => {
    // The real build arm, driven by a stub xcodebuild: the marker is what
    // keeps another checkout's sweep from rm -rf'ing this tree mid-build.
    const stubBin = path.join(tmpRoot, "ensure-stub-bin");
    await fsp.mkdir(stubBin, { recursive: true });
    await fsp.writeFile(
      path.join(stubBin, "xcodebuild"),
      [
        "#!/bin/sh",
        // The toolchain fingerprint calls this first; it takes no derived dir.
        'if [ "$1" = "-version" ]; then echo "Xcode 99.0"; exit 0; fi',
        'for arg in "$@"; do derived="$arg"; done', // -derivedDataPath's value is last
        'if [ -f "$derived/.argent-build-owner" ]; then : > "$derived/owner-seen"; fi',
        '/bin/mkdir -p "$derived/Build/Products"', // PATH holds only this stub
        ': > "$derived/Build/Products/ArgentRunner_iphoneos18.0-arm64.xctestrun"',
        "",
      ].join("\n"),
      { mode: 0o755 }
    );

    const artifact = await withEnsureEnv(
      "owner-marker",
      () => ensureRunnerArtifact(CONFIG),
      stubBin
    );

    await fsp.access(path.join(artifact.derivedDataPath, "owner-seen"));
    await expect(
      fsp.access(path.join(artifact.derivedDataPath, ".argent-build-owner"))
    ).rejects.toThrow();
  });
});

describe("resolveRunnerProjectPath", () => {
  it("probes the checkout walk-up first, then the packaged sibling of the bundle", () => {
    const saved = process.env.ARGENT_IOS_RUNNER_PROJECT;
    delete process.env.ARGENT_IOS_RUNNER_PROJECT;
    try {
      const probed: string[] = [];
      const resolved = resolveRunnerProjectPath((candidate) => {
        probed.push(candidate);
        return probed.length === 2;
      });

      expect(probed).toHaveLength(2);
      for (const candidate of probed) {
        expect(candidate).toMatch(/ios-device-runner\/ArgentRunner\/ArgentRunner\.xcodeproj$/);
      }
      expect(probed[1]).not.toBe(probed[0]);
      expect(resolved).toBe(probed[1]);
    } finally {
      if (saved === undefined) delete process.env.ARGENT_IOS_RUNNER_PROJECT;
      else process.env.ARGENT_IOS_RUNNER_PROJECT = saved;
    }
  });

  it("stamps the project-not-found error with a failure signal", () => {
    const saved = process.env.ARGENT_IOS_RUNNER_PROJECT;
    delete process.env.ARGENT_IOS_RUNNER_PROJECT;
    try {
      let caught: unknown;
      try {
        // Both candidates exist in real layouts, so the not-found arm is
        // reached through the exists seam.
        resolveRunnerProjectPath(() => false);
      } catch (error) {
        caught = error;
      }

      expect((caught as Error).message).toContain(
        "Could not locate the ios-device-runner Xcode project"
      );
      // Telemetry classification (T44): the broken-install story must not
      // fall into the registry's unclassified bucket.
      const signal = getFailureSignal(caught);
      expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY);
      expect(signal?.failure_stage).toBe("ios_device_runner_project_resolve");
    } finally {
      if (saved === undefined) delete process.env.ARGENT_IOS_RUNNER_PROJECT;
      else process.env.ARGENT_IOS_RUNNER_PROJECT = saved;
    }
  });
});

describe("isProfileMissingDeviceFailure", () => {
  it("recognizes the fresh-team shape alongside the new-device shapes", () => {
    const cases = [
      "Error 0xe8008012 while installing",
      "profile doesn't include the currently selected device",
      "this provisioning profile cannot be installed on this device",
      "error: Your team has no devices from which to generate a provisioning profile.",
    ];
    for (const text of cases) {
      expect(isProfileMissingDeviceFailure(text), text).toBe(true);
    }
    expect(isProfileMissingDeviceFailure("ld: symbol(s) not found")).toBe(false);
  });
});

describe("xcodebuildFailureSummary", () => {
  it("extracts the error lines, deduped, instead of the boilerplate tail", () => {
    const output = [
      "Build description signature: abc",
      "/proj.xcodeproj: error: No Accounts: Add a new account in Accounts settings.",
      "/proj.xcodeproj: error: No profiles for 'com.x' were found: Xcode couldn't find any.",
      "/proj.xcodeproj: error: No Accounts: Add a new account in Accounts settings.",
      "** TEST BUILD FAILED **",
      "The following build commands failed:",
      "\tBuilding project ArgentRunner for testing with scheme ArgentRunner",
      "(1 failure)",
    ].join("\n");

    const summary = xcodebuildFailureSummary(output);

    expect(summary).toBe(
      "/proj.xcodeproj: error: No Accounts: Add a new account in Accounts settings.\n" +
        "/proj.xcodeproj: error: No profiles for 'com.x' were found: Xcode couldn't find any."
    );
    expect(summary).not.toContain("TEST BUILD FAILED");
  });

  it("falls back to the tail when no error line exists", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    expect(xcodebuildFailureSummary(lines.join("\n"))).toBe(lines.slice(-15).join("\n"));
  });
});

describe("resolveSigningHint", () => {
  it("answers the fresh-team failure with the registration hint, not the sign-in one", () => {
    const hint = resolveSigningHint(
      "error: Your team has no devices from which to generate a provisioning profile."
    );
    expect(hint).toContain("no registered devices");
    expect(hint).not.toContain("Xcode > Settings > Accounts");
  });

  it("maps the explicit registration failure to the personal-team cap", () => {
    expect(
      resolveSigningHint("error: Failed Registering Bundle Identifier (in target 'ArgentRunner')")
    ).toContain("Personal Team");
  });

  it("gives the registration hint when 'is not available' carries registration context", () => {
    const output =
      'The app identifier "com.argent.runner.tabcde12345" cannot be registered to your ' +
      "development team because it is not available.";
    expect(resolveSigningHint(output)).toContain("Personal Team");
  });

  it("does not blame registration for unrelated 'is not available' failures", () => {
    const output =
      "xcodebuild: error: iPhone 15 with iOS 18.0 is not available for this run destination.";
    expect(resolveSigningHint(output)).toBeNull();
  });

  it("maps provisioning failures to the Xcode sign-in hint", () => {
    expect(
      resolveSigningHint('No profiles for "com.argent.runner.tabcde12345" were found')
    ).toContain("Xcode > Settings > Accounts");
  });
});

const EMPTY_LISTING = {
  currentCacheDirName: "cache-aaaa111122223333",
  cacheDirNames: [] as string[],
  productNames: [] as string[],
  logNames: [] as string[],
  testLogNames: [] as string[],
};

/** An xcresult bundle as Xcode names it, from a session timestamp. */
const xcresultName = (stamp: string): string => `Test-ArgentRunner-${stamp}-+0200.xcresult`;

describe("planRunnerStorageSweep", () => {
  it("deletes every cache-* sibling except the current key's dir", () => {
    const plan = planRunnerStorageSweep({
      ...EMPTY_LISTING,
      cacheDirNames: ["cache-aaaa111122223333", "cache-0123456789abcdef", "cache-ffff000011112222"],
    });

    expect(plan.cacheDirNames.sort()).toEqual(["cache-0123456789abcdef", "cache-ffff000011112222"]);
    expect(plan.cloneNames).toEqual([]);
    expect(plan.logNames).toEqual([]);
  });

  it("spares a sibling cache dir a live build owns", () => {
    // A second checkout fingerprints to a second key, so its in-flight
    // build-for-testing tree looks exactly like a superseded sibling.
    const plan = planRunnerStorageSweep({
      ...EMPTY_LISTING,
      cacheDirNames: ["cache-aaaa111122223333", "cache-0123456789abcdef", "cache-ffff000011112222"],
      busyCacheDirNames: ["cache-0123456789abcdef"],
    });

    expect(plan.cacheDirNames).toEqual(["cache-ffff000011112222"]);
  });

  it("ignores foreign names under the cache root", () => {
    const plan = planRunnerStorageSweep({
      ...EMPTY_LISTING,
      cacheDirNames: [
        ".DS_Store",
        "cache-README.txt",
        "cache-",
        "Cache-0123456789abcdef", // wrong case: not ours
        "scratch",
      ],
    });

    expect(plan.cacheDirNames).toEqual([]);
  });

  it("deletes stale env clones but keeps the excluded one and the base xctestrun", () => {
    const plan = planRunnerStorageSweep({
      ...EMPTY_LISTING,
      productNames: [
        "ArgentRunner_iphoneos18.0-arm64.xctestrun",
        "ArgentRunner_iphoneos18.0-arm64.env.port-50505.xctestrun",
        "ArgentRunner_iphoneos18.0-arm64.env.port-50506.xctestrun",
        "Debug-iphoneos",
      ],
      keepCloneName: "ArgentRunner_iphoneos18.0-arm64.env.port-50506.xctestrun",
    });

    expect(plan.cloneNames).toEqual(["ArgentRunner_iphoneos18.0-arm64.env.port-50505.xctestrun"]);
  });

  it("deletes ALL env clones when no exclusion is given (ensure-time: the session's clone is minted later)", () => {
    const plan = planRunnerStorageSweep({
      ...EMPTY_LISTING,
      productNames: [
        "ArgentRunner_iphoneos18.0-arm64.xctestrun",
        "ArgentRunner_iphoneos18.0-arm64.env.port-50505.xctestrun",
        "ArgentRunner_iphoneos18.0-arm64.env.port-50506.xctestrun",
      ],
    });

    expect(plan.cloneNames.sort()).toEqual([
      "ArgentRunner_iphoneos18.0-arm64.env.port-50505.xctestrun",
      "ArgentRunner_iphoneos18.0-arm64.env.port-50506.xctestrun",
    ]);
  });

  it("caps runner logs to the newest N by embedded timestamp, ignoring foreign files", () => {
    const plan = planRunnerStorageSweep({
      ...EMPTY_LISTING,
      logNames: [
        "runner-00008120-100.log",
        "runner-00008120-300.log",
        "runner-0000aaaa-200.log",
        "usbmux.log",
        "runner-note.txt",
      ],
      maxLogFiles: 2,
    });

    expect(plan.logNames).toEqual(["runner-00008120-100.log"]);
  });

  it("defaults the log cap to the newest 20", () => {
    const logNames = Array.from(
      { length: MAX_RUNNER_LOG_FILES + 3 },
      (_, i) => `runner-00008120-${1000 + i}.log`
    );

    const plan = planRunnerStorageSweep({ ...EMPTY_LISTING, logNames });

    expect(plan.logNames.sort()).toEqual([
      "runner-00008120-1000.log",
      "runner-00008120-1001.log",
      "runner-00008120-1002.log",
    ]);
  });

  it("caps result bundles to the newest N by their session timestamp", () => {
    const plan = planRunnerStorageSweep({
      ...EMPTY_LISTING,
      testLogNames: [
        xcresultName("2026.08.20_09-30-00"),
        xcresultName("2026.08.22_08-00-00"),
        xcresultName("2026.08.22_07-59-00"),
        xcresultName("2026.08.21_23-59-59"),
        "LogStoreManifest.plist", // foreign: Xcode's own index, never ours
      ],
      maxResultBundles: 2,
    });

    expect(plan.resultBundleNames.sort()).toEqual([
      xcresultName("2026.08.20_09-30-00"),
      xcresultName("2026.08.21_23-59-59"),
    ]);
  });

  it("defaults the result-bundle cap to the newest 3, enough for the crash reader", () => {
    const testLogNames = Array.from({ length: MAX_RUNNER_RESULT_BUNDLES + 1 }, (_, i) =>
      xcresultName(`2026.08.2${i}_10-00-00`)
    );

    const plan = planRunnerStorageSweep({ ...EMPTY_LISTING, testLogNames });

    expect(plan.resultBundleNames).toEqual([xcresultName("2026.08.20_10-00-00")]);
  });
});

describe("sweepRunnerStorage", () => {
  it("prunes a fake storage tree down to exactly the expected survivors", async () => {
    const root = path.join(tmpRoot, "sweep");
    const derived = path.join(root, "derived");
    const current = path.join(derived, "cache-aaaa111122223333");
    const products = path.join(current, "Build", "Products");
    const logDir = path.join(root, "logs");
    await fsp.mkdir(products, { recursive: true });
    await fsp.mkdir(path.join(derived, "cache-0123456789abcdef", "Build"), { recursive: true });
    await fsp.mkdir(path.join(derived, "foreign-dir"), { recursive: true });
    await fsp.mkdir(logDir, { recursive: true });
    const base = path.join(products, "ArgentRunner_iphoneos18.0-arm64.xctestrun");
    const keptClone = path.join(products, "ArgentRunner_iphoneos18.0-arm64.env.port-2.xctestrun");
    const staleClone = path.join(products, "ArgentRunner_iphoneos18.0-arm64.env.port-1.xctestrun");
    await Promise.all([base, keptClone, staleClone].map((p) => fsp.writeFile(p, "plist")));
    await Promise.all(
      [100, 200, 300].map((ts) => fsp.writeFile(path.join(logDir, `runner-00008120-${ts}.log`), ""))
    );
    await fsp.writeFile(path.join(logDir, "keep-me.txt"), "");

    await sweepRunnerStorage({
      derivedDataPath: current,
      keepClonePath: keptClone,
      logDir,
      maxLogFiles: 2,
    });

    expect((await fsp.readdir(derived)).sort()).toEqual(["cache-aaaa111122223333", "foreign-dir"]);
    expect((await fsp.readdir(products)).sort()).toEqual([
      "ArgentRunner_iphoneos18.0-arm64.env.port-2.xctestrun",
      "ArgentRunner_iphoneos18.0-arm64.xctestrun",
    ]);
    expect((await fsp.readdir(logDir)).sort()).toEqual([
      "keep-me.txt",
      "runner-00008120-200.log",
      "runner-00008120-300.log",
    ]);
  });

  it("keeps a sibling whose build is in flight and prunes stale result bundles", async () => {
    const root = path.join(tmpRoot, "sweep-busy");
    const derived = path.join(root, "derived");
    const current = path.join(derived, "cache-aaaa111122223333");
    const inFlight = path.join(derived, "cache-bbbb222233334444");
    const abandoned = path.join(derived, "cache-cccc333344445555");
    const testLogs = path.join(current, "Logs", "Test");
    await fsp.mkdir(testLogs, { recursive: true });
    await fsp.mkdir(inFlight, { recursive: true });
    await fsp.mkdir(abandoned, { recursive: true });
    // A peer checkout mid-build: its owner pid is alive (this process).
    await fsp.writeFile(path.join(inFlight, ".argent-build-owner"), String(process.pid));
    // A marker left behind by a killed build: no owner, nothing to protect.
    // 999999 is past macOS's pid ceiling, so the liveness probe always ESRCHs.
    await fsp.writeFile(path.join(abandoned, ".argent-build-owner"), "999999");
    for (const stamp of ["2026.08.20_10-00-00", "2026.08.21_10-00-00", "2026.08.22_10-00-00"]) {
      await fsp.mkdir(path.join(testLogs, xcresultName(stamp)));
    }
    await fsp.writeFile(path.join(testLogs, "LogStoreManifest.plist"), "");

    await sweepRunnerStorage({
      derivedDataPath: current,
      logDir: path.join(root, "logs"),
      maxResultBundles: 2,
    });

    expect((await fsp.readdir(derived)).sort()).toEqual([
      "cache-aaaa111122223333",
      "cache-bbbb222233334444",
    ]);
    expect((await fsp.readdir(testLogs)).sort()).toEqual([
      "LogStoreManifest.plist",
      xcresultName("2026.08.21_10-00-00"),
      xcresultName("2026.08.22_10-00-00"),
    ]);
  });

  it("resolves without throwing when none of the directories exist", async () => {
    await expect(
      sweepRunnerStorage({
        derivedDataPath: path.join(tmpRoot, "sweep-missing", "derived", "cache-aaaa111122223333"),
        logDir: path.join(tmpRoot, "sweep-missing", "logs"),
      })
    ).resolves.toBeUndefined();
  });
});

/**
 * Run launchRunner with PATH replaced by `pathDir` (so "xcodebuild" resolves
 * to a stub, or to nothing) and HOME moved under tmpRoot (so the launch log
 * lands in the fixture tree, not the real ~/.argent).
 */
async function launchWithPath(pathDir: string): Promise<Awaited<ReturnType<typeof launchRunner>>> {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = pathDir;
  process.env.HOME = tmpRoot;
  try {
    return await launchRunner({
      udid: "00008120-000000000000001E",
      xctestrunPath: path.join(tmpRoot, "fake.xctestrun"),
      derivedDataPath: path.join(tmpRoot, "derived"),
    });
  } finally {
    process.env.PATH = saved.PATH;
    process.env.HOME = saved.HOME;
  }
}

describe("launchRunner", () => {
  it("rejects with the wrapped spawn failure instead of crashing the process", async () => {
    const emptyBin = path.join(tmpRoot, "empty-bin");
    await fsp.mkdir(emptyBin, { recursive: true });

    // Before the spawn/error race, the ENOENT arrived as an unhandled async
    // "error" event; this test completing green is the no-crash proof.
    const error = await launchWithPath(emptyBin).catch((caught: unknown) => caught);

    expect((error as Error).name).toBe("FailureError");
    expect((error as Error).message).toBe(
      "xcodebuild could not be started. Check that Xcode is installed and on PATH."
    );
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("resolves with the launched child and log path when the spawn succeeds", async () => {
    const stubBin = path.join(tmpRoot, "stub-bin");
    await fsp.mkdir(stubBin, { recursive: true });
    await fsp.writeFile(path.join(stubBin, "xcodebuild"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const launched = await launchWithPath(stubBin);

    expect(launched.child.pid).toBeGreaterThan(0);
    expect(path.dirname(launched.logPath)).toBe(
      path.join(tmpRoot, ".argent", "ios-device-runner", "logs")
    );
    expect(path.basename(launched.logPath)).toMatch(/^runner-00008120-\d+\.log$/);
    await fsp.access(launched.logPath);
    // The swallow listener that keeps a late "error" from becoming uncaught.
    expect(launched.child.listenerCount("error")).toBe(1);
  });
});

/**
 * Fake process table driving waitForPidsToExit's seams; no real processes.
 * `dyingAfterPolls` maps a pid to the number of sleeps after which its
 * liveness probe starts reporting it gone; pids absent from the map are dead
 * from the start, Infinity ignores SIGTERM forever.
 */
function fakeProcessTable(dyingAfterPolls: Record<number, number>) {
  let polls = 0;
  const sleeps: number[] = [];
  const kills: Array<{ pid: number; signal: string }> = [];
  return {
    sleeps,
    kills,
    isAlive: (pid: number) => (dyingAfterPolls[pid] ?? -1) > polls,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      polls += 1;
    },
    kill: (pid: number, signal: string) => {
      kills.push({ pid, signal });
    },
  };
}

describe("waitForPidsToExit", () => {
  it("polls the bounded window then SIGKILLs the process group of a holdout", async () => {
    const table = fakeProcessTable({ 101: Infinity });

    const holdouts = await waitForPidsToExit([101], {
      ...table,
      timeoutMs: 500,
      pollIntervalMs: 100,
    });

    expect(holdouts).toEqual([101]);
    expect(table.sleeps).toEqual([100, 100, 100, 100, 100]);
    expect(table.kills).toEqual([{ pid: -101, signal: "SIGKILL" }]);
  });

  it("SIGKILLs only the holdout when the other pid exits mid-window", async () => {
    const table = fakeProcessTable({ 101: 2, 102: Infinity });

    const holdouts = await waitForPidsToExit([101, 102], {
      ...table,
      timeoutMs: 300,
      pollIntervalMs: 100,
    });

    expect(holdouts).toEqual([102]);
    expect(table.kills).toEqual([{ pid: -102, signal: "SIGKILL" }]);
  });

  it("tolerates a pid exiting between the last poll and the escalation", async () => {
    const table = fakeProcessTable({ 101: Infinity });

    const holdouts = await waitForPidsToExit([101], {
      ...table,
      timeoutMs: 100,
      pollIntervalMs: 100,
      kill: () => {
        throw new Error("ESRCH: no such process");
      },
    });

    expect(holdouts).toEqual([101]);
  });
});

const STALE_UDID = "00008120-000000000000001E";
const STALE_XCTESTRUN =
  "/Users/dev/.argent/ios-device-runner/derived/cache-aaaa111122223333/Build/Products/" +
  "ArgentRunner_iphoneos18.0-arm64.env.port-50505.xctestrun";

/**
 * One `ps -ax -o pid=,ppid=,command=` line shaped like a launched runner.
 * The defaults satisfy all three argv filter clauses; each override drops
 * exactly one, so a spared override pins that clause individually.
 */
function runnerPsLine(opts: {
  pid: number;
  ppid: number;
  action?: string;
  udid?: string;
  xctestrun?: string;
}): string {
  return [
    String(opts.pid).padStart(5),
    String(opts.ppid).padStart(5),
    "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild",
    opts.action ?? "test-without-building",
    "-xctestrun",
    opts.xctestrun ?? STALE_XCTESTRUN,
    "-destination",
    `platform=iOS,id=${opts.udid ?? STALE_UDID}`,
  ].join(" ");
}

function fakeSweepDeps(dyingAfterPolls: Record<number, number>, psLines: string[]) {
  return {
    ...fakeProcessTable(dyingAfterPolls),
    listProcesses: async () => psLines.join("\n"),
    timeoutMs: 300,
    pollIntervalMs: 100,
  };
}

describe("killStaleRunnersForDevice", () => {
  it("SIGTERMs an orphan re-parented to launchd (ppid 1), ignoring unrelated lines", async () => {
    const deps = fakeSweepDeps({}, [
      "  400     1 /usr/local/bin/node /opt/argent/dist/server.js",
      runnerPsLine({ pid: 101, ppid: 1 }),
    ]);

    const killed = await killStaleRunnersForDevice(STALE_UDID, deps);

    expect(killed).toBe(1);
    expect(deps.kills).toEqual([{ pid: -101, signal: "SIGTERM" }]);
    expect(deps.sleeps).toEqual([]);
  });

  it("SIGTERMs an orphan whose parent pid is no longer alive", async () => {
    // ppid 4242 is absent from the table, so the liveness probe reports it
    // gone: the owning tool-server died without launchd adoption completing.
    const deps = fakeSweepDeps({}, [runnerPsLine({ pid: 101, ppid: 4242 })]);

    const killed = await killStaleRunnersForDevice(STALE_UDID, deps);

    expect(killed).toBe(1);
    expect(deps.kills).toEqual([{ pid: -101, signal: "SIGTERM" }]);
  });

  it("spares a matched runner whose parent is a LIVE peer tool-server", async () => {
    const deps = fakeSweepDeps({ 4242: Infinity }, [runnerPsLine({ pid: 101, ppid: 4242 })]);

    const killed = await killStaleRunnersForDevice(STALE_UDID, deps);

    expect(killed).toBe(0); // the peer's session conflict is testmanagerd's to report
    expect(deps.kills).toEqual([]);
    expect(deps.sleeps).toEqual([]);
  });

  it("never signals its own pid, even when it would count as an orphan", async () => {
    const deps = fakeSweepDeps({}, [runnerPsLine({ pid: process.pid, ppid: 1 })]);

    expect(await killStaleRunnersForDevice(STALE_UDID, deps)).toBe(0);
    expect(deps.kills).toEqual([]);
  });

  // The three clause tests below each present an ORPHAN (ppid 1), so the only
  // thing sparing it is the missing argv clause under test.
  it("spares a line without the test-without-building clause (a build is not a runner)", async () => {
    const deps = fakeSweepDeps({}, [
      runnerPsLine({ pid: 101, ppid: 1, action: "build-for-testing" }),
    ]);

    expect(await killStaleRunnersForDevice(STALE_UDID, deps)).toBe(0);
    expect(deps.kills).toEqual([]);
  });

  it("spares a runner driving a DIFFERENT device", async () => {
    const deps = fakeSweepDeps({}, [
      runnerPsLine({ pid: 101, ppid: 1, udid: "00008120-FFFFFFFFFFFFFFFF" }),
    ]);

    expect(await killStaleRunnersForDevice(STALE_UDID, deps)).toBe(0);
    expect(deps.kills).toEqual([]);
  });

  it("spares an xcodebuild test run outside our cache root", async () => {
    const deps = fakeSweepDeps({}, [
      runnerPsLine({
        pid: 101,
        ppid: 1,
        xctestrun: "/Users/dev/proj/build/MyAppUITests.xctestrun",
      }),
    ]);

    expect(await killStaleRunnersForDevice(STALE_UDID, deps)).toBe(0);
    expect(deps.kills).toEqual([]);
  });

  it("escalates a SIGTERM-ignoring orphan to SIGKILL via waitForPidsToExit", async () => {
    const deps = fakeSweepDeps({ 101: Infinity }, [runnerPsLine({ pid: 101, ppid: 1 })]);

    const killed = await killStaleRunnersForDevice(STALE_UDID, deps);

    expect(killed).toBe(1);
    expect(deps.sleeps).toEqual([100, 100, 100]);
    expect(deps.kills).toEqual([
      { pid: -101, signal: "SIGTERM" },
      { pid: -101, signal: "SIGKILL" },
    ]);
  });

  it("falls back to a bare-pid SIGTERM when the process-group signal fails", async () => {
    const kills: Array<{ pid: number; signal: string }> = [];
    const deps = {
      ...fakeSweepDeps({}, [runnerPsLine({ pid: 101, ppid: 1 })]),
      kill: (pid: number, signal: string) => {
        kills.push({ pid, signal });
        if (pid < 0) throw new Error("EPERM: operation not permitted");
      },
    };

    expect(await killStaleRunnersForDevice(STALE_UDID, deps)).toBe(1);
    expect(kills).toEqual([
      { pid: -101, signal: "SIGTERM" },
      { pid: 101, signal: "SIGTERM" },
    ]);
  });

  it("treats a failed ps snapshot as nothing to reap", async () => {
    const deps = {
      ...fakeSweepDeps({}, []),
      listProcesses: async (): Promise<string> => {
        throw new Error("ps: command failed");
      },
    };

    expect(await killStaleRunnersForDevice(STALE_UDID, deps)).toBe(0);
    expect(deps.kills).toEqual([]);
  });

  it("default ps provider spawns the absolute PS_BIN, immune to a GUI-launched /bin-less PATH", () => {
    const [bin, ...args] = PROCESS_TABLE_ARGV;
    expect(bin).toBe(PS_BIN);
    expect(path.isAbsolute(bin)).toBe(true);
    expect(args).toEqual(["-ax", "-o", "pid=,ppid=,command="]);
  });
});
