import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { hdcFileRecv, runHdcShell } from "../src/utils/harmony-hdc";

// Every case below is a real `hdc` outcome that exits 0 with no `[Fail]` line,
// so nothing but what was printed separates them. Measured on hdc 3.2.0d:
// a completed transfer prints `FileTransfer finish, …`, and a client that
// cannot reach its own server writes bare prose to STDERR with stdout empty.
// The stub reads the case from a file rather than argv so one binary can stand
// in for all of them.
const root = mkdtempSync(join(tmpdir(), "argent-deveco-"));
const binDir = join(root, "sdk", "default", "openharmony", "toolchains");
const modeFile = join(root, "mode");
mkdirSync(binDir, { recursive: true });
writeFileSync(
  join(binDir, "hdc"),
  `#!/usr/bin/env bash
case "$(cat ${modeFile})" in
  connect-fail) echo "Connect server failed" >&2 ;;
  transfer-ok) echo "FileTransfer finish, Size:6, File count = 1, time:10ms rate:0.60kB/s" ;;
  truncated) echo "DumpLayout saved to:/data/local/tmp/dump.json" ;;
  silent) ;;
esac
exit 0
`,
  { mode: 0o755 }
);
const hdcBehaves = (mode: string): void => writeFileSync(modeFile, mode);

beforeAll(() => vi.stubEnv("DEVECO_STUDIO_HOME", root));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function rejection(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error("expected a rejection, got a resolution");
    },
    (e: unknown) => e as Error
  );
}

describe("hdcFileRecv success is read off the transfer line", () => {
  const remote = "/data/local/tmp/argent-screen.png";

  it("refuses a transfer the connector never made", async () => {
    // The whole failure is on stderr with no prefix, so classifying on `[Fail]`
    // alone resolves — handing `harmony-screen` a path with nothing at it, which
    // it then reports as a decode failure of a file that was never copied.
    hdcBehaves("connect-fail");
    const err = await rejection(hdcFileRecv("127.0.0.1:5555", remote, join(root, "out.png")));
    expect(err.message).toContain("Connect server failed");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.HARMONY_FILE_TRANSFER_FAILED);
  });

  it("refuses a silent run rather than reading silence as a copy", async () => {
    hdcBehaves("silent");
    const err = await rejection(hdcFileRecv("127.0.0.1:5555", remote, join(root, "out.png")));
    expect(err.message).toMatch(/neither a transfer nor a diagnostic/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.HARMONY_FILE_TRANSFER_FAILED);
  });

  it("accepts a completed transfer", async () => {
    // The other half of the positive match: every HarmonyOS screenshot and
    // layout dump goes through here, so a marker that never matches breaks all
    // of them just as silently as one that always does.
    hdcBehaves("transfer-ok");
    await expect(
      hdcFileRecv("127.0.0.1:5555", remote, join(root, "out.png"))
    ).resolves.toBeUndefined();
  });
});

describe("runHdcShell without an exit status", () => {
  it("quotes the connector's own diagnostic instead of blaming the device", async () => {
    // Same stderr prose, one layer up: it leaves stdout empty, so the rc
    // sentinel is missing and this lands in the no-status branch. Sending the
    // caller to look at a device that was never reached is the wrong repair.
    hdcBehaves("connect-fail");
    const err = await rejection(runHdcShell("127.0.0.1:5555", "uitest dumpLayout"));
    expect(err.message).toContain("Connect server failed");
    expect(err.message).not.toMatch(/terminated on the device/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.HARMONY_SHELL_NO_STATUS);
  });

  it("still names a truncated command when hdc said nothing at all", async () => {
    hdcBehaves("silent");
    const err = await rejection(runHdcShell("127.0.0.1:5555", "uitest dumpLayout"));
    expect(err.message).toMatch(/returned no exit status/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.HARMONY_SHELL_NO_STATUS);
  });

  it("does not quote a cut-off command's own output back as hdc's verdict", async () => {
    // `uitest`'s success line is prose by every test {@link hdcProse} applies —
    // spaces, no tab, no prefix. Output that arrived without the sentinel is a
    // command that ran and was truncated, which is the opposite repair from a
    // connector that never reached the device.
    hdcBehaves("truncated");
    const err = await rejection(runHdcShell("127.0.0.1:5555", "uitest dumpLayout"));
    expect(err.message).toMatch(/returned no exit status/);
    expect(err.message).not.toContain("DumpLayout saved to");
  });
});
