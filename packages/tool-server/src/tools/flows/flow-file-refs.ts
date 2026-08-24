import * as fs from "node:fs/promises";
import * as path from "node:path";
import { classifyOnDiskSpelling, type OnDiskSpelling } from "./flow-utils";

/**
 * One hop from a flow file to a file it NAMES, and the canonicalization that
 * hop is built on.
 *
 * Both names a flow file can carry — a `run:` target's YAML, a `script:` step's
 * `.mjs` — resolve through here, which is the point: "a script path resolves
 * exactly like a `run:` target" is then a fact about the code rather than two
 * implementations that happen to agree.
 *
 * Not to be confused with `flow-utils.ts`' own private `canonicalFlowPath`,
 * which answers a different question — the identity a RECORDING is keyed by,
 * following a dangling symlink by hand so a not-yet-created file still resolves
 * to one key.
 */

/**
 * Canonicalize a flow path — the cycle guard's identity key and the root
 * anchor derivation (flowsDir + runStack seed).
 *
 * The input must arrive with any `..` segments intact (no path.resolve/join
 * over the string): a `..` that follows a symlinked directory component names
 * the parent of the link's TARGET, which only the kernel can know, so a lexical
 * collapse first silently picks a different file than the spelling denotes on
 * disk. fs/promises' realpath keeps kernel semantics (realpath(3), unlike
 * callback fs.realpath, which path.resolve()s first), so handing it the
 * un-collapsed string is sufficient. When realpath fails the containing
 * directory is still kernel-resolved before the basename is re-appended, so the
 * subsequent read opens — and its ENOENT names — the file the spelling denotes
 * rather than an existing impostor a collapse could have named; when the
 * directory chain itself is broken the spelling is returned verbatim, for the
 * same reason.
 *
 * Callers must pass an absolute path: every return value, the verbatim fallback
 * included, is consumed as absolute (readFile, dirname-derived anchors) with no
 * resolve step after this point.
 */
export async function canonicalFlowPath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    try {
      return path.join(await fs.realpath(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

interface ResolvedFlowRelativeFile {
  /** What the kernel resolves the as-written join to. */
  canonical: string;
  spelling: OnDiskSpelling;
}

/**
 * One hop from a flow file to a file it NAMES. Three things here are
 * load-bearing:
 *
 * - **The anchor is the CONTAINING file's canonical directory**, never the root
 *   flow's. A root anchor would make a fragment resolve a different file
 *   depending on which flow composed it, so a shared fragment would stop being
 *   self-contained — the one property `run:` composition exists to have.
 * - **The join is string concatenation, not `path.resolve`/`path.join`.** Those
 *   collapse a `..` lexically before the kernel ever sees the spelling, and
 *   after a symlinked directory component the collapse names a different file
 *   than the one on disk. Both name kinds deliberately admit `..` (shared
 *   fragments and shared scripts may live outside the referencing file's
 *   directory), so the spelling has to reach the kernel intact. The anchor is
 *   absolute and the target relative — parse rejects an absolute or
 *   drive-prefixed target — so the concatenation is well-formed.
 * - **The casing check lists the directory the target is SPELLED in**, not
 *   `path.dirname(canonical)`: realpath rewrites a symlinked target to its own
 *   target's name, so `run: alias.yaml` (alias.yaml → a.yaml) — a legitimate
 *   layout the cycle guard already relies on — would be refused for not being
 *   named "a.yaml". `path.dirname` removes a segment without collapsing `..`,
 *   so a `..` still reaches readdir intact.
 *
 * `addressable` only decides whether a `case_folded` verdict can point the
 * author at the on-disk spelling or has to ask for a rename; the callers word
 * their own refusals, because "mis-cased fragment reference" and "mis-cased
 * script path" send an author to different places.
 *
 * There is deliberately NO path fence here. A target is reachable exactly when
 * the tool-server user can read it, which is the reach the front door already
 * grants: an operator can point `flow_path` at any YAML on the host (see
 * `resolveFlowSource`). The one route carrying untrusted content, an uploaded
 * flow, never reaches this function at all — `assertUploadSelfContained`
 * rejects every `run:` and `script:` step on that path, and a recording whose
 * files are not on this host is refused by `flow-add-script` before it gets
 * here.
 */
export async function resolveFlowRelativeFile(
  anchorDir: string,
  target: string,
  addressable: RegExp
): Promise<ResolvedFlowRelativeFile> {
  const spelled = anchorDir + path.sep + target;
  const canonical = await canonicalFlowPath(spelled);
  const spelling = await classifyOnDiskSpelling(
    path.dirname(spelled),
    path.posix.basename(target),
    addressable
  );
  return { canonical, spelling };
}
