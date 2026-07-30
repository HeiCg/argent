import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { previewImageRoots } from "../src/preview";

/**
 * The `/variant-image` route serves a variant's `previewImage` only when the
 * file resolves inside one of these roots — otherwise it 404s and the Argent
 * Lens renders "No preview". The Lens workflow's whole premise is handing a
 * freshly captured screenshot's path straight to `propose_variant`, and
 * `screenshot` saves that PNG durably under `.argent/screenshots/`, so those
 * directories have to be servable.
 */
function contains(roots: string[], file: string): boolean {
  return roots.some((root) => file === root || file.startsWith(root + sep));
}

describe("previewImageRoots", () => {
  let projectRoot: string;
  let home: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    projectRoot = await realpath(await mkdtemp(join(tmpdir(), "argent-proj-")));
    await writeFile(join(projectRoot, "package.json"), "{}"); // the project marker
    home = await realpath(await mkdtemp(join(tmpdir(), "argent-home-")));
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("serves a durable screenshot captured from a subdirectory of the project", async () => {
    // The failure this pins: cwd is `apps/mobile` but the screenshot is saved at
    // the PROJECT root's `.argent/screenshots/`, which is not under cwd, tmpdir,
    // or /tmp. Anchoring only on cwd 404s every Lens thumbnail in a monorepo.
    const sub = join(projectRoot, "apps", "mobile");
    await mkdir(sub, { recursive: true });
    process.chdir(sub);

    const shot = join(projectRoot, ".argent", "screenshots", "screenshot-SIM-1.png");
    expect(contains(previewImageRoots(), shot)).toBe(true);
  });

  it("serves a durable screenshot saved under the global ~/.argent when outside a project", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "argent-noproj-")));
    process.chdir(outside);
    try {
      const shot = join(home, ".argent", "screenshots", "screenshot-SIM-1.png");
      expect(contains(previewImageRoots(), shot)).toBe(true);
    } finally {
      process.chdir(originalCwd);
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("resolves the screenshots root even before the directory exists", async () => {
    // The roots are computed once when the router is built — before any
    // screenshot has been taken — so resolving them must not depend on the
    // leaf directory already being on disk.
    process.chdir(projectRoot);
    const roots = previewImageRoots();
    expect(roots).toContain(join(projectRoot, ".argent", "screenshots"));
  });

  it("keeps the scratch roots agents already use", async () => {
    process.chdir(projectRoot);
    const roots = previewImageRoots();
    expect(contains(roots, join(await realpath(tmpdir()), "shot.png"))).toBe(true);
    expect(contains(roots, join(projectRoot, "shot.png"))).toBe(true);
  });

  it("widens only as far as the screenshots directory itself", async () => {
    // The roots added here name `.argent/screenshots`, never the `.argent` tree
    // that also holds argent's config — asserted on the root list rather than by
    // containment, because this suite's HOME and project both live under tmpdir,
    // which is a root in its own right.
    process.chdir(projectRoot);
    const roots = previewImageRoots();
    for (const base of [projectRoot, home]) {
      expect(roots).toContain(join(base, ".argent", "screenshots"));
      expect(roots).not.toContain(join(base, ".argent"));
    }
  });
});
