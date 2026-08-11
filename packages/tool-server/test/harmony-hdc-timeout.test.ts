import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHdc } from "../src/utils/harmony-hdc";

// Resolve `hdc` through the documented `$DEVECO_STUDIO_HOME` layout rather than
// PATH: pointing the resolver at a real stub is hermetic, where stubbing the
// PATH lookup alone still lets a host with DevEco Studio installed find and run
// the real `hdc`.
const root = mkdtempSync(join(tmpdir(), "argent-deveco-"));
const binDir = join(root, "sdk", "default", "openharmony", "toolchains");
mkdirSync(binDir, { recursive: true });
// A wedged `hdc`: blocked on an unresponsive daemon and deaf to SIGTERM. `exec`
// so the process that ignores the signal IS the one the timeout kills - without
// it the shell dies and leaves the `sleep` orphaned for its full duration.
writeFileSync(join(binDir, "hdc"), "#!/usr/bin/env bash\ntrap '' TERM\nexec sleep 30\n", {
  mode: 0o755,
});

beforeAll(() => vi.stubEnv("DEVECO_STUDIO_HOME", root));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("runHdc timeout enforcement", () => {
  it("reaps a child that ignores SIGTERM, so the timeout it was given actually fires", async () => {
    // `execFile`'s `timeout` sends `killSignal` once and never escalates, so with
    // the default SIGTERM this call never settles and every per-call budget on
    // the HarmonyOS path is advisory - only `list-devices` has a deadline behind
    // it, and the interaction tools have nothing. Measured against this stub
    // without `killSignal`: still running 6s after a 1s timeout.
    const started = Date.now();

    await expect(runHdc(["list", "targets"], 800)).rejects.toThrow();

    // Far below the stub's own 30s sleep: the assertion is that the deadline is
    // enforced at all, not its precise latency on a loaded CI box.
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 20_000);
});
