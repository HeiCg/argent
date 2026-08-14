import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHarmonyHdcTargets, listHarmonyHdcTargetsStrict } from "../src/utils/harmony-devices";

// A real stub binary reached through the documented `$DEVECO_STUDIO_HOME`
// layout, as `harmony-hdc-timeout.test.ts` does: the behaviour under test is
// `hdc` exiting 0 while reporting a failure, which a mock at the run boundary
// would simply assert rather than reproduce.
const root = mkdtempSync(join(tmpdir(), "argent-deveco-targets-"));
const binDir = join(root, "sdk", "default", "openharmony", "toolchains");
mkdirSync(binDir, { recursive: true });
// Verbatim from `hdc list targets -v` with the daemon down, which is the state
// a `-stop` leaves behind while the connector restarts.
writeFileSync(join(binDir, "hdc"), '#!/usr/bin/env bash\necho "[Fail]Connect server failed"\n', {
  mode: 0o755,
});

beforeAll(() => vi.stubEnv("DEVECO_STUDIO_HOME", root));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("hdc target listing when the connector itself fails", () => {
  it("reports a refused listing as an empty device table to a polling caller", async () => {
    // `hdc` exits 0 whatever happens, so this cannot be told from success by
    // status. A caller watching for a change wants exactly this: nothing new.
    await expect(listHarmonyHdcTargets()).resolves.toEqual([]);
  });

  it("raises the refusal instead, for a caller that is establishing a baseline", async () => {
    // An empty baseline silently means "everything that appears next is new",
    // so `boot-device` would adopt an emulator that was already connected as
    // the instance it just started. Rejecting is what makes that refusable —
    // and it has to happen here, since the exit status never carries it.
    await expect(listHarmonyHdcTargetsStrict()).rejects.toThrow("[Fail]Connect server failed");
  });
});
