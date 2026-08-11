import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolve `hdc` to a stub instead of a real toolchain. Its own module-level
// binary cache starts empty per test file, so this is the only seam needed.
vi.mock("../src/utils/command-on-path", () => ({
  commandOnPath: vi.fn(async () => stub),
}));

import { runHdc } from "../src/utils/harmony-hdc";

const stubDir = mkdtempSync(join(tmpdir(), "argent-hdc-stub-"));
const stub = join(stubDir, "hdc");
// A wedged `hdc`: blocked on an unresponsive daemon and deaf to SIGTERM.
writeFileSync(stub, "#!/usr/bin/env bash\ntrap '' TERM\nsleep 30\n", { mode: 0o755 });

afterAll(() => rmSync(stubDir, { recursive: true, force: true }));

describe("runHdc timeout enforcement", () => {
  it("reaps a child that ignores SIGTERM, so the timeout it was given actually fires", async () => {
    // `execFile`'s `timeout` sends `killSignal` once and never escalates, so with
    // the default SIGTERM this call never settles and every per-call budget on
    // the HarmonyOS path is advisory - only `list-devices` has a deadline behind
    // it, and the interaction tools have nothing. Measured against this stub
    // without `killSignal`: still running 6s after a 1s timeout.
    vi.stubEnv("DEVECO_STUDIO_HOME", "");
    const started = Date.now();

    await expect(runHdc(["list", "targets"], 800)).rejects.toThrow();

    // Far below the stub's own 30s sleep: the assertion is that the deadline is
    // enforced at all, not its precise latency on a loaded CI box.
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 20_000);
});
