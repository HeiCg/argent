import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Finding bash, on every host. The `where` / `command -v` call is injected the
 * way `command-on-path.test.ts` injects it, so the Windows rules — the WSL
 * launcher under `%SystemRoot%`, the Git-derived fallback — are exercised on
 * POSIX CI as well as natively on the Windows runner.
 */
const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const result = execFileMock(cmd, args);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bashSearchPath,
  resolveBashInterpreter,
} from "../../../src/tools/flows/script/flow-script-interpreter";

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

const roots: string[] = [];

/**
 * A project root of its own, with the `.argent` marker `resolveProjectRoot`
 * stops at — so the read lands on this file and not on whatever project the
 * temporary directory happens to sit inside.
 */
function projectWith(config: Record<string, unknown> | undefined): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-project-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".argent"), { recursive: true });
  if (config) {
    fs.writeFileSync(path.join(root, ".argent", "config.json"), JSON.stringify(config), "utf8");
  }
  return root;
}

/** An executable file that is not bash: it runs, and answers with no version. */
function notBash(dir: string, name = "bash"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
  return file;
}

/**
 * A real bash, found without the resolver under test. The resolver runs each
 * candidate once and refuses one that prints no `$BASH_VERSION`, so a written
 * stand-in would be refused for a reason the tests below are not about.
 */
function hostBash(): string | undefined {
  const candidates =
    realPlatform === "win32"
      ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]
      : ["/bin/bash", "/usr/bin/bash"];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const withBash = it.skipIf(hostBash() === undefined);

beforeEach(() => execFileMock.mockReset());

afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("scripts.bash, read against the flow's own project", () => {
  withBash("honours a configured path and never looks at PATH", async () => {
    const configured = hostBash()!;
    const root = projectWith({ scripts: { bash: configured } });

    expect(await resolveBashInterpreter(root)).toEqual({ path: configured });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // `getConfigValue` resolves the project scope from the cwd it is given, and
  // the tool server's own cwd is whatever the editor that spawned it chose —
  // so the bare call would read another project's file, or none.
  withBash("reads the flow's project, not the tool server's working directory", async () => {
    const configured = hostBash()!;
    const flowProject = projectWith({ scripts: { bash: configured } });
    const serverCwd = projectWith({ scripts: { bash: "/nowhere/else/bash" } });
    const realCwd = process.cwd();
    vi.spyOn(process, "cwd").mockReturnValue(serverCwd);
    try {
      expect(await resolveBashInterpreter(flowProject)).toEqual({ path: configured });
    } finally {
      vi.spyOn(process, "cwd").mockReturnValue(realCwd);
    }
  });

  it("refuses a relative value rather than falling through to PATH", async () => {
    const root = projectWith({ scripts: { bash: "bin/bash" } });
    const found = await resolveBashInterpreter(root);

    expect("path" in found).toBe(false);
    expect((found as { problem: string }).problem).toContain("scripts.bash");
    expect((found as { problem: string }).problem).toContain("not an absolute path");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // `readScopeValue` hands back `undefined` for a value its `parse` rejected,
  // which is indistinguishable from an absent key — so a value the schema threw
  // away would fall through to PATH and run the step under a bash that happens
  // to exist on this machine, which is the outcome `scripts.bash` exists to
  // prevent.
  it("refuses an empty value rather than reading it as an absent key", async () => {
    const root = projectWith({ scripts: { bash: "   " } });
    const found = await resolveBashInterpreter(root);

    expect("path" in found).toBe(false);
    expect((found as { problem: string }).problem).toContain("is empty");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("refuses a value that is not a string, naming what it found", async () => {
    const root = projectWith({ scripts: { bash: 123 } });
    const found = await resolveBashInterpreter(root);

    expect((found as { problem: string }).problem).toContain("scripts.bash = 123");
    expect((found as { problem: string }).problem).toContain("not an absolute path");
  });

  it("names the file the value came from, not the project it ran in", async () => {
    const root = projectWith({ scripts: { bash: "bin/bash" } });
    const found = await resolveBashInterpreter(root);

    expect((found as { problem: string }).problem).toContain(
      path.join(root, ".argent", "config.json")
    );
  });

  it("refuses a configured path that does not exist", async () => {
    const root = projectWith(undefined);
    const missing = path.join(root, "no-such-bash");
    fs.writeFileSync(
      path.join(root, ".argent", "config.json"),
      JSON.stringify({ scripts: { bash: missing } })
    );
    const found = await resolveBashInterpreter(root);

    expect((found as { problem: string }).problem).toContain("does not exist");
    expect((found as { problem: string }).problem).toContain(missing);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a configured path that is not executable",
    async () => {
      const root = projectWith(undefined);
      const file = path.join(root, "readable-bash");
      fs.writeFileSync(file, "");
      fs.chmodSync(file, 0o644);
      fs.writeFileSync(
        path.join(root, ".argent", "config.json"),
        JSON.stringify({ scripts: { bash: file } })
      );

      const found = await resolveBashInterpreter(root);
      expect((found as { problem: string }).problem).toContain("is not executable");
    }
  );

  // Every static check passes for an executable file that is not a shell, and
  // the three properties after them hide it: the parent seeds $ARGENT_OUTPUT,
  // the child's output is discarded, and an exit code of 0 is a pass. So a
  // wrapper that forgets to forward its arguments would report every `.sh` step
  // green while running none of them.
  it("refuses a configured interpreter that answers with no $BASH_VERSION", async () => {
    const root = projectWith(undefined);
    const stub = notBash(root);
    fs.writeFileSync(
      path.join(root, ".argent", "config.json"),
      JSON.stringify({ scripts: { bash: stub } })
    );

    const found = await resolveBashInterpreter(root);
    expect("path" in found).toBe(false);
    expect((found as { problem: string }).problem).toContain("is not a bash");
    expect((found as { problem: string }).problem).toContain(stub);
  });

  it("refuses a configured System32 bash, naming WSL", async () => {
    setPlatform("win32");
    const root = projectWith({
      scripts: { bash: "C:\\Windows\\System32\\bash.exe" },
    });
    const found = await resolveBashInterpreter(root);

    expect((found as { problem: string }).problem).toContain("WSL");
    expect((found as { problem: string }).problem).toContain("scripts.bash");
  });
});

describe("bash on PATH", () => {
  // The three cases that fake a POSIX platform need a POSIX host to hold the
  // fixture: a `C:\…` path is not posix-absolute, and there is no /bin/bash
  // behind it to fall through to. The Windows rules below run everywhere.
  const onPosix = it.skipIf(realPlatform === "win32");
  const onPosixWithBash = it.skipIf(realPlatform === "win32" || hostBash() === undefined);

  onPosixWithBash("takes the first absolute answer on POSIX", async () => {
    setPlatform(realPlatform);
    const root = projectWith(undefined);
    // A path of its own that is really a bash, so the answer is distinguishable
    // from the fixed location the resolver would otherwise fall through to.
    const onPath = path.join(root, "bash");
    fs.symlinkSync(hostBash()!, onPath);
    execFileMock.mockReturnValue({ stdout: `${onPath}\n`, stderr: "" });

    expect(await resolveBashInterpreter(root)).toEqual({ path: onPath });
    expect(execFileMock).toHaveBeenCalledWith("/bin/sh", ["-c", "command -v bash"]);
  });

  // `System32\bash.exe` is the WSL launcher, and it is early on every PATH: it
  // runs the file inside a Linux distribution where the project path and
  // $ARGENT_OUTPUT do not exist. Pinned on the candidate list rather than on the
  // resolved path, because no `C:\…` file exists on a POSIX host to be found —
  // and on the Windows runner this is the same list the resolver then stats.
  it("drops a System32 match from the Windows candidates and keeps the next one", async () => {
    setPlatform("win32");
    execFileMock.mockImplementation((_cmd: string, args?: readonly string[]) =>
      args?.[0] === "bash"
        ? {
            stdout: "C:\\Windows\\System32\\bash.exe\r\nC:\\Program Files\\Git\\bin\\bash.exe\r\n",
            stderr: "",
          }
        : new Error("not found")
    );

    const candidates = await bashSearchPath();
    expect(candidates[0]).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(candidates.some((entry) => /system32/i.test(entry))).toBe(false);
  });

  // `git.exe` on PATH is a SHIM under Scoop and Chocolatey, and two levels above
  // a shim there is no `bin\\bash.exe`. Chocolatey installs Git for Windows
  // itself, so `ProgramFiles` covers it; Scoop keeps its own tree.
  it("offers Scoop's own Git bash, which no shim derivation reaches", async () => {
    setPlatform("win32");
    const realProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = "C:\\Users\\dev";
    execFileMock.mockImplementation((_cmd: string, args?: readonly string[]) =>
      args?.[0] === "git"
        ? { stdout: "C:\\Users\\dev\\scoop\\shims\\git.exe\r\n", stderr: "" }
        : new Error("not found")
    );

    try {
      const candidates = await bashSearchPath();
      expect(candidates).toContain("C:\\Users\\dev\\scoop\\apps\\git\\current\\bin\\bash.exe");
    } finally {
      if (realProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = realProfile;
    }
  });

  it("derives Git for Windows' bash from git.exe when PATH has only the WSL launcher", async () => {
    setPlatform("win32");
    execFileMock.mockImplementation((_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "bash") {
        return { stdout: "C:\\Windows\\System32\\bash.exe\r\n", stderr: "" };
      }
      if (args?.[0] === "git") return { stdout: "D:\\Tools\\Git\\cmd\\git.exe\r\n", stderr: "" };
      return new Error("not found");
    });

    const candidates = await bashSearchPath();
    expect(candidates[0]).toBe("D:\\Tools\\Git\\bin\\bash.exe");
  });

  onPosix("never offers a relative candidate, whatever the source", async () => {
    setPlatform(realPlatform);
    const root = projectWith(undefined);
    // A relative PATH entry gives `command -v` a relative answer, which `spawn`
    // would resolve against the runner's own working directory.
    execFileMock.mockReturnValue({ stdout: "bin/bash\n", stderr: "" });

    const found = await resolveBashInterpreter(root);
    if ("path" in found) expect(path.isAbsolute(found.path)).toBe(true);
  });

  onPosix("takes the first candidate that exists, not the first that was listed", async () => {
    setPlatform(realPlatform);
    const root = projectWith(undefined);
    const real = notBash(root);
    execFileMock.mockReturnValue({ stdout: `${path.join(root, "gone")}\n`, stderr: "" });

    // With PATH naming a file that is not there, the fixed locations decide —
    // and on a host with neither, the refusal below is what an author reads.
    const found = await resolveBashInterpreter(root);
    if ("path" in found) expect(found.path).not.toBe(path.join(root, "gone"));
    else expect(found.problem).toContain("No bash was found");
    expect(fs.existsSync(real)).toBe(true);
  });
});

describe("no bash anywhere", () => {
  it("reports a spawn refusal naming what it looked at and each remedy", async () => {
    setPlatform("win32");
    const root = projectWith(undefined);
    execFileMock.mockReturnValue(new Error("INFO: Could not find files"));

    const found = await resolveBashInterpreter(root);
    const problem = (found as { problem: string }).problem;

    expect(problem).toContain("No bash was found");
    expect(problem).toContain("Git for Windows");
    expect(problem).toContain("scripts.bash");
    // The PATH the tool server searched is a snapshot from when it started, so
    // a bash a terminal finds may still be absent here.
    expect(problem).toContain("snapshot");
  });
});
