import fs from "fs/promises";
import path from "path";
import type { ToolDefinition } from "@argent/registry";
import { advertisedSchema } from "./catalog";

/**
 * Vocabulary for "this image is at the device's own resolution", in the
 * spellings the screenshot surfaces reach for. `screenshot-diff` captures live
 * input at full resolution only when the device streams it, and writes its diff
 * at whatever size the comparison ran at, so every one of these is a claim that
 * has to be checked against `captureLiveInput` and `writeDiffArtifacts`.
 *
 * One list for every surface. Two lists that each miss what the other catches
 * is how `full size` — the exact wording of the label this fix removed — stayed
 * legal in skill markdown while being banned in the tool description.
 *
 * `native resolution` is deliberately absent: argent-screen-recording uses it
 * correctly for h264 frames, which never go through this parameter. A range
 * mention ("`scale` accepts values from 0.01 to 1.0") is not a claim about a
 * capture and does not match; the boundary before `scale` keeps `grayscale = 1`,
 * `upscale: 1` and `ARGENT_SCREENSHOT_SCALE` out.
 */
const CLAIMS_SIZE =
  /full[- ](?:resolution|res\b|size)|\bunscaled\b|\b1:1\b|100%\s*(?:of\s+)?(?:the\s+)?(?:original\s+|device\s+|native\s+)?(?:scale|resolution)|\bscale["'`]?\s*(?:[:=]|\s+(?:of|to)\s+)?\s*1(?:\.0+)?\b/i;

/**
 * Whitespace is not part of a claim: a soft line wrap between "full" and
 * "resolution" reads identically to an agent and to a maintainer, and would
 * otherwise slip a banned phrase past a single-space pattern.
 */
const flatten = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The sentences of `text` that reach for that vocabulary. Pinning the whole
 * collection, rather than the presence of a corrected phrase, is what makes a
 * contradicting *addition* visible: it arrives as an extra element instead of
 * sitting beside the phrase a positive assertion already found.
 *
 * Split on a period followed by whitespace, which leaves decimals ("0.3 by
 * default") intact.
 */
export function sentencesClaimingSize(text: string): string[] {
  return flatten(text)
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => CLAIMS_SIZE.test(sentence));
}

/** The same sweep over a rendered summary, which is line- rather than sentence-shaped. */
export function linesClaimingSize(text: string): string[] {
  return text.split("\n").filter((line) => CLAIMS_SIZE.test(flatten(line)));
}

/**
 * Every string a tool puts in front of an agent: the description, the schema a
 * client is actually served, the search hint, and the progress messages. Read
 * through `advertisedSchema` rather than `zodSchema.shape`, because a
 * `.describe()` written before `.optional()` is dropped from the shape while
 * still being advertised — a description an agent reads and a sweep does not.
 */
export function agentFacingText(def: ToolDefinition<any, any>): Array<[string, string]> {
  const schema = advertisedSchema(def);
  const properties = (schema?.properties ?? {}) as Record<string, { description?: string }>;
  const interaction = (def.interaction ?? {}) as Record<string, unknown>;
  return [
    ["description", def.description ?? ""],
    ["searchHint", def.searchHint ?? ""],
    // The progress messages read as source rather than as output: two of the
    // three need a result or a failure signal to render, and a claim written
    // into one is a literal in the function either way.
    ...Object.entries(interaction).map(([name, formatter]): [string, string] => [
      name,
      typeof formatter === "function" ? formatter.toString() : "",
    ]),
    ...Object.entries(properties).map(([name, property]): [string, string] => [
      name,
      property.description ?? "",
    ]),
  ];
}

/** Every markdown file shipped with a skill, so a claim cannot hide in `references/`. */
export async function readSkillDocs(): Promise<Array<{ name: string; text: string }>> {
  const root = path.join(__dirname, "../../../skills/skills");
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return Promise.resolve(entry.name.endsWith(".md") ? [full] : []);
      })
    );
    return nested.flat();
  };
  const files = await walk(root);
  return Promise.all(
    files.map(async (file) => ({
      name: path.relative(root, file),
      text: await fs.readFile(file, "utf8"),
    }))
  );
}
