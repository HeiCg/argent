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
  // One test, because the sweep is spent on the first bash step of the process:
  // every directory it has to judge has to be planted before that step runs.
  it("judges each exchange directory by the bound its own step wrote", async () => {
    const ws = createScriptWorkspace("bash-sweep");
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);

    // An older layout, which carries no bound of its own: its age is all the
    // sweep can read, and this one is older than the widest a live step of
    // THIS install can be.
    const abandoned = fs.mkdtempSync(path.join(os.tmpdir(), exchangeDirPrefix()));
    fs.writeFileSync(path.join(abandoned, "output.json"), '{"token":"derived-from-a-secret"}');
    fs.utimesSync(abandoned, longAgo, longAgo);
    const liveOldLayout = fs.mkdtempSync(path.join(os.tmpdir(), exchangeDirPrefix()));

    // A step of another install, still running, whose own time limit is longer
    // than anything this install would allow. A directory's mtime never
    // advances after creation, so age alone would read this as abandoned and
    // take the exchange out from under a correct script.
    const stamped = (owned: number): string =>
      fs.mkdtempSync(path.join(os.tmpdir(), `${exchangeDirPrefix()}${Date.now() + owned}-`));
    const liveElsewhere = stamped(60 * 60 * 1000);
    fs.utimesSync(liveElsewhere, longAgo, longAgo);
    // And one whose own bound has passed, which is abandoned however new the
    // directory is.
    const finishedElsewhere = stamped(-1_000);

    try {
      const script = ws.write("sweep.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
      const result = await new FlowScriptExecutor({
        concurrency: 2,
        maxTimeoutMs: 60_000,
      }).execute({ scriptPath: script, interpreter: "bash", projectRoot: ws.dir });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(abandoned)).toBe(false);
      expect(fs.existsSync(finishedElsewhere)).toBe(false);
      // A directory a concurrent step still owns is younger than the bound, so
      // the sweep cannot take it out from under that step.
      expect(fs.existsSync(liveOldLayout)).toBe(true);
      expect(fs.existsSync(liveElsewhere)).toBe(true);
    } finally {
      for (const dir of [abandoned, liveOldLayout, liveElsewhere, finishedElsewhere]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      ws.cleanup();
    }
  }, 30_000);
});
