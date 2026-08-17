import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { runInstall, type InstallOutcome } from "../src/install-runner.js";
import { runShellCommand, ShellCommandError } from "../src/shell.js";
import { detectPackageManager, hasProjectPackageJson, isLocallyInstalled } from "../src/utils.js";
import { probeGlobalInstallTarget } from "../src/global-prefix.js";
import { log, select } from "@clack/prompts";
import type { InitTelemetry } from "../src/init-telemetry.js";

// Exercises installLocally's failure handling: the retry-once semantics, the
// don't-retry rules (missing binary, signal-terminated install), the
// locale-independent Windows missing-binary signal, and retry telemetry.

vi.mock("../src/shell.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/shell.js")>();
  return {
    ...original,
    runShellCommand: vi.fn(),
  };
});

vi.mock("../src/utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...original,
    resolveProjectRoot: vi.fn(() => "/fake/project"),
    hasProjectPackageJson: vi.fn(() => true),
    isDeclaredLocally: vi.fn(() => false),
    isLocallyInstalled: vi.fn(() => false),
    isYarnPnp: vi.fn(() => false),
    getLocallyInstalledVersion: vi.fn(() => "1.0.0"),
    detectProjectPackageManager: vi.fn(() => "pnpm" as const),
    detectPackageManager: vi.fn(() => "npm" as const),
    isGloballyInstalled: vi.fn(() => false),
    getGloballyInstalledVersion: vi.fn(() => "2.0.0"),
    getLatestVersion: vi.fn(async () => null),
  };
});

// Only the probe is faked — the messages the recovery prints are the real ones.
vi.mock("../src/global-prefix.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/global-prefix.js")>();
  return { ...original, probeGlobalInstallTarget: vi.fn() };
});

// Real clack spinners animate on a TTY; stub the UI surface entirely.
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    select: vi.fn(),
    cancel: vi.fn(),
  };
});

vi.mock("@argent/telemetry", () => ({ track: vi.fn() }));

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

function makeTel(): InitTelemetry & { trackPackageAction: ReturnType<typeof vi.fn> } {
  return {
    installMode: "local",
    editorsConfiguredCount: 0,
    initSucceeded: false,
    trackPackageAction: vi.fn(async () => {}),
    finalize: vi.fn(async () => {}),
  } as unknown as InitTelemetry & { trackPackageAction: ReturnType<typeof vi.fn> };
}

function localInstall(tel: InitTelemetry): Promise<InstallOutcome> {
  return runInstall({
    installMode: "local",
    fromTar: null,
    nonInteractive: true,
    version: "0.0.0",
    globalTarget: null,
    globalBlockAcknowledged: false,
    tel,
  });
}

