import { rmSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Windows answers `EBUSY` while a surviving descendant still holds a file in
 * the exchange directory, and `execute` owes its caller a verdict — so the
 * removal must report itself as a note rather than throw over a step that
 * already produced one. A real EBUSY is not reachable on a POSIX host, so the
 * one call is refused here; everything else passes straight through.
 *
 * Its own file, because the mock is module-wide.
 */
let refuseRemoval: ((target: string) => boolean) | undefined;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const rmSync: typeof actual.rmSync = (target, options) => {
    if (refuseRemoval?.(String(target))) {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    }
    return actual.rmSync(target, options);
  };
  return { ...actual, rmSync, default: { ...actual, rmSync } };
});

import {
  exchangeDirPrefix,
  FlowScriptExecutor,
} from "../../../src/tools/flows/script/flow-script-executor";
import { resolveBashInterpreter } from "../../../src/tools/flows/script/flow-script-interpreter";
import { createScriptWorkspace } from "../../helpers/flow-script-workspace";

let noBash: string | undefined;

beforeAll(async () => {
  const found = await resolveBashInterpreter(undefined);
  if (!("path" in found)) noBash = found.problem;
});

beforeEach((ctx) => {
  if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
});

afterEach(() => {
  refuseRemoval = undefined;
});

describe("an exchange directory that will not go", () => {
  it("becomes a note on the result, never a throw", async () => {
    const ws = createScriptWorkspace("bash-busy");
    const script = ws.write("held.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
    refuseRemoval = (target) => target.includes(exchangeDirPrefix());
    try {
      const result = await new FlowScriptExecutor({ concurrency: 2 }).execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
      });

      expect(result.ok).toBe(true);
      expect(result.output).toEqual({ ok: true });
      const note = result.notes.join(" ");
      expect(note).toContain("could not be removed");
      expect(note).toContain("EBUSY");
      // The note names the directory it left behind, which is how the next
      // tool server's sweep finds it — and how this test cleans up after
      // itself rather than leaving a document under os.tmpdir().
      const left = new RegExp(`(\\S*${exchangeDirPrefix()}\\S+?) could not be removed`).exec(
        note
      )?.[1];
      expect(left).toBeDefined();
      refuseRemoval = undefined;
      rmSync(left!, { recursive: true, force: true });
    } finally {
      refuseRemoval = undefined;
      ws.cleanup();
    }
  }, 30_000);
});
