import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  exchangeDirPrefix,
  FlowScriptExecutor,
} from "../../../src/tools/flows/script/flow-script-executor";
import { resolveBashInterpreter } from "../../../src/tools/flows/script/flow-script-interpreter";
import { createScriptWorkspace } from "../../helpers/flow-script-workspace";

/**
 * The first-use sweep, which runs once per process — so it needs a test file of
 * its own, where no earlier bash step has already spent it. vitest isolates the
 * module registry per file, which is what makes that hold.
 *
 * It exists for the orphan case: when the tool server dies mid-step the
 * lifeline kills the runner and nobody reaches the exchange directory, and the
 * document in it may hold values derived from a secret.
 */
let noBash: string | undefined;

beforeAll(async () => {
  const found = await resolveBashInterpreter(undefined);
  if (!("path" in found)) noBash = found.problem;
});

beforeEach((ctx) => {
  if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
});

describe("the first bash step of a process", () => {
  it("sweeps an abandoned exchange directory and leaves a live one alone", async () => {
    const ws = createScriptWorkspace("bash-sweep");
    const abandoned = fs.mkdtempSync(path.join(os.tmpdir(), exchangeDirPrefix()));
    fs.writeFileSync(path.join(abandoned, "output.json"), '{"token":"derived-from-a-secret"}');
    // Older than the widest a live step can be: the host's maximum time limit
    // plus every margin the stop path spends after it.
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(abandoned, longAgo, longAgo);
    const live = fs.mkdtempSync(path.join(os.tmpdir(), exchangeDirPrefix()));

    try {
      const script = ws.write("sweep.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
      const result = await new FlowScriptExecutor({
        concurrency: 2,
        maxTimeoutMs: 60_000,
      }).execute({ scriptPath: script, interpreter: "bash", projectRoot: ws.dir });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(abandoned)).toBe(false);
      // A directory a concurrent step still owns is younger than the bound, so
      // the sweep cannot take it out from under that step.
      expect(fs.existsSync(live)).toBe(true);
    } finally {
      fs.rmSync(abandoned, { recursive: true, force: true });
      fs.rmSync(live, { recursive: true, force: true });
      ws.cleanup();
    }
  }, 30_000);
});