describe("installLocally failure handling", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(runShellCommand).mockReset();
    vi.mocked(isLocallyInstalled).mockReset();
    vi.mocked(isLocallyInstalled).mockReturnValue(false);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("retries once on a transient failure and succeeds", async () => {
    const tel = makeTel();
    vi.mocked(runShellCommand)
      .mockRejectedValueOnce(new ShellCommandError("ERR_PNPM_META_FETCH_FAIL", 1, null))
      .mockImplementationOnce(async () => {
        vi.mocked(isLocallyInstalled).mockReturnValue(true);
      });

    await expect(localInstall(tel)).resolves.toEqual({ version: "1.0.0", installMode: "local" });

    expect(runShellCommand).toHaveBeenCalledTimes(2);
    expect(tel.trackPackageAction).toHaveBeenCalledWith(
      "fresh_install",
      expect.any(Number),
      true,
      undefined,
      expect.objectContaining({ retry_count: 1 })
    );
  });

  it("fails after the single retry and reports retry_count in telemetry", async () => {
    const tel = makeTel();
    vi.mocked(runShellCommand).mockRejectedValue(new ShellCommandError("registry down", 1, null));

    await expect(localInstall(tel)).rejects.toThrow(ExitCalled);

    expect(runShellCommand).toHaveBeenCalledTimes(2);
    expect(tel.trackPackageAction).toHaveBeenCalledWith(
      "fresh_install",
      expect.any(Number),
      false,
      expect.objectContaining({ error_code: expect.anything() }),
      expect.objectContaining({
        retry_count: 1,
        last_attempt_duration_ms: expect.any(Number),
      })
    );
  });

  it("does not retry when the package manager binary is missing (POSIX ENOENT)", async () => {
    const tel = makeTel();
    vi.mocked(runShellCommand).mockRejectedValue(
      Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" })
    );

    await expect(localInstall(tel)).rejects.toThrow(ExitCalled);
    expect(runShellCommand).toHaveBeenCalledTimes(1);
  });

  it("does not retry a signal-terminated install (an interruption is not transient)", async () => {
    // A signal-delivered SIGINT/SIGTERM (CI, kill, timeout wrapper) closes the
    // child with code null; retrying would spawn a second full install after
    // the user or supervisor cancelled the first.
    const tel = makeTel();
    vi.mocked(runShellCommand).mockRejectedValue(
      new ShellCommandError("Command terminated by signal SIGINT", null, "SIGINT")
    );

    await expect(localInstall(tel)).rejects.toThrow(ExitCalled);
    expect(runShellCommand).toHaveBeenCalledTimes(1);
    expect(tel.trackPackageAction).toHaveBeenCalledWith(
      "fresh_install",
      expect.any(Number),
      false,
      expect.anything(),
      expect.objectContaining({ retry_count: 0 })
    );
  });

  it("treats cmd.exe exit code 9009 as a missing binary on Windows (locale-independent)", async () => {
    // cmd.exe's "is not recognized" stderr is localized; 9009 is the one
    // stable signal, and runShellCommand must carry it through.
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const tel = makeTel();
      vi.mocked(runShellCommand).mockRejectedValue(
        new ShellCommandError(
          '"pnpm" ist entweder falsch geschrieben oder konnte nicht gefunden werden.',
          9009,
          null
        )
      );

      await expect(localInstall(tel)).rejects.toThrow(ExitCalled);
      expect(runShellCommand).toHaveBeenCalledTimes(1);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("retries an ordinary non-zero exit on Windows (9009 only means missing binary)", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const tel = makeTel();
      vi.mocked(runShellCommand).mockRejectedValue(
        new ShellCommandError("install failed", 1, null)
      );

      await expect(localInstall(tel)).rejects.toThrow(ExitCalled);
      expect(runShellCommand).toHaveBeenCalledTimes(2);
    } finally {
      platformSpy.mockRestore();
    }
  });
});

// The Nix case: npm's global directory is inside the read-only store. Every way
// out is something init can carry out, so an interactive run offers them.
describe("a global install whose target directory cannot be written", () => {
  const blocked = {
    dir: "/nix/store/abc-nodejs-22.16.0/lib/node_modules",
    blocked: true,
    nixStore: true,
  };
  // What the re-probe sees once `npm config set prefix` has run.
  const writableAfterMove = {
    dir: "/home/dev/.npm-global/lib/node_modules",
    blocked: false,
    nixStore: false,
  };
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let savedPath: string | undefined;

  const globalInstall = (
    tel: InitTelemetry,
    opts: { nonInteractive?: boolean; acknowledged?: boolean } = {}
  ): Promise<InstallOutcome> =>
    runInstall({
      installMode: "global",
      fromTar: null,
      nonInteractive: opts.nonInteractive ?? false,
      version: "0.0.0",
      globalTarget: blocked,
      globalBlockAcknowledged: opts.acknowledged ?? false,
      tel,
    });

  beforeEach(() => {
    vi.mocked(runShellCommand).mockReset();
    vi.mocked(runShellCommand).mockResolvedValue(undefined as never);
    vi.mocked(select).mockReset();
    vi.mocked(log.error).mockReset();
    vi.mocked(log.warn).mockReset();
    vi.mocked(hasProjectPackageJson).mockReturnValue(true);
    vi.mocked(probeGlobalInstallTarget).mockReturnValue(blocked);
    savedPath = process.env.PATH;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    process.env.PATH = savedPath;
  });

  it("installs into the project when that recovery is chosen", async () => {
    vi.mocked(select).mockResolvedValue("local" as never);
    vi.mocked(isLocallyInstalled).mockReturnValue(true);

    await expect(globalInstall(makeTel())).resolves.toEqual({
      version: "1.0.0",
      installMode: "local",
    });

    // The devDependency install ran, and no global install was attempted.
    const commands = vi.mocked(runShellCommand).mock.calls.map(([cmd]) => cmd);
    expect(commands).toEqual([expect.objectContaining({ bin: "pnpm" })]);
    expect(commands.flatMap((c) => c.args)).not.toContain("-g");
  });

  it("moves the npm prefix, then installs globally, when that recovery is chosen", async () => {
    vi.mocked(select).mockResolvedValue("prefix" as never);
    vi.mocked(probeGlobalInstallTarget).mockReturnValue(writableAfterMove);

    const outcome = await globalInstall(makeTel());

    expect(outcome.installMode).toBe("global");
    const commands = vi.mocked(runShellCommand).mock.calls.map(([cmd]) => cmd);
    expect(commands[0]).toEqual({
      bin: "npm",
      args: ["config", "set", "prefix", expect.stringContaining(".npm-global")],
    });
    expect(commands[1]).toEqual(
      expect.objectContaining({ bin: "npm", args: expect.arrayContaining(["-g"]) })
    );
    // The new bin directory is on PATH for the rest of the run, so the configs
    // written below name a binary that resolves.
    expect(process.env.PATH?.split(path.delimiter)[0]).toBe(
      path.join(os.homedir(), ".npm-global", "bin")
    );
  });

  it("installs nothing when the user cancels", async () => {
    vi.mocked(select).mockResolvedValue("cancel" as never);

    await expect(globalInstall(makeTel())).rejects.toThrow(ExitCalled);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(runShellCommand).not.toHaveBeenCalled();
  });

  it("does not offer the project install where there is no package.json to add it to", async () => {
    vi.mocked(hasProjectPackageJson).mockReturnValue(false);
    vi.mocked(select).mockResolvedValue("cancel" as never);

    await expect(globalInstall(makeTel())).rejects.toThrow(ExitCalled);

    const [{ options }] = vi.mocked(select).mock.calls[0] as [
      { options: Array<{ value: string }> },
    ];
    expect(options.map((o) => o.value)).toEqual(["prefix", "cancel"]);
  });

  it("never prompts under --yes — it fails with the remedies spelled out", async () => {
    const tel = makeTel();

    await expect(globalInstall(tel, { nonInteractive: true })).rejects.toThrow(ExitCalled);

    expect(select).not.toHaveBeenCalled();
    expect(runShellCommand).not.toHaveBeenCalled();
    const [message] = vi.mocked(log.error).mock.calls[0] as [string];
    expect(message).toContain("read-only Nix store");
    expect(message).toContain("argent init --local");
  });

  // The install-mode step already showed the cause and said "Globally" moves
  // npm's prefix here; re-asking would put the same question on screen twice.
  it("moves the prefix without re-asking when the mode step already said so", async () => {
    vi.mocked(probeGlobalInstallTarget).mockReturnValue(writableAfterMove);

    const outcome = await globalInstall(makeTel(), { acknowledged: true });

    expect(select).not.toHaveBeenCalled();
    // The PATH advice still warns; the cause the mode step already gave does not.
    const warnings = vi.mocked(log.warn).mock.calls.map(([m]) => m as string);
    expect(warnings.filter((m) => m.includes("read-only Nix store"))).toEqual([]);
    expect(outcome.installMode).toBe("global");
    const commands = vi.mocked(runShellCommand).mock.calls.map(([cmd]) => cmd);
    expect(commands[0]).toEqual({
      bin: "npm",
      args: ["config", "set", "prefix", expect.stringContaining(".npm-global")],
    });
    expect(commands[1]).toEqual(
      expect.objectContaining({ bin: "npm", args: expect.arrayContaining(["-g"]) })
    );
  });

  // pnpm's global directory argent cannot relocate, and with no package.json
  // there is no devDependency to fall back to — a prompt here would offer
  // nothing but "Cancel".
  it("spells out the remedies instead of prompting when it can carry out neither", async () => {
    vi.mocked(detectPackageManager).mockReturnValue("pnpm");
    vi.mocked(hasProjectPackageJson).mockReturnValue(false);
    try {
      await expect(globalInstall(makeTel())).rejects.toThrow(ExitCalled);

      expect(select).not.toHaveBeenCalled();
      expect(runShellCommand).not.toHaveBeenCalled();
      const [message] = vi.mocked(log.error).mock.calls[0] as [string];
      expect(message).toContain("argent init --local");
    } finally {
      vi.mocked(detectPackageManager).mockReturnValue("npm");
    }
  });
});
